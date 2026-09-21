import { describe, expect, it } from "vitest";

import type { FleetSnapshot } from "./fleet-monitor.js";
import {
  attentionCardKeyboard,
  formatAge,
  formatCountdown,
  diffSummaryKeyboard,
  radarKeyboard,
  renderAttentionCard,
  renderQuotaAlert,
  renderRadar,
  sessionLabel,
  shortenPath,
  truncateStart,
} from "./radar.js";
import type { AttentionItem, FleetSession } from "./types.js";

const now = Date.parse("2026-09-20T12:00:00.000Z");

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
  it("fits a phone notification in two lines", () => {
    const text = renderAttentionCard(
      item({ session: session({ state: "awaiting_approval", detail: "Claude needs permission to run Bash" }) }),
      now,
    );

    expect(text.split("\n").filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(text).toContain("needs approval");
    expect(text).toContain("Claude needs permission to run Bash");
  });

  it("reports a finish with what changed rather than prose", () => {
    const text = renderAttentionCard(
      item({
        session: session({
          state: "finished",
          git: {
            branch: "x",
            filesChanged: 15,
            insertions: 283,
            deletions: 5,
            untracked: 0,
            ahead: 0,
            behind: 0,
            hasUpstream: true,
            aheadOfBase: null,
          },
        }),
        kind: "finished_unreviewed",
      }),
      now,
    );

    expect(text).toContain("done");
    expect(text).toContain("+283/−5 · 15 files");
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

describe("radarKeyboard", () => {
  it("keeps callback data inside Telegram's 64-byte limit", () => {
    const blocked = item({ session: session({ key: "claude-transcript:e92089c1-5db6-4404-8a36-3909d139a033" }) });
    const keyboard = radarKeyboard(snapshot({ attention: [blocked] }), () => 12345);

    for (const row of keyboard) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
        expect(button.text.length).toBeLessThanOrEqual(40);
      }
    }
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
    // Snooze and review are always available, even for watch-only sessions.
    expect(external.some((button) => button.text === "Snooze 1h")).toBe(true);
  });
});

describe("sessionLabel", () => {
  const home = "/Users/someone";

  it("uses repo and branch when the session has both", () => {
    expect(sessionLabel(session({ repoName: "conductor-tg", branch: "ushuaia" }), home)).toBe("conductor-tg · ushuaia");
  });

  it("falls back to the path rather than naming the user's home directory as a repo", () => {
    // A session started in $HOME derives repoName from the directory, which is
    // the account name, and reports a detached HEAD. Neither means anything.
    const label = sessionLabel(session({ repoName: "someone", branch: "HEAD", cwd: "/Users/someone" }), home);

    expect(label).toBe("~");
  });

  it("shortens a deep path to its last two segments", () => {
    expect(shortenPath("/Users/someone/conductor/workspaces/conductor-tg/ushuaia", home)).toBe(
      "…/conductor-tg/ushuaia",
    );
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
    const fileButtons = rows.flat().filter((button) => /^fleet:diff:42:\d+$/.test(button.callback_data));

    expect(fileButtons[0]?.callback_data).toBe("fleet:diff:42:8");
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
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
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
