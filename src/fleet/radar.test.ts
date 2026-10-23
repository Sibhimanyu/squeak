import type { TelegramInlineKeyboardButton } from "../types.js";
import { describe, expect, it, vi } from "vitest";

import { canReplyFromCard } from "./fleet-controller.js";

import type { FleetSnapshot } from "./fleet-monitor.js";
import {
  attentionCardKeyboard,
  cardLabel,
  formatAge,
  formatCountdown,
  diffSummaryKeyboard,
  originLabel,
  radarKeyboard,
  renderAttentionCard,
  renderQuotaAlert,
  renderRadar,
  renderUsage,
  sessionLabel,
  shortenPath,
  stateGlyph,
  truncateStart,
} from "./radar.js";
import type { AttentionItem, FleetSession } from "./types.js";

const now = Date.parse("2026-09-20T12:00:00.000Z");

/** The callback of a callback button; "" for a link button. */
function callbackData(button: TelegramInlineKeyboardButton | undefined): string {
  return button && "callback_data" in button ? button.callback_data : "";
}

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "claude-transcript:abc",
    source: "claude-transcript",
    agent: "claude",
    origin: "terminal",
    sourceId: "abc",
    agentSessionId: "abc",
    conductorSessionId: null,
    cwd: "/Users/someone/repo",
    repoName: "repo",
    branch: "main",
    title: "Fix the parser",
    state: "working",
    detail: null,
    lastActivityAt: "2026-09-20T11:58:00.000Z",
    transcriptPath: null,
    pid: null,
    alive: true,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
    ...overrides,
  };
}

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    session: session({ state: "awaiting_approval" }),
    kind: "blocked_approval",
    score: 1000,
    since: "2026-09-20T11:50:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    sessions: [],
    attention: [],
    generatedAt: "2026-09-20T12:00:00.000Z",
    codexUsage: null,
    ...overrides,
    // The radar renders the active set; default it to whatever the test
    // supplied as sessions so each case reads as one list.
    active: overrides.active ?? overrides.sessions ?? [],
  };
}

describe("formatAge", () => {
  it("reads as a glance, not a timestamp", () => {
    expect(formatAge("2026-09-20T11:59:40.000Z", now)).toBe("just now");
    expect(formatAge("2026-09-20T11:57:00.000Z", now)).toBe("3m");
    expect(formatAge("2026-09-20T10:00:00.000Z", now)).toBe("2h");
    expect(formatAge("2026-09-20T09:50:00.000Z", now)).toBe("2h 10m");
    expect(formatAge("2026-09-18T12:00:00.000Z", now)).toBe("2d");
  });

  it("does not print a negative age for clock skew", () => {
    expect(formatAge("2026-09-20T12:05:00.000Z", now)).toBe("just now");
  });
});

