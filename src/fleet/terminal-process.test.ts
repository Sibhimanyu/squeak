import { describe, expect, it } from "vitest";

import {
  claudeBusyReason,
  isCodexTui,
  locateAgentProcess,
  parseProcessTable,
  type ClaudeSessionFile,
  type ProcessRow,
  type TerminalProcessSources,
} from "./terminal-process.js";

const TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";

/** Terminal → login → bash → agent, as `ps` showed it on a real machine. */
function terminalTree(agent: Partial<ProcessRow> & { command: string }): ProcessRow[] {
  return [
    { pid: 500, ppid: 1, pgid: 500, tpgid: -1, tty: "??", started: "Fri Sep 25 07:00:00 2026", command: TERMINAL },
    {
      pid: 600,
      ppid: 500,
      pgid: 600,
      tpgid: 700,
      tty: "ttys004",
      started: "Fri Sep 25 13:12:00 2026",
      command: "login -pf me /bin/bash",
    },
    {
      pid: 601,
      ppid: 600,
      pgid: 601,
      tpgid: 700,
      tty: "ttys004",
      started: "Fri Sep 25 13:12:00 2026",
      command: "-bash",
    },
    { pid: 700, ppid: 601, pgid: 700, tpgid: 700, tty: "ttys004", started: "Fri Sep 25 13:13:34 2026", ...agent },
  ];
}

function sources(
  processes: ProcessRow[],
  claude: ClaudeSessionFile[] = [],
  cwds: Record<number, string> = {},
): TerminalProcessSources {
  return {
    listProcesses: async () => processes,
    cwdOf: async (pids) => new Map(pids.filter((pid) => cwds[pid]).map((pid) => [pid, cwds[pid]!])),
    listClaudeSessions: () => claude,
  };
}

function claudeFile(overrides: Partial<ClaudeSessionFile> = {}): ClaudeSessionFile {
  return {
    pid: 700,
    sessionId: "8ed8b2c9-29d6-443e-ab31-85495508d53d",
    status: "idle",
    waitingFor: null,
    procStart: "Fri Sep 25 13:13:34 2026",
    kind: "interactive",
    ...overrides,
  };
}

const claudeSession = { agent: "claude" as const, agentSessionId: "8ed8b2c9-29d6-443e-ab31-85495508d53d", cwd: "/w" };
const codexSession = { agent: "codex" as const, agentSessionId: "01a0d8ba-e2c1-7771-b67d-a088c6a9f0b3", cwd: "/w" };

