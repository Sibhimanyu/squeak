// Usage, Usage details, Films and the review card: the pure logic, with fakes (no DOM, no network).

import { describe, expect, it } from "vitest";

import { shape } from "../js/command-shapes.js";
import {
  answerCommand,
  askValue,
  briefInit,
  briefSubmission,
  briefValid,
  callOutcome,
  canSendAsk,
  canSendNote,
  chatReason,
  chatRows,
  clock,
  currentCall,
  filmLine,
  filmsSummary,
  filmsWaiting,
  frameComment,
  frameRedo,
  markedIds,
  moreLabel,
  moreValue,
  noteValue,
  numberProblem,
  openNotes,
  pickLabel,
  pictureRect,
  pinFromTap,
  progressLine,
  progressSteps,
  readCard,
  readFilms,
  reviewFooter,
  sceneAt,
  sendAnswer,
  sendChat,
  settledChat,
  stateTone,
  stateWord,
  visibleFilms,
  waitingOnYou,
} from "../js/films-logic.js";
import { MediaError, fetchMediaBytes, readMediaRef } from "../js/media-chunks.js";
import { ReviewSession } from "../js/review-session.js";
import * as u from "../js/usage-logic.js";
import { loadStats, refresh, resetUsageState, state } from "../js/usage-view.js";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const at = (ms) => new Date(NOW + ms).toISOString();

describe("usage wording", () => {
  it("reads a window as used, reset or empty", () => {
    expect(u.usedLabel(41.6, at(60_000), NOW)).toBe("42% used");
    expect(u.usedLabel(120, at(60_000), NOW)).toBe("100% used");
    expect(u.usedLabel(80, at(-1), NOW)).toBe("Reset");
    expect(u.usedFraction(25, at(60_000), NOW)).toBe(0.25);
    expect(u.usedFraction(25, at(-5), NOW)).toBe(0);
    expect(u.fraction(-5)).toBe(0);
    expect(u.fraction(500)).toBe(1);
  });

  it("says when a window resets", () => {
    expect(u.resets(at(-1), NOW)).toBe("has reset since");
    expect(u.resets(at(30_000), NOW)).toBe("resets in 1m");
    expect(u.resets(at(130 * 60_000), NOW)).toBe("resets in 2h 10m");
    expect(u.resets(at(3 * 3_600_000), NOW)).toBe("resets in 3h");
    expect(u.resets(at((5 * 24 + 3) * 3_600_000), NOW)).toBe("resets in 5d 3h");
    expect(u.resets(at(2 * 24 * 3_600_000), NOW)).toBe("resets in 2d");
    expect(u.resets("nope", NOW)).toBe("");
  });

  it("carries a reading's age only once it is stale", () => {
    expect(u.asOf(at(-30 * 60_000), NOW)).toBeNull();
    expect(u.asOf(at(-3 * 3_600_000), NOW)).toBe("as of 3 hours ago");
    expect(u.asOf(at(-3_600_000), NOW)).toBe("as of 1 hour ago");
    expect(u.asOf(at(-50 * 3_600_000), NOW)).toBe("as of 2 days ago");
    expect(u.asOf(null, NOW)).toBeNull();
  });

  it("lays out each provider's rows in the iPhone's words", () => {
    const usage = {
      claude: { fiveHour: { usedPercent: 1, resetsAt: "x" }, sevenDay: null, observedAt: null },
      codex: { fiveHour: null, weekly: { usedPercent: 2, resetsAt: "y" }, observedAt: null },
    };
    expect(u.providerRows("claude", usage).map((r) => r.name)).toEqual(["5 hours", "7 days"]);
    expect(u.providerRows("codex", usage).map((r) => r.name)).toEqual(["5 hours", "Weekly"]);
    expect(u.providerRows("codex", { claude: usage.claude, codex: null })).toBeNull();
  });
});

