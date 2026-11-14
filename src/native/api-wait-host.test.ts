import { describe, expect, it } from "vitest";

import { SessionHost, agentProgressed } from "./host.js";
import { patchSettings } from "./project-settings.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";

class FakeRunner implements Runner {
  sent: string[] = [];
  readonly canSteer = false;
  constructor(readonly hooks: RunnerHooks) {}
  async send(text: string) {
    this.sent.push(text);
    this.hooks.onStatus("working");
  }
  async steer() {
    return false;
  }
  async interrupt() {}
  async setPermissionMode() {}
  async setModel() {}
  async close() {}
}

function setup(summary: () => Promise<string> = async () => "SUMMARY of the old chat") {
  const store = new NativeStore(":memory:");
  const runners: FakeRunner[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, hooks) => {
      const r = new FakeRunner(hooks);
      runners.push(r);
      return r;
    },
    summaryCall: summary,
  });
  return { store, host, runners };
}

const spec = { cwd: "/w", agent: "claude" as const, model: "claude-opus-5[1m]", permissionMode: "default" };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function failedTurn(detail: string) {
  const ctx = setup();
  const s = await ctx.host.create({ ...spec, text: "please do the thing" });
  ctx.runners[0]!.hooks.onTurnEnd("error", detail);
  await tick(20);
  return { ...ctx, s };
}

