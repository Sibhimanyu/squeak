// Home, Needs you, the Mac strip, the splash and unread replies, held to the
// iPhone's own expectations: these are the cases of its HomeGroupingTests,
// NeedsYouTests, MacStripTests and SplashTests, run against the browser's port.

import { describe, expect, it } from "vitest";

import { Channel, RENAME_MAX_CHARS } from "../js/channel.js";
import { generateDeviceKey, importChannelKey } from "../js/channel-crypto.js";
import { MAX_READ, ReadStore } from "../js/chat-stores.js";
import { homeModel } from "../js/home-view.js";
import { iconUri } from "../js/icons.js";
import { KeyStore } from "../js/key-store.js";
import * as strip from "../js/mac-strip.js";
import * as needs from "../js/needs-you.js";
import { groupingPref, verbosePref } from "../js/prefs.js";
import * as p from "../js/presentation.js";
import * as send from "../js/send-state.js";
import { fakeIndexedDB } from "./helpers.js";

const chat = (key, state, o = {}) => ({
  key,
  conductorSessionId: key,
  label: `${o.repo ?? "storefront"} · ${key}`,
  agent: "claude",
  state,
  lastActivityAt: o.at ?? "2026-10-19T10:00:00Z",
  detail: o.detail ?? null,
  git: null,
  contextPercent: null,
  turnId: o.turn ?? "t",
  message: o.message ?? null,
  choices: o.choices ?? null,
  title: key,
  question: o.question ?? null,
  asks: o.asks ?? null,
  ...(o.conductor === false ? { conductorSessionId: null } : {}),
  ...(o.open === undefined ? {} : { open: o.open }),
});

