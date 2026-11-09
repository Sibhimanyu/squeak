import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempRepo } from "./checkpoints.test.js";
import { HostError, SessionHost, type ForkPoint } from "./host.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await tick(10);
  expect(fn()).toBe(true);
};

function setup(agent: "claude" | "codex" = "claude") {
  const store = new NativeStore(":memory:");
  const hooks: RunnerHooks[] = [];
  const sent: [string, string][] = [];
  const forks: { id: string; point: ForkPoint }[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (s: SessionRow, h: RunnerHooks): Runner => {
      hooks.push(h);
      return {
        canSteer: false,
        send: async (t) => {
          sent.push([s.id, t]);
          h.onStatus("working");
        },
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
    },
    forkAgent: async (s, point) => {
      forks.push({ id: s.agentSessionId!, point });
      return `forked-${forks.length}`;
    },
  });
  return { store, host, hooks, sent, forks, agent };
}

/** One finished turn: the user text, an assistant message with a uuid, then the turn's end. */
async function turn(
  ctx: ReturnType<typeof setup>,
  sid: string,
  text: string,
  edit: () => void,
  opts: { codex?: boolean; n?: number } = {},
) {
  const before = ctx.hooks.length;
  await ctx.host.send(sid, text);
  const h = ctx.hooks[Math.max(0, before === 0 ? 0 : ctx.hooks.length - 1)]!;
  edit();
  const n = opts.n ?? ctx.store.listTurns(sid).length;
  if (opts.codex) h.onMessage("agent", "turn/completed", { id: `ct-${n}`, status: "completed" });
  else h.onMessage("agent", "assistant", { type: "assistant", uuid: `u-${n}` });
  h.onTurnEnd("idle");
  await until(() => ctx.store.getSession(sid)!.status === "idle");
}

describe("per-turn checkpoints", () => {
  it("snapshots at turn start and end, lists files per turn, and leaves the user's git state alone", async () => {
    const dir = tempRepo();
    const ctx = setup();
    const s = ctx.store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
    const head = git(dir, "rev-parse", "HEAD");
    const index = git(dir, "ls-files", "-s");
    fs.writeFileSync(path.join(dir, "b.txt"), "b-staged\n");
    git(dir, "add", "b.txt");
    const staged = git(dir, "status", "--porcelain=v2");
    await turn(ctx, s.id, "first", () => {
      fs.writeFileSync(path.join(dir, "a.txt"), "a2\n");
      fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
    });
    await turn(ctx, s.id, "second", () => fs.rmSync(path.join(dir, "new.txt")));
    const turns = await ctx.host.turns(s.id);
    expect(turns.map((t) => t.text)).toEqual(["first", "second"]);
    expect(turns[0]!.startCheckpoint?.ref).toBe(`refs/squeak-checkpoints/${s.id}/1-start`);
    expect(git(dir, "rev-parse", turns[0]!.endCheckpoint!.ref).trim()).toBe(turns[0]!.endCheckpoint!.commit);
    expect(turns[0]!.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["A new.txt", "M a.txt"]);
    expect(turns[1]!.files).toEqual([{ path: "new.txt", status: "D" }]);
    expect(turns[0]!.endSeq).toBeGreaterThan(turns[0]!.startSeq);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "ls-files", "-s")).not.toBe(index); // b.txt staged by the test itself
    expect(git(dir, "status", "--porcelain=v2")).toContain("a.txt");
    expect(staged).toContain("b.txt");
    expect(git(dir, "stash", "list")).toBe("");
  });

  it("skips checkpoints outside a git repository but still records turns", async () => {
    const ctx = setup();
    const s = ctx.store.createSession({ cwd: "/not/a/repo", agent: "claude", model: "m", permissionMode: "default" });
    await turn(ctx, s.id, "hi", () => {});
    const [t] = await ctx.host.turns(s.id);
    expect(t).toMatchObject({ text: "hi", startCheckpoint: null, endCheckpoint: null, files: [] });
    await expect(ctx.host.revertFiles(s.id, 1, "start", true)).rejects.toMatchObject({ status: 409 });
  });
});

