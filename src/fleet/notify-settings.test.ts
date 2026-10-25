import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { shouldPush } from "./attention.js";
import {
  channelFilter,
  defaultNotifySettings,
  inQuietHours,
  NotifySettingsStore,
  readNotifyChange,
  readNotifyRequest,
  shouldPushTo,
  wantsAllFinishes,
  type NotifySettings,
} from "./notify-settings.js";
import type { AttentionKind, FleetSession } from "./types.js";

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "k",
    source: "claude-transcript",
    agent: "claude",
    origin: "terminal",
    sourceId: "s",
    agentSessionId: "s",
    conductorSessionId: null,
    cwd: null,
    repoName: null,
    branch: null,
    title: null,
    state: "working",
    detail: null,
    lastActivityAt: "2026-09-20T12:00:00.000Z",
    transcriptPath: null,
    pid: null,
    alive: false,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
    ...overrides,
  };
}

const conductor = session({ conductorSessionId: "abc", origin: "conductor" });
const terminal = session();
const ALL_KINDS: AttentionKind[] = [
  "blocked_approval",
  "blocked_question",
  "asked_question",
  "stalled",
  "errored",
  "finished_unreviewed",
  "context_pressure",
];
// Local time, so the tests hold in any timezone.
const at = (hour: number, minute = 0) => new Date(2026, 9, 25, hour, minute);

function settings(channel: "telegram" | "cliq", patch: Partial<NotifySettings["telegram"]>): NotifySettings {
  const base = defaultNotifySettings();
  return { ...base, [channel]: { ...base[channel], ...patch } };
}

describe("shouldPushTo defaults", () => {
  it("matches shouldPush for every kind, session and channel", () => {
    const replyableTerminal = session({ alive: true, agentSessionId: "a", transcriptPath: "/t.jsonl" });
    for (const channel of ["telegram", "cliq"] as const) {
      for (const kind of ALL_KINDS) {
        for (const s of [conductor, terminal, replyableTerminal]) {
          expect(shouldPushTo(channel, kind, s, defaultNotifySettings(), at(3))).toBe(shouldPush(kind, s));
        }
      }
    }
  });
});

describe("shouldPushTo switches", () => {
  it("muted stops every kind", () => {
    for (const kind of ALL_KINDS) {
      expect(shouldPushTo("telegram", kind, conductor, settings("telegram", { muted: true }), at(12))).toBe(false);
    }
  });

  it("is per channel", () => {
    const s = settings("telegram", { muted: true });
    expect(shouldPushTo("telegram", "blocked_approval", conductor, s, at(12))).toBe(false);
    expect(shouldPushTo("cliq", "blocked_approval", conductor, s, at(12))).toBe(true);
  });

  it("approval covers both blocked kinds", () => {
    const s = settings("cliq", { approval: false });
    expect(shouldPushTo("cliq", "blocked_approval", conductor, s, at(12))).toBe(false);
    expect(shouldPushTo("cliq", "blocked_question", conductor, s, at(12))).toBe(false);
    expect(shouldPushTo("cliq", "stalled", conductor, s, at(12))).toBe(true);
  });

  it("question and stalled switch their own kind", () => {
    expect(
      shouldPushTo("telegram", "asked_question", conductor, settings("telegram", { question: false }), at(12)),
    ).toBe(false);
    expect(shouldPushTo("telegram", "stalled", conductor, settings("telegram", { stalled: false }), at(12))).toBe(
      false,
    );
    expect(
      shouldPushTo("telegram", "finished_unreviewed", conductor, settings("telegram", { stalled: false }), at(12)),
    ).toBe(true);
  });

  it("finished: off stops finishes only; all lets in a terminal agent", () => {
    const off = settings("telegram", { finished: "off" });
    expect(shouldPushTo("telegram", "finished_unreviewed", conductor, off, at(12))).toBe(false);
    expect(shouldPushTo("telegram", "blocked_approval", conductor, off, at(12))).toBe(true);
    const all = settings("telegram", { finished: "all" });
    expect(shouldPushTo("telegram", "finished_unreviewed", terminal, all, at(12))).toBe(true);
    expect(shouldPushTo("telegram", "asked_question", terminal, all, at(12))).toBe(true);
    expect(shouldPushTo("telegram", "finished_unreviewed", terminal, defaultNotifySettings(), at(12))).toBe(false);
    // errors and context pressure never push, whatever the switches say
    expect(shouldPushTo("telegram", "errored", terminal, all, at(12))).toBe(false);
    expect(shouldPushTo("telegram", "context_pressure", terminal, all, at(12))).toBe(false);
  });

  it("accepts a millisecond clock", () => {
    expect(shouldPushTo("telegram", "stalled", conductor, defaultNotifySettings(), at(12).getTime())).toBe(true);
  });
});