describe("failure card", () => {
  it("a dropped connection becomes a plain, retryable card keeping the agent's words", async () => {
    const { store, s } = await failedTurn("API Error: Connection dropped (ECONNRESET). Check the proxy");
    const row = store.messagesBefore(s.id, null, 50).find((m) => m.kind === "system/error")!;
    expect(row.payload).toMatchObject({
      text: expect.stringMatching(/^Couldn't reach Claude — connection dropped after \d+s$/),
      failure: "dropped",
      retryable: true,
      detail: expect.stringContaining("ECONNRESET"),
    });
  });

  it("an ordinary error stays as it was, with no Try again", async () => {
    const { store, s } = await failedTurn("Not logged in · Please run /login");
    const row = store.messagesBefore(s.id, null, 50).find((m) => m.kind === "system/error")!;
    expect(row.payload).toEqual({ text: "Not logged in · Please run /login" });
  });
});

describe("Try again", () => {
  it("resends the last message when the agent got nowhere", async () => {
    const { host, runners, s, store } = await failedTurn("socket hang up");
    const out = await host.retry(s.id);
    expect(out).toEqual({ resent: true });
    expect(runners[0]!.sent.at(-1)).toBe("please do the thing");
    expect(store.getSession(s.id)!.status).toBe("working");
  });

  it("does not resend when the agent already replied (the request did go through)", async () => {
    const { host, runners, s, store } = await failedTurn("socket hang up");
    store.appendMessage(s.id, "agent", "assistant", {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    const out = await host.retry(s.id);
    expect(out.resent).toBe(false);
    expect(runners[0]!.sent).toHaveLength(1);
  });

  it("an API-error assistant row is not progress", () => {
    expect(
      agentProgressed({
        kind: "assistant",
        payload: { isApiErrorMessage: true, message: { content: [{ type: "text", text: "API Error" }] } },
      }),
    ).toBe(false);
  });
});

describe("handoff", () => {
  it("drafts the summary with the cheap model and falls back to the person's words when it fails", async () => {
    const a = setup();
    const s = await a.host.create({ ...spec, text: "build the thing" });
    expect(await a.host.handoffDraft(s.id)).toMatchObject({ summary: "SUMMARY of the old chat", auto: true });
    const b = setup(async () => {
      throw new Error("no model");
    });
    const t = await b.host.create({ ...spec, text: "build the thing" });
    const draft = await b.host.handoffDraft(t.id);
    expect(draft.auto).toBe(false);
    expect(draft.summary).toContain("build the thing");
  });

  it("creates a linked thread in the same workspace and model whose first message is the summary", async () => {
    const { host, store, runners } = setup();
    const old = await host.create({ ...spec, text: "start" });
    runners[0]!.hooks.onTurnEnd("idle");
    await tick(20);
    const next = await host.handoff(old.id, "Edited summary");
    expect(next.id).not.toBe(old.id);
    expect(next).toMatchObject({ cwd: "/w", model: spec.model, agent: "claude", workspaceId: old.workspaceId });
    expect(runners[1]!.sent).toEqual(["Edited summary"]);
    const fromNote = store.messagesBefore(next.id, null, 20).find((m) => m.kind === "system/note")!;
    expect(fromNote.payload).toMatchObject({ linkedSessionId: old.id, link: "from" });
    const toNote = store.messagesBefore(old.id, null, 20).find((m) => m.kind === "system/note")!;
    expect(toNote.payload).toMatchObject({ linkedSessionId: next.id, link: "to" });
  });

  it("refuses an empty summary and a working chat", async () => {
    const { host } = setup();
    const s = await host.create({ ...spec, text: "start" });
    await expect(host.handoff(s.id, "  ")).rejects.toThrow();
    await expect(host.handoff(s.id, "text")).rejects.toThrow(/working/);
  });
});

describe("auto-compaction in the host", () => {
  async function big(used: number) {
    const ctx = setup();
    const s = await ctx.host.create({ ...spec, text: "go" });
    // a stored reply whose usage puts the context at `used`
    ctx.runners[0]!.hooks.onMessage("agent", "assistant", {
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: used, output_tokens: 10 } },
    });
    ctx.runners[0]!.hooks.onTurnEnd("idle");
    await tick(30);
    return { ...ctx, s };
  }

  it("compacts an idle chat past 200k by default, with the image-dropping instruction", async () => {
    const { runners } = await big(660_000);
    expect(runners[0]!.sent.at(-1)).toMatch(/^\/compact .*screenshots/);
  });

  it("leaves a chat under the point alone", async () => {
    const { runners } = await big(150_000);
    expect(runners[0]!.sent).toEqual(["go"]);
  });

  it("the very large chat carries a large flag for the Mac's notice", async () => {
    const { host, s, store } = await big(660_000);
    const row = host.list().find((x) => x.id === s.id)!;
    expect(row.large).toMatchObject({ reason: "context" });
    void store;
  });
});

describe("project setting", () => {
  it("autoCompactTokens defaults to null (200k), accepts 0 (off) and a value, rejects junk", () => {
    const store = new NativeStore(":memory:");
    const p = store.createProject({ name: "p", rootPath: "/w", defaultBranch: "main" });
    const cur = store.getProjectSettings(p.id);
    expect(cur.autoCompactTokens).toBeNull();
    expect(patchSettings(cur, { autoCompactTokens: 0 }).autoCompactTokens).toBe(0);
    expect(patchSettings(cur, { autoCompactTokens: 300_000 }).autoCompactTokens).toBe(300_000);
    expect(patchSettings(cur, { autoCompactTokens: null }).autoCompactTokens).toBeNull();
    expect(() => patchSettings(cur, { autoCompactTokens: 5 })).toThrow();
    store.saveProjectSettings(patchSettings(cur, { autoCompactTokens: 300_000 }));
    expect(store.getProjectSettings(p.id).autoCompactTokens).toBe(300_000);
  });

  it("off in the project means the host never compacts that chat, however large", async () => {
    const ctx = setup();
    const p = ctx.store.createProject({ name: "p", rootPath: "/w", defaultBranch: "main" });
    ctx.store.saveProjectSettings(patchSettings(ctx.store.getProjectSettings(p.id), { autoCompactTokens: 0 }));
    const s = await ctx.host.create({ ...spec, text: "go" });
    ctx.runners[0]!.hooks.onMessage("agent", "assistant", {
      type: "assistant",
      message: { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 700_000, output_tokens: 10 } },
    });
    ctx.runners[0]!.hooks.onTurnEnd("idle");
    await tick(30);
    expect(ctx.host.compactThreshold(ctx.store.getSession(s.id)!)).toBeNull();
    expect(ctx.runners[0]!.sent).toEqual(["go"]);
  });
});