describe("revert", () => {
  it("restores a turn's start, writes the system message, refuses mid-turn and without confirm", async () => {
    const dir = tempRepo();
    const ctx = setup();
    const s = ctx.store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
    await turn(ctx, s.id, "one", () => fs.writeFileSync(path.join(dir, "a.txt"), "a-one\n"));
    await turn(ctx, s.id, "two", () => {
      fs.writeFileSync(path.join(dir, "a.txt"), "a-two\n");
      fs.writeFileSync(path.join(dir, "made.txt"), "m\n");
    });
    await expect(ctx.host.revertFiles(s.id, 2, "start", false)).rejects.toMatchObject({ status: 400 });
    const r = await ctx.host.revertFiles(s.id, 2, "start", true);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a-one\n");
    expect(fs.existsSync(path.join(dir, "made.txt"))).toBe(false);
    const last = ctx.store.messagesAfter(s.id).at(-1)!;
    expect(last).toMatchObject({
      role: "system",
      kind: "system/files-restored",
      payload: { text: "Files restored to before turn 2" },
    });
    // the revert itself can be undone through its safety checkpoint
    expect(git(dir, "cat-file", "-t", r.safety).trim()).toBe("commit");
    await expect(ctx.host.revertFiles(s.id, 9, "end", true)).rejects.toMatchObject({ status: 404 });

    // mid-turn: refused, files untouched
    await ctx.host.send(s.id, "three");
    await expect(ctx.host.revertFiles(s.id, 1, "start", true)).rejects.toBeInstanceOf(HostError);
    await expect(ctx.host.revertFiles(s.id, 1, "start", true)).rejects.toMatchObject({ status: 409 });
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a-one\n");
    // and a second chat in the same folder is refused too
    const other = ctx.store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
    ctx.store.setStatus(s.id, "idle");
    ctx.store.setStatus(other.id, "working");
    await expect(ctx.host.revertFiles(s.id, 1, "start", true)).rejects.toMatchObject({ status: 409 });
  });

  it("prunes refs of an archived workspace", async () => {
    const dir = tempRepo();
    const ctx = setup();
    const project = ctx.store.createProject({ name: "p", rootPath: dir, defaultBranch: "main" });
    const ws = ctx.store.createWorkspace({ projectId: project.id, name: "w", path: dir, branch: "main" });
    const s = ctx.store.createSession({
      cwd: dir,
      workspaceId: ws.id,
      agent: "claude",
      model: "m",
      permissionMode: "default",
    });
    await turn(ctx, s.id, "one", () => {});
    expect(git(dir, "for-each-ref", "refs/squeak-checkpoints/")).not.toBe("");
    expect(await ctx.host.pruneCheckpoints(ws.id)).toBe(2);
    expect(git(dir, "for-each-ref", "refs/squeak-checkpoints/")).toBe("");
    expect(ctx.store.getTurn(s.id, 1)).toMatchObject({ startCommit: null, endCommit: null });
  });
});