describe("Home groups and words (the iPhone's HomeGroupingTests)", () => {
  it("lists only the states with chats, in attention order", () => {
    const chats = [
      chat("a", "awaiting_input"),
      chat("b", "awaiting_approval"),
      chat("c", "working"),
      chat("d", "finished"),
      chat("e", "idle"),
    ];
    expect(p.statusGroups(chats).map((g) => g.filter)).toEqual(["needsYou", "working", "done", "idle"]);
    expect(p.statusGroups(chats).map((g) => g.count)).toEqual([2, 1, 1, 1]);
    expect(p.statusGroups([...chats, chat("f", "error")]).map((g) => g.filter)).toEqual([
      "needsYou",
      "working",
      "done",
      "error",
      "idle",
    ]);
    expect(p.statusGroups([chat("c", "working")]).map((g) => g.filter)).toEqual(["working"]);
    expect(p.inFilter(chat("e", "idle"), "idle")).toBe(true);
    expect(p.inFilter(chat("f", "error"), "idle")).toBe(false);
  });

  it("counts a finished chat that asks as needing you, and not as done", () => {
    const asking = chat("q", "finished", { asks: "Open a PR?", message: "Tests pass.\n\nOpen a PR?" });
    expect(p.inFilter(asking, "needsYou")).toBe(true);
    expect(p.inFilter(asking, "done")).toBe(false);
    expect(p.status(asking)).toEqual({ text: "needs an answer", tone: "needsYou" });
    expect(p.rank(asking)).toBe(0);
  });

  it("says how many chats and how many work", () => {
    expect(p.headerCount([])).toBe("Nothing active");
    expect(p.headerCount([chat("a", "idle")])).toBe("1 session");
    const six = ["working", "working", "working", "idle", "idle", "error"].map((s, i) => chat(`c${i}`, s));
    expect(p.headerCount(six)).toBe("6 sessions · 3 working");
  });

  it("summarises a project in words that add up", () => {
    expect(p.projectSummary([chat("a", "error"), chat("b", "working"), chat("c", "idle")])).toBe(
      "3 sessions · 1 working · 1 error · 1 idle",
    );
    expect(p.projectSummary([chat("a", "awaiting_input"), chat("b", "awaiting_approval")])).toBe(
      "2 sessions · need you",
    );
    expect(p.projectSummary([chat("a", "awaiting_input"), chat("b", "finished")])).toBe(
      "2 sessions · 1 needs you · 1 done",
    );
    expect(p.projectSummary([chat("a", "idle"), chat("b", "idle")])).toBe("2 sessions · idle");
    expect(p.projectSummary([chat("a", "working")])).toBe("1 session · working");
    const mixed = [
      chat("a", "awaiting_input"),
      chat("b", "working"),
      chat("c", "working"),
      chat("d", "finished"),
      chat("e", "idle"),
    ];
    expect(p.statusGroups(mixed).reduce((n, g) => n + g.count, 0)).toBe(mixed.length);
    expect(p.projectSummary(mixed)).toBe("5 sessions · 1 needs you · 2 working · 1 done · 1 idle");
  });

  it("groups by repo in attention order, and a chat without a repo is its own project", () => {
    const chats = [
      chat("t1", "working", { repo: "squeak", at: "2026-10-19T10:30:00Z" }),
      chat("p1", "finished", { repo: "storefront", at: "2026-10-19T08:00:00Z" }),
      chat("p2", "awaiting_input", { repo: "storefront", at: "2026-10-19T09:00:00Z" }),
      chat("i1", "idle", { repo: "compass" }),
      chat("s1", "finished", { repo: "atlas", at: "2026-10-19T10:00:00Z" }),
    ];
    const list = p.projects(chats);
    expect(list.map((x) => x.name)).toEqual(["storefront", "atlas", "squeak", "compass"]);
    expect(list[0].sessions.map((s) => s.key)).toEqual(["p2", "p1"]);
    expect(p.projectName({ label: "scratch", agent: "codex", state: "working" })).toBe("scratch");
  });

  it("previews the most urgent chats and counts the rest", () => {
    const chats = [
      chat("i", "idle", { at: "2026-10-19T10:05:00Z" }),
      chat("w", "working", { at: "2026-10-19T10:04:00Z" }),
      chat("n", "awaiting_input", { at: "2026-10-19T09:00:00Z" }),
      chat("d", "finished", { at: "2026-10-19T10:00:00Z" }),
    ];
    const two = p.preview(chats);
    expect(two.shown.map((s) => s.key)).toEqual(["n", "d"]);
    expect(two.more).toBe(2);
    const three = p.preview(chats, p.previewLimit("needsYou"));
    expect(three.shown.map((s) => s.key)).toEqual(["n", "d", "w"]);
    expect(three.more).toBe(1);
    expect(p.previewLimit("working")).toBe(2);
    expect(p.preview([chat("a", "idle")])).toMatchObject({ more: 0 });
    expect(p.preview([]).shown).toEqual([]);
    expect(p.moreLine(0)).toBeNull();
    expect(p.moreLine(1)).toBe("1 more session");
    expect(p.moreLine(3)).toBe("3 more sessions");
  });

  it("speaks in a row only for what waits, failed or finished", () => {
    expect(p.previewDetail(chat("a", "awaiting_approval"), { finished: false })).toBe(
      "Wants approval for a tool call. Answer it on your Mac.",
    );
    expect(p.previewDetail(chat("w", "working"), { finished: true })).toBeNull();
    expect(p.previewDetail(chat("i", "idle"), { finished: true })).toBeNull();
    expect(p.previewDetail(chat("e", "error"), { finished: true })).toBeNull();
    const done = chat("d", "finished", { message: "## Tests pass\nAll 66 green." });
    expect(p.previewDetail(done, { finished: false })).toBeNull();
    expect(p.previewDetail(done, { finished: true })).toBe("Tests pass");
  });

  it("counts only chats that wait on you", () => {
    expect(p.needsYouCount([])).toBe(0);
    expect(p.needsYouCount([chat("a", "working"), chat("b", "finished"), chat("c", "error")])).toBe(0);
    expect(p.needsYouCount([chat("a", "awaiting_input"), chat("b", "awaiting_approval"), chat("c", "idle")])).toBe(2);
  });

  it("names a chat by its own title, else repo and branch, and never 'Untitled'", () => {
    expect(p.displayTitle({ label: "farm · arm", title: "Irrigation" })).toBe("Irrigation");
    expect(p.displayTitle({ label: "farm · arm", title: "Untitled" })).toBe("farm · arm");
    expect(p.displayTitle({ label: "farm · arm (Irrigation)" })).toBe("Irrigation");
    expect(p.displayTitle({ label: "farm · arm (Irrigation)", title: "" })).toBe("farm · arm");
    expect(p.subtitle({ label: "farm · arm", agent: "claude" })).toBe("farm · Claude");
    expect(p.subtitle({ label: "scratch", agent: "codex" })).toBe("Codex");
  });

  it("says what a working chat is doing, in the Mac's own phrasing", () => {
    const working = chat("w", "working");
    working.activity = { steps: [{ kind: "tool", text: "Run vitest" }] };
    expect(p.status(working)).toEqual({ text: "running tests", tone: "working" });
    expect(p.status(chat("w", "working")).text).toBe("working");
  });

  it("words ages as the iPhone does", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(p.age("2026-10-19T11:59:40Z", now)).toBe("now");
    expect(p.age("2026-10-19T11:56:00Z", now)).toBe("4m");
    expect(p.age("2026-10-19T09:00:00Z", now)).toBe("3h");
    expect(p.age("2026-10-17T12:00:00Z", now)).toBe("2d");
    expect(p.age("nope", now)).toBe("");
    expect(p.heardAgo(now - 3_000, now)).toBe("just now");
    expect(p.heardAgo(now - 12_000, now)).toBe("12s ago");
    expect(p.heardAgo(now - 37 * 60_000, now)).toBe("37m ago");
    expect(p.heardAgo(now - 2 * 3600_000, now)).toBe("2h ago");
  });
});