describe("quiet hours", () => {
  const quiet = { from: "22:00", to: "07:00" };

  it("crosses midnight, in local time, from inclusive to exclusive", () => {
    expect(inQuietHours(quiet, at(21, 59))).toBe(false);
    expect(inQuietHours(quiet, at(22, 0))).toBe(true);
    expect(inQuietHours(quiet, at(23, 59))).toBe(true);
    expect(inQuietHours(quiet, at(0, 0))).toBe(true);
    expect(inQuietHours(quiet, at(6, 59))).toBe(true);
    expect(inQuietHours(quiet, at(7, 0))).toBe(false);
    expect(inQuietHours(quiet, at(12, 0))).toBe(false);
  });

  it("works within one day and with none", () => {
    expect(inQuietHours({ from: "09:00", to: "17:30" }, at(9, 0))).toBe(true);
    expect(inQuietHours({ from: "09:00", to: "17:30" }, at(17, 30))).toBe(false);
    expect(inQuietHours({ from: "09:00", to: "17:30" }, at(8, 59))).toBe(false);
    expect(inQuietHours(null, at(3))).toBe(false);
  });

  it("holds back finishes, questions and stalls, never a blocked approval", () => {
    const s = settings("telegram", { quiet });
    expect(shouldPushTo("telegram", "finished_unreviewed", conductor, s, at(23))).toBe(false);
    expect(shouldPushTo("telegram", "asked_question", conductor, s, at(23))).toBe(false);
    expect(shouldPushTo("telegram", "stalled", conductor, s, at(23))).toBe(false);
    expect(shouldPushTo("telegram", "blocked_approval", conductor, s, at(23))).toBe(true);
    expect(shouldPushTo("telegram", "blocked_question", conductor, s, at(23))).toBe(true);
    expect(shouldPushTo("telegram", "finished_unreviewed", conductor, s, at(12))).toBe(true);
    // the other channel has no quiet hours
    expect(shouldPushTo("cliq", "finished_unreviewed", conductor, s, at(23))).toBe(true);
  });
});

describe("channelFilter and wantsAllFinishes", () => {
  it("reads the store live and gates the quota alert", () => {
    let current = defaultNotifySettings();
    const filter = channelFilter(
      {
        get settings() {
          return current;
        },
      },
      "telegram",
      () => at(12).getTime(),
    );
    expect(filter.item({ kind: "stalled", session: conductor })).toBe(true);
    expect(filter.quota()).toBe(true);
    current = settings("telegram", { quota: false });
    expect(filter.quota()).toBe(false);
    current = settings("telegram", { muted: true });
    expect(filter.item({ kind: "stalled", session: conductor })).toBe(false);
    expect(filter.quota()).toBe(false);
  });

  it("asks the monitor to widen only for an unmuted channel on all", () => {
    expect(wantsAllFinishes(defaultNotifySettings())).toBe(false);
    expect(wantsAllFinishes(settings("cliq", { finished: "all" }))).toBe(true);
    expect(wantsAllFinishes(settings("cliq", { finished: "all", muted: true }))).toBe(false);
  });
});