describe("locateAgentProcess", () => {
  it("proves a Claude session's process from its own session file", async () => {
    const result = await locateAgentProcess(
      sources(terminalTree({ command: "/Users/me/.local/bin/claude --model haiku" }), [claudeFile()]),
      claudeSession,
    );

    expect(result).toEqual({
      ok: true,
      pid: 700,
      tty: "ttys004",
      host: "terminal-app",
      claudeStatus: { status: "idle", waitingFor: null },
    });
  });

  it("refuses a pid that was reused since the session file was written", async () => {
    const result = await locateAgentProcess(
      sources(terminalTree({ command: "/Users/me/.local/bin/claude" }), [
        claudeFile({ procStart: "Thu Sep 24 09:00:00 2026" }),
      ]),
      claudeSession,
    );

    expect(result.ok).toBe(false);
  });

  it("refuses when something else owns the terminal's foreground", async () => {
    // The agent ran `!vim`: it is still alive, but keystrokes go to vim.
    const tree = terminalTree({ command: "/Users/me/.local/bin/claude", tpgid: 800 });
    const result = await locateAgentProcess(sources(tree, [claudeFile()]), claudeSession);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("foreground") });
  });

  it("refuses a process with no terminal, like Conductor's", async () => {
    const tree = terminalTree({ command: "/Users/me/.local/bin/claude", tty: "??" });
    const result = await locateAgentProcess(sources(tree, [claudeFile()]), claudeSession);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not attached to a terminal") });
  });

  it("names a terminal it cannot drive", async () => {
    const tree = terminalTree({ command: "/Users/me/.local/bin/claude" });
    tree[0]!.command = "/Applications/iTerm.app/Contents/MacOS/iTerm2";
    const result = await locateAgentProcess(sources(tree, [claudeFile()]), claudeSession);

    expect(result).toMatchObject({ ok: true, host: { other: "iTerm" } });
  });

  it("finds the one Codex TUI in the session's folder", async () => {
    const result = await locateAgentProcess(
      sources(terminalTree({ command: "codex" }), [], { 700: "/w" }),
      codexSession,
    );

    expect(result).toMatchObject({ ok: true, pid: 700, tty: "ttys004", claudeStatus: null });
  });

  it("refuses when two Codex TUIs share the folder", async () => {
    const tree = [
      ...terminalTree({ command: "codex" }),
      {
        pid: 900,
        ppid: 601,
        pgid: 900,
        tpgid: 900,
        tty: "ttys005",
        started: "Fri Sep 25 13:20:00 2026",
        command: "codex",
      },
    ];
    const result = await locateAgentProcess(sources(tree, [], { 700: "/w", 900: "/w" }), codexSession);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("Several Codex") });
  });

  it("prefers the Codex that resumed this thread by name, and skips one that resumed another", async () => {
    const tree = [
      ...terminalTree({ command: `codex resume ${codexSession.agentSessionId}` }),
      {
        pid: 900,
        ppid: 601,
        pgid: 900,
        tpgid: 900,
        tty: "ttys005",
        started: "Fri Sep 25 13:20:00 2026",
        command: "codex resume 11111111-2222-3333-4444-555555555555",
      },
    ];
    const result = await locateAgentProcess(sources(tree, [], { 700: "/w", 900: "/w" }), codexSession);

    expect(result).toMatchObject({ ok: true, pid: 700 });
  });

  it("does not mistake the app-server or codex exec for a TUI", async () => {
    const result = await locateAgentProcess(
      sources(terminalTree({ command: "codex exec do the thing" }), [], { 700: "/w" }),
      codexSession,
    );

    expect(result.ok).toBe(false);
  });
});

describe("isCodexTui", () => {
  it("separates the interactive CLI from Codex's servers", () => {
    expect(isCodexTui({ command: "codex" })).toBe(true);
    expect(isCodexTui({ command: "codex --model gpt-5 resume --last" })).toBe(true);
    expect(isCodexTui({ command: "codex app-server" })).toBe(false);
    expect(
      isCodexTui({ command: "/Users/me/Library/Application Support/com.conductor.app/bin/codex app-server" }),
    ).toBe(false);
    expect(isCodexTui({ command: "/opt/bin/codex-app-server --port 1" })).toBe(false);
    expect(isCodexTui({ command: "codex mcp-server" })).toBe(false);
    expect(isCodexTui({ command: "/Users/me/.local/bin/claude" })).toBe(false);
  });
});

describe("claudeBusyReason", () => {
  it("lets only an idle session take a message", () => {
    expect(claudeBusyReason({ status: "idle", waitingFor: null })).toBeNull();
    expect(claudeBusyReason({ status: "busy", waitingFor: null })).toContain("still working");
    expect(claudeBusyReason({ status: "waiting", waitingFor: "permission prompt" })).toContain("permission prompt");
    expect(claudeBusyReason({ status: null, waitingFor: null })).not.toBeNull();
  });
});

describe("parseProcessTable", () => {
  it("reads ps's columns, with lstart's five words and a command containing spaces", () => {
    const rows = parseProcessTable(
      [
        "  700   601   700   700 ttys004  Fri Sep 25 13:13:34 2026     /Users/me/.local/bin/claude --model haiku",
        "36289     1 36289    -1 ??       Fri Sep 25 12:20:01 2026     /Users/me/Library/Application Support/claude --resume=x",
        "garbage",
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        pid: 700,
        ppid: 601,
        pgid: 700,
        tpgid: 700,
        tty: "ttys004",
        started: "Fri Sep 25 13:13:34 2026",
        command: "/Users/me/.local/bin/claude --model haiku",
      },
      {
        pid: 36289,
        ppid: 1,
        pgid: 36289,
        tpgid: -1,
        tty: "??",
        started: "Fri Sep 25 12:20:01 2026",
        command: "/Users/me/Library/Application Support/claude --resume=x",
      },
    ]);
  });
});