describe("usage details wording", () => {
  it("formats tokens, cost, time and models like the iPhone", () => {
    expect(u.tokens(912)).toBe("912");
    expect(u.tokens(2_994)).toBe("3.0K");
    expect(u.tokens(12_400)).toBe("12K");
    expect(u.tokens(2_994_740)).toBe("3.0M");
    expect(u.tokens(13_900_186_405)).toBe("13.9B");
    expect(u.cost(12.4)).toBe("$12.40");
    expect(u.cost(4128.4)).toBe("$4,128");
    expect(u.cost(null)).toBeNull();
    expect(u.duration(1044)).toBe("17h 24m");
    expect(u.duration(45)).toBe("45m");
    expect(u.hour(14)).toBe("2 PM – 3 PM");
    expect(u.hour(0)).toBe("12 AM – 1 AM");
    expect(u.hour(11)).toBe("11 AM – 12 PM");
    expect(u.model("claude-opus-5-5")).toBe("Opus 5.5");
    expect(u.model("claude-sonnet-5")).toBe("Sonnet 5");
    expect(u.model("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(u.day("2026-09-24")).toBe("24 Sep");
    expect(u.day("bad")).toBeNull();
    expect(u.days(1)).toBe("1 day");
    expect(u.days(12)).toBe("12 days");
  });

  it("explains where each agent's numbers come from", () => {
    expect(u.source({ agent: "codex", since: "2026-09-24" })).toContain("Its logs go back to 24 Sep.");
    expect(u.source({ agent: "claude", keepDays: 30, keptFrom: "2026-09-28" })).toContain(
      "after 30 days, so All time here starts around 28 Sep",
    );
    expect(u.recordNote({ tokens: 2_994_740, since: "2026-07-01" })).toContain("counts 3.0M tokens since 1 Jul");
  });

  it("builds the tiles, token rows and day bars from stats", () => {
    const stats = {
      totals: {
        tokens: 1000,
        input: 100,
        output: 50,
        cacheRead: 800,
        cacheWrite: 50,
        messages: 5000,
        sessions: 3,
        costUsd: null,
      },
      activeDays: 2,
      currentStreak: 1,
      longestStreak: 4,
      favoriteModel: null,
      peakHour: null,
      longestSession: null,
    };
    const tiles = Object.fromEntries(u.headlineTiles(stats).map((t) => [t.title, t]));
    expect(tiles["Estimated cost"]).toEqual({ title: "Estimated cost", value: "Not priced", detail: null });
    expect(tiles["Current streak"].detail).toBe("Longest 4 days");
    expect(tiles["Favorite model"].value).toBe("None yet");
    expect(tiles["Busiest hour"].value).toBe("Not yet");
    expect(u.tokenRows(stats.totals)[2]).toEqual({ name: "Cache reads", value: 800, share: 0.8 });
    expect(u.tokenRows({ ...stats.totals, tokens: 0 })[0].share).toBe(0);
    const { peak, bars } = u.dailyBars([
      { date: "a", tokens: 0 },
      { date: "b", tokens: 50 },
    ]);
    expect(peak).toBe(50);
    expect(bars.map((b) => b.share)).toEqual([0, 1]);
  });

  it("asks for ranges and agents the Mac accepts, and drops an answer for another pick", () => {
    expect(u.statsRequest("30d", "codex")).toEqual({ range: "30d", agent: "codex" });
    expect(u.statsRequest("90d", "codex")).toBeNull();
    expect(u.statsRequest("7d", "gemini")).toBeNull();
    expect(() => shape("stats", u.statsRequest("all", "claude"))).not.toThrow();
    expect(u.statsFits({ agent: "claude", range: "7d" }, "7d", "claude")).toBe(true);
    expect(u.statsFits({ agent: null, range: "7d" }, "7d", "codex")).toBe(true);
    expect(u.statsFits({ agent: "codex", range: "7d" }, "7d", "claude")).toBe(false);
    expect(u.statsFits({ agent: "claude", range: "30d" }, "7d", "claude")).toBe(false);
  });
});

describe("usage refresh pacing", () => {
  it("waits out the Mac's minute and recognises an open", () => {
    expect(u.refreshWait(null, NOW)).toBe(0);
    expect(u.refreshWait(NOW - 20_000, NOW)).toBe(40_000);
    expect(u.refreshWait(NOW - 61_000, NOW)).toBe(0);
    expect(u.isOpening(null, NOW)).toBe(true);
    expect(u.isOpening(NOW - 15_000, NOW)).toBe(false);
    expect(u.isOpening(NOW - 60_000, NOW)).toBe(true);
  });

  it("words the outcome of a refresh", () => {
    expect(u.refreshNote({ ok: true, result: {} })).toBe("Updated just now.");
    expect(u.refreshNote({ ok: true, result: { throttled: true } })).toBe(
      "Already up to date: read in the last minute.",
    );
    expect(u.refreshNote({ ok: true, result: { note: "Read 2 min ago." } })).toBe("Read 2 min ago.");
    expect(u.refreshNote({ ok: false, status: "refused", reason: "No." })).toBe("No.");
    expect(u.refreshNote({ ok: false, status: "unconfirmed", reason: "Couldn't confirm it arrived." })).toBe(
      "Couldn't confirm it arrived.",
    );
  });

  it("refreshes once, not twice in a minute, and never while one runs", async () => {
    resetUsageState();
    let sent = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const ctx = {
      touch: () => {},
      commands: {
        waitMs: () => 0,
        usage: async () => {
          sent++;
          await gate;
          return { ok: true, result: {} };
        },
      },
    };
    let clockMs = NOW;
    const first = refresh(ctx, () => clockMs);
    await refresh(ctx, () => clockMs);
    expect(sent).toBe(1);
    expect(state.refreshing).toBe(true);
    release();
    await first;
    expect(state.note).toBe("Updated just now.");
    clockMs += 20_000;
    await refresh(ctx, () => clockMs);
    expect(sent).toBe(1);
    expect(state.note).toBe("Already up to date: read in the last minute.");
    clockMs += 60_000;
    await refresh(ctx, () => clockMs);
    expect(sent).toBe(2);
  });

  it("keeps an answer for each pick and ignores one that lands for another", async () => {
    resetUsageState();
    const statsFor = (agent, range) => ({
      ok: true,
      result: { stats: { range, agent, totals: { tokens: 10 } } },
    });
    const pending = [];
    const ctx = {
      touch: () => {},
      commands: {
        stats: (input) => new Promise((resolve) => pending.push({ input, resolve })),
      },
    };
    state.agent = "claude";
    state.range = "7d";
    const first = loadStats(ctx);
    expect(pending[0].input).toEqual({ range: "7d", agent: "claude" });
    state.range = "30d";
    pending[0].resolve(statsFor("claude", "7d"));
    await first;
    // The 7d answer is stored for 7d; the screen is on 30d and shows no problem for it.
    expect(state.stats.has("claude 7d")).toBe(true);
    expect(state.problem).toBeNull();
    const second = loadStats(ctx);
    pending[1].resolve({ ok: false, reason: "Busy." });
    await second;
    expect(state.problem).toBe("Busy.");
  });
});

/* ---------- films ---------- */

const FILM_A = "film:0123456789abcdef";
const FILM_B = "film:fedcba9876543210";

const card = (o = {}) => ({
  provider: "rasanai",
  call: "look",
  step: "look-1",
  revision: "rev-1",
  title: "Dawn",
  prompt: "Pick a look",
  options: [
    {
      id: "a",
      label: "Sure",
      title: "Quiet",
      frames: [{ id: "f1", image: "img/1" }],
      beats: [{ name: "b", seconds: 4, line: "Hi" }],
    },
    { id: "b", label: "Bold", title: "Loud" },
  ],
  recommended: "a",
  canAskMore: true,
  ...o,
});

const view = (films) => ({ films });
const film = (id, o = {}) => ({ id, title: "Dawn", updatedAt: at(-60_000), director: { state: "running" }, ...o });

describe("films on Home", () => {
  it("is null when the Mac publishes none, and counts the films waiting on you", () => {
    expect(readFilms({})).toBeNull();
    expect(filmsWaiting({})).toBe(0);
    const v = view([
      film(FILM_A, { card: card() }),
      film(FILM_B, { director: { state: "finished" }, card: card() }),
      film("film:1111111111111111", { progress: { call: "story", calls: [], waiting: true } }),
      film("film:2222222222222222"),
    ]);
    expect(filmsWaiting(v)).toBe(2);
  });

  it("lists newest first with the Mac's order for ties, and reads what view-model leaves out", () => {
    const v = view([
      film(FILM_A, { updatedAt: at(-3_600_000) }),
      film(FILM_B, {
        updatedAt: at(-1000),
        canChat: true,
        canStop: true,
        poster: "p/1",
        sessionKey: "k",
        engineNote: "Update.",
      }),
    ]);
    const films = readFilms(v);
    expect(films.map((f) => f.id)).toEqual([FILM_B, FILM_A]);
    expect(films[0]).toMatchObject({
      canChat: true,
      canStop: true,
      canResume: false,
      poster: "p/1",
      sessionKey: "k",
      engineNote: "Update.",
    });
    expect(films[1].poster).toBeNull();
  });

  it("says where a film is in words, with the accent only on a call waiting", () => {
    const [waiting] = readFilms(view([film(FILM_A, { card: card() })]));
    expect(waitingOnYou(waiting)).toBe(true);
    expect(stateWord(waiting)).toBe("Waiting on you");
    expect(stateTone(waiting)).toBe("needsYou");
    expect(currentCall(waiting)).toBe("Look");
    expect(filmLine(waiting)).toBe("Look · Pick a look");
    const [working] = readFilms(view([film(FILM_A, { progress: { call: "story", calls: [], activity: "Writing" } })]));
    expect(stateWord(working)).toBe("Working");
    expect(stateTone(working)).toBe("working");
    expect(filmLine(working)).toBe("Writing");
    const [done] = readFilms(view([film(FILM_A, { director: { state: "finished" }, card: card() })]));
    expect(stateWord(done)).toBe("Finished");
    expect(filmLine(done)).toBe("The film is finished.");
    const [crashed] = readFilms(view([film(FILM_A, { director: { state: "crashed" } })]));
    expect(stateWord(crashed)).toBe("Stopped unexpectedly");
    expect(stateTone(crashed)).toBe("error");
    const [quiet] = readFilms(view([film(FILM_A, { director: { state: "none", detail: "Not started." } })]));
    expect(stateWord(quiet)).toBe("Idle");
    expect(filmLine(quiet)).toBe("Not started.");
  });

  it("shows four rows and expands, with a summary that leads with the waiting", () => {
    const films = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    expect(visibleFilms(films, false)).toHaveLength(4);
    expect(visibleFilms(films, true)).toHaveLength(6);
    expect(filmsSummary(2, 6)).toBe("2 waiting on you");
    expect(filmsSummary(0, 1)).toBe("1 film");
    expect(filmsSummary(0, 6)).toBe("6 films");
  });

  it("draws the stepper from the five calls when the Mac sends none", () => {
    const [f] = readFilms(view([film(FILM_A, { progress: { call: "look", calls: [] } })]));
    expect(progressSteps(f.progress).map((s) => s.call)).toEqual(["brief", "story", "look", "animatic", "final"]);
    expect(progressLine({ waiting: true, call: "look" })).toBe("Waiting on you: Look");
    expect(progressLine({ waiting: false, call: "look", activity: "Drawing" })).toBe("Drawing");
    expect(progressLine({ waiting: false, call: "animatic" })).toBe("Working on the animatic");
  });

  it("reads a call defensively: strings stay text, junk is dropped", () => {
    expect(readCard(null)).toBeNull();
    const c = readCard({
      call: 7,
      step: "s",
      revision: "r",
      prompt: "<b>x</b>",
      options: [{ id: "a", label: "A", title: "<img src=x>" }, { label: "no id" }],
      review: {
        kind: "final",
        scenes: [
          { id: "s1", start: "bad" },
          { id: "s2", start: 3 },
        ],
        media: { kind: "video", source: "m" },
        finish: ["approve", 4],
      },
    });
    expect(c.call).toBe("other");
    expect(c.prompt).toBe("<b>x</b>");
    expect(c.options).toHaveLength(1);
    expect(c.review.scenes.map((s) => s.id)).toEqual(["s2"]);
    expect(c.review.finish).toEqual(["approve"]);
    expect(c.review.media).toEqual({ kind: "video", source: "m", poster: null });
  });
});

describe("what a call sends", () => {
  const c = readCard(card());

  it("builds commands the Mac's own shape checks accept", () => {
    const [kind, input] = answerCommand({ filmId: FILM_A }, c, { type: "choose", value: "a" });
    expect(kind).toBe("film");
    expect(shape("film", input)).toMatchObject({
      filmId: FILM_A,
      op: "answer",
      step: "look-1",
      revision: "rev-1",
      type: "choose",
      value: "a",
    });
    const [kind2, input2] = answerCommand({ sessionKey: "k:1" }, c, { type: "approve" });
    expect(kind2).toBe("workflow");
    expect(shape("workflow", input2)).toMatchObject({ sessionKey: "k:1", type: "approve" });
    // A "decide" and an "approve" send no value; a note carries its words.
    expect(shape("film", answerCommand({ filmId: FILM_A }, c, { type: "decide" })[1]).value).toBeUndefined();
    expect(
      shape("film", answerCommand({ filmId: FILM_A }, c, { type: "comment", value: { t: 1 }, note: "x" })[1]).note,
    ).toBe("x");
  });

  it("labels the pick, 'three more' and answers to the director's question", () => {
    expect(pickLabel(c, c.options, null)).toBe("Pick a look");
    expect(pickLabel({ call: "story" }, c.options, null)).toBe("Pick a story");
    expect(pickLabel({ call: "other" }, c.options, null)).toBe("Pick a one");
    expect(pickLabel(c, c.options, "b")).toBe("Use Bold");
    expect(moreLabel(c.options, "a")).toBe("Three more like Sure");
    expect(moreLabel(c.options, null)).toBe("Three more");
    expect(moreValue("a")).toEqual({ near: "a" });
    expect(moreValue(null)).toEqual({});
    expect(askValue(null, "words")).toEqual({ choice: null, text: "words" });
    expect(askValue("x", "")).toEqual({ choice: "x", text: "" });
    expect(canSendAsk(null, "  ")).toBe(false);
    expect(canSendAsk("x", "")).toBe(true);
    expect(canSendAsk(null, "hi")).toBe(true);
  });

  it("marks styleframes in the grid's order and builds a comment and a redo", () => {
    const frames = [{ id: "1" }, { id: "2" }, { id: "3" }];
    expect(markedIds(frames, new Set(["3", "1"]))).toEqual(["1", "3"]);
    expect(frameComment("2", "darker")).toEqual({ frame: "2", text: "darker" });
    expect(frameRedo(["1"], "again")).toEqual({ ids: ["1"], note: "again" });
  });

  it("turns outcomes into the iPhone's lines and never offers a resend when unconfirmed", () => {
    expect(callOutcome({ ok: true, result: { said: "Picked Bold" } }).line).toBe("Picked Bold");
    expect(callOutcome({ ok: true, result: {} }, { chat: true }).line).toBe("Sent · RasanAI picks it up from here");
    const unconfirmed = callOutcome({ ok: false, unconfirmed: true, retrySafe: false, reason: "x" });
    expect(unconfirmed).toMatchObject({ delivered: false, retrySafe: false, unconfirmed: true });
    expect(unconfirmed.line).toContain("Check the film before answering again");
    expect(callOutcome({ ok: false, retrySafe: true, reason: "Changed." })).toMatchObject({
      delivered: false,
      retrySafe: true,
      line: "Changed.",
    });
  });

  it("sends an answer once and reports the outcome", async () => {
    const seen = [];
    const commands = {
      run: async (kind, input) => {
        seen.push([kind, input]);
        return { ok: true, result: { said: "Done" } };
      },
    };
    const out = await sendAnswer(commands, { filmId: FILM_A }, c, { type: "choose", value: "a" });
    expect(seen).toHaveLength(1);
    expect(out).toMatchObject({ delivered: true, line: "Done" });
  });
});

describe("the brief", () => {
  const brief = {
    fields: [
      { key: "title", label: "Title", kind: "text", value: "Dawn", options: [], min: null, max: null },
      { key: "length", label: "Length", kind: "number", value: 60, options: [], min: 15, max: 120 },
      {
        key: "tone",
        label: "Tone",
        kind: "choice",
        value: "calm",
        options: [{ id: "calm", label: "Calm" }],
        min: null,
        max: null,
      },
      { key: "music", label: "Music", kind: "bool", value: true, options: [], min: null, max: null },
      { key: "notes", label: "Notes", kind: "longtext", value: null, options: [], min: null, max: null },
    ],
    format: { tile: "size", option: "wide", label: "Wide" },
    formats: [],
    findings: [],
    captures: [],
  };

  it("starts from the brief and sends numbers as numbers, with the format", () => {
    const form = briefInit(brief);
    expect(form.texts).toEqual({ title: "Dawn", length: "60", notes: "" });
    expect(form.picks).toEqual({ tone: "calm", music: true });
    form.texts.length = " 90 ";
    form.picks.music = false;
    expect(briefSubmission(brief, form)).toEqual({
      fields: { title: "Dawn", length: 90, tone: "calm", music: false, notes: "" },
      format: { tile: "size", option: "wide" },
    });
    // The Mac's own shape accepts it as a submit.
    const [, input] = answerCommand(
      { filmId: FILM_A },
      { step: "s", revision: "r" },
      { type: "submit", value: briefSubmission(brief, form) },
    );
    expect(() => shape("film", input)).not.toThrow();
  });

  it("refuses a number the field's range does not allow", () => {
    const field = brief.fields[1];
    expect(numberProblem(field, "")).toBe("Enter a number.");
    expect(numberProblem(field, "abc")).toBe("That isn't a number.");
    expect(numberProblem(field, "10")).toBe("At least 15.");
    expect(numberProblem(field, "500")).toBe("At most 120.");
    expect(numberProblem(field, "60")).toBeNull();
    expect(briefValid(brief, { length: "5" })).toBe(false);
    expect(briefValid(brief, { length: "60" })).toBe(true);
  });

  it("leaves an unset choice out, and no format when none is picked", () => {
    const form = { texts: {}, picks: { tone: null }, format: null };
    const out = briefSubmission({ ...brief, fields: [brief.fields[2]] }, form);
    expect(out).toEqual({ fields: {} });
  });
});

describe("Ask Rasan", () => {
  const server = [
    { id: "1", who: "rasan", text: "Hello", t: null, state: null },
    { id: "2", who: "you", text: "Make it  darker", t: null, state: "pending" },
  ];

  it("settles a typed line against the Mac's thread by its words", () => {
    const local = [
      { id: "a", text: "Make it darker", at: 0, state: "sent" },
      { id: "b", text: "Make it darker", at: 0, state: "sent" },
      { id: "c", text: "new", at: 0, state: "sending" },
      { id: "d", text: "broken", at: 0, state: "failed", reason: "Nope." },
    ];
    const rows = chatRows(server, local);
    // The Mac shows "Make it darker" once, so it settles one typed line; the second identical one is still on its way.
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "local-b", "local-c", "local-d"]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["2"].status).toBe("Sent, waiting for Rasan to read it");
    expect(byId["1"].isYou).toBe(false);
    expect(byId["local-b"].status).toBe("Sent, waiting for Rasan to read it");
    expect(byId["local-c"].status).toBe("Sending\u2026");
    expect(byId["local-d"]).toMatchObject({ failed: true, status: "Nope.", local: "d" });
  });

  it("drops settled and old typed lines but keeps a failed one", () => {
    const local = [
      { id: "a", text: "Make it darker", at: 0, state: "sent" },
      { id: "b", text: "other", at: 100_000, state: "sent" },
      { id: "c", text: "stale", at: 0, state: "sent" },
      { id: "d", text: "bad", at: 0, state: "failed" },
    ];
    expect(settledChat(server, local, 650_000, 600_000).map((l) => l.id)).toEqual(["b", "d"]);
  });

  it("says why asking is unavailable", () => {
    const base = { canChat: false, engineNote: null, director: { state: "running" } };
    expect(chatReason({ ...base, canChat: true })).toBeNull();
    expect(chatReason({ ...base, engineNote: "Update RasanAI Studio." })).toBe("Update RasanAI Studio.");
    expect(chatReason({ ...base, director: { state: "finished" } })).toBe(
      "The film is finished, so there is no one to ask.",
    );
    expect(chatReason(base)).toBe("Asking Rasan isn't available for this film.");
  });

  it("sends one line, and an unconfirmed one is failed and not safe to send again", async () => {
    let calls = 0;
    const answer = (out) => ({ run: async () => (calls++, out) });
    expect(await sendChat(answer({ ok: true }), FILM_A, "hi")).toEqual({
      state: "sent",
      reason: null,
      retrySafe: false,
    });
    expect(await sendChat(answer({ ok: false, retrySafe: true, reason: "Busy." }), FILM_A, "hi")).toEqual({
      state: "failed",
      reason: "Busy.",
      retrySafe: true,
    });
    const lost = await sendChat(answer({ ok: false, unconfirmed: true, retrySafe: false, reason: "?" }), FILM_A, "hi");
    expect(lost.retrySafe).toBe(false);
    expect(lost.reason).toContain("Check the film");
    const before = calls;
    expect((await sendChat(answer({ ok: true }), FILM_A, "   ")).state).toBe("failed");
    expect(calls).toBe(before);
  });
});

