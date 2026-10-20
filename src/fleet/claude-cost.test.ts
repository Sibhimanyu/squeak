import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeCostReader } from "./claude-cost.js";

const temporaryFiles: string[] = [];

function makeTranscript(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cost-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  temporaryFiles.push(file);
  return file;
}

function assistantEntry(id: string, model: string, usage: Record<string, unknown>): unknown {
  return { type: "assistant", isSidechain: false, message: { id, model, usage } };
}

afterEach(() => {
  while (temporaryFiles.length > 0) {
    fs.rmSync(path.dirname(temporaryFiles.pop() as string), { recursive: true, force: true });
  }
});

describe("ClaudeCostReader", () => {
  it("passes through an authoritative figure untouched, without reading the file", () => {
    const reader = new ClaudeCostReader();
    // A path that does not exist: if this were read, the call would throw.
    expect(reader.read("/does/not/exist.jsonl", 42.5)).toBe(42.5);
  });

  it("sums real per-message usage into a dollar estimate", () => {
    const file = makeTranscript([
      assistantEntry("msg_1", "claude-opus-5", { input_tokens: 1000, output_tokens: 500 }),
      assistantEntry("msg_2", "claude-opus-5", { input_tokens: 1000, output_tokens: 500 }),
    ]);

    const cost = new ClaudeCostReader().read(file, null);

    // 2000 input @ $5/MTok + 1000 output @ $25/MTok
    expect(cost).toBeCloseTo((2000 * 5 + 1000 * 25) / 1_000_000, 6);
  });

  it("counts a repeated message id once, keeping the last occurrence", () => {
    // Claude Code writes the same assistant message more than once as it is
    // finalised during streaming. Summing every occurrence doubled a real
    // session's cost against Anthropic's own authoritative figure.
    const file = makeTranscript([
      assistantEntry("msg_1", "claude-opus-5", { input_tokens: 100, output_tokens: 50 }),
      assistantEntry("msg_1", "claude-opus-5", { input_tokens: 100, output_tokens: 50 }),
      assistantEntry("msg_1", "claude-opus-5", { input_tokens: 100, output_tokens: 50 }),
    ]);

    const cost = new ClaudeCostReader().read(file, null);

    expect(cost).toBeCloseTo((100 * 5 + 50 * 25) / 1_000_000, 6);
  });

  it("skips subagent messages", () => {
    const file = makeTranscript([
      {
        type: "assistant",
        isSidechain: true,
        message: { id: "sub_1", model: "claude-opus-5", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
      },
    ]);

    expect(new ClaudeCostReader().read(file, null)).toBeNull();
  });

  it("returns null rather than reporting zero when every message is unpriced", () => {
    const file = makeTranscript([assistantEntry("msg_1", "some-future-model", { input_tokens: 1000 })]);

    // A silent 0 would read as "this session was free", which is worse than
    // admitting the estimate could not be made.
    expect(new ClaudeCostReader().read(file, null)).toBeNull();
  });

  it("returns null for a file over the size cap rather than a partial sum", () => {
    const file = makeTranscript([
      assistantEntry("msg_1", "claude-opus-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ]);

    const reader = new ClaudeCostReader({ maxFileBytes: 10 });

    expect(reader.read(file, null)).toBeNull();
  });

  it("caches by mtime, so an idle session is not re-parsed every poll", () => {
    const file = makeTranscript([assistantEntry("msg_1", "claude-opus-5", { input_tokens: 1000, output_tokens: 0 })]);
    const reader = new ClaudeCostReader({ ttlMs: 60_000 });
    const first = reader.read(file, null);

    // A real idle session's mtime does not move between polls; assert the
    // file is not touched a second time rather than fighting the
    // filesystem's mtime precision (whole seconds on some volumes) to fake
    // a content change under an unchanged mtime.
    const readSpy = vi.spyOn(fs, "readFileSync");
    const second = reader.read(file, null);

    expect(second).toBe(first);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("re-reads once the file's content actually changes", () => {
    const file = makeTranscript([assistantEntry("msg_1", "claude-opus-5", { input_tokens: 1000, output_tokens: 0 })]);
    const reader = new ClaudeCostReader({ ttlMs: 60_000 });
    const first = reader.read(file, null);

    const future = new Date(Date.now() + 5000);
    fs.appendFileSync(
      file,
      `\n${JSON.stringify(assistantEntry("msg_2", "claude-opus-5", { input_tokens: 1000, output_tokens: 0 }))}`,
    );
    fs.utimesSync(file, future, future);

    expect(reader.read(file, null)).toBeCloseTo((first ?? 0) * 2, 6);
  });

  it("returns null rather than throwing for a file that does not exist", () => {
    expect(new ClaudeCostReader().read("/definitely/not/a/real/path.jsonl", null)).toBeNull();
  });
});