describe("renderRadar", () => {
  it("lists each section newest first, even when an older session is the blocked one", () => {
    const text = renderRadar(
      snapshot({
        sessions: [
          session({ key: "w-old", title: "Old worker", state: "working", lastActivityAt: "2026-09-20T11:00:00.000Z" }),
          session({ key: "w-new", title: "New worker", state: "working", lastActivityAt: "2026-09-20T11:59:00.000Z" }),
          session({
            key: "b-old",
            title: "Old ask",
            state: "awaiting_input",
            lastActivityAt: "2026-09-20T10:00:00.000Z",
          }),
          session({
            key: "b-new",
            title: "New ask",
            state: "awaiting_input",
            lastActivityAt: "2026-09-20T11:30:00.000Z",
          }),
        ],
      }),
      now,
    );
    // Blocked stays its own section first; inside each section, newest first.
    expect(text.indexOf("New ask")).toBeLessThan(text.indexOf("Old ask"));
    expect(text.indexOf("Old ask")).toBeLessThan(text.indexOf("New worker"));
    expect(text.indexOf("New worker")).toBeLessThan(text.indexOf("Old worker"));
  });

  it("always names the agent, so two sessions on the same branch are never identical rows", () => {
    // Conductor allows a Claude chat and a Codex chat open on the same
    // workspace at once; before this, two such rows rendered with nothing to
    // tell them apart.
    const text = renderRadar(
      snapshot({
        sessions: [
          session({ key: "a", agent: "claude", origin: "conductor" }),
          session({ key: "b", agent: "codex", origin: "conductor" }),
        ],
      }),
      now,
    );

    expect(text).toContain("claude");
    expect(text).toContain("codex");
  });

  it("still appends where the session came from, after the agent", () => {
    const text = renderRadar(snapshot({ sessions: [session({ agent: "claude", origin: "terminal" })] }), now);
    expect(text).toContain("claude terminal");
  });

  it("names every origin but Conductor's, in one place for every surface", () => {
    expect(originLabel({ origin: "terminal", conductorSessionId: null })).toBe("terminal");
    expect(originLabel({ origin: "desktop", conductorSessionId: null })).toBe("desktop");
    expect(originLabel({ origin: "cowork", conductorSessionId: null })).toBe("cowork");
    expect(originLabel({ origin: "sdk", conductorSessionId: null })).toBe("headless");
    expect(originLabel({ origin: "conductor", conductorSessionId: "c1" })).toBeNull();
    expect(originLabel({ origin: "unknown", conductorSessionId: null })).toBe("external");
  });

  it("bolds the session heading so it stands out from the detail line beneath it", () => {
    const text = renderRadar(snapshot({ sessions: [session({ repoName: "repo", branch: "main" })] }), now);
    expect(text).toContain("**repo · main**");
  });

  it("adds each session's own title only once two rows share a label", () => {
    // Same repo, same branch, same agent — a real, current scenario: two
    // Claude chats open on one Conductor workspace. Agent identity cannot
    // separate these; only the sessions' own titles can.
    const text = renderRadar(
      snapshot({
        sessions: [
          session({ key: "a", title: "Blume Conductor Master App" }),
          session({ key: "b", title: "Telegram Squeak message improve" }),
        ],
      }),
      now,
    );

    expect(text).toContain("(Blume Conductor Master App)");
    expect(text).toContain("(Telegram Squeak message improve)");
  });

  it("does not add a title when there is nothing to disambiguate", () => {
    const text = renderRadar(snapshot({ sessions: [session({ title: "Blume Conductor Master App" })] }), now);
    expect(text).not.toContain("(Blume Conductor Master App)");
  });

  it("treats Conductor's own 'Untitled' placeholder as no title at all", () => {
    const text = renderRadar(
      snapshot({ sessions: [session({ key: "a", title: "Untitled" }), session({ key: "b", title: "Untitled" })] }),
      now,
    );
    expect(text).not.toContain("(Untitled)");
  });

  it("truncates a long title rather than letting one row run on", () => {
    const long = "A very long session title that goes on for quite a while describing everything";
    const text = renderRadar(
      snapshot({ sessions: [session({ key: "a", title: long }), session({ key: "b", title: "Short" })] }),
      now,
    );
    expect(text).toContain("…)");
    expect(text).not.toContain(long);
  });

  it("flags context usage past the pressure threshold instead of blending it into the line", () => {
    const calm = renderRadar(snapshot({ sessions: [session({ contextPercent: 65 })] }), now);
    const hot = renderRadar(snapshot({ sessions: [session({ contextPercent: 88 })] }), now);

    expect(calm).toContain("ctx 65%");
    expect(calm).not.toContain("⚠️");
    expect(hot).toContain("⚠️ ctx 88%");
  });

  it("leads with what is blocking and counts each state", () => {
    const blocked = session({ state: "awaiting_approval", detail: "Claude needs permission to use Bash" });
    const text = renderRadar(snapshot({ sessions: [blocked, session({ state: "working" })] }), now);

    expect(text).toContain("1 needs you");
    expect(text).toContain("1 working");
    expect(text).toContain("needs approval");
    expect(text).toContain("repo · main");
  });

  it("puts blocked sessions above finished ones, and finished above working", () => {
    const text = renderRadar(
      snapshot({
        sessions: [
          session({ key: "w", state: "working", repoName: "working-repo" }),
          session({ key: "d", state: "finished", repoName: "done-repo" }),
          session({ key: "b", state: "awaiting_input", repoName: "blocked-repo" }),
        ],
      }),
      now,
    );

    // Distinct names on purpose: "repo" is a substring of "blocked-repo".
    expect(text.indexOf("blocked-repo")).toBeLessThan(text.indexOf("done-repo"));
    expect(text.indexOf("done-repo")).toBeLessThan(text.indexOf("working-repo"));
  });

  it("flags a session the bridge cannot drive", () => {
    const text = renderRadar(snapshot({ sessions: [session({ state: "working" })] }), now);

    expect(text).toContain("terminal");
  });

  it("says plainly when nothing is running", () => {
    expect(renderRadar(snapshot(), now)).toContain("No agents are running.");
    expect(renderRadar(snapshot(), now)).toContain("nothing running");
  });

  it("mentions the idle sessions it is hiding without listing them", () => {
    // Twenty-odd abandoned sessions are an archive, not a status display.
    const live = session({ state: "working" });
    const text = renderRadar(
      snapshot({
        sessions: [live, ...Array.from({ length: 12 }, (_, i) => session({ key: `idle${i}`, state: "idle" }))],
        active: [live],
      }),
      now,
    );

    expect(text).toContain("12 idle, hidden");
    expect(text).toContain("1 working");
  });

  it("does not mention hidden sessions when there are none", () => {
    expect(renderRadar(snapshot({ sessions: [session({ state: "working" })] }), now)).not.toContain("hidden");
  });

  it("shows context share once it is high enough to matter", () => {
    const text = renderRadar(snapshot({ sessions: [session({ state: "working", contextPercent: 91 })] }), now);
    expect(text).toContain("ctx 91%");
  });

  it("stays quiet about a context that is not yet worth mentioning", () => {
    expect(renderRadar(snapshot({ sessions: [session({ contextPercent: 30 })] }), now)).not.toContain("ctx ");
  });

  it("does not say 'just now ago'", () => {
    expect(renderRadar(snapshot({ sessions: [session({ state: "working" })] }), now)).not.toContain("just now ago");
  });
});

