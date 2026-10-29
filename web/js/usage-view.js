// Usage and Usage details (UsageView.swift, UsageDetailsView.swift). Plan windows for Claude and Codex as
// ink bars, a Refresh that asks the Mac (once a minute at most), and Details (tokens, cost, models, streaks,
// projects) over 7 days, 30 days or all time, only for a Mac that answers `stats`.
//
// The page rebuilds its DOM on every draw, so what this screen remembers lives here, in `state`; a draw reads
// it and an answer that lands later calls `ctx.touch()`.

import { h } from "./dom.js";
import {
  AGENTS,
  RANGES,
  REFRESH_FOOTNOTE,
  asOf,
  claudeCodeRecord,
  cost,
  dailyBars,
  day,
  headlineTiles,
  isOpening,
  model as modelName,
  providerRows,
  recordNote,
  refreshNote,
  refreshWait,
  resets,
  source,
  statsFits,
  statsRequest,
  tokenRows,
  tokens,
  usedFraction,
  usedLabel,
} from "./usage-logic.js";
import { statsResult, usage as readUsage, usageStats } from "./view-model.js";

import { keepScroll } from "./screen-scroll.js";

export const title = () => "Usage";
const SCREEN_KEY = () => (state.details ? "details" : "main");

export const state = {
  lastRenderAt: null,
  refreshing: false,
  note: null,
  lastRefreshAt: null,
  details: false,
  agent: "claude",
  range: "7d",
  /** `${agent} ${range}` -> the last good answer */
  stats: new Map(),
  loading: null,
  problem: null,
  record: null,
};

/** For tests. */
export function resetUsageState() {
  Object.assign(state, {
    lastRenderAt: null,
    refreshing: false,
    note: null,
    lastRefreshAt: null,
    details: false,
    agent: "claude",
    range: "7d",
    stats: new Map(),
    loading: null,
    problem: null,
    record: null,
  });
}

/** Asks the Mac for a fresh reading. Never twice at once, and not inside the Mac's own minute. */
export async function refresh(ctx, now = () => Date.now()) {
  if (state.refreshing) return;
  const wait = Math.max(refreshWait(state.lastRefreshAt, now()), ctx.commands?.waitMs?.("usage") ?? 0);
  if (wait > 0) {
    state.note = "Already up to date: read in the last minute.";
    ctx.touch?.();
    return;
  }
  state.refreshing = true;
  state.lastRefreshAt = now();
  ctx.touch?.();
  const out = await ctx.commands.usage({});
  state.refreshing = false;
  state.note = refreshNote(out);
  ctx.touch?.();
}

/** Loads one (agent, range) of Details. An answer for a pick that is no longer on screen is dropped. */
export async function loadStats(ctx) {
  const asked = statsRequest(state.range, state.agent);
  if (!asked) return;
  const key = `${asked.agent} ${asked.range}`;
  if (state.loading === key) return;
  state.loading = key;
  ctx.touch?.();
  const out = await ctx.commands.stats(asked);
  if (state.loading === key) state.loading = null;
  if (out.ok) {
    const stats = statsResult(out.result);
    if (stats && statsFits(stats, asked.range, asked.agent)) {
      state.stats.set(key, { stats, record: claudeCodeRecord(out.result) });
      if (key === `${state.agent} ${state.range}`) state.problem = null;
    } else if (key === `${state.agent} ${state.range}`) {
      state.problem = "Your Mac sent usage details this page can't read.";
    }
  } else if (key === `${state.agent} ${state.range}`) {
    state.problem = out.reason;
  }
  ctx.touch?.();
}

const bar = (fraction) => {
  const fill = h("span", { class: "ubar-fill" });
  fill.style.width = `${Math.max(fraction * 100, fraction > 0 ? 1.5 : 0)}%`;
  return h("span", { class: "ubar", "aria-hidden": "true" }, fill);
};

function windowRow(name, window, now) {
  return h(
    "div",
    { class: "urow" },
    h(
      "div",
      { class: "urow-head" },
      h("span", { class: "urow-name" }, name),
      window ? h("span", { class: "urow-value" }, usedLabel(window.usedPercent, window.resetsAt, now)) : null,
    ),
    window ? bar(usedFraction(window.usedPercent, window.resetsAt, now)) : null,
    h("div", { class: "urow-note" }, window ? resets(window.resetsAt, now) : "Not reported"),
  );
}

