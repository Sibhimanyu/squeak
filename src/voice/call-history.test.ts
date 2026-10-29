import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CallHistory, MAX_CALLS } from "./call-history.js";

const dirs: string[] = [];
function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calls-"));
  dirs.push(dir);
  return path.join(dir, "voice-calls.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("CallHistory", () => {
  it("lists newest first, whatever order they were written", () => {
    const history = new CallHistory(file());
    history.record({ at: 100, kind: "agent", label: "a", outcome: "unanswered", durationMs: 1 });
    history.record({ at: 300, kind: "test", outcome: "answered", letter: "B", durationMs: 2 });
    history.record({ at: 200, kind: "agent", outcome: "failed", failure: "no route", durationMs: 0 });
    expect(history.list().map((c) => c.at)).toEqual([300, 200, 100]);
    expect(history.list(2)).toHaveLength(2);
    expect(new Set(history.list().map((c) => c.id)).size).toBe(3);
  });

  it("keeps the newest 200", () => {
    const history = new CallHistory(file());
    for (let i = 0; i < MAX_CALLS + 20; i++)
      history.record({ at: i, kind: "test", outcome: "unanswered", durationMs: 0 });
    const all = new CallHistory(history["file" as never] as string).list(1000);
    expect(all).toHaveLength(MAX_CALLS);
    expect(all[0]!.at).toBe(MAX_CALLS + 19);
    expect(all.at(-1)!.at).toBe(20);
    expect(history.list()).toHaveLength(100);
  });

  it("reloads after a restart and writes mode 0600", () => {
    const f = file();
    new CallHistory(f).record({
      at: 5,
      kind: "agent",
      label: "x".repeat(200),
      outcome: "moved_on",
      letter: "A",
      sent: false,
      durationMs: 9,
    });
    const reloaded = new CallHistory(f).list();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ outcome: "moved_on", letter: "A", sent: false, durationMs: 9 });
    expect(reloaded[0]!.label).toHaveLength(80);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("tolerates a corrupt file and carries on", () => {
    const f = file();
    fs.writeFileSync(f, "{not json");
    const history = new CallHistory(f);
    expect(history.list()).toEqual([]);
    history.record({ at: 1, kind: "test", outcome: "answered", durationMs: 0 });
    expect(new CallHistory(f).list()).toHaveLength(1);
  });

  it("drops invalid entries and never keeps a digit as the letter", () => {
    const f = file();
    const history = new CallHistory(f);
    expect(history.record({ at: 1, kind: "test", outcome: "bogus" as never, durationMs: 0 })).toBeNull();
    const entry = history.record({ at: 2, kind: "test", outcome: "answered", letter: "1234" as never, durationMs: 0 });
    expect(entry?.letter).toBeUndefined();
    expect(fs.readFileSync(f, "utf8")).not.toContain("1234");
  });
});
