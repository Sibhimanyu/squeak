import { describe, expect, it } from "vitest";
import { supports } from "../core/adapter.js";
import type { AgentEvent } from "../core/events.js";
import { AgentRegistry } from "../core/registry.js";
import { fleetSession } from "../core/adapters/fixtures.js";
import { asSessionId, type SessionId } from "../core/types.js";
import type { RunnerHooks, Runner, Resolution } from "../native/types.js";
import { ClaudeCodeAdapter, claudeLaunch } from "./claude-adapter.js";
import { CodexAdapter, codexLaunch } from "./codex-adapter.js";
import { createLaunchPort } from "./launch-port.js";
import { registerAgentAdapters } from "./index.js";
import type { RunnerFactory, RunnerFactoryInput } from "./runner-adapter.js";
import type { WorkspaceMetadata } from "../workspace/types.js";

class FakeRunner implements Runner {
  readonly canSteer = false;
  sent: string[] = [];
  closed = false;
  interrupted = false;
  constructor(readonly input: RunnerFactoryInput) {}
  get hooks(): RunnerHooks {
    return this.input.hooks;
  }
  async send(t: string) {
    this.sent.push(t);
  }
  async steer() {
    return false;
  }
  async interrupt() {
    this.interrupted = true;
  }
  async setPermissionMode() {}
  async close() {
    this.closed = true;
  }
}

function rig() {
  const runners: FakeRunner[] = [];
  const createRunner: RunnerFactory = (i) => {
    const r = new FakeRunner(i);
    runners.push(r);
    return r;
  };
  let n = 0;
  const base = { createRunner, now: () => "2026-11-09T10:00:00.000Z", newId: () => `id${++n}` };
  return { runners, base };
}

