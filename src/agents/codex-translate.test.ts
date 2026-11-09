import { describe, expect, it } from "vitest";
import { asSessionId } from "../core/types.js";
import { CodexEventTranslator } from "./codex-translate.js";

const mk = () => new CodexEventTranslator(asSessionId("c1"), () => "2026-11-09T10:00:00.000Z");
// Item shapes follow src/native/codex-runner.test.ts.
const done = (item: Record<string, unknown>) => ({ method: "item/completed", params: { item } });

describe("CodexEventTranslator", () => {
  it("agent message and reasoning", () => {
    const t = mk();
    expect(t.translate(done({ type: "agentMessage", id: "a", text: "hi" }))[0]).toMatchObject({
      type: "agentMessage",
      text: "hi",
    });
    expect(t.translate(done({ type: "reasoning", id: "r" }))[0]).toMatchObject({ type: "thinking" });
    expect(t.translate(done({ type: "userMessage", id: "u" }))).toEqual([]);
  });

  it("a command becomes started, output, completed with shell category and failure state", () => {
    const evs = mk().translate(
      done({ type: "commandExecution", id: "x", command: "npm test", aggregatedOutput: "ok", exitCode: 1 }),
    );
    expect(evs.map((e) => e.type)).toEqual(["toolStarted", "toolOutput", "toolCompleted"]);
    const last = evs[2]!;
    expect(last.type === "toolCompleted" && last.tool).toMatchObject({
      category: "shell",
      state: "failed",
      detail: "npm test",
    });
  });

  it("a patch maps to generic file activity", () => {
    const evs = mk().translate(
      done({ type: "fileChange", id: "f", changes: [{ path: "a.txt" }, { path: "b.txt", kind: { type: "add" } }] }),
    );
    expect(evs.map((e) => e.type)).toEqual(["toolStarted", "fileEdited", "fileCreated", "toolCompleted"]);
    expect(evs[3]!.type === "toolCompleted" && evs[3]!.tool.category).toBe("fileWrite");
  });

  it("started then completed share ids, so replays are deduplicable", () => {
    const t = mk();
    const s = t.translate({
      method: "item/started",
      params: { item: { type: "fileChange", id: "f", changes: [{ path: "a" }] } },
    });
    const c = t.translate(done({ type: "fileChange", id: "f", changes: [{ path: "a" }] }));
    expect(s[0]!.id).toBe(c[0]!.id);
  });

  it("output deltas are numbered per item", () => {
    const t = mk();
    const n = { method: "item/commandExecution/outputDelta", params: { itemId: "x", delta: "\n" } };
    const [a, b] = [t.translate(n)[0]!, t.translate(n)[0]!];
    expect(a.id).not.toBe(b.id);
  });

  it("turn completion", () => {
    const turn = (status: string) =>
      mk().translate({ method: "turn/completed", params: { turn: { id: "t", status } } })[0]!;
    expect(turn("completed").type).toBe("completed");
    expect(turn("interrupted").type).toBe("sessionStopped");
    expect(turn("failed")).toMatchObject({ type: "failed", message: "failed" });
  });

  it("approvals", () => {
    const t = mk();
    const cmd = t.approval("item/commandExecution/requestApproval", {
      itemId: "i",
      command: "touch x",
      availableDecisions: ["accept", "acceptForSession"],
    })!;
    expect(cmd.type === "permissionRequested" && cmd.request).toMatchObject({
      category: "shell",
      command: "touch x",
      availableActions: ["allowOnce", "allowSession", "deny"],
    });
    const fc = t.approval("item/fileChange/requestApproval", { itemId: "f" }, { changes: [{ path: "a.txt" }] })!;
    expect(fc.type === "permissionRequested" && fc.request).toMatchObject({
      category: "fileWrite",
      files: ["a.txt"],
      availableActions: ["allowOnce", "deny"],
    });
    expect(t.approval("item/tool/call", {})).toBeUndefined();
  });

  it("is resilient to junk", () => {
    const t = mk();
    for (const params of [
      {},
      { item: null },
      { item: { type: "commandExecution" } },
      { item: { type: "mystery", id: "z" } },
      { turn: 5 },
    ]) {
      for (const method of ["item/started", "item/completed", "item/agentMessage/delta", "unknown"]) {
        expect(() => t.translate({ method, params })).not.toThrow();
      }
    }
  });
});
