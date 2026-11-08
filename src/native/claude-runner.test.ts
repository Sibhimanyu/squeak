import { describe, expect, it } from "vitest";

import { ClaudeRunner, Pushable, type ClaudeQuery, type ClaudeQueryFn } from "./claude-runner.js";
import type { RequestKind, Resolution, RunnerHooks, SessionStatus } from "./types.js";

/** A fake SDK `query`: records the options and the pushed prompts; the test plays the agent's side. */
function fakeQuery() {
  const out = new Pushable<Record<string, unknown>>();
  const inputs: unknown[] = [];
  const calls: Record<string, unknown>[] = [];
  const state = { closed: false, interrupts: 0, modes: [] as string[], models: [] as (string | undefined)[] };
  const queryFn: ClaudeQueryFn = ({ prompt, options }) => {
    calls.push(options);
    void (async () => {
      for await (const m of prompt) inputs.push(m);
    })();
    const q: ClaudeQuery = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>>,
      interrupt: async () => {
        state.interrupts++;
        out.push({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: "tool_use" });
        return { still_queued: [] };
      },
      setPermissionMode: async (m) => {
        state.modes.push(m);
      },
      setModel: async (m) => {
        state.models.push(m);
      },
      close: () => {
        state.closed = true;
        out.end();
      },
    };
    return q;
  };
  return { queryFn, out, inputs, calls, state };
}

