import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { session } from "./fixtures.js";
import {
  CALLBACK_START_MS,
  CALLBACK_TTL_MS,
  CallbackRequests,
  judgeCallback,
  MAX_CALLBACKS,
  type CallbackRequest,
} from "./callbacks.js";

const file = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "squeak-callbacks-")), "cb.json");
const request = (overrides: Partial<CallbackRequest> = {}): CallbackRequest => ({
  id: "r1",
  target: "c1",
  label: "squeak",
  note: "",
  at: 1_000_000,
  seenWorking: true,
  ...overrides,
});

describe("CallbackRequests", () => {
  it("keeps one request per chat, clips and cleans the note, and survives a restart", () => {
    const path = file();
    const store = new CallbackRequests(path, () => 5);
    store.add("c1", "squeak", "first", true);
    const second = store.add("c1", "squeak", "  the\u0000 tests\n\n and docs  ", true)!;
    expect(store.list()).toHaveLength(1);
    expect(second.note).toBe("the tests and docs");
    expect(store.add("c2", "other", "x".repeat(500), false)!.note).toHaveLength(120);
    const again = new CallbackRequests(path);
    expect(again.list().map((r) => r.target)).toEqual(["c1", "c2"]);
    expect(again.has("c2")).toBe(true);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });

  it("marks a chat as seen working, and removes a request", () => {
    const store = new CallbackRequests(file());
    const added = store.add("c1", "squeak", "", false)!;
    expect(store.list()[0]!.seenWorking).toBe(false);
    store.markWorking(added.id);
    expect(store.list()[0]!.seenWorking).toBe(true);
    store.remove(added.id);
    expect(store.list()).toEqual([]);
  });

  it("refuses more than the limit, and ignores a damaged file", () => {
    const store = new CallbackRequests(file());
    for (let i = 0; i < MAX_CALLBACKS; i++) expect(store.add(`c${i}`, "x", "", true)).not.toBeNull();
    expect(store.add("extra", "x", "", true)).toBeNull();
    const bad = file();
    fs.writeFileSync(bad, "not json");
    expect(new CallbackRequests(bad).list()).toEqual([]);
  });
});

describe("judgeCallback", () => {
  const at = 1_000_000;
  it("waits while the chat works, and fires when it stops after having worked", () => {
    expect(judgeCallback(request(), session({ state: "working" }), at + 1)).toBe("wait");
    for (const state of ["finished", "idle", "error"] as const) {
      expect(judgeCallback(request(), session({ state }), at + 1)).toBe("fire");
    }
  });

  it("does not fire for a chat that never started (a message sent but not yet picked up)", () => {
    const fresh = request({ seenWorking: false });
    expect(judgeCallback(fresh, session({ state: "finished" }), at + 1_000)).toBe("wait");
    expect(judgeCallback(fresh, session({ state: "finished" }), at + CALLBACK_START_MS + 1)).toBe("drop");
  });

  it("drops a request whose chat is gone or that is too old", () => {
    expect(judgeCallback(request(), null, at + 1)).toBe("drop");
    expect(judgeCallback(request(), session({ state: "finished" }), at + CALLBACK_TTL_MS + 1)).toBe("drop");
  });
});