describe("git state on the radar", () => {
  const git = {
    branch: "ushuaia",
    filesChanged: 8,
    insertions: 312,
    deletions: 40,
    untracked: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    aheadOfBase: 3,
  };

  it("says what the agent actually did, not just that it finished", () => {
    const text = renderRadar(snapshot({ sessions: [session({ state: "finished", git })] }), now);

    expect(text).toContain("+312/−40 · 8 files · 3 commits, not pushed");
  });

  it("does not waste a line saying a tree is clean", () => {
    const clean = { ...git, filesChanged: 0, insertions: 0, deletions: 0, aheadOfBase: 0, hasUpstream: true };
    const text = renderRadar(snapshot({ sessions: [session({ state: "working", git: clean })] }), now);

    expect(text).not.toContain("clean");
  });

  it("omits the line entirely when git was not read", () => {
    expect(renderRadar(snapshot({ sessions: [session({ state: "working" })] }), now)).not.toContain("files");
  });
});

describe("renderAttentionCard", () => {
  it("says a stuck session seems stuck, what it waits on and for how long", () => {
    const text = renderAttentionCard(
      item({
        kind: "stalled",
        since: "2026-09-20T11:46:00.000Z",
        session: session({ state: "working", waitingOn: "model", detail: "Running Bash" }),
      }),
      now,
    );
    expect(text).toContain("— seems stuck");
    expect(text).toContain("No response from the model for 14m.");
    const api = renderAttentionCard(
      item({
        kind: "stalled",
        since: "2026-09-20T11:53:00.000Z",
        session: session({ state: "error", waitingOn: "api" }),
      }),
      now,
    );
    expect(api).toContain("Retrying API errors for 7m.");
  });

  const git = {
    branch: "x",
    filesChanged: 15,
    insertions: 283,
    deletions: 5,
    untracked: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    aheadOfBase: 34,
  };

  it("fits a phone notification in three lines", () => {
    const text = renderAttentionCard(
      item({ session: session({ state: "awaiting_approval", detail: "Claude needs permission to run Bash" }) }),
      now,
    );

    expect(text.split("\n").filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(text).toContain("needs approval");
    expect(text).toContain("Claude needs permission to run Bash");
  });

  it("says what the agent did, not only that the tree changed", () => {
    const text = renderAttentionCard(
      item({
        session: session({
          state: "finished",
          conductorSessionId: "c1",
          detail: "**Done!** Rewrote the push card so it says what changed. Tests pass.",
          git,
        }),
        kind: "finished_unreviewed",
      }),
      now,
    );

    expect(text).toContain("Rewrote the push card so it says what changed.");
    expect(text).not.toContain("**Done!**");
    expect(text).toContain("+283/−5 · 15 files");
  });

  it("does not count commits at a lock screen, only says the work is still local", () => {
    const text = renderAttentionCard(
      item({ session: session({ state: "finished", conductorSessionId: "c1", git }), kind: "finished_unreviewed" }),
      now,
    );

    expect(text).toContain("not pushed");
    expect(text).not.toContain("34 commits");
  });

  it("spends no line on a clean tree", () => {
    const clean = { ...git, filesChanged: 0, insertions: 0, deletions: 0, aheadOfBase: 0 };
    const text = renderAttentionCard(
      item({
        session: session({ state: "finished", conductorSessionId: "c1", detail: "Nothing to change.", git: clean }),
        kind: "finished_unreviewed",
      }),
      now,
    );

    expect(text).not.toContain("clean");
  });

  it("keeps the heading to one phone line", () => {
    const text = renderAttentionCard(
      item({
        session: session({
          state: "finished",
          conductorSessionId: "c1",
          // Long enough that repo and branch together overflow a card line.
          repoName: "squeak-agent-pager",
          branch: "blume-style-session-hub",
          git,
        }),
        kind: "finished_unreviewed",
      }),
      now,
    );

    const heading = text.split("\n")[0] ?? "";
    expect(heading.length).toBeLessThanOrEqual(56);
    // The branch is what identifies the work; the repo is what gets dropped.
    expect(heading).toContain("blume-style-session-hub");
    expect(heading).not.toContain("squeak-agent-pager");
  });

  it("keeps a diffstat off a blocked card, where the question is the point", () => {
    const text = renderAttentionCard(
      item({
        session: session({ state: "awaiting_approval", conductorSessionId: "c1", detail: "Run `rm -rf dist`?", git }),
      }),
      now,
    );

    expect(text).not.toContain("15 files");
  });

  it("says when it cannot act on the session", () => {
    const text = renderAttentionCard(item(), now);
    expect(text).toContain("answer it where it runs");
  });

  it("says nothing of the sort for a Conductor session", () => {
    const text = renderAttentionCard(
      item({ session: session({ state: "awaiting_input", conductorSessionId: "c1" }), kind: "blocked_question" }),
      now,
    );
    expect(text).not.toContain("answer it where it runs");
  });
});

describe("cardLabel", () => {
  it("keeps repo and branch when both fit", () => {
    expect(cardLabel(session({ repoName: "repo", branch: "ushuaia" }), "/Users/someone")).toBe("repo · ushuaia");
  });

  it("drops the repo rather than wrapping", () => {
    expect(
      cardLabel(session({ repoName: "squeak-agent-pager", branch: "blume-style-session-hub" }), "/Users/someone"),
    ).toBe("blume-style-session-hub");
  });
});

describe("radarKeyboard", () => {
  it("keeps callback data inside Telegram's 64-byte limit", () => {
    const blocked = item({ session: session({ key: "claude-transcript:e92089c1-5db6-4404-8a36-3909d139a033" }) });
    const keyboard = radarKeyboard(snapshot({ attention: [blocked] }), () => 12345);

    for (const row of keyboard) {
      for (const button of row) {
        expect(Buffer.byteLength(callbackData(button))).toBeLessThanOrEqual(64);
        expect(button.text.length).toBeLessThanOrEqual(40);
      }
    }
  });

  it("truncates a long label with an ellipsis rather than cutting mid-word", () => {
    const long = item({
      session: session({ repoName: "squeak", branch: "blume-style-session-hub-that-runs-long" }),
    });
    const keyboard = radarKeyboard(snapshot({ attention: [long] }), () => 1);

    const text = keyboard[0]?.[0]?.text ?? "";
    // The old `.slice(0, 40)` produced "...session-hu" — a word cut in half
    // with nothing to show it was shortened.
    expect(text).toContain("…");
    expect(text.endsWith("hu")).toBe(false);
  });
});

describe("a finish that asks", () => {
  const asking = session({
    state: "finished",
    conductorSessionId: "c1",
    asks: "Want me to open a PR?",
    detail: "Pushed the branch and CI is green.",
  });
  const asked = item({ session: asking, kind: "asked_question", score: 850 });

  it("leads the card with the question under the needs-you red", () => {
    const lines = renderAttentionCard(asked, now).split("\n");
    expect(lines[0]).toBe("🔴 **repo · main** — asks you");
    expect(lines[1]).toBe("Want me to open a PR?");
  });

  it("keeps Reply and the full message on the card, since the chat is idle", () => {
    expect(canReplyFromCard(asked, { send: vi.fn(), lastTurnText: vi.fn() } as never)).toBe(true);
    const buttons = attentionCardKeyboard(asked, 1, { reply: true, open: false, full: true }).flat();
    expect(buttons.map((button) => button.text)).toEqual(expect.arrayContaining(["Reply", "Full message"]));
  });

  it("counts under needs you on the radar, with the question as its line", () => {
    const text = renderRadar(snapshot({ sessions: [asking] }), now);
    expect(text).toContain("1 needs you");
    expect(text).not.toContain("1 done");
    expect(text).toContain("🔴");
    expect(text).toContain("asks you · Want me to open a PR?");
  });

  it("a plain finish stays done", () => {
    const text = renderRadar(snapshot({ sessions: [{ ...asking, asks: null }] }), now);
    expect(text).toContain("1 done");
    expect(text).not.toContain("needs you");
  });
});

describe("attentionCardKeyboard", () => {
  it("offers Reply only when there is a Conductor session behind it", () => {
    const external = attentionCardKeyboard(item(), 1).flat();
    const conductorBacked = attentionCardKeyboard(
      item({ session: session({ state: "awaiting_input", conductorSessionId: "c1" }) }),
      1,
    ).flat();

    expect(external.some((button) => button.text === "Reply")).toBe(false);
    expect(conductorBacked.some((button) => button.text === "Reply")).toBe(true);
    // The diff needs no control channel, so it is offered even for
    // sessions the bot cannot drive — and it is the only card button left.
    expect(external.some((button) => button.text === "View Diff")).toBe(true);
  });

  it("repeats no button that is already a command", () => {
    const buttons = attentionCardKeyboard(
      item({ session: session({ state: "finished", conductorSessionId: "c1" }), kind: "finished_unreviewed" }),
      1,
    ).flat();

    expect(buttons.some((button) => button.text === "Snooze 1h")).toBe(false);
    expect(buttons.some((button) => button.text === "Radar")).toBe(false);
  });
});

describe("sessionLabel", () => {
  const home = "/Users/someone";

  it("uses repo and branch when the session has both", () => {
    expect(sessionLabel(session({ repoName: "squeak", branch: "ushuaia" }), home)).toBe("squeak · ushuaia");
  });

  it("falls back to the path rather than naming the user's home directory as a repo", () => {
    // A session started in $HOME derives repoName from the directory, which is
    // the account name, and reports a detached HEAD. Neither means anything.
    const label = sessionLabel(session({ repoName: "someone", branch: "HEAD", cwd: "/Users/someone" }), home);

    expect(label).toBe("~");
  });

  it("shortens a deep path to its last two segments", () => {
    expect(shortenPath("/Users/someone/conductor/workspaces/squeak/ushuaia", home)).toBe("…/squeak/ushuaia");
    expect(shortenPath("/Users/someone/Downloads", home)).toBe("~/Downloads");
    expect(shortenPath("/tmp/scratch", home)).toBe("/tmp/scratch");
  });
});

describe("diffSummaryKeyboard", () => {
  function diffWith(count: number) {
    return {
      baseRef: "origin/main",
      files: Array.from({ length: count }, (_, index) => ({
        path: `src/very/deeply/nested/path/to/file${index}.ts`,
        insertions: 1,
        deletions: 0,
        binary: false,
        untracked: false,
      })),
      insertions: count,
      deletions: 0,
      truncated: false,
    };
  }

  it("indexes buttons by absolute position so paging opens the right file", () => {
    const rows = diffSummaryKeyboard(diffWith(20), 42, 1);
    const fileButtons = rows.flat().filter((button) => /^fleet:diff:42:\d+$/.test(callbackData(button)));

    expect(callbackData(fileButtons[0])).toBe("fleet:diff:42:8");
  });

  it("offers paging only when there is more than one page", () => {
    const single = diffSummaryKeyboard(diffWith(3), 42, 0).flat();
    const many = diffSummaryKeyboard(diffWith(20), 42, 0).flat();

    expect(single.some((button) => button.text === "More files")).toBe(false);
    expect(many.some((button) => button.text === "More files")).toBe(true);
    // No Prev on the first page.
    expect(many.some((button) => button.text === "Prev")).toBe(false);
    expect(
      diffSummaryKeyboard(diffWith(20), 42, 1)
        .flat()
        .some((button) => button.text === "Prev"),
    ).toBe(true);
  });

  it("keeps long paths recognisable by their tail and inside Telegram's limits", () => {
    for (const row of diffSummaryKeyboard(diffWith(20), 42, 0)) {
      for (const button of row) {
        expect(Buffer.byteLength(callbackData(button))).toBeLessThanOrEqual(64);
        expect(button.text.length).toBeLessThanOrEqual(38);
      }
    }
    const shortened = truncateStart("src/very/deeply/nested/path/to/file0.ts", 20);
    expect(shortened).toBe("…ed/path/to/file0.ts");
    expect(shortened).toHaveLength(20);
    // A path that already fits is left exactly as it is.
    expect(truncateStart("src/a.ts", 20)).toBe("src/a.ts");
  });
});

describe("Codex quota on the radar", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  function usage(overrides: Partial<{ primaryPercent: number; secondaryPercent: number }> = {}) {
    return {
      planType: "team",
      primary: {
        usedPercent: overrides.primaryPercent ?? 60,
        windowMinutes: 300,
        resetsAt: "2026-09-20T14:00:00.000Z",
      },
      secondary: overrides.secondaryPercent
        ? { usedPercent: overrides.secondaryPercent, windowMinutes: 10080, resetsAt: "2026-09-27T12:00:00.000Z" }
        : null,
      hasCredits: false,
      creditBalance: null,
      observedAt: "2026-09-20T11:59:00.000Z",
    };
  }

  it("shows a window once it is worth mentioning", () => {
    const text = renderRadar(snapshot({ codexUsage: usage({ primaryPercent: 60 }) }), now);
    expect(text).toContain("Codex quota: 60% (5h, resets in 2h)");
  });

  it("says nothing for a window that is not close to the limit", () => {
    const text = renderRadar(snapshot({ codexUsage: usage({ primaryPercent: 10 }) }), now);
    expect(text).not.toContain("Codex quota");
  });

  it("shows both windows when both matter", () => {
    const text = renderRadar(snapshot({ codexUsage: usage({ primaryPercent: 60, secondaryPercent: 70 }) }), now);
    expect(text).toContain("60% (5h");
    expect(text).toContain("70% (7d");
  });

  it("says nothing when there is no usage data at all", () => {
    expect(renderRadar(snapshot({ codexUsage: null }), now)).not.toContain("Codex quota");
  });
});