describe("readNotifyChange and readNotifyRequest", () => {
  it("accepts exactly one known key with its exact type", () => {
    expect(readNotifyChange({ muted: true })).toEqual({ muted: true });
    expect(readNotifyChange({ approval: false })).toEqual({ approval: false });
    expect(readNotifyChange({ finished: "all" })).toEqual({ finished: "all" });
    expect(readNotifyChange({ quiet: { from: "22:00", to: "07:00" } })).toEqual({
      quiet: { from: "22:00", to: "07:00" },
    });
    expect(readNotifyChange({ quiet: null })).toEqual({ quiet: null });
  });

  it("refuses everything else", () => {
    for (const bad of [
      null,
      [],
      "muted",
      {},
      { muted: "yes" },
      { muted: 1 },
      { muted: true, stalled: true },
      { error: true },
      { context: true },
      { finished: "some" },
      { finished: true },
      { quiet: { from: "22:00" } },
      { quiet: { from: "22:00", to: "07:00", extra: 1 } },
      { quiet: { from: "24:00", to: "07:00" } },
      { quiet: { from: "7:00", to: "08:00" } },
      { quiet: { from: "22:00", to: "22:00" } },
      { quiet: "22:00-07:00" },
    ]) {
      expect(readNotifyChange(bad)).toBeNull();
    }
  });

  it("a request names a known channel and a change, nothing more", () => {
    expect(readNotifyRequest({ channel: "cliq", change: { muted: true } })).toEqual({
      channel: "cliq",
      change: { muted: true },
    });
    for (const bad of [
      null,
      {},
      { channel: "phone", change: { muted: true } },
      { channel: "cliq" },
      { channel: "cliq", change: { muted: "x" } },
      { channel: "cliq", change: { muted: true }, extra: 1 },
    ]) {
      expect(readNotifyRequest(bad)).toBeNull();
    }
  });
});

describe("NotifySettingsStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-settings-"));
    dirs.push(dir);
    return path.join(dir, "notify-settings.json");
  };

  it("is today's behaviour when nothing is saved", () => {
    expect(new NotifySettingsStore(file()).settings).toEqual(defaultNotifySettings());
  });

  it("saves one change at a time, 0600, and a new store reads it back", () => {
    const f = file();
    const store = new NotifySettingsStore(f);
    expect(store.apply({ channel: "telegram", change: { finished: "off" } }).ok).toBe(true);
    const out = store.apply({ channel: "cliq", change: { quiet: { from: "22:00", to: "07:00" } } });
    expect(out.ok && out.settings.cliq.quiet).toEqual({ from: "22:00", to: "07:00" });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(f))).toEqual(["notify-settings.json"]);
    const again = new NotifySettingsStore(f).settings;
    expect(again.telegram.finished).toBe("off");
    expect(again.telegram.muted).toBe(false);
    expect(again.cliq.quiet).toEqual({ from: "22:00", to: "07:00" });
  });

  it("refuses a bad write without changing anything", () => {
    const f = file();
    const store = new NotifySettingsStore(f);
    expect(store.apply({ channel: "telegram", change: { error: true } }).ok).toBe(false);
    expect(store.settings).toEqual(defaultNotifySettings());
    expect(fs.existsSync(f)).toBe(false);
  });

  it("ignores unknown keys and bad values on read", () => {
    const f = file();
    fs.writeFileSync(
      f,
      JSON.stringify({
        telegram: { muted: true, finished: "weird", approval: "no", future: 1, quiet: { from: "99:00", to: "07:00" } },
        other: {},
      }),
    );
    const read = new NotifySettingsStore(f).settings;
    expect(read.telegram).toEqual({ ...defaultNotifySettings().telegram, muted: true });
    expect(read.cliq).toEqual(defaultNotifySettings().cliq);
    fs.writeFileSync(f, "not json");
    expect(new NotifySettingsStore(f).settings).toEqual(defaultNotifySettings());
  });
});
