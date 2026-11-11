import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ClaudeRunner, Pushable, type ClaudeQuery, type ClaudeQueryFn } from "./claude-runner.js";
import type { RequestKind, Resolution, RunnerHooks, SessionStatus } from "./types.js";

/** A fake SDK `query`: records the options and the pushed prompts; the test plays the agent's side. */
function fakeQuery() {
  const outs: Pushable<Record<string, unknown>>[] = [];
  const inputs: unknown[] = [];
  const calls: Record<string, unknown>[] = [];
  const state = {
    closed: false,
    interrupts: 0,
    refuse: false,
    modes: [] as string[],
    models: [] as (string | undefined)[],
  };
  const queryFn: ClaudeQueryFn = ({ prompt, options }) => {
    calls.push(options);
    const out = new Pushable<Record<string, unknown>>();
    outs.push(out);
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
        if (state.refuse) throw new Error("cannot switch to bypass");
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
  return {
    queryFn,
    get out() {
      return outs[outs.length - 1]!;
    },
    inputs,
    calls,
    state,
  };
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
    background: [] as number[],
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
    onBackground: (n) => log.background.push(n),
    onExit: () => log.exits++,
  };
  return { h, log };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ClaudeRunner", () => {
  it("gives the chat Squeak's tools and plugin, and lets only Squeak's own tools run without asking", async () => {
    const f = fakeQuery();
    const asked: string[] = [];
    const { h } = hooks((kind, payload) => {
      asked.push((payload as { toolName: string }).toolName);
      return { decision: "deny" };
    });
    const r = new ClaudeRunner({
      cwd: "/w",
      model: "m",
      permissionMode: "default",
      hooks: h,
      queryFn: f.queryFn,
      executable: "/bin/claude",
      mcp: { url: "http://127.0.0.1:1/mcp/s1", token: "tok" },
      plugins: ["/p/agent-plugin"],
    });
    await r.send("hi");
    await tick();
    expect(f.calls[0]).toMatchObject({
      mcpServers: {
        squeak: { type: "http", url: "http://127.0.0.1:1/mcp/s1", headers: { Authorization: "Bearer tok" } },
      },
      plugins: [{ type: "local", path: "/p/agent-plugin" }],
    });
    const canUseTool = f.calls[0]!.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      c: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    expect((await canUseTool("mcp__squeak__send_to_chat", {}, {})).behavior).toBe("allow");
    expect((await canUseTool("mcp__squeak__not_a_tool", {}, {})).behavior).toBe("deny");
    expect((await canUseTool("mcp__evil__send_to_chat", {}, {})).behavior).toBe("deny");
    expect(asked).toEqual(["mcp__squeak__not_a_tool", "mcp__evil__send_to_chat"]);
  });

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
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      thinking: { type: "adaptive", display: "summarized" },
      pathToClaudeCodeExecutable: "/bin/claude",
      env: { A: "1", CLAUDE_CODE_ENTRYPOINT: "squeak" },
    });
    expect(f.calls[0]).not.toHaveProperty("resume");
    expect(f.inputs).toEqual([
      { type: "user", message: { role: "user", content: "hello" }, parent_tool_use_id: null, uuid: expect.any(String) },
      { type: "user", message: { role: "user", content: "again" }, parent_tool_use_id: null, uuid: expect.any(String) },
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

  it("a rule of the chat allows a tool before any request is made, but never a question or a plan", async () => {
    const f = fakeQuery();
    const { h, log } = hooks(() => ({ decision: "deny", message: "asked" }));
    const allowed: string[] = [];
    h.tryAutoAllow = (kind, payload) => {
      allowed.push(`${kind}:${(payload as { toolName: string }).toolName}`);
      return true;
    };
    const r = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: h, queryFn: f.queryFn });
    await r.send("hi");
    const can = f.calls[0]!.canUseTool as (n: string, i: Record<string, unknown>, c: unknown) => Promise<unknown>;
    expect(await can("Bash", { command: "npm test" }, {})).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test" },
    });
    expect(await can("ExitPlanMode", {}, {})).toMatchObject({ behavior: "deny" });
    expect(await can("AskUserQuestion", {}, {})).toMatchObject({ behavior: "deny" });
    expect(allowed).toEqual(["tool:Bash"]);
    expect(log.requests.map((x) => x.kind)).toEqual(["plan", "question"]);
    expect(log.statuses).not.toContain("needs_user_permission");
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

  const started = async (opts: Partial<ConstructorParameters<typeof ClaudeRunner>[0]> = {}) => {
    const f = fakeQuery();
    const { h, log } = hooks();
    const r = new ClaudeRunner({
      cwd: "/w",
      model: "m",
      permissionMode: "default",
      hooks: h,
      queryFn: f.queryFn,
      executable: "/bin/claude",
      ...opts,
    });
    await r.send("go");
    await tick();
    const uuid = (f.inputs[0] as { uuid: string }).uuid;
    return { f, r, log, uuid };
  };
  type CanUse = (n: string, i: Record<string, unknown>, c: object) => Promise<{ behavior: string }>;

  it("gives every message a uuid and ends the turn only on the result of a message it sent", async () => {
    const { f, log, uuid } = await started();
    expect(uuid).toEqual(expect.any(String));
    f.out.push({ type: "result", subtype: "success", user_message_uuid: "someone-elses" });
    await tick();
    expect(log.ends).toEqual([]);
    f.out.push({ type: "result", subtype: "success", user_message_uuid: uuid });
    await tick();
    expect(log.ends).toEqual(["idle"]);
  });

  it("ignores the result of a task-notification mini turn", async () => {
    const { f, log, uuid } = await started();
    f.out.push({ type: "result", subtype: "success", num_turns: 0, origin: { kind: "task-notification" } });
    f.out.push({ type: "result", subtype: "success", parent_tool_use_id: "toolu_1" });
    await tick();
    expect(log.ends).toEqual([]);
    f.out.push({ type: "result", subtype: "success", user_message_uuid: uuid });
    await tick();
    expect(log.ends).toEqual(["idle"]);
  });

  it("stays working while background tasks run and ends the turn when the last one reports", async () => {
    const { f, log, uuid } = await started();
    f.out.push({ type: "system", subtype: "task_started", task_id: "a", task_type: "local_agent" });
    f.out.push({ type: "system", subtype: "task_started", task_id: "b", task_type: "local_bash" });
    f.out.push({ type: "result", subtype: "success", user_message_uuid: uuid });
    await tick();
    expect(log.ends).toEqual([]);
    expect(log.background.at(-1)).toBe(2);
    f.out.push({ type: "system", subtype: "task_notification", task_id: "a", status: "completed" });
    // the notification's own mini turn
    f.out.push({ type: "result", subtype: "success", origin: { kind: "task-notification" } });
    await tick();
    expect(log.ends).toEqual([]);
    f.out.push({ type: "system", subtype: "task_updated", task_id: "b", patch: { status: "completed" } });
    await tick();
    expect(log.ends).toEqual(["idle"]);
    expect(log.background.at(-1)).toBe(0);
  });

  it("reads the chat's live mode in canUseTool: skip approvals applies at once, and back", async () => {
    const { f, r, log } = await started();
    const canUse = f.calls[0]!.canUseTool as CanUse;
    void canUse("Bash", { command: "ls" }, {});
    await tick();
    expect(log.requests).toHaveLength(1); // asked
    await r.setPermissionMode("bypassPermissions");
    expect(f.state.modes).toEqual(["bypassPermissions"]);
    expect(await canUse("Bash", { command: "ls" }, {})).toMatchObject({ behavior: "allow" });
    expect(log.requests).toHaveLength(1);
    // plans and questions still ask
    void canUse("ExitPlanMode", {}, {});
    await tick();
    expect(log.requests).toHaveLength(2);
    await r.setPermissionMode("default");
    void canUse("Bash", { command: "pwd" }, {});
    await tick();
    expect(log.requests).toHaveLength(3);
  });

  it("setPermissionMode never throws when the agent refuses; the live mode still applies", async () => {
    const { f, r } = await started();
    f.state.refuse = true;
    await expect(r.setPermissionMode("bypassPermissions")).resolves.toBeUndefined();
    const canUse = f.calls[0]!.canUseTool as CanUse;
    expect(await canUse("Bash", {}, {})).toMatchObject({ behavior: "allow" });
  });

  it("steers mid-turn through the same input, and a swallowed result settles by the watchdog", async () => {
    const { f, r, log, uuid } = await started({ settleMs: 30 });
    expect(await r.steer("also this")).toBe(true);
    await tick();
    expect(f.inputs).toHaveLength(2);
    const second = f.inputs[1] as { uuid: string; message: { content: string } };
    expect(second.message.content).toBe("also this");
    expect(second.uuid).not.toBe(uuid);
    // the first message's result comes while the steer's own is still due: held
    f.out.push({ type: "result", subtype: "success", user_message_uuid: uuid });
    await tick();
    expect(log.ends).toEqual([]);
    await new Promise((res) => setTimeout(res, 80));
    expect(log.ends).toEqual(["idle"]);
  });

  it("a steer's own result ends the turn at once and folds the earlier one in", async () => {
    const { f, r, log } = await started({ settleMs: 5000 });
    await r.steer("more");
    await tick();
    const steerUuid = (f.inputs[1] as { uuid: string }).uuid;
    f.out.push({ type: "result", subtype: "success", user_message_uuid: steerUuid });
    await tick();
    expect(log.ends).toEqual(["idle"]);
  });

  it("cannot steer when nothing runs or the process is not up", async () => {
    const { r, f, uuid } = await started();
    f.out.push({ type: "result", subtype: "success", user_message_uuid: uuid });
    await tick();
    expect(await r.steer("late")).toBe(false);
    const cold = new ClaudeRunner({ cwd: "/w", model: "m", permissionMode: "default", hooks: hooks().h });
    expect(await cold.steer("x")).toBe(false);
  });

  // Recorded from the real claude CLI (2.1.322): see fixtures/claude-real-stream.json
  const real = JSON.parse(readFileSync(new URL("./fixtures/claude-real-stream.json", import.meta.url), "utf8")) as {
    steerResult: Record<string, unknown>;
    abortResult: Record<string, unknown>;
    backgroundBash: Record<string, unknown>[];
  };
  const bind = <T>(o: T, map: Record<string, string>): T =>
    JSON.parse(JSON.stringify(o), (_k, v) => (typeof v === "string" && map[v] ? map[v] : v)) as T;

  it("real CLI: a steer folded into the running turn shares one result listing both uuids and ends the turn at once", async () => {
    const { f, r, log, uuid } = await started({ settleMs: 5000 });
    await r.steer("banana too");
    await tick();
    const steerUuid = (f.inputs[1] as { uuid: string }).uuid;
    // real shape: user_message_uuid is the FIRST message, user_message_uuids lists both
    f.out.push(bind(real.steerResult, { U1: uuid, U2: steerUuid }));
    await tick();
    expect(log.ends).toEqual(["idle"]);
  });

  it("real CLI: background bash. Its result arrives before the task ends; the chat stays working until task_updated/notification", async () => {
    const { f, log, uuid } = await started();
    for (const m of real.backgroundBash) {
      f.out.push(bind(m, { U1: uuid }));
      await tick();
      if (m.type === "result") {
        expect(log.ends).toEqual([]);
        expect(log.background.at(-1)).toBe(1);
      }
    }
    expect(log.ends).toEqual(["idle"]);
    expect(log.background.at(-1)).toBe(0);
  });

  it("real CLI: Stop ends idle, records the 'aborted by user' row, and the interrupted result is not an error", async () => {
    const { f, r, log, uuid } = await started();
    await r.interrupt();
    // the fake already answered; replay the recorded abort result as the CLI wrote it
    f.out.push(bind(real.abortResult, { U1: uuid }));
    await tick();
    expect(log.ends).toEqual(["idle"]);
    expect(log.messages.filter((m) => m.kind === "error")).toEqual([
      { kind: "error", payload: { type: "error", content: "aborted by user" } },
    ]);
  });

  it("an interrupt the CLI never answers closes the process after the timeout, ends idle, and the next send restarts it", async () => {
    const { f, r, log } = await started({ interruptMs: 30 });
    f.state.interrupts = 0;
    // a CLI that swallows the interrupt: nothing comes back
    const q = f.calls.length;
    (r as unknown as { query: ClaudeQuery }).query.interrupt = async () => new Promise(() => undefined);
    await r.interrupt();
    expect(f.state.closed).toBe(true);
    expect(log.ends).toEqual(["idle"]);
    expect(log.messages.filter((m) => m.kind === "error")).toHaveLength(1);
    expect(log.exits).toBe(0);
    await r.send("again");
    expect(f.calls.length).toBe(q + 1);
  });

  it("read-only tools never ask, in default mode; edits and shell still do", async () => {
    const { f, log } = await started();
    const canUse = f.calls[0]!.canUseTool as CanUse;
    for (const t of ["Read", "Glob", "Grep", "LS"])
      expect(await canUse(t, {}, {})).toMatchObject({ behavior: "allow" });
    expect(log.requests).toHaveLength(0);
    void canUse("Write", { file_path: "/w/a" }, {});
    void canUse("WebSearch", {}, {});
    await tick();
    expect(log.requests.map((q) => q.payload.toolName)).toEqual(["Write", "WebSearch"]);
  });

  it("warm() spawns the process without a message", async () => {
    const f = fakeQuery();
    const { h, log } = hooks();
    const r = new ClaudeRunner({
      cwd: "/w",
      model: "m",
      permissionMode: "default",
      hooks: h,
      queryFn: f.queryFn,
      executable: "/bin/claude",
    });
    await r.warm();
    expect(f.calls).toHaveLength(1);
    expect(f.inputs).toHaveLength(0);
    expect(log.statuses).toEqual([]);
    await r.send("first");
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(f.inputs).toHaveLength(1);
  });
});