describe("formatCountdown", () => {
  it("counts down to a future instant rather than reporting elapsed time", () => {
    expect(formatCountdown("2026-09-20T12:03:00.000Z", now)).toBe("3m");
    expect(formatCountdown("2026-09-20T14:30:00.000Z", now)).toBe("2h 30m");
    expect(formatCountdown("2026-09-22T12:00:00.000Z", now)).toBe("2d");
  });

  it("reports 'now' for an instant that has already passed", () => {
    expect(formatCountdown("2026-09-20T11:00:00.000Z", now)).toBe("now");
  });
});

describe("renderQuotaAlert", () => {
  it("names the window, the percent, and when it resets", () => {
    const text = renderQuotaAlert(
      {
        planType: "team",
        primary: { usedPercent: 90, windowMinutes: 300, resetsAt: "2026-09-20T14:00:00.000Z" },
        secondary: null,
        hasCredits: false,
        creditBalance: null,
        observedAt: "2026-09-20T11:59:00.000Z",
      },
      "primary",
      now,
    );
    expect(text).toContain("90% used (5h)");
    expect(text).toContain("resets in 2h");
  });
});

describe("stateGlyph", () => {
  it("follows DESIGN.md: one red for needs-you, violet for error, no yellow", () => {
    expect(stateGlyph("awaiting_approval")).toBe("🔴");
    expect(stateGlyph("awaiting_input")).toBe("🔴");
    expect(stateGlyph("error")).toBe("🟣");
    expect(stateGlyph("working")).toBe("🟢");
    expect(stateGlyph("finished")).toBe("✅");
  });
});

