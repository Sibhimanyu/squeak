import { describe, expect, it } from "vitest";
import { supports } from "../core/adapter.js";
import type { AgentEvent } from "../core/events.js";
import type { SpawnedProcess, SpawnSpec } from "../workspace/supervisor.js";
import { CustomCommandAdapter } from "./custom-command-adapter.js";

function rig() {
  const specs: SpawnSpec[] = [];
  const written: string[] = [];
  const killed: string[] = [];
  let out: (s: "stdout" | "stderr", c: string) => void = () => {};
  let exit: (c: number | null, s: string | null) => void = () => {};
  let err: (e: Error) => void = () => {};
  const spawner = (spec: SpawnSpec): SpawnedProcess => {
    specs.push(spec);
    return {
      pid: 1,
      onOutput: (cb) => (out = cb),
      onExit: (cb) => (exit = cb),
      onError: (cb) => (err = cb),
      write: (d) => void written.push(d),
      kill: (s) => void killed.push(s),
    };
  };
  let n = 0;
  const adapter = new CustomCommandAdapter({
    config: { command: "agent", args: ["-x"], env: { K: "v" } },
    spawner,
    now: () => "2026-11-09T10:00:00.000Z",
    newId: () => `s${++n}`,
  });
  return {
    adapter,
    specs,
    written,
    killed,
    out: (s: "stdout" | "stderr", c: string) => out(s, c),
    exit: (c: number | null, s: string | null = null) => exit(c, s),
    err: (e: Error) => err(e),
  };
}

async function all(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const o: AgentEvent[] = [];
  for await (const e of it) o.push(e);
  return o;
}

describe("CustomCommandAdapter", () => {
  it("claims messaging, start and stop only", () => {
    const { adapter } = rig();
    const claimed = (
      ["messaging", "questions", "approvals", "steering", "startSession", "stopSession", "structuredTools"] as const
    ).filter((c) => supports(adapter, c));
    expect(claimed).toEqual(["messaging", "startSession", "stopSession"]);
  });

  it("launches with config, writes prompt to stdin, lines become messages across chunks, exit 0 completes", async () => {
    const r = rig();
    const s = await r.adapter.startSession({ projectId: "p", workspacePath: "/w", prompt: "hello" });
    expect(r.specs[0]).toEqual({ executable: "agent", args: ["-x"], env: { K: "v" }, cwd: "/w", requiresPTY: false });
    expect(r.written).toEqual(["hello\n"]);
    r.out("stdout", "one\ntw");
    r.out("stderr", "ignored\n");
    r.out("stdout", "o\r\nthree");
    r.exit(0);
    const events = await all(r.adapter.eventStream(s.id));
    expect(events.map((e) => e.type)).toEqual([
      "sessionStarted",
      "userMessage",
      "agentMessage",
      "agentMessage",
      "agentMessage",
      "completed",
    ]);
    expect(events.filter((e) => e.type === "agentMessage").map((e) => (e as { text: string }).text)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect((await r.adapter.discoverSessions())[0]!.state).toBe("completed");
  });

  it("nonzero exit fails with a fixed sentence", async () => {
    const r = rig();
    const s = await r.adapter.startSession({ projectId: "p", workspacePath: "/w" });
    r.exit(3);
    expect((await all(r.adapter.eventStream(s.id))).at(-1)).toMatchObject({
      type: "failed",
      message: "The command exited with code 3.",
    });
  });

  it("stop sends SIGTERM and the exit reads as stopped", async () => {
    const r = rig();
    const s = await r.adapter.startSession({ projectId: "p", workspacePath: "/w" });
    await r.adapter.stop!(s.id);
    expect(r.killed).toEqual(["SIGTERM"]);
    r.exit(null, "SIGTERM");
    expect((await all(r.adapter.eventStream(s.id))).at(-1)!.type).toBe("sessionStopped");
  });

  it("spawn errors fail; send after exit is refused; path required", async () => {
    const r = rig();
    const s = await r.adapter.startSession({ projectId: "p", workspacePath: "/w" });
    r.err(new Error("spawn ENOENT secret"));
    const last = (await all(r.adapter.eventStream(s.id))).at(-1)!;
    expect(last).toMatchObject({ type: "failed", message: "The command could not be started." });
    await expect(r.adapter.send!(s.id, "x")).rejects.toThrow(/already exited/);
    await expect(r.adapter.startSession({ projectId: "p" })).rejects.toThrow(/workspace path/);
  });
});