function hooks(answer?: (kind: RequestKind, payload: unknown) => Resolution) {
  const log = {
    statuses: [] as SessionStatus[],
    messages: [] as { kind: string; payload: unknown }[],
    deltas: 0,
    ends: [] as string[],
    ids: [] as string[],
    requests: [] as { kind: RequestKind; payload: Record<string, unknown> }[],
    exits: 0,
  };
  const h: RunnerHooks = {
    onAgentSessionId: (id) => log.ids.push(id),
    onMessage: (_r, kind, payload) => log.messages.push({ kind, payload }),
    onDelta: () => log.deltas++,
    onStatus: (s) => log.statuses.push(s),
    onRequest: async (kind, payload) => {
      log.requests.push({ kind, payload: payload as Record<string, unknown> });
      return answer ? answer(kind, payload) : { decision: "allow" };
    },
    onTurnEnd: (o) => log.ends.push(o),
    onExit: () => log.exits++,
  };
  return { h, log };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ClaudeRunner", () => {
  it("starts one process with the right options and feeds each message into it", async () => {
    const f = fakeQuery();
    const { h, log } = hooks();
    const r = new ClaudeRunner({
      cwd: "/w",
      model: "opus-5-1m",
      effort: "high",
      permissionMode: "default",
      hooks: h,
      queryFn: f.queryFn,
      executable: "/bin/claude",
      env: { A: "1" },
    });
    await r.send("hello");
    await r.send("again");
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      cwd: "/w",
      model: "claude-opus-5[1m]",
      effort: "high",
      permissionMode: "default",
      includePartialMessages: true,
      pathToClaudeCodeExecutable: "/bin/claude",
      env: { A: "1", CLAUDE_CODE_ENTRYPOINT: "squeak" },
    });
    expect(f.calls[0]).not.toHaveProperty("resume");
    expect(f.inputs).toEqual([
      { type: "user", message: { role: "user", content: "hello" }, parent_tool_use_id: null },
      { type: "user", message: { role: "user", content: "again" }, parent_tool_use_id: null },
    ]);
    expect(log.statuses[0]).toBe("working");
  });

  it("takes the session id from init, streams deltas, and a success result ends the turn idle", async () => {
    const f = fakeQuery();
    const { h, log } = hooks();
    const r = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: h, queryFn: f.queryFn });
    await r.send("hi");
    f.out.push({ type: "system", subtype: "init", session_id: "sess-1" });
    f.out.push({ type: "system", subtype: "session_state_changed", state: "running" });
    f.out.push({ type: "stream_event", event: { type: "content_block_delta" } });
    f.out.push({ type: "assistant", message: { content: [{ type: "text", text: "yo" }] } });
    f.out.push({ type: "result", subtype: "success", is_error: false });
    await tick();
    expect(log.ids).toEqual(["sess-1"]);
    expect(log.deltas).toBe(1);
    expect(log.messages.map((m) => m.kind)).toEqual(["system/init", "assistant", "result/success"]);
    expect(log.ends).toEqual(["idle"]);
  });

  it("an error result is an error turn", async () => {
    const f = fakeQuery();
    const { h, log } = hooks();
    const r = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: h, queryFn: f.queryFn });
    await r.send("hi");
    f.out.push({ type: "result", subtype: "error_max_turns", is_error: true });
    await tick();
    expect(log.ends).toEqual(["error"]);
  });

  it("a refused turn reports its own words, not the subtype", async () => {
    const f = fakeQuery();
    const { h } = hooks();
    const details: Array<string | undefined> = [];
    const original = h.onTurnEnd.bind(h);
    h.onTurnEnd = (outcome, detail) => {
      details.push(detail);
      original(outcome, detail);
    };
    const r = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: h, queryFn: f.queryFn });
    await r.send("hi");
    f.out.push({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    await tick();
    expect(details).toEqual(["Not logged in · Please run /login"]);
  });

  it("allow returns the input (or the answers merged), deny returns the message; status follows the kind", async () => {
    const f = fakeQuery();
    const { h, log } = hooks((kind) =>
      kind === "question"
        ? { decision: "allow", answers: { q1: "A" } }
        : kind === "plan"
          ? { decision: "deny", message: "no thanks" }
          : { decision: "allow" },
    );
    const r = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: h, queryFn: f.queryFn });
    await r.send("hi");
    const can = f.calls[0]!.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      c: Record<string, unknown>,
    ) => Promise<unknown>;
    expect(await can("Bash", { command: "ls" }, { toolUseID: "t1" })).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
    expect(await can("AskUserQuestion", { questions: [] }, {})).toEqual({
      behavior: "allow",
      updatedInput: { questions: [], answers: { q1: "A" } },
    });
    expect(await can("ExitPlanMode", { plan: "p" }, {})).toEqual({ behavior: "deny", message: "no thanks" });
    expect(log.requests.map((x) => x.kind)).toEqual(["tool", "question", "plan"]);
    expect(log.requests[0]!.payload).toMatchObject({ toolName: "Bash", toolUseID: "t1" });
    expect(log.statuses).toContain("needs_user_permission");
    expect(log.statuses).toContain("needs_user_input");
    expect(log.statuses).toContain("needs_plan_response");
  });

  it("a denial without a message still says something", async () => {
    const f = fakeQuery();
    const { h } = hooks(() => ({ decision: "deny" }));
    const r = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: h, queryFn: f.queryFn });
    await r.send("hi");
    const can = f.calls[0]!.canUseTool as (n: string, i: unknown, c: unknown) => Promise<{ message: string }>;
    expect((await can("Bash", {}, {})).message).toMatch(/Squeak/);
  });

  it("interrupt asks the query to stop, shows cancelling, and the resulting error result lands idle", async () => {
    const f = fakeQuery();
    const { h, log } = hooks();
    const r = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: h, queryFn: f.queryFn });
    await r.interrupt(); // nothing running: a no-op
    expect(f.state.interrupts).toBe(0);
    await r.send("long");
    await r.interrupt();
    await tick();
    expect(f.state.interrupts).toBe(1);
    expect(log.statuses).toContain("cancelling");
    expect(log.ends).toEqual(["idle"]);
    // the same process takes the next message, and a real failure afterwards is an error again
    await r.send("next");
    f.out.push({ type: "result", subtype: "error_during_execution", is_error: true });
    await tick();
    expect(log.ends).toEqual(["idle", "error"]);
  });

  it("resumes with the agent's session id and changes mode on the live query", async () => {
    const f = fakeQuery();
    const { h } = hooks();
    const r = new ClaudeRunner({
      cwd: "/w",
      model: "m",
      permissionMode: "plan",
      resume: "old-id",
      hooks: h,
      queryFn: f.queryFn,
    });
    await r.setPermissionMode("acceptEdits"); // before start: remembered
    await r.send("hi");
    expect(f.calls[0]).toMatchObject({ resume: "old-id", permissionMode: "acceptEdits" });
    await r.setPermissionMode("default");
    expect(f.state.modes).toEqual(["default"]);
  });

  it("reports an unexpected end but not its own close", async () => {
    const a = fakeQuery();
    const x = hooks();
    const r1 = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: x.h, queryFn: a.queryFn });
    await r1.send("hi");
    a.out.end();
    await tick();
    expect(x.log.exits).toBe(1);

    const b = fakeQuery();
    const y = hooks();
    const r2 = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: y.h, queryFn: b.queryFn });
    await r2.send("hi");
    await r2.close();
    await tick();
    expect(b.state.closed).toBe(true);
    expect(y.log.exits).toBe(0);
  });

  it("setModel switches a live query; a changed effort restarts it quietly on the next turn", async () => {
    const f = fakeQuery();
    const { h, log } = hooks();
    const r = new ClaudeRunner({
      cwd: "/w",
      model: "m",
      effort: "low",
      permissionMode: "default",
      hooks: h,
      queryFn: f.queryFn,
    });
    await r.setModel("sonnet-5", "low"); // before start: remembered
    await r.send("a");
    expect(f.calls[0]).toMatchObject({ effort: "low" });
    await r.setModel("opus-5", "low");
    expect(f.state.models).toHaveLength(1);
    f.out.push({ type: "result", subtype: "success" });
    await tick();
    await r.setModel("opus-5", "high");
    expect(f.state.closed).toBe(true);
    await tick();
    expect(log.exits).toBe(0);
    await r.send("b");
    expect(f.calls[1]).toMatchObject({ effort: "high" });
  });
});