describe("search", () => {
  const sessions = [
    chat("pay", "working", { repo: "storefront" }),
    chat("irrigate", "finished", { repo: "farm", detail: "Valve schedule done" }),
  ];
  it("matches the label, title, agent and summary, ignoring case and padding", () => {
    expect(p.matches(sessions[0], "  STORE ")).toBe(true);
    expect(p.matches(sessions[0], "claude")).toBe(true);
    expect(p.matches(sessions[1], "valve")).toBe(true);
    expect(p.matches(sessions[1], "storefront")).toBe(false);
    expect(p.matches(sessions[0], "")).toBe(true);
  });

  it("searches across active and earlier chats, active first, and skips the groups", () => {
    const earlier = [chat("old-store", "idle", { repo: "storefront" }), chat("old-farm", "idle", { repo: "farm" })];
    const model = homeModel({
      view: {},
      active: sessions,
      recent: earlier,
      seen: new Map(),
      query: "storefront",
      grouping: "projects",
    });
    expect(model.searching).toBe(true);
    expect(model.results.active.map((s) => s.key)).toEqual(["pay"]);
    expect(model.results.older.map((s) => s.key)).toEqual(["old-store"]);
    expect(
      homeModel({ view: {}, active: sessions, recent: [], seen: new Map(), query: "", grouping: "status" }).results,
    ).toBeNull();
  });
});

