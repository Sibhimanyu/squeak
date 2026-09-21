import { describe, expect, it } from "vitest";

import type { FleetSnapshot } from "./fleet-monitor.js";
import {
  attentionCardKeyboard,
  formatAge,
  diffSummaryKeyboard,
  radarKeyboard,
  renderAttentionCard,
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
    ...overrides,
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
  it("leads with what is blocking and says how many", () => {
    const blocked = item();
    const text = renderRadar(snapshot({ sessions: [blocked.session], attention: [blocked] }), now);

    expect(text).toContain("1 waiting on you");
    expect(text).toContain("Needs you");
    expect(text).toContain("Waiting for approval");
    expect(text).toContain("repo · main");
    expect(text).toContain("10m");
  });

  it("flags a session the bridge cannot drive", () => {
    const text = renderRadar(snapshot({ sessions: [item().session], attention: [item()] }), now);

    expect(text).toContain("watch only");
    expect(text).toContain("terminal");
  });

  it("does not flag a Conductor session as watch only", () => {
    const actionable = item({
      session: session({ state: "awaiting_input", conductorSessionId: "c1", origin: "conductor" }),
      kind: "blocked_question",
    });
    const text = renderRadar(snapshot({ sessions: [actionable.session], attention: [actionable] }), now);

    expect(text).not.toContain("watch only");
  });

  it("keeps finished work below working sessions rather than hiding it", () => {
    const finished = item({
      session: session({ key: "k2", state: "finished", repoName: "other" }),
      kind: "finished_unreviewed",
      score: 300,
    });
    const text = renderRadar(snapshot({ sessions: [session(), finished.session], attention: [finished] }), now);

    expect(text.indexOf("Working")).toBeLessThan(text.indexOf("Finished, unreviewed"));
  });

  it("says so plainly when nothing is running", () => {
    expect(renderRadar(snapshot(), now)).toContain("No agent sessions running");
  });

  it("reports quiet sessions instead of claiming nothing is running", () => {
    const idle = session({ state: "idle" });
    const text = renderRadar(snapshot({ sessions: [idle] }), now);

    expect(text).toContain("1 idle sessions, nothing pending.");
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

describe("renderAttentionCard", () => {
  it("carries enough context to decide without opening anything", () => {
    const text = renderAttentionCard(
      item({ session: session({ state: "awaiting_approval", detail: "Claude needs permission to run Bash" }) }),
      now,
    );

    expect(text).toContain("Waiting for approval");
    expect(text).toContain("Fix the parser");
    expect(text).toContain("Claude needs permission to run Bash");
    expect(text).toContain("waiting 10m");
  });

  it("tells you where to answer a session it cannot drive", () => {
    const text = renderAttentionCard(item(), now);

    expect(text).toContain("Started outside Conductor");
    expect(text).toContain("/Users/someone/repo");
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

describe("radar footer", () => {
  it("does not say 'just now ago'", () => {
    expect(renderRadar(snapshot(), now)).toContain("_updated just now_");
    expect(renderRadar(snapshot({ generatedAt: "2026-09-20T11:55:00.000Z" }), now)).toContain("_updated 5m ago_");
  });
});

describe("context pressure on the radar", () => {
  it("gets its own section rather than being mixed in with blocked work", () => {
    const pressured = item({
      session: session({ state: "working", contextPercent: 91 }),
      kind: "context_pressure",
      score: 250,
    });
    const text = renderRadar(snapshot({ sessions: [pressured.session], attention: [pressured] }), now);

    expect(text).toContain("Running low on context");
    expect(text).not.toContain("Needs you");
    expect(text).toContain("ctx 91%");
  });

  it("does not claim nothing is running when a session is low on context", () => {
    const pressured = item({
      session: session({ state: "working", contextPercent: 91 }),
      kind: "context_pressure",
    });
    const text = renderRadar(snapshot({ sessions: [pressured.session], attention: [pressured] }), now);

    expect(text).not.toContain("No agent sessions running");
  });

  it("stays quiet about a context that is not yet worth mentioning", () => {
    const text = renderRadar(snapshot({ sessions: [session({ contextPercent: 30 })] }), now);

    expect(text).not.toContain("ctx ");
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
    const finished = item({
      session: session({ state: "finished", detail: "Done.", git }),
      kind: "finished_unreviewed",
    });
    const text = renderRadar(snapshot({ sessions: [finished.session], attention: [finished] }), now);

    expect(text).toContain("+312/−40 · 8 files · 3 commits, not pushed");
  });

  it("puts it on the push card too", () => {
    const text = renderAttentionCard(item({ session: session({ state: "awaiting_approval", git }) }), now);

    expect(text).toContain("+312/−40");
  });

  it("omits the line entirely when git was not read", () => {
    const text = renderRadar(snapshot({ sessions: [session({ state: "working" })] }), now);

    expect(text).not.toContain("files");
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
