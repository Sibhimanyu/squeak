import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readFileTranscript } from "./file-transcript.js";
import { FleetReplyRouter } from "./reply-router.js";
import type { FleetSession } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function write(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ft-"));
  dirs.push(dir);
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

const at = (n: number): string => new Date(Date.UTC(2030, 0, 1, 0, 0, n)).toISOString();

function user(n: number, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: "user", uuid: `u${n}`, timestamp: at(n), cwd: "/tmp/a", message: { role: "user", content }, ...extra };
}
function assistant(n: number, id: string, blocks: unknown[], stop = "end_turn") {
  return {
    type: "assistant",
    uuid: `a${n}`,
    timestamp: at(n),
    cwd: "/tmp/b",
    message: { id, role: "assistant", stop_reason: stop, content: blocks },
  };
}

const fixture = [
  user(1, "plan the host controls"),
  assistant(2, "m1", [{ type: "thinking", thinking: "hmm" }], "tool_use"),
  assistant(3, "m1", [{ type: "text", text: "I will write a plan." }], "tool_use"),
  assistant(4, "m1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/x/plan.md" } }], "tool_use"),
  user(5, [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
  // The same block written again as it streamed: one message.
  assistant(6, "m2", [{ type: "text", text: "Plan written." }]),
  assistant(7, "m2", [{ type: "text", text: "Plan written." }]),
  user(8, "<task-notification><summary>worker done</summary></task-notification>"),
  user(9, "<command-name>/cd</command-name>"),
  user(10, "now do the youtube part", { isMeta: false }),
  user(11, "skill body", { isMeta: true }),
  assistant(12, "m3", [{ type: "text", text: "On it." }]),
];

describe("readFileTranscript (claude)", () => {
  it("returns the conversation oldest first without plumbing, with tool counts", () => {
    const result = readFileTranscript("claude", write(fixture), { limit: 40 });
    expect(result.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "plan the host controls"],
      ["assistant", "I will write a plan."],
      ["assistant", "Plan written."],
      ["user", "now do the youtube part"],
      ["assistant", "On it."],
    ]);
    expect(result.messages[2]!.workBefore).toBe(1);
    expect(result.complete).toBe(true);
    expect(result.nextBefore).toBeNull();
  });

  it("pages newest first by cursor and covers every message once", () => {
    const file = write(fixture);
    const newest = readFileTranscript("claude", file, { limit: 2 });
    expect(newest.messages.map((m) => m.text)).toEqual(["now do the youtube part", "On it."]);
    expect(newest.complete).toBe(false);
    const older = readFileTranscript("claude", file, { limit: 2, before: Number(newest.nextBefore) });
    expect(older.messages.map((m) => m.text)).toEqual(["I will write a plan.", "Plan written."]);
    const oldest = readFileTranscript("claude", file, { limit: 2, before: Number(older.nextBefore) });
    expect(oldest.messages.map((m) => m.text)).toEqual(["plan the host controls"]);
    expect(oldest.complete).toBe(true);
  });

  it("returns nothing for a missing file", () => {
    expect(readFileTranscript("claude", "/nonexistent/x.jsonl", { limit: 5 }).messages).toEqual([]);
  });

  it("pages a transcript bigger than the first window", () => {
    const filler = "x".repeat(2000);
    const lines: unknown[] = [];
    for (let i = 0; i < 1500; i += 1) {
      lines.push(user(i, `q${i} ${filler}`));
    }
    const file = write(lines);
    const first = readFileTranscript("claude", file, { limit: 40 });
    expect(first.messages).toHaveLength(40);
    expect(first.messages.at(-1)!.text.startsWith("q1499")).toBe(true);
    const second = readFileTranscript("claude", file, { limit: 40, before: Number(first.nextBefore) });
    expect(second.messages.at(-1)!.text.startsWith("q1459")).toBe(true);
  });
});

describe("readFileTranscript (codex)", () => {
  it("keeps real turns and skips injected context", () => {
    const item = (n: number, payload: unknown) => ({ type: "response_item", timestamp: at(n), payload });
    const file = write([
      { type: "session_meta", payload: { id: "x" } },
      item(1, { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] }),
      item(2, { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] }),
      item(3, { type: "function_call", name: "exec" }),
      item(4, { type: "message", role: "assistant", content: [{ type: "output_text", text: "fixed" }] }),
    ]);
    const result = readFileTranscript("codex", file, { limit: 40 });
    expect(result.messages.map((m) => m.text)).toEqual(["fix it", "fixed"]);
    expect(result.messages[1]!.workBefore).toBe(1);
  });
});

describe("FleetReplyRouter.transcript for a watched session", () => {
  it("reads the session's transcript file by fleet key", () => {
    const file = write(fixture);
    const session = { key: "claude-transcript:358b", agent: "claude", transcriptPath: file } as unknown as FleetSession;
    const router = new FleetReplyRouter({
      hosts: () => [],
      sessions: () => [session],
    });
    expect(router.transcript("claude-transcript:358b", 40).messages).toHaveLength(5);
    expect(router.transcript("claude-transcript:other", 40).messages).toEqual([]);
  });
});
