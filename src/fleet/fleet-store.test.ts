import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FleetStore } from "./fleet-store.js";

const stores: FleetStore[] = [];
const dirs: string[] = [];

function makeStore(): FleetStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-store-"));
  dirs.push(dir);
  const store = new FleetStore(path.join(dir, "bridge.db"));
  store.init();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("recordState", () => {
  it("keeps the original entry time while a session stays in one state", () => {
    const store = makeStore();

    const first = store.recordState({
      sessionKey: "k",
      state: "awaiting_approval",
      lastActivityAt: "2026-09-20T12:00:00.000Z",
      observedAt: "2026-09-20T12:00:01.000Z",
    });
    const second = store.recordState({
      sessionKey: "k",
      state: "awaiting_approval",
      lastActivityAt: "2026-09-20T12:00:00.000Z",
      observedAt: "2026-09-20T12:05:00.000Z",
    });

    expect(second.changed).toBe(false);
    // Without this, "waiting 5m" would reset to "just now" on every poll.
    expect(second.stateEnteredAt).toBe(first.stateEnteredAt);
  });

  it("resets the entry time when the state changes", () => {
    const store = makeStore();
    store.recordState({
      sessionKey: "k",
      state: "working",
      lastActivityAt: "2026-09-20T12:00:00.000Z",
      observedAt: "2026-09-20T12:00:00.000Z",
    });
    const changed = store.recordState({
      sessionKey: "k",
      state: "finished",
      lastActivityAt: "2026-09-20T12:05:00.000Z",
      observedAt: "2026-09-20T12:05:00.000Z",
    });

    expect(changed.changed).toBe(true);
    expect(changed.stateEnteredAt).toBe("2026-09-20T12:05:00.000Z");
  });

  it("forgets a review once the session moves on", () => {
    const store = makeStore();
    store.recordState({
      sessionKey: "k",
      state: "finished",
      lastActivityAt: "2026-09-20T12:00:00.000Z",
      observedAt: "2026-09-20T12:00:00.000Z",
    });
    store.markReviewed("k", "2026-09-20T12:01:00.000Z");
    store.recordState({
      sessionKey: "k",
      state: "working",
      lastActivityAt: "2026-09-20T12:02:00.000Z",
      observedAt: "2026-09-20T12:02:00.000Z",
    });

    // A session you reviewed and then poked again is unreviewed once more.
    expect(store.getReview("k")).toBeNull();
  });
});

describe("claimNotification", () => {
  it("fires once per entry into a state", () => {
    const store = makeStore();

    const first = store.claimNotification({
      sessionKey: "k",
      kind: "blocked_approval",
      stateEnteredAt: "2026-09-20T12:00:00.000Z",
      notifiedAt: "2026-09-20T12:00:01.000Z",
    });
    const repeat = store.claimNotification({
      sessionKey: "k",
      kind: "blocked_approval",
      stateEnteredAt: "2026-09-20T12:00:00.000Z",
      notifiedAt: "2026-09-20T12:00:30.000Z",
    });

    expect(first).toBe(true);
    expect(repeat).toBe(false);
  });

  it("fires again when the session re-enters the state", () => {
    const store = makeStore();
    store.claimNotification({
      sessionKey: "k",
      kind: "blocked_approval",
      stateEnteredAt: "2026-09-20T12:00:00.000Z",
      notifiedAt: "2026-09-20T12:00:01.000Z",
    });

    expect(
      store.claimNotification({
        sessionKey: "k",
        kind: "blocked_approval",
        stateEnteredAt: "2026-09-20T12:30:00.000Z",
        notifiedAt: "2026-09-20T12:30:01.000Z",
      }),
    ).toBe(true);
  });
});

describe("handles", () => {
  it("gives a session a short stable alias that fits in callback data", () => {
    const store = makeStore();
    const key = "claude-transcript:e92089c1-5db6-4404-8a36-3909d139a033";

    const handle = store.handleFor(key);

    expect(store.handleFor(key)).toBe(handle);
    expect(store.keyForHandle(handle)).toBe(key);
    expect(`fleet:snooze:${handle}`.length).toBeLessThanOrEqual(64);
  });
});

describe("prune", () => {
  it("drops sessions that have aged out and keeps the ones still observed", () => {
    const store = makeStore();
    store.recordState({
      sessionKey: "old",
      state: "idle",
      lastActivityAt: "2026-09-18T12:00:00.000Z",
      observedAt: "2026-09-18T12:00:00.000Z",
    });
    store.recordState({
      sessionKey: "fresh",
      state: "idle",
      lastActivityAt: "2026-09-20T12:00:00.000Z",
      observedAt: "2026-09-20T12:00:00.000Z",
    });

    const removed = store.pruneSnapshots(new Set(["fresh"]), "2026-09-19T12:00:00.000Z");

    expect(removed).toBe(1);
    expect(store.getSnapshot("old")).toBeNull();
    expect(store.getSnapshot("fresh")).not.toBeNull();
  });
});

describe("mute", () => {
  it("expires", () => {
    const store = makeStore();
    store.setMute("*", "2026-09-20T13:00:00.000Z");

    expect(store.isMuted("*", "2026-09-20T12:30:00.000Z")).toBe(true);
    expect(store.isMuted("*", "2026-09-20T13:30:00.000Z")).toBe(false);
  });

  it("is scoped per repo", () => {
    const store = makeStore();
    store.setMute("noisy-repo", null);

    expect(store.isMuted("noisy-repo", "2026-09-20T12:00:00.000Z")).toBe(true);
    expect(store.isMuted("other-repo", "2026-09-20T12:00:00.000Z")).toBe(false);
  });
});

describe("radar anchors", () => {
  it("stores one anchor per conversation, replacing the previous message", () => {
    const store = makeStore();
    store.setRadarAnchor(123, null, 10);
    store.setRadarAnchor(123, null, 11);
    store.setRadarAnchor(123, 7, 12);

    expect(store.getRadarAnchor(123, null)?.messageId).toBe(11);
    expect(store.getRadarAnchor(123, 7)?.messageId).toBe(12);
    expect(store.listRadarAnchors()).toHaveLength(2);

    store.clearRadarAnchor(123, null);
    expect(store.listRadarAnchors()).toHaveLength(1);
  });
});