/* ---------- review ---------- */

const review = (o = {}) => ({
  kind: "animatic",
  scenes: [
    { id: "s1", title: "One", line: null, start: 0, seconds: 5, thumb: null },
    { id: "s2", title: "Two", line: null, start: 5, seconds: 5, thumb: null },
  ],
  media: { kind: "video", source: "m/1", poster: null },
  duration: 10,
  notes: [
    { id: "n1", t: 1, scene: "s1", x: null, y: null, text: "a", state: "open", resolution: null },
    { id: "n2", t: 2, scene: "s1", x: null, y: null, text: "b", state: "resolved", resolution: "done" },
  ],
  finish: ["approve", "preview"],
  quick: ["Slower"],
  ...o,
});

describe("review helpers", () => {
  it("formats the clock and finds the scene at a moment", () => {
    expect(clock(65.9)).toBe("1:05");
    expect(clock(-3)).toBe("0:00");
    expect(clock(NaN)).toBe("0:00");
    const r = review();
    expect(sceneAt(r, 0).id).toBe("s1");
    expect(sceneAt(r, 4.99).id).toBe("s1");
    expect(sceneAt(r, 5).id).toBe("s2");
    expect(sceneAt(r, 99).id).toBe("s2");
    expect(sceneAt({ scenes: [] }, 1)).toBeNull();
    expect(openNotes(r).map((n) => n.id)).toEqual(["n1"]);
  });

  it("maps a tap on the frame to fractions of the picture, not its letterbox", () => {
    // A 16:9 picture in a 400x400 box sits in the middle band.
    const rect = pictureRect(400, 400, 1600, 900);
    expect(rect).toEqual({ left: 0, top: 87.5, width: 400, height: 225 });
    expect(pinFromTap(200, 200, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(pinFromTap(0, 87.5, rect)).toEqual({ x: 0, y: 0 });
    expect(pinFromTap(200, 10, rect)).toBeNull();
    expect(pinFromTap(200, 390, rect)).toBeNull();
    expect(pictureRect(0, 100, 10, 10)).toBeNull();
    // Without a size for the picture the whole box counts.
    expect(pictureRect(300, 200, 0, 0)).toEqual({ left: 0, top: 0, width: 300, height: 200 });
  });

  it("builds a note's value with a pin only when one is set", () => {
    expect(noteValue({ t: 3, scene: "s1", pin: { x: 0.25, y: 0.75 }, quick: "Slower" })).toEqual({
      t: 3,
      scene: "s1",
      quick: "Slower",
      x: 0.25,
      y: 0.75,
    });
    expect(noteValue({ t: 3, scene: undefined, pin: null, quick: null })).toEqual({ t: 3, scene: null, quick: null });
    expect(canSendNote("  ", null)).toBe(false);
    expect(canSendNote("", "Slower")).toBe(true);
    expect(canSendNote("fix", null)).toBe(true);
  });

  it("closes the call with apply when notes are open, else approve, render or preview", () => {
    expect(reviewFooter(review(), 2)).toEqual([
      { id: "apply", label: "Apply 2 notes", primary: true, type: "apply", value: null },
    ]);
    expect(reviewFooter(review(), 1)[0].label).toBe("Apply 1 note");
    const none = reviewFooter(review(), 0);
    expect(none.map((a) => a.id)).toEqual(["approve", "preview"]);
    expect(none[0].label).toBe("Looks right, build it");
    expect(reviewFooter(review({ kind: "final", finish: ["approve"] }), 0)[0].label).toBe("Looks right");
    expect(reviewFooter(review({ finish: ["render"] }), 0)).toEqual([
      { id: "render", label: "Render the final", primary: true, type: "choose", value: "render" },
    ]);
    expect(reviewFooter(review({ finish: [] }), 0)).toEqual([]);
  });
});

/* ---------- media chunks ---------- */

const bytesOf = (...n) => Uint8Array.from(n);
const sha = async (bytes) => `d:${Array.from(bytes).join(",")}`.padEnd(64, "0");

function mediaFixture(parts, { mime = "video/mp4", digestOf } = {}) {
  const joined = Uint8Array.from(parts.flatMap((p) => [...p]));
  const ref = { id: "abcdef012345", chunks: parts.length, bytes: joined.length, sha256: "x".repeat(64), mime };
  return { ref, joined, parts, digestOf };
}

describe("media chunks", () => {
  const channel = (parts, { drop = null, swap = false } = {}) => ({
    key: "k",
    path: (kind, id) => `${kind}/${id}`,
    db: {
      get: async (path) => {
        const index = Number(path.split("-").pop());
        if (index === drop) return null;
        const at = swap ? (index + 1) % parts.length : index;
        return { box: JSON.stringify({ i: at, n: parts.length, data: Array.from(parts[at]).join(",") }) };
      },
    },
  });
  const open = async (_key, box) => JSON.parse(box);
  const decode = (text) => Uint8Array.from(text.split(",").map(Number));

  it("reads a reference only when it is well formed", () => {
    const good = { id: "abcdef012345", chunks: 2, bytes: 10, sha256: "a".repeat(64), mime: "video/mp4" };
    expect(readMediaRef(good)).toEqual(good);
    expect(readMediaRef({ ...good, id: "../x" })).toBeNull();
    expect(readMediaRef({ ...good, chunks: 0 })).toBeNull();
    expect(readMediaRef({ ...good, chunks: 401 })).toBeNull();
    expect(readMediaRef({ ...good, sha256: "zz" })).toBeNull();
    expect(readMediaRef({ ...good, mime: "text/html" })).toBeNull();
    expect(readMediaRef(null)).toBeNull();
  });

  it("assembles the chunks in order and checks length and hash", async () => {
    const parts = [bytesOf(1, 2), bytesOf(3), bytesOf(4, 5), bytesOf(6)];
    const { ref, joined } = mediaFixture(parts);
    const progress = [];
    const digest = async (bytes) => (bytes.length === joined.length ? ref.sha256 : "bad");
    const out = await fetchMediaBytes(channel(parts), ref, {
      open,
      decode,
      digest,
      onProgress: (p) => progress.push(p),
    });
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress).toEqual([0.5, 1]);
  });

  it("refuses a hash mismatch, a missing chunk, a mislabelled chunk and a wrong length", async () => {
    const parts = [bytesOf(1, 2), bytesOf(3)];
    const { ref } = mediaFixture(parts);
    const okDigest = async () => ref.sha256;
    await expect(fetchMediaBytes(channel(parts), ref, { open, decode, digest: async () => "other" })).rejects.toThrow(
      MediaError,
    );
    await expect(fetchMediaBytes(channel(parts, { drop: 1 }), ref, { open, decode, digest: okDigest })).rejects.toThrow(
      "gone from the channel",
    );
    await expect(
      fetchMediaBytes(channel(parts, { swap: true }), ref, { open, decode, digest: okDigest }),
    ).rejects.toThrow("didn't check out");
    await expect(
      fetchMediaBytes(channel(parts), { ...ref, bytes: 99 }, { open, decode, digest: okDigest }),
    ).rejects.toThrow("incomplete");
  });

  it("stops between batches when cancelled", async () => {
    const parts = [bytesOf(1), bytesOf(2), bytesOf(3), bytesOf(4)];
    const { ref } = mediaFixture(parts);
    let polls = 0;
    await expect(
      fetchMediaBytes(channel(parts), ref, { open, decode, digest: sha, cancelled: () => polls++ > 0 }),
    ).rejects.toThrow("Cancelled");
  });
});

/* ---------- the review state machine ---------- */

function session({
  mediaOut,
  bytes = bytesOf(1, 2, 3),
  answer = { ok: true, result: { said: "Sent" } },
  c = card({ call: "animatic", review: review() }),
} = {}) {
  const log = { urls: [], revoked: [], commands: [], changes: 0 };
  const ref = { id: "abcdef012345", chunks: 1, bytes: bytes.length, sha256: "a".repeat(64), mime: "video/mp4" };
  const parsed = readCard(c);
  const deps = {
    commands: {
      media: async (req) => (log.commands.push(["media", req]), mediaOut ?? { ok: true, result: { media: ref } }),
      run: async (kind, input) => (
        log.commands.push([kind, input]),
        typeof answer === "function" ? answer(input) : answer
      ),
    },
    channel: {
      key: "k",
      path: (kind, id) => `${kind}/${id}`,
      db: { get: async () => ({ box: "b" }) },
    },
    open: async () => ({ i: 0, n: 1, data: "AQID" }),
    decode: () => bytes,
    digest: async () => ref.sha256,
    makeUrl: (b, mime) => {
      const url = `blob:${log.urls.length}`;
      log.urls.push([url, b.length, mime]);
      return url;
    },
    revokeUrl: (url) => log.revoked.push(url),
    onChange: () => log.changes++,
  };
  return { s: new ReviewSession({ owner: { filmId: FILM_A }, card: parsed, deps }), log };
}

describe("the review session", () => {
  it("brings the copy over only when asked, once, and revokes its URL on leave", async () => {
    const { s, log } = session();
    expect(s.phase).toBe("idle");
    expect(log.commands).toEqual([]);
    const a = s.loadMedia();
    const b = s.loadMedia();
    await Promise.all([a, b]);
    expect(log.commands.filter((c) => c[0] === "media")).toHaveLength(1);
    expect(log.commands[0][1]).toEqual({ filmId: FILM_A, source: "m/1" });
    expect(s.phase).toBe("ready");
    expect(log.urls).toEqual([["blob:0", 3, "video/mp4"]]);
    s.release();
    expect(log.revoked).toEqual(["blob:0"]);
    expect(s.phase).toBe("idle");
    expect(s.url).toBeNull();
  });

  it("names a chat's session instead of a film", async () => {
    const { s, log } = session();
    s.owner = { sessionKey: "k:7" };
    await s.loadMedia();
    expect(log.commands[0][1]).toEqual({ sessionKey: "k:7", source: "m/1" });
  });

  it("fails with the Mac's reason, allows trying again, and a late answer after leaving is dropped", async () => {
    const { s } = session({ mediaOut: { ok: false, reason: "Not here." } });
    await s.loadMedia();
    expect(s.phase).toBe("failed");
    expect(s.problem).toBe("Not here.");
    const second = session({ mediaOut: { ok: true, result: { media: { id: "bad" } } } });
    await second.s.loadMedia();
    expect(second.s.problem).toBe("Your Mac sent something this page can't play.");
    const slow = session();
    const pending = slow.s.loadMedia();
    slow.s.release();
    await pending;
    expect(slow.s.phase).toBe("idle");
    expect(slow.log.urls).toEqual([]);
  });

  it("composes a note: pin, quick chip, words, then sends it and leaves the call open", async () => {
    const { s, log } = session();
    expect(s.canSendNote).toBe(false);
    s.setPin({ x: 0.5, y: 0.5 });
    expect(s.pin).toBeNull();
    s.startNote();
    s.setPin({ x: 0.2, y: 0.4 });
    expect(s.canSendNote).toBe(false);
    s.toggleQuick("Slower");
    expect(s.canSendNote).toBe(true);
    s.toggleQuick("Slower");
    expect(s.canSendNote).toBe(false);
    s.setWords("  too fast  ");
    await s.sendNote(12.5, "s2");
    const [kind, input] = log.commands.at(-1);
    expect(kind).toBe("film");
    expect(input).toMatchObject({
      op: "answer",
      type: "comment",
      note: "too fast",
      value: { t: 12.5, scene: "s2", x: 0.2, y: 0.4, quick: null },
    });
    expect(() => shape(kind, input)).not.toThrow();
    expect(s.composing).toBe(false);
    expect(s.closed).toBe(false);
    expect(s.line.delivered).toBe(true);
  });

  it("keeps a failed note's draft open so it can be sent again", async () => {
    const { s } = session({ answer: { ok: false, retrySafe: true, reason: "Changed." } });
    s.startNote();
    s.setWords("x");
    await s.sendNote(1, null);
    expect(s.composing).toBe(true);
    expect(s.words).toBe("x");
    expect(s.line).toMatchObject({ delivered: false, text: "Changed.", retrySafe: true });
  });

  it("does not double-send while a note is in flight", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { s, log } = session({ answer: () => gate });
    s.startNote();
    s.setWords("x");
    const first = s.sendNote(1, null);
    await s.sendNote(1, null);
    expect(log.commands.filter((c) => c[0] === "film")).toHaveLength(1);
    release({ ok: true, result: {} });
    await first;
  });

  it("applies the open notes and closes the call; a refusal leaves it open", async () => {
    const { s, log } = session();
    expect(s.footer.map((a) => a.id)).toEqual(["apply"]);
    await s.finish("apply");
    expect(log.commands.at(-1)[1]).toMatchObject({ type: "apply", step: "look-1", revision: "rev-1" });
    expect(s.closed).toBe(true);
    expect(s.footer).toEqual([]);
    const refused = session({ answer: { ok: false, retrySafe: true, reason: "The call moved on." } });
    await refused.s.finish("apply");
    expect(refused.s.closed).toBe(false);
    expect(refused.s.line.text).toBe("The call moved on.");
  });

  it("does not close the call when the answer could not be confirmed", async () => {
    const { s } = session({ answer: { ok: false, unconfirmed: true, retrySafe: false, reason: "?" } });
    await s.finish("apply");
    expect(s.closed).toBe(false);
    expect(s.line.retrySafe).toBe(false);
    expect(s.line.text).toContain("didn't confirm");
  });

  it("sends 'choose render' as a plain id for the final", async () => {
    const final = card({ call: "final", review: review({ kind: "final", notes: [], finish: ["render"] }) });
    const { s, log } = session({ c: final });
    await s.finish("render");
    expect(log.commands.at(-1)[1]).toMatchObject({ type: "choose", value: "render" });
  });
});
