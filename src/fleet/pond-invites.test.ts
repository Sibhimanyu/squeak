import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeHostError } from "../native/client.js";
import {
  channelFilter,
  defaultNotifySettings,
  NotifySettingsStore,
  readNotifyChange,
  shouldPushInviteTo,
} from "./notify-settings.js";
import {
  PondInviteNotifier,
  renderDecisionCard,
  renderJoinCard,
  type InviteSink,
  type JoinBrief,
  type PondBrief,
  type PondInvitePort,
} from "./pond-invites.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-invites-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const join = (over: Partial<JoinBrief> = {}): JoinBrief => ({
  requestId: "r1",
  name: "Ada",
  nest: "ada-mac",
  role: "member",
  ...over,
});

function setup(opts: { ponds?: PondBrief[]; joins?: JoinBrief[]; allowed?: boolean } = {}) {
  const state = {
    ponds: opts.ponds ?? [{ id: "p1", name: "Blume", role: "owner", status: "active" }],
    joins: opts.joins ?? [join()],
    allowed: opts.allowed ?? true,
  };
  const decide = vi.fn<PondInvitePort["decideJoin"]>(async () => undefined);
  const port: PondInvitePort = {
    listPonds: async () => state.ponds,
    pendingJoins: async () => state.joins,
    decideJoin: decide,
  };
  const pushed: Array<{ text: string; buttons: Array<{ label: string; handle: number; action: string }> }> = [];
  const sink: InviteSink = {
    channel: "telegram",
    allowed: () => state.allowed,
    push: async (card) => void pushed.push(card),
  };
  const make = () => new PondInviteNotifier({ port, sinks: [sink], file: path.join(dir, "pond-invites.json") });
  return { state, decide, pushed, make };
}

describe("owner card", () => {
  it("says who asked to join which pond in two short lines", () => {
    const text = renderJoinCard(join({ client: "web", verifiedEmail: "ada@x.com" }), "Blume");
    expect(text).toBe("**Ada** asked to join **Blume**\nAs a member, from a web link, ada@x.com");
    expect(text.split("\n").length).toBeLessThanOrEqual(3);
    expect(renderJoinCard(join(), "Blume")).toContain("a Mac, ada-mac");
  });

  it("is sent once per request, even across polls and a restart", async () => {
    const t = setup();
    const n = t.make();
    await n.pollOnce();
    await n.pollOnce();
    await t.make().pollOnce();
    expect(t.pushed).toHaveLength(1);
    expect(t.pushed[0]!.text).toContain("asked to join");
    expect(t.pushed[0]!.buttons.map((b) => b.label)).toEqual(["Approve", "Decline"]);
    // A new request is a new card.
    t.state.joins = [join(), join({ requestId: "r2", name: "Bo" })];
    await n.pollOnce();
    expect(t.pushed).toHaveLength(2);
  });

  it("only watches published ponds this Mac owns", async () => {
    const t = setup({
      ponds: [
        { id: "a", name: "Local", role: "owner", status: "active", local: true },
        { id: "b", name: "Theirs", role: "member", status: "active" },
      ],
    });
    await t.make().pollOnce();
    expect(t.pushed).toHaveLength(0);
  });

  it("button data is a short persisted handle, never an id", async () => {
    const t = setup();
    await t.make().pollOnce();
    for (const b of t.pushed[0]!.buttons) {
      expect(`fleet:pond:a:${b.handle}`.length).toBeLessThan(64);
      expect(Number.isInteger(b.handle)).toBe(true);
    }
  });
});

describe("buttons run the host's decideJoin", () => {
  it("approve and decline reach decideJoin with the pond and request, also after a restart", async () => {
    const t = setup();
    await t.make().pollOnce();
    const handle = t.pushed[0]!.buttons[0]!.handle;
    const after = t.make();
    expect(await after.decide(handle, true)).toBe("Ada joined Blume.");
    expect(t.decide).toHaveBeenLastCalledWith("p1", "r1", true);
    expect(await after.decide(handle, false)).toBe("Declined Ada for Blume.");
    expect(t.decide).toHaveBeenLastCalledWith("p1", "r1", false);
  });

  it("surfaces the host's refusals as fixed sentences and invents nothing for an unknown handle", async () => {
    const t = setup();
    const n = t.make();
    await n.pollOnce();
    const handle = t.pushed[0]!.buttons[0]!.handle;
    t.decide.mockRejectedValueOnce(new NativeHostError("No such join request.", "http", 404));
    expect(await n.decide(handle, true)).toBe("That request is no longer waiting.");
    t.decide.mockRejectedValueOnce(new NativeHostError("Only an owner can decide a join.", "http", 403));
    expect(await n.decide(handle, true)).toBe("Only an owner of the pond can decide that.");
    t.decide.mockRejectedValueOnce(new NativeHostError("down", "down"));
    expect(await n.decide(handle, true)).toContain("could not reach");
    t.decide.mockClear();
    expect(await n.decide(999, true)).toBe("That request is no longer waiting.");
    expect(t.decide).not.toHaveBeenCalled();
  });
});

describe("requester card", () => {
  it("tells a member Mac when it is approved or declined, once", async () => {
    const t = setup({ ponds: [{ id: "p9", name: "Reef", role: "member", status: "pending" }], joins: [] });
    const n = t.make();
    await n.pollOnce();
    expect(t.pushed).toHaveLength(0);
    t.state.ponds = [{ id: "p9", name: "Reef", role: "member", status: "active" }];
    await n.pollOnce();
    await n.pollOnce();
    expect(t.pushed.map((p) => p.text)).toEqual([renderDecisionCard("Reef", true)]);
    expect(t.pushed[0]!.buttons).toEqual([]);

    t.state.ponds = [{ id: "p8", name: "Kelp", role: "member", status: "pending" }];
    await n.pollOnce();
    t.state.ponds = [];
    await n.pollOnce();
    expect(t.pushed[1]!.text).toBe(renderDecisionCard("Kelp", false));
    expect(t.pushed[1]!.text).toContain("declined");
  });
});

describe("the invites setting", () => {
  it("off suppresses the card for that channel", async () => {
    const t = setup({ allowed: false });
    await t.make().pollOnce();
    expect(t.pushed).toHaveLength(0);
  });

  it("is on by default, strict, and carried by the store", () => {
    const settings = defaultNotifySettings();
    expect(settings.telegram.invites).toBe(true);
    expect(readNotifyChange({ invites: false })).toEqual({ invites: false });
    expect(readNotifyChange({ invites: "no" })).toBeNull();
    const store = new NotifySettingsStore(path.join(dir, "notify-settings.json"));
    expect(store.apply({ channel: "cliq", change: { invites: false } }).ok).toBe(true);
    expect(shouldPushInviteTo("cliq", store.settings)).toBe(false);
    expect(shouldPushInviteTo("telegram", store.settings)).toBe(true);
    const reloaded = new NotifySettingsStore(path.join(dir, "notify-settings.json"));
    expect(reloaded.settings.cliq.invites).toBe(false);
    expect(channelFilter(reloaded, "cliq").invite!()).toBe(false);
    expect(channelFilter(reloaded, "telegram").invite!()).toBe(true);
  });

  it("a mute holds it back, quiet hours never do", () => {
    const settings = defaultNotifySettings();
    settings.telegram.quiet = { from: "00:00", to: "23:59" };
    expect(shouldPushInviteTo("telegram", settings)).toBe(true);
    settings.telegram.muted = true;
    expect(shouldPushInviteTo("telegram", settings)).toBe(false);
  });
});