const req = { projectId: "p", workspacePath: "/w", prompt: "fix it" };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function collect(it: AsyncIterable<AgentEvent>, n: number): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) {
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

describe("capabilities", () => {
  it("claims only what the methods and runners support", () => {
    const { base } = rig();
    const claude = new ClaudeCodeAdapter(base);
    const codex = new CodexAdapter(base);
    for (const a of [claude, codex]) {
      expect(supports(a, "startSession")).toBe(true);
      expect(supports(a, "messaging")).toBe(true);
      expect(supports(a, "stopSession")).toBe(true);
      expect(supports(a, "approvals")).toBe(true);
      expect(a.capabilities.steering).toBe(false);
    }
    expect(claude.capabilities.questions).toBe(true);
    expect(codex.capabilities.questions).toBe(false);
    expect(claude.matrix.attach && codex.matrix.attach).toBe(true);
  });
});

describe("ClaudeCodeAdapter", () => {
  it("starts, streams normalized events in order, and completes", async () => {
    const { base, runners } = rig();
    const a = new ClaudeCodeAdapter(base);
    const s = await a.startSession({ ...req, model: "opus" });
    expect(s).toMatchObject({ provider: "claudeCode", state: "starting", title: "fix it" });
    const r = runners[0]!;
    expect(r.input.cwd).toBe("/w");
    expect(r.input.model).toBe("opus");
    expect(r.sent).toEqual(["fix it"]);
    r.hooks.onAgentSessionId("agent-1");
    r.hooks.onMessage("agent", "assistant", {
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: "on it" }] },
    });
    r.hooks.onMessage("agent", "assistant", {
      type: "assistant",
      message: { id: "m1", content: [{ type: "text", text: "on it" }] },
    });
    r.hooks.onMessage("agent", "result/success", { type: "result", subtype: "success", result: "done", uuid: "u" });
    r.hooks.onTurnEnd("idle");
    const events = await collect(a.eventStream(s.id), 4);
    expect(events.map((e) => e.type)).toEqual(["sessionStarted", "userMessage", "agentMessage", "completed"]);
    expect(new Set(events.map((e) => e.id)).size).toBe(4); // the duplicated streamed message was dropped
    const [found] = (await a.discoverSessions()).filter((x) => x.id === s.id);
    expect(found).toMatchObject({ state: "completed", providerRef: { provider: "claudeCode", externalId: "agent-1" } });
  });

  it("resume passes the provider's own id", async () => {
    const { base, runners } = rig();
    const s = await new ClaudeCodeAdapter(base).resumeSession("agent-9", req);
    expect(runners[0]!.input.resume).toBe("agent-9");
    expect(s.providerRef).toEqual({ provider: "claudeCode", externalId: "agent-9" });
  });

  it("holds a permission request until respond, then resolves the runner", async () => {
    const { base, runners } = rig();
    const a = new ClaudeCodeAdapter(base);
    const s = await a.startSession(req);
    const hooks = runners[0]!.hooks;
    const resolved: Resolution[] = [];
    void hooks
      .onRequest("tool", { toolName: "Bash", toolUseID: "p1", input: { command: "ls" } })
      .then((r) => resolved.push(r));
    await tick();
    const ev = (await collect(a.eventStream(s.id), 3))[2]!;
    expect(ev.type).toBe("permissionRequested");
    expect(resolved).toEqual([]);
    await a.respond(s.id, { requestId: "p1", actionId: "allowOnce" });
    await tick();
    expect(resolved).toEqual([{ decision: "allow" }]);
    await expect(a.respond(s.id, { requestId: "p1", actionId: "allowOnce" })).rejects.toThrow(/No pending/);
  });

  it("deny with feedback carries the text; unknown actions deny", async () => {
    const { base, runners } = rig();
    const a = new ClaudeCodeAdapter(base);
    const s = await a.startSession(req);
    const got: Resolution[] = [];
    void runners[0]!.hooks
      .onRequest("tool", { toolName: "Edit", toolUseID: "p2", input: { file_path: "/a" } })
      .then((r) => got.push(r));
    await tick();
    await a.respond(s.id, { requestId: "p2", actionId: "denyWithFeedback", text: "use Write" });
    await tick();
    expect(got).toEqual([{ decision: "deny", message: "use Write" }]);
  });

  it("answers a question with the chosen option", async () => {
    const { base, runners } = rig();
    const a = new ClaudeCodeAdapter(base);
    const s = await a.startSession(req);
    const got: Resolution[] = [];
    void runners[0]!.hooks
      .onRequest("question", {
        toolName: "AskUserQuestion",
        toolUseID: "q1",
        input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] },
      })
      .then((r) => got.push(r));
    await tick();
    await a.respond(s.id, { requestId: "q1", actionId: "1" });
    await tick();
    expect(got).toEqual([{ decision: "allow", answers: { "Which?": "B" } }]);
  });

  it("an unreadable request is denied, not hung", async () => {
    const { base, runners } = rig();
    await new ClaudeCodeAdapter(base).startSession(req);
    const r = await runners[0]!.hooks.onRequest("tool", "junk");
    expect(r.decision).toBe("deny");
  });

  it("stop interrupts, closes, denies what waits, and ends the stream", async () => {
    const { base, runners } = rig();
    const a = new ClaudeCodeAdapter(base);
    const s = await a.startSession(req);
    const waiting = runners[0]!.hooks.onRequest("tool", { toolName: "Bash", toolUseID: "p", input: {} });
    await a.stop(s.id);
    expect((await waiting).decision).toBe("deny");
    expect(runners[0]).toMatchObject({ interrupted: true, closed: true });
    const all: AgentEvent[] = [];
    for await (const e of a.eventStream(s.id)) all.push(e);
    expect(all.at(-1)!.type).toBe("sessionStopped");
  });

  it("a crashing process fails the session; a send error fails start", async () => {
    const { base, runners } = rig();
    const a = new ClaudeCodeAdapter(base);
    const s = await a.startSession(req);
    runners[0]!.hooks.onExit(new Error("exit 1"));
    const all: AgentEvent[] = [];
    for await (const e of a.eventStream(s.id)) all.push(e);
    expect(all.at(-1)).toMatchObject({ type: "failed", message: "exit 1" });
    const bad = new ClaudeCodeAdapter({
      ...base,
      createRunner: () =>
        ({
          ...new FakeRunner({} as RunnerFactoryInput),
          send: async () => {
            throw new Error("no claude");
          },
        }) as unknown as Runner,
    });
    await expect(bad.startSession(req)).rejects.toThrow("no claude");
  });

  it("needs a workspace path, and unknown sessions are refused", async () => {
    const { base } = rig();
    const a = new ClaudeCodeAdapter(base);
    await expect(a.startSession({ projectId: "p" })).rejects.toThrow(/workspace path/);
    await expect(a.send(asSessionId("nope"), "x")).rejects.toThrow(/No claudeCode session/);
    expect(await collect(a.eventStream(asSessionId("nope")), 1)).toEqual([]);
  });

  it("status hooks drive state", async () => {
    const { base, runners } = rig();
    const a = new ClaudeCodeAdapter(base);
    const s = await a.startSession(req);
    runners[0]!.hooks.onStatus("awaiting_approval");
    expect((await a.discoverSessions())[0]!.state).toBe("waitingForPermission");
    runners[0]!.hooks.onStatus("working");
    expect((await a.discoverSessions())[0]!.state).toBe("working");
    void s;
  });
});