function providerCard(name, provider, usage, now, empty) {
  const rows = providerRows(provider, usage);
  const observed = usage?.[provider]?.observedAt ?? null;
  const stale = rows ? asOf(observed, now) : null;
  return h(
    "section",
    { class: "usection" },
    h("div", { class: "usection-head" }, h("h2", null, name), stale ? h("span", { class: "urow-note" }, stale) : null),
    rows ? rows.map((r) => windowRow(r.name, r.window, now)) : h("p", { class: "note" }, empty),
  );
}

function pick(label, options, current, choose) {
  return h(
    "div",
    { class: "seg", role: "group", "aria-label": label },
    options.map((o) =>
      h(
        "button",
        {
          class: "seg-btn",
          type: "button",
          "aria-pressed": o.id === current ? "true" : "false",
          onclick: () => choose(o.id),
        },
        o.label,
      ),
    ),
  );
}

function section(titleText, ...children) {
  return h("section", { class: "usection" }, h("h2", null, titleText), children);
}

function detailsBody(ctx, entry) {
  const { stats, record } = entry;
  const body = [];
  if (stats.pending > 0) {
    body.push(
      h(
        "p",
        { class: "note" },
        `Your Mac is still reading ${stats.pending} files for the first time, so these will grow.`,
      ),
    );
  }
  body.push(
    h(
      "div",
      { class: "utiles" },
      headlineTiles(stats).map((t) =>
        h(
          "div",
          { class: "utile" },
          h("span", { class: "urow-note" }, t.title),
          h("span", { class: "utile-value" }, t.value),
          t.detail ? h("span", { class: "urow-note" }, t.detail) : null,
        ),
      ),
    ),
  );
  body.push(
    section(
      "Tokens",
      tokenRows(stats.totals).map((r) =>
        h(
          "div",
          { class: "urow" },
          h(
            "div",
            { class: "urow-head" },
            h("span", { class: "urow-name" }, r.name),
            h("span", { class: "urow-value" }, tokens(r.value)),
          ),
          bar(r.share),
        ),
      ),
      h(
        "p",
        { class: "note" },
        "Cache reads are the context an agent reads again each turn; they cost a tenth of fresh input or less.",
      ),
    ),
  );
  if (stats.daily.length > 0) {
    const { peak, bars } = dailyBars(stats.daily);
    const chart = h(
      "div",
      { class: "udaily", role: "img", "aria-label": `Tokens by day, peak ${tokens(peak)}` },
      bars.map((b) => {
        const column = h("span", { class: b.tokens > 0 ? "udaily-bar on" : "udaily-bar" });
        column.style.height = `${Math.max(2, 96 * b.share)}px`;
        return h("span", { class: "udaily-col" }, column);
      }),
    );
    body.push(
      section(
        stats.range === "all" ? "Last 30 active days" : "By day",
        chart,
        h(
          "div",
          { class: "udaily-axis" },
          h("span", null, day(stats.daily[0].date) ?? ""),
          h("span", null, `Peak ${tokens(peak)}`),
          h("span", null, day(stats.daily[stats.daily.length - 1].date) ?? ""),
        ),
      ),
    );
  }
  if (stats.models.length > 0) {
    body.push(
      section(
        "Models",
        stats.models.map((m) =>
          h(
            "div",
            { class: "urow" },
            h(
              "div",
              { class: "urow-head" },
              h("span", { class: "urow-name" }, modelName(m.model)),
              h("span", { class: "urow-value" }, `${Math.round(m.share * 100)}%`),
            ),
            bar(Math.min(1, Math.max(0, m.share))),
            h(
              "div",
              { class: "urow-note" },
              [`${tokens(m.tokens)} tokens`, cost(m.costUsd)].filter(Boolean).join(" · "),
            ),
          ),
        ),
      ),
    );
  }
  if (stats.projects.length > 0) {
    body.push(
      section(
        "Top projects",
        stats.projects.map((p) =>
          h(
            "div",
            { class: "urow" },
            h(
              "div",
              { class: "urow-head" },
              h("span", { class: "urow-name uclip" }, p.name),
              h("span", { class: "urow-value" }, tokens(p.tokens)),
            ),
            bar(stats.totals.tokens > 0 ? Math.min(1, p.tokens / stats.totals.tokens) : 0),
          ),
        ),
      ),
    );
  }
  body.push(
    section(
      "Where this comes from",
      h("p", { class: "note" }, source(stats)),
      record
        ? h(
            "div",
            { class: "utile wide" },
            h(
              "div",
              { class: "urow-head" },
              h("span", { class: "urow-name" }, "Claude Code's own count"),
              h("span", { class: "urow-value" }, tokens(record.tokens)),
            ),
            h("div", { class: "urow-note" }, recordNote(record)),
          )
        : null,
    ),
  );
  return body;
}