describe("fork", () => {
  it("Claude: forks at a turn through the last assistant uuid of that turn and copies the history", async () => {
    const ctx = setup();
    const s = ctx.store.createSession({
      cwd: "/w",
      agent: "claude",
      model: "m",
      permissionMode: "default",
      title: "Chat A",
    });
    ctx.store.setAgentSessionId(s.id, "agent-1");
    await turn(ctx, s.id, "one", () => {});
    await turn(ctx, s.id, "two", () => {});
    await turn(ctx, s.id, "three", () => {});
    const fork = await ctx.host.fork(s.id, 2);
    expect(ctx.forks).toEqual([{ id: "agent-1", point: { claudeMessageUuid: "u-2" } }]);
    expect(fork).toMatchObject({ title: "Chat A (fork)", agentSessionId: "forked-1", cwd: "/w", status: "idle" });
    const copied = ctx.store.messagesAfter(fork.id).filter((m) => m.kind === "user/text");
    expect(copied.map((m) => (m.payload as { text: string }).text)).toEqual(["one", "two"]);
    expect(ctx.store.listTurns(fork.id).map((t) => t.n)).toEqual([1, 2]);
    // the original is untouched
    expect(ctx.store.messagesAfter(s.id).filter((m) => m.kind === "user/text")).toHaveLength(3);
    // latest turn: whole conversation
    await ctx.host.fork(s.id);
    expect(ctx.forks[1]!.point).toEqual({});
    // turn 0: empty history, no agent fork
    const empty = await ctx.host.fork(s.id, 0);
    expect(ctx.forks).toHaveLength(2);
    expect(empty.agentSessionId).toBeNull();
    expect(ctx.store.messagesAfter(empty.id)).toEqual([]);
    await expect(ctx.host.fork(s.id, 7)).rejects.toMatchObject({ status: 404 });
  });

  it("Codex: forks through that turn's id", async () => {
    const ctx = setup("codex");
    const s = ctx.store.createSession({ cwd: "/w", agent: "codex", model: "m", permissionMode: "default" });
    ctx.store.setAgentSessionId(s.id, "thread-1");
    await turn(ctx, s.id, "one", () => {}, { codex: true });
    await turn(ctx, s.id, "two", () => {}, { codex: true });
    await ctx.host.fork(s.id, 1);
    expect(ctx.forks[0]).toEqual({ id: "thread-1", point: { codexTurnId: "ct-1" } });
  });

  it("refuses while working, and before the chat has run", async () => {
    const ctx = setup();
    const s = ctx.store.createSession({ cwd: "/w", agent: "claude", model: "m", permissionMode: "default" });
    await expect(ctx.host.fork(s.id)).rejects.toMatchObject({ status: 409 });
    ctx.store.setAgentSessionId(s.id, "a");
    await ctx.host.send(s.id, "go");
    await expect(ctx.host.fork(s.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("edit", () => {
  it("forks before the turn, sends the new text there, and can restore the turn's start files first", async () => {
    const dir = tempRepo();
    const ctx = setup();
    const s = ctx.store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
    ctx.store.setAgentSessionId(s.id, "agent-1");
    await turn(ctx, s.id, "one", () => fs.writeFileSync(path.join(dir, "a.txt"), "a-one\n"));
    await turn(ctx, s.id, "two", () => fs.writeFileSync(path.join(dir, "a.txt"), "a-two\n"));
    const { session, restored } = await ctx.host.edit(s.id, { turn: 2, text: "two, better", revertFiles: true });
    expect(restored).not.toBeNull();
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a-one\n");
    expect(ctx.forks[0]!.point).toEqual({ claudeMessageUuid: "u-1" });
    expect(ctx.sent.at(-1)).toEqual([session.id, "two, better"]);
    const texts = ctx.store.messagesAfter(session.id).filter((m) => m.kind === "user/text");
    expect(texts.map((m) => (m.payload as { text: string }).text)).toEqual(["one", "two, better"]);

    // editing the first message forks to an empty history
    const first = await ctx.host.edit(s.id, { turn: 1, text: "fresh start" });
    expect(first.restored).toBeNull();
    expect(ctx.store.getSession(first.session.id)!.agentSessionId).toBeNull();
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a-one\n");
    await expect(ctx.host.edit(s.id, { turn: 0, text: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(ctx.host.edit(s.id, { turn: 5, text: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("changes nothing when the fork cannot be planned", async () => {
    const dir = tempRepo();
    const ctx = setup();
    const s = ctx.store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default" });
    ctx.store.setAgentSessionId(s.id, "a");
    await turn(ctx, s.id, "one", () => fs.writeFileSync(path.join(dir, "a.txt"), "x\n"));
    // turn 2 never produced an assistant message: forking before turn 3 is impossible, and no files move
    await ctx.host.send(s.id, "two");
    ctx.hooks.at(-1)!.onTurnEnd("idle");
    await until(() => ctx.store.getSession(s.id)!.status === "idle");
    await turn(ctx, s.id, "three", () => {});
    fs.writeFileSync(path.join(dir, "a.txt"), "keep\n");
    await expect(ctx.host.edit(s.id, { turn: 3, text: "z", revertFiles: true })).rejects.toMatchObject({ status: 409 });
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("keep\n");
  });
});