describe("renderUsage", () => {
  it("shows Codex's real quota and Claude's estimated cost, heaviest session first", () => {
    const text = renderUsage(
      {
        codexUsage: {
          planType: null,
          primary: { usedPercent: 42.4, windowMinutes: 300, resetsAt: "2026-09-20T14:10:00.000Z" },
          secondary: { usedPercent: 18, windowMinutes: 10080, resetsAt: "2026-09-23T16:00:00.000Z" },
          hasCredits: false,
          creditBalance: null,
          observedAt: "2026-09-20T12:00:00.000Z",
        },
        active: [
          session({ key: "a", branch: "cheap", costUsd: 0.5 }),
          session({ key: "b", branch: "dear", costUsd: 3.25 }),
          session({ key: "c", branch: "codex", agent: "codex", costUsd: null }),
        ],
      },
      now,
    );
    expect(text).toContain("Codex · 5h: 42% used, resets in 2h 10m");
    expect(text).toMatch(/Codex · .*: 18% used, resets in 3d 4h/);
    expect(text).toContain("Claude · ~$3.75 est. cost across 2 active sessions");
    expect(text.indexOf("dear")).toBeLessThan(text.indexOf("cheap"));
    // Never "no limit": the limit exists, Squeak just has not read it.
    expect(text).toContain("Claude · limit not seen yet");
  });

  it("shows Claude's real plan limit from the last reading, with its age", () => {
    const text = renderUsage({ codexUsage: null, active: [] }, now, {
      fiveHour: { utilization: 0.14, resetsAt: "2026-09-20T14:05:00.000Z" },
      sevenDay: { utilization: 0.05, resetsAt: "2026-09-18T00:00:00.000Z" },
      observedAt: "2026-09-20T11:48:00.000Z",
    });
    expect(text).toContain("Claude · 5h: 14% used, resets in 2h 5m · read 12m ago");
    expect(text).toContain("Claude · 7d: reset since the last reading (was 5%)");
    expect(text).not.toContain("not seen yet");
  });

  it("does not pass off a reading from before the window reset as current", () => {
    const text = renderUsage(
      {
        codexUsage: {
          planType: null,
          primary: { usedPercent: 61, windowMinutes: 300, resetsAt: "2026-09-20T11:00:00.000Z" },
          secondary: null,
          hasCredits: false,
          creditBalance: null,
          observedAt: "2026-09-20T06:00:00.000Z",
        },
        active: [],
      },
      now,
    );
    expect(text).toContain("Codex · 5h: reset since Codex last reported (was 61%)");
  });

  it("says 'read just now', not 'read just now ago'", () => {
    const text = renderUsage({ codexUsage: null, active: [] }, now, {
      fiveHour: { utilization: 0.5, resetsAt: "2026-09-20T13:00:00.000Z" },
      sevenDay: null,
      observedAt: new Date(now).toISOString(),
    });
    expect(text).toContain("· read just now");
    expect(text).not.toContain("just now ago");
  });

  it("says so when there is nothing to report", () => {
    const text = renderUsage({ codexUsage: null, active: [session()] }, now);
    expect(text).toContain("Codex · no quota reported yet");
    expect(text).toContain("Claude · no cost for the active sessions yet");
  });
});