describe("the home model", () => {
  it("puts New replies out of the active groups and out of Earlier", () => {
    const seen = new Map([
      ["done", Date.parse("2026-10-19T09:00:00Z")],
      ["quiet", Date.parse("2026-10-19T08:00:00Z")],
    ]);
    const active = [chat("done", "finished", { message: "Done.", at: "2026-10-19T10:00:00Z" }), chat("w", "working")];
    const recent = [chat("quiet", "idle", { message: "Bye", at: "2026-10-19T09:30:00Z" }), chat("older", "idle")];
    const model = homeModel({ view: {}, active, recent, seen, query: "", grouping: "projects" });
    expect(model.unread.map((s) => s.key)).toEqual(["done", "quiet"]);
    expect(model.sessions.map((s) => s.key)).toEqual(["w"]);
    expect(model.earlier.map((s) => s.key)).toEqual(["older"]);
    expect(model.summary).toBe("1 session · 1 working");
  });

  it("shows no summary and the resting duck when nothing is active", () => {
    const model = homeModel({ view: {}, active: [], recent: [], seen: new Map(), query: "", grouping: "projects" });
    expect(model.summary).toBeNull();
    expect(model.sessions).toEqual([]);
    expect(model.hasView).toBe(true);
    expect(
      homeModel({ view: null, active: [], recent: [], seen: new Map(), query: "", grouping: "projects" }).hasView,
    ).toBe(false);
  });

  it("groups by status or by project from the same chats", () => {
    const active = [chat("a", "awaiting_input"), chat("b", "working", { repo: "farm" })];
    const byStatus = homeModel({ view: {}, active, recent: [], seen: new Map(), query: "", grouping: "status" });
    expect(byStatus.statuses.map((g) => g.filter)).toEqual(["needsYou", "working"]);
    expect(byStatus.projects).toEqual([]);
    const byProject = homeModel({ view: {}, active, recent: [], seen: new Map(), query: "", grouping: "projects" });
    expect(byProject.projects.map((x) => x.name)).toEqual(["storefront", "farm"]);
    expect(byProject.needs).toBe(1);
  });
});