describe("attach is observe-only", () => {
  const term = fleetSession();
  it("returns the observed session but no runner: send is refused", async () => {
    const { base, runners } = rig();
    const a = new ClaudeCodeAdapter({ ...base, observe: async () => [term] });
    const attached = await a.attach(asSessionId(term.key));
    expect(attached.id).toBe(term.key);
    await expect(a.send(attached.id, "typed")).rejects.toThrow(/read-only/);
    await expect(a.stop(attached.id)).rejects.toThrow(/read-only/);
    expect(runners).toEqual([]);
    await expect(a.attach(asSessionId("claude-transcript:other"))).rejects.toThrow();
    expect((await a.discoverSessions()).map((x) => x.id)).toEqual([term.key]);
  });

  it("is refused when nothing is observed", async () => {
    await expect(new ClaudeCodeAdapter(rig().base).attach(asSessionId("x"))).rejects.toThrow(/no claudeCode sessions/);
  });
});

describe("CodexAdapter", () => {
  it("translates completed items, approvals and the turn end", async () => {
    const { base, runners } = rig();
    const a = new CodexAdapter(base);
    const s = await a.startSession(req);
    const hooks = runners[0]!.hooks;
    hooks.onMessage("agent", "item/agentMessage", { type: "agentMessage", id: "a", text: "hi" });
    hooks.onMessage("agent", "item/fileChange", { type: "fileChange", id: "f", changes: [{ path: "a.txt" }] });
    const got: Resolution[] = [];
    void hooks
      .onRequest("command", {
        method: "item/commandExecution/requestApproval",
        threadId: "t",
        itemId: "x",
        command: "npm i",
        availableDecisions: ["accept", "acceptForSession"],
      })
      .then((r) => got.push(r));
    await tick();
    await a.respond(s.id, { requestId: "x", actionId: "allowSession" });
    await tick();
    expect(got).toEqual([{ decision: "allow", scope: "session" }]);
    hooks.onMessage("agent", "turn/completed", { id: "t1", status: "completed" });
    const types = (await collect(a.eventStream(s.id), 8)).map((e) => e.type);
    expect(types).toEqual([
      "sessionStarted",
      "userMessage",
      "agentMessage",
      "toolStarted",
      "fileEdited",
      "toolCompleted",
      "permissionRequested",
      "completed",
    ]);
    expect(types).toContain("permissionRequested");
    expect(types.at(-1)).toBe("completed");
  });
});

describe("launch descriptors and port", () => {
  const ws = { path: "/w", name: "w" } as WorkspaceMetadata;
  const locate = (c: string) => (c === "codex" ? undefined : `/bin/${c}`);

  it("claude: stream-json, resume and entrypoint", () => {
    const l = claudeLaunch(ws, { model: "m", title: "T" }, locate, "abc");
    expect(l.descriptor.arguments).toEqual(
      expect.arrayContaining(["--output-format", "stream-json", "--model", "m", "--resume", "abc"]),
    );
    expect(l.descriptor).toMatchObject({ executable: "/bin/claude", workingDirectory: "/w", requiresPTY: false });
    expect(l.descriptor.environment.CLAUDE_CODE_ENTRYPOINT).toBe("squeak");
    expect(l).toMatchObject({ externalId: "abc", title: "T" });
  });

  it("codex: app-server; missing binary is a plain error", () => {
    expect(() => codexLaunch(ws, {}, locate)).toThrow("Codex is not installed.");
    expect(codexLaunch(ws, {}, () => "/bin/codex").descriptor.arguments).toEqual([
      "app-server",
      "--listen",
      "stdio://",
    ]);
  });

  it("port routes by provider and refuses the rest by name", async () => {
    const port = createLaunchPort({ locate, custom: { command: "my-agent", args: ["--x"], env: { A: "1" } } });
    expect((await port(ws, "claudeCode", { extra: { resume: "r" } })).externalId).toBe("r");
    expect((await port(ws, "shell", {})).descriptor).toMatchObject({
      executable: "my-agent",
      arguments: ["--x"],
      environment: { A: "1" },
    });
    await expect(port(ws, "openCode", {})).rejects.toThrow("openCode cannot be launched by Squeak yet.");
    await expect(createLaunchPort({ locate })(ws, "shell", {})).rejects.toThrow(/No custom command/);
  });
});

describe("registerAgentAdapters", () => {
  it("registers only what is given", () => {
    const { base } = rig();
    const reg = new AgentRegistry();
    registerAgentAdapters(reg, { claude: base, codex: base });
    expect(reg.providers()).toEqual(["claudeCode", "codex"]);
    expect(() => registerAgentAdapters(reg, { claude: base })).toThrow(/already registered/);
    const empty = new AgentRegistry();
    registerAgentAdapters(empty, {});
    expect(empty.providers()).toEqual([]);
  });
});

export type { SessionId };
