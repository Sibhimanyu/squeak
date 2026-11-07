import { describe, expect, it } from "vitest";

import { ProcessLivenessObserver, classifyCommand, parseLsofOutput, parsePsOutput } from "./process-liveness.js";

describe("classifyCommand", () => {
  it("matches the executable, not the arguments", () => {
    expect(classifyCommand("/usr/local/bin/claude --resume abc")).toBe("claude");
    expect(classifyCommand("codex exec 'fix the tests'")).toBe("codex");
    // A command that merely mentions an agent is not an agent.
    expect(classifyCommand("grep -r claude /Users/someone/codex-notes")).toBeNull();
    expect(classifyCommand("/Applications/Cursor.app/Contents/MacOS/Cursor")).toBeNull();
  });

  it("recognises the Conductor-managed binaries", () => {
    expect(
      classifyCommand(
        "/Users/someone/Library/Application Support/com.conductor.app/agent-binaries/claude/2.1.274/claude",
      ),
    ).toBe("claude");
  });
});

describe("parsePsOutput", () => {
  it("keeps only agent processes", () => {
    const processes = parsePsOutput(
      [
        "    1 /sbin/launchd",
        " 4321 /usr/local/bin/claude",
        " 5678 /Users/someone/Library/Application Support/com.conductor.app/bin/codex",
        " 9999 /usr/bin/vim notes.md",
      ].join("\n"),
    );

    expect(processes).toEqual([
      { pid: 4321, agent: "claude", command: "/usr/local/bin/claude" },
      {
        pid: 5678,
        agent: "codex",
        command: "/Users/someone/Library/Application Support/com.conductor.app/bin/codex",
      },
    ]);
  });
});

describe("parseLsofOutput", () => {
  it("pairs each pid with its working directory", () => {
    const cwds = parseLsofOutput(["p4321", "n/Users/someone/repo", "p5678", "n/Users/someone/other"].join("\n"));

    expect(cwds.get(4321)).toBe("/Users/someone/repo");
    expect(cwds.get(5678)).toBe("/Users/someone/other");
  });
});

describe("ProcessLivenessObserver", () => {
  it("joins ps and lsof into one answer", async () => {
    const observer = new ProcessLivenessObserver({
      runPs: async () => " 4321 /usr/local/bin/claude",
      runLsof: async () => "p4321\nn/Users/someone/repo",
    });

    expect(await observer.observe()).toEqual([
      { pid: 4321, agent: "claude", cwd: "/Users/someone/repo", command: "/usr/local/bin/claude" },
    ]);
  });

  it("names a Claude process's session from Claude Code's pid files", async () => {
    const observer = new ProcessLivenessObserver({
      runPs: async () => " 4321 /usr/local/bin/claude\n 99 /usr/local/bin/codex",
      runLsof: async () => "p4321\nn/Users/someone/repo",
      claudeSessions: () => [
        { pid: 4321, sessionId: "s-1" },
        { pid: 99, sessionId: "not-claude" },
      ],
    });
    const seen = await observer.observe();
    expect(seen.find((p) => p.pid === 4321)?.sessionId).toBe("s-1");
    expect(seen.find((p) => p.pid === 99)).not.toHaveProperty("sessionId");
  });

  it("still reports liveness when lsof is unavailable", async () => {
    const observer = new ProcessLivenessObserver({
      runPs: async () => " 4321 /usr/local/bin/claude",
      runLsof: async () => {
        throw new Error("lsof: permission denied");
      },
    });

    const [entry] = await observer.observe();
    expect(entry?.pid).toBe(4321);
    expect(entry?.cwd).toBeNull();
  });

  it("returns nothing rather than throwing when ps fails", async () => {
    const observer = new ProcessLivenessObserver({
      runPs: async () => {
        throw new Error("ps exploded");
      },
      runLsof: async () => "",
    });

    expect(await observer.observe()).toEqual([]);
  });
});