function detailsScreen(ctx) {
  const key = `${state.agent} ${state.range}`;
  const entry = state.stats.get(key) ?? null;
  const picks = [
    pick("Agent", AGENTS, state.agent, (id) => {
      state.agent = id;
      state.problem = null;
      ctx.touch?.();
      if (!state.stats.has(`${id} ${state.range}`)) void loadStats(ctx);
    }),
    pick("Range", RANGES, state.range, (id) => {
      state.range = id;
      state.problem = null;
      ctx.touch?.();
      if (!state.stats.has(`${state.agent} ${id}`)) void loadStats(ctx);
    }),
  ];
  if (!entry && state.loading === null && state.problem === null) void Promise.resolve().then(() => loadStats(ctx));
  return h(
    "div",
    { class: "screen usage", "data-key": SCREEN_KEY() },
    h(
      "button",
      {
        class: "btn quiet",
        type: "button",
        onclick: () => {
          state.details = false;
          ctx.touch?.();
        },
      },
      "‹ Usage",
    ),
    h("h1", null, "Details"),
    picks,
    entry ? detailsBody(ctx, entry) : null,
    !entry && state.loading === key ? h("p", { class: "note", role: "status" }, "Asking your Mac…") : null,
    state.problem ? h("p", { class: "note", role: "alert" }, state.problem) : null,
    h(
      "button",
      { class: "btn quiet", type: "button", disabled: state.loading !== null, onclick: () => void loadStats(ctx) },
      "Reload",
    ),
  );
}

export function render(ctx) {
  const now = Date.now();
  const opening = isOpening(state.lastRenderAt, now);
  state.lastRenderAt = now;
  const view = ctx.view ?? null;
  keepScroll("screen.usage", SCREEN_KEY());

  if (state.details && usageStats(view)) return [detailsScreen(ctx)];
  state.details = false;

  if (opening && view && readUsage(view) !== null && !state.refreshing) void refresh(ctx);

  const usage = readUsage(view);
  const head = h(
    "div",
    { class: "usage-head" },
    h("h1", null, "Usage"),
    h(
      "button",
      {
        class: "btn",
        type: "button",
        disabled: state.refreshing || view === null,
        "aria-busy": state.refreshing ? "true" : "false",
        onclick: () => void refresh(ctx),
      },
      state.refreshing ? "Refreshing…" : "Refresh",
    ),
  );
  const body = [];
  if (view === null) body.push(h("p", { class: "note" }, "Waiting for your Mac."));
  else if (usage === null)
    body.push(h("p", { class: "note" }, "Your Mac hasn't sent usage yet. Update Squeak on your Mac to see it here."));
  else {
    body.push(providerCard("Claude", "claude", usage, now, "Not seen yet. Press Refresh."));
    body.push(providerCard("Codex", "codex", usage, now, "Not seen yet. Codex reports it once a session has run."));
    if (usageStats(view)) {
      body.push(
        h(
          "button",
          {
            class: "ulink",
            type: "button",
            onclick: () => {
              state.details = true;
              ctx.touch?.();
            },
          },
          h(
            "span",
            { class: "ulink-text" },
            h("strong", null, "Details"),
            h("span", { class: "urow-note" }, "Tokens, cost, models, streaks and projects"),
          ),
          h("span", { "aria-hidden": "true" }, "›"),
        ),
      );
    }
  }
  return [
    h(
      "div",
      { class: "screen usage", "data-key": SCREEN_KEY() },
      head,
      body,
      h("p", { class: "note", role: "status" }, state.note ?? REFRESH_FOOTNOTE),
    ),
  ];
}