describe("Needs you (the iPhone's NeedsYouTests)", () => {
  const lettered = {
    question: "Arm it?",
    options: [
      { letter: "A", title: "Now" },
      { letter: "B", title: "Later" },
    ],
    recommended: "B",
  };
  const question = {
    toolUseId: "tu",
    questions: [{ question: "Which?", multiSelect: false, options: [{ label: "X" }] }],
  };

  it("asks the lettered question with its options, a reply and Open chat", () => {
    const c = needs.card(
      chat("a", "finished", {
        message: "Done.\n\n**Arm it?**\n\n**A) Now.** x\n\n**B) Later.** y",
        choices: lettered,
        asks: "Arm it?",
      }),
    );
    expect(c.kind).toBe("choices");
    expect(c.stateWord).toBe("needs an answer");
    expect(c.heading).toBe("Arm it?");
    expect(c.controls).toEqual(["choices", "reply", "openChat"]);
    expect(c.context).toBe("Done.");
  });

  it("gives a plain question a reply field and no options", () => {
    const c = needs.card(
      chat("a", "finished", { message: "Tests pass.\n\nWant me to open a PR?", asks: "Want me to open a PR?" }),
    );
    expect(c.kind).toBe("asks");
    expect(c.stateWord).toBe("asks you");
    expect(c.controls).toEqual(["reply", "openChat"]);
    expect(c.context).toBe("Tests pass.");
  });

  it("says where to approve and offers no dead buttons", () => {
    const text = "Codex needs your permission to run a command";
    const c = needs.card(chat("a", "awaiting_approval", { detail: text, message: text }));
    expect(c.kind).toBe("approval");
    expect(c.stateWord).toBe("needs approval");
    expect(c.heading).toBe(text);
    expect(c.controls).toEqual(["approvalNote", "openChat"]);
    expect(c.context).toBeNull();
  });

  it("uses the chat's own controls for a question or a plan, and no reply", () => {
    const q = needs.card(chat("a", "awaiting_input", { question }));
    expect(q.kind).toBe("question");
    expect(q.heading).toBeNull();
    expect(q.controls).toEqual(["answerQuestion", "openChat"]);
    const plan = needs.card(
      chat("a", "awaiting_input", { question: { toolUseId: "tu", questions: [], plan: "1. Do it" } }),
    );
    expect(plan.kind).toBe("plan");
    expect(plan.stateWord).toBe("needs approval");
    expect(plan.controls).toEqual(["plan", "openChat"]);
  });

  it("only sends you to the Mac for a blocked chat with nothing to read", () => {
    const c = needs.card(chat("a", "awaiting_input"));
    expect(c.kind).toBe("blocked");
    expect(c.controls).toEqual(["approvalNote", "openChat"]);
  });

  it("gives a chat the browser cannot reply to no reply field", () => {
    expect(needs.card(chat("a", "finished", { conductor: false, message: "Q?", asks: "Q?" })).controls).toEqual([
      "openChat",
    ]);
    expect(needs.card(chat("a", "finished", { open: false, message: "Q?", asks: "Q?" })).controls).toEqual([
      "openChat",
    ]);
  });

  it("cuts a long message at a sentence and offers the full text", () => {
    const long = "The check runs before a chat starts and compares paths. ".repeat(12);
    const c = needs.card(chat("a", "finished", { message: `${long}\n\nShip it?`, asks: "Ship it?" }));
    expect(c.hasMore).toBe(true);
    expect(c.context.length).toBeLessThanOrEqual(210);
    expect(c.context.endsWith("…")).toBe(true);
    expect(c.full.length).toBeGreaterThan(c.context.length);
    expect(needs.card(chat("a", "finished", { message: "Short.\n\nShip it?", asks: "Ship it?" })).hasMore).toBe(false);
  });

  it("orders approvals first, then the one that has waited longest", () => {
    const sessions = [
      chat("new-q", "finished", { at: "2026-10-19T12:00:00Z", message: "Q?", asks: "Q?" }),
      chat("old-q", "finished", { at: "2026-10-19T09:00:00Z", message: "Q?", asks: "Q?" }),
      chat("approve", "awaiting_approval", { at: "2026-10-19T11:00:00Z" }),
      chat("working", "working", { at: "2026-10-19T08:00:00Z" }),
    ];
    expect(needs.ordered(sessions).map((s) => s.key)).toEqual(["approve", "old-q", "new-q"]);
  });

  it("lays out one or two whole cards, then rows", () => {
    expect(needs.layout(0)).toMatchObject({ full: 0, compact: 0, moreLine: null });
    expect(needs.layout(1)).toMatchObject({ full: 1, compact: 0 });
    expect(needs.layout(2)).toMatchObject({ full: 2, compact: 0, moreLine: null });
    expect(needs.layout(5)).toMatchObject({ full: 2, compact: 3, moreLine: "3 more waiting" });
  });

  it("says what is running when nothing needs you", () => {
    expect(needs.hint([chat("a", "working"), chat("b", "working"), chat("c", "working"), chat("d", "idle")])).toBe(
      "3 working",
    );
    expect(needs.hint([chat("d", "idle")])).toBe("Nothing is running either.");
  });

  it("follows only the send for this turn, and is honest about a failed one", () => {
    const session = chat("a", "finished", { message: "Q?", asks: "Q?", turn: "t1" });
    const mine = (status, turn) => ({ id: "s1", answersTurn: turn, status });
    expect(needs.outcome([], session)).toEqual({ kind: "none" });
    // An earlier turn's message is not this answer.
    expect(needs.outcome([mine(send.sent, "t0")], session)).toEqual({ kind: "none" });
    expect(needs.outcome([mine(send.sending, "t1")], session)).toMatchObject({ kind: "sending", line: "Sending…" });
    expect(needs.outcome([mine(send.sent, "t1")], session).line).toBe("Sent · waiting for the agent");
    expect(needs.outcome([mine(send.queued("Claude"), "t1")], session).kind).toBe("sent");
    const refused = needs.outcome([mine(send.refused("your Mac refused"), "t1")], session);
    expect(refused).toMatchObject({ kind: "failed", sendId: "s1" });
    expect(refused.line).toMatch(/^Not sent\. Nothing started\./);
    const unsure = needs.outcome([mine(send.notConfirmed, "t1")], session);
    expect(unsure.kind).toBe("failed");
    expect(unsure.line).toMatch(/^Couldn't confirm/);
  });

  it("reads an option's detail out of the agent's message", () => {
    const reading = p.read("Intro.\n\n**Arm it?**\n\n**A) Now.** I set it up now.\n\nB) Later. Wait a day.", lettered);
    expect(reading.before).toEqual(["Intro."]);
    expect(reading.details).toEqual({ A: "I set it up now.", B: "Wait a day." });
  });
});

describe("the Mac strip (the iPhone's MacStripTests)", () => {
  const now = 1_800_000_000_000;
  const battery = { percent: 64, onBattery: true, watts: 12, lidClosed: false };
  const make = (view, live = { kind: "answering" }) => strip.compose({ view, live, now, locale: "en-US" });

  it("words a timed awake session with the lid closed on battery", () => {
    const s = make({
      keepAwake: true,
      awakeUntil: new Date(now + 80 * 60_000).toISOString(),
      awakeLid: "on",
      macPower: battery,
    });
    expect(s.tone).toBe("awake");
    expect(s.lines[0].startsWith("Awake until ")).toBe(true);
    expect(s.lines[0].endsWith("· 1h 20m left")).toBe(true);
    expect(s.lines[1]).toBe("Lid closed OK · 64% on battery");
    expect(s.spoken.startsWith("Mac awake.")).toBe(true);
  });

  it("words an awake session with no end", () => {
    const s = make({ keepAwake: true, macPower: { percent: 100, onBattery: false, watts: null, lidClosed: false } });
    expect(s.lines).toEqual(["Kept awake until you end it", "Lid open only · 100% plugged in"]);
  });

  it("is the failed tone when the lid could not be turned on", () => {
    const s = make({ keepAwake: true, awakeLid: "failed", macPower: battery });
    expect(s.tone).toBe("failed");
    expect(s.lines[1].startsWith("Lid closed didn't turn on")).toBe(true);
  });

  it("lets a safety rule's sentence replace the battery", () => {
    const s = make({
      keepAwake: true,
      awakeLid: "on",
      awakeSafety: "Low Power Mode on · Battery at 38%",
      macPower: battery,
    });
    expect(s.lines[1]).toBe("Lid closed OK · Low Power Mode on · Battery at 38%");
    expect(make({ keepAwake: true, awakeLid: "starting" }).lines[1]).toBe("Getting ready for a closed lid");
  });

  it("is hidden when off with nothing notable, or when the Mac offers no awake sessions", () => {
    expect(make({ keepAwake: false, macPower: battery })).toBeNull();
    expect(make({ macPower: { ...battery, lidClosed: true } })).toBeNull();
    expect(make(null)).toBeNull();
  });

  it("says when off with the lid shut, a sleep problem, or a session a safety rule ended", () => {
    expect(make({ keepAwake: false, macPower: { ...battery, lidClosed: true } }).lines).toEqual([
      "Lid closed · Sleeps as usual",
    ]);
    const problem = make({ keepAwake: false, awakeSleepProblem: "Another app turned sleep off." });
    expect(problem.tone).toBe("failed");
    expect(problem.lines).toEqual(["Sleep is still turned off", "Another app turned sleep off."]);
    const ended = make({
      keepAwake: false,
      awakeLastEnd: { reason: "battery", at: new Date(now).toISOString(), why: "Battery at 9%" },
    });
    expect(ended.lines[0]).toContain("battery ran low");
    const old = make({
      keepAwake: false,
      awakeLastEnd: { reason: "battery", at: new Date(now - 7 * 3600_000).toISOString() },
    });
    expect(old).toBeNull();
  });

  it("replaces a stale awake and battery reading with 'Mac not answering'", () => {
    const s = make(
      { keepAwake: true, awakeUntil: new Date(now + 3600_000).toISOString(), awakeLid: "on", macPower: battery },
      { kind: "silent", since: now - 37 * 60_000 },
    );
    expect(s.tone).toBe("silent");
    expect(s.lines).toEqual(["Mac not answering", "Last heard 37m ago"]);
    expect(s.spoken).not.toContain("battery");
    // Even before the Mac has ever published a view.
    expect(make(null, { kind: "silent", since: now - 90_000 }).lines[1]).toBe("Last heard 1m ago");
  });

  it("formats what is left and decides liveness as the iPhone does", () => {
    expect(strip.left(now + 30_000, now)).toBe("under a minute");
    expect(strip.left(now + 45 * 60_000, now)).toBe("45m");
    expect(strip.left(now + 26 * 3600_000, now)).toBe("1d 2h");
    expect(strip.liveness({ aliveAt: undefined, lookingSince: now, now })).toEqual({ kind: "unknown" });
    expect(strip.liveness({ aliveAt: now - 59_000, lookingSince: 0, now })).toEqual({ kind: "answering" });
    expect(strip.liveness({ aliveAt: now - 5 * 60_000, lookingSince: now - 10_000, now })).toEqual({
      kind: "checking",
    });
    expect(strip.liveness({ aliveAt: now - 5 * 60_000, lookingSince: now - 40_000, now })).toEqual({
      kind: "silent",
      since: now - 5 * 60_000,
    });
  });
});

describe("the launch splash (the iPhone's SplashTests)", () => {
  it("shows while waiting for a fresh view, goes the moment one arrives, and caps at 2.5 s", () => {
    expect(strip.splashShows({ paired: true, fresh: false, elapsedMs: 100 })).toBe(true);
    expect(strip.splashShows({ paired: true, fresh: false, elapsedMs: 2_400 })).toBe(true);
    expect(strip.splashShows({ paired: true, fresh: true, elapsedMs: 0 })).toBe(false);
    expect(strip.splashShows({ paired: true, fresh: false, elapsedMs: 2_500 })).toBe(false);
    expect(strip.SPLASH_CAP_MS).toBe(2_500);
  });

  it("never shows for a browser that is not paired", () => {
    expect(strip.splashShows({ paired: false, fresh: false, elapsedMs: 0 })).toBe(false);
  });
});

describe("unread replies", () => {
  const at = (iso) => Date.parse(iso);
  const done = chat("d", "finished", { message: "Done.", at: "2026-10-19T10:00:00Z" });

  it("is unread only for a chat you have a stake in that answered after you looked", () => {
    const seen = new Map([["d", at("2026-10-19T09:00:00Z")]]);
    expect(p.isUnread(done, seen)).toBe(true);
    expect(p.isUnread(done, new Map())).toBe(false); // never looked: not yours yet
    expect(p.isUnread(done, new Map([["d", at("2026-10-19T10:00:00Z")]]))).toBe(false);
    expect(p.isUnread({ ...done, state: "working" }, seen)).toBe(false);
    expect(p.isUnread({ ...done, message: null, detail: null }, seen)).toBe(false);
    // A chat waiting on you has its own, louder mark.
    expect(p.isUnread({ ...done, asks: "Ship it?" }, seen)).toBe(false);
    expect(p.isUnread(chat("x", "awaiting_input", { message: "m" }), seen)).toBe(false);
  });

  it("is kept in the browser's database, comes back after a reload, and is wiped with it", async () => {
    const idb = fakeIndexedDB();
    const kv = new KeyStore(idb);
    const store = new ReadStore(kv, { delayMs: 5 });
    await store.load();
    store.markSeen("d", at("2026-10-19T09:00:00Z"));
    await store.flush();
    expect(idb.databases.has("squeak-web")).toBe(true);

    const reloaded = new ReadStore(kv);
    const seen = await reloaded.load();
    expect(seen.get("d")).toBe(at("2026-10-19T09:00:00Z"));
    expect(p.isUnread(done, seen)).toBe(true);
    // Looking at it marks it read, and that survives too.
    reloaded.markSeen("d", at("2026-10-19T10:05:00Z"));
    await reloaded.flush();
    expect(p.isUnread(done, await new ReadStore(kv).load())).toBe(false);

    // Forget: nothing writes after dispose, then the database goes.
    await reloaded.dispose();
    reloaded.markSeen("d", 1);
    await reloaded.flush();
    await kv.forget();
    expect(idb.databases.has("squeak-web")).toBe(false);
    expect((await new ReadStore(new KeyStore(idb)).load()).size).toBe(0);
    expect(idb.databases.has("squeak-web")).toBe(true); // read() reopened an empty one, with nothing in it
  });

  it("writes nothing once disposed, so a late write cannot bring the wiped database back", async () => {
    const idb = fakeIndexedDB();
    const store = new ReadStore(new KeyStore(idb), { delayMs: 1 });
    await store.dispose();
    store.markSeen("late", 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idb.databases.has("squeak-web")).toBe(false);
  });

  it("starts caring about a chat seen working, keeps the newest 300, and ignores damaged files", async () => {
    const kv = new KeyStore(fakeIndexedDB());
    const store = new ReadStore(kv, { delayMs: 1_000 });
    store.watchIfNew("w", 100);
    store.watchIfNew("w", 999);
    expect(store.seen.get("w")).toBeGreaterThan(0);
    const first = store.seen.get("w");
    store.watchIfNew("w");
    expect(store.seen.get("w")).toBe(first);
    for (let i = 0; i < MAX_READ + 20; i++) store.markSeen(`c${i}`, i + 1);
    expect(store.seen.size).toBe(MAX_READ);
    expect(store.seen.has("c0")).toBe(false);
    await store.dispose();
    await kv.write("read", { v: 1, seen: [["ok", 5], [3, 4], "junk", ["bad", "x"]] });
    expect([...(await new ReadStore(kv).load())]).toEqual([["ok", 5]]);
    await kv.write("read", "not a file");
    expect((await new ReadStore(kv).load()).size).toBe(0);
  });
});

describe("preferences", () => {
  it("defaults Show thinking live to on and Home to projects", () => {
    expect(verbosePref(null)).toBe(true);
    expect(verbosePref({ verbose: false })).toBe(false);
    expect(groupingPref(null)).toBe("projects");
    expect(groupingPref({ grouping: "status" })).toBe("status");
    expect(groupingPref({ grouping: "anything else" })).toBe("projects");
  });
});

describe("project icons", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHpyVfQAAAABJRU5ErkJggg==";
  it("accepts only a small, well-formed PNG, as a data: URI", () => {
    expect(iconUri({ farm: png }, "farm")).toBe(`data:image/png;base64,${png}`);
    expect(iconUri({ farm: png }, "other")).toBeNull();
    expect(iconUri(null, "farm")).toBeNull();
    expect(iconUri({ farm: "PHN2Zy8+" }, "farm")).toBeNull(); // not a PNG (an SVG)
    expect(iconUri({ farm: `${png}"onload="x` }, "farm")).toBeNull();
    expect(iconUri({ farm: `iVBORw0KGgo${"A".repeat(200_001)}` }, "farm")).toBeNull();
    expect(iconUri({ farm: 5 }, "farm")).toBeNull();
    // A name that is on Object.prototype is not an icon.
    expect(iconUri({}, "constructor")).toBeNull();
  });
});

describe("a rename made in the browser", () => {
  const session = { conductorSessionId: "s1", label: "farm · arm" };
  async function made() {
    const key = await importChannelKey(Buffer.alloc(32, 7).toString("base64"));
    const { privateKey } = await generateDeviceKey();
    return { channel: new Channel({ channelId: "a".repeat(22), deviceId: "web", key, db: {} }), privateKey };
  }

  it("refuses to build what the Mac would refuse", async () => {
    const { channel, privateKey } = await made();
    await expect(channel.renameDocument({ conductorSessionId: null }, "x", privateKey)).rejects.toThrow();
    await expect(channel.renameDocument(session, "   ", privateKey)).rejects.toThrow();
    await expect(channel.renameDocument(session, "x".repeat(RENAME_MAX_CHARS + 1), privateKey)).rejects.toThrow();
    await expect(channel.renameDocument(session, "x".repeat(RENAME_MAX_CHARS), privateKey)).resolves.toBeTruthy();
  });
});
