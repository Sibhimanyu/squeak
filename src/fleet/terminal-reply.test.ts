import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { ClaudeSessionFile, ProcessRow, TerminalProcessSources } from "./terminal-process.js";
import {
  lastAgentMessage,
  lastAgentTurnId,
  TerminalReplier,
  transcriptHasUserMessage,
  type ScreenRead,
  type ScreenType,
  type TerminalScreenDriver,
} from "./terminal-reply.js";
import type { FleetSession } from "./types.js";

const NOW = Date.parse("2026-09-25T13:30:00.000Z");
const SESSION_ID = "8ed8b2c9-29d6-443e-ab31-85495508d53d";
const TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function screenFixture(name: string): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "screens");
  return fs.readFileSync(path.join(dir, `${name}.txt`), "utf8");
}

function writeTranscript(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-reply-"));
  dirs.push(dir);
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

function appendEntry(file: string, entry: unknown): void {
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

/** A finished Claude turn, in the shape Claude Code 2.1 writes it. */
function claudeTurn(question: string, answer: string, at: string): unknown[] {
  return [
    { type: "user", timestamp: at, message: { role: "user", content: question } },
    {
      type: "assistant",
      timestamp: at,
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: answer }] },
    },
  ];
}

function processes(): ProcessRow[] {
  return [
    { pid: 500, ppid: 1, pgid: 500, tpgid: -1, tty: "??", started: "Fri Sep 25 07:00:00 2026", command: TERMINAL },
    {
      pid: 601,
      ppid: 500,
      pgid: 601,
      tpgid: 700,
      tty: "ttys004",
      started: "Fri Sep 25 13:12:00 2026",
      command: "-bash",
    },
    {
      pid: 700,
      ppid: 601,
      pgid: 700,
      tpgid: 700,
      tty: "ttys004",
      started: "Fri Sep 25 13:13:34 2026",
      command: "/Users/me/.local/bin/claude",
    },
  ];
}

function sources(file: Partial<ClaudeSessionFile> = {}, cwds: Record<number, string> = {}): TerminalProcessSources {
  return {
    listProcesses: async () => processes(),
    cwdOf: async (pids) => new Map(pids.filter((pid) => cwds[pid]).map((pid) => [pid, cwds[pid]!])),
    listClaudeSessions: () => [
      {
        pid: 700,
        sessionId: SESSION_ID,
        status: "idle",
        waitingFor: null,
        procStart: "Fri Sep 25 13:13:34 2026",
        kind: "interactive",
        ...file,
      },
    ],
  };
}

/**
 * A terminal that shows `contents` and, when typed into, lets `onType` play
 * the agent (usually: append the user message to the transcript).
 */
class FakeTerminal implements TerminalScreenDriver {
  typed: string[] = [];
  constructor(
    private contents: string,
    private readonly onType: (text: string) => ScreenType = () => ({ ok: true }),
  ) {}

  async read(): Promise<ScreenRead> {
    return { ok: true, contents: this.contents, sha256: "sha-of-screen" };
  }

  async type(_tty: string, text: string, expectSha256: string): Promise<ScreenType> {
    if (expectSha256 !== "sha-of-screen") {
      return { ok: false, error: "screen-changed" };
    }
    this.typed.push(text);
    return this.onType(text);
  }
}

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: `claude-transcript:${SESSION_ID}`,
    source: "claude-transcript",
    agent: "claude",
    origin: "terminal",
    sourceId: SESSION_ID,
    agentSessionId: SESSION_ID,
    conductorSessionId: null,
    cwd: "/w",
    repoName: "w",
    branch: null,
    title: null,
    state: "finished",
    detail: null,
    lastActivityAt: "2026-09-25T13:29:00.000Z",
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    pid: 700,
    alive: true,
    git: null,
    stateSource: "transcript",
    ...overrides,
  };
}

function replier(terminal: FakeTerminal, processSources = sources()) {
  let now = NOW;
  return new TerminalReplier({
    sources: processSources,
    screen: terminal,
    now: () => now,
    // Time passes only when the confirm loop waits.
    sleep: async (ms) => {
      now += ms;
    },
    confirmTimeoutMs: 3_000,
  });
}

describe("TerminalReplier", () => {
  it("types into an idle Claude prompt and confirms from the transcript", async () => {
    const transcript = writeTranscript(claudeTurn("go", "Done. Want tests too?", "2026-09-25T13:29:00.000Z"));
    const terminal = new FakeTerminal(screenFixture("claude-idle"), (text) => {
      appendEntry(transcript, { type: "user", timestamp: "2026-09-25T13:30:00.500Z", message: { content: text } });
      return { ok: true };
    });

    const outcome = await replier(terminal).send(session({ transcriptPath: transcript }), "  yes,\r\nplease\t ");

    expect(outcome).toEqual({ status: "started", via: "terminal" });
    expect(terminal.typed).toEqual(["yes,\nplease"]);
  });

  it("refuses a Claude session that its own session file says is busy or waiting", async () => {
    const transcript = writeTranscript(claudeTurn("go", "ok", "2026-09-25T13:29:00.000Z"));
    const terminal = new FakeTerminal(screenFixture("claude-idle"));

    const busy = await replier(terminal, sources({ status: "busy" })).send(
      session({ transcriptPath: transcript }),
      "hi",
    );
    const waiting = await replier(terminal, sources({ status: "waiting", waitingFor: "permission prompt" })).send(
      session({ transcriptPath: transcript }),
      "1",
    );

    expect(busy).toMatchObject({ status: "refused", reason: expect.stringContaining("still working") });
    expect(waiting).toMatchObject({ status: "refused", reason: expect.stringContaining("permission prompt") });
    expect(terminal.typed).toEqual([]);
  });

  it("refuses when the screen shows a permission prompt, whatever the session file says", async () => {
    const transcript = writeTranscript(claudeTurn("go", "ok", "2026-09-25T13:29:00.000Z"));
    const terminal = new FakeTerminal(screenFixture("claude-permission"));

    const outcome = await replier(terminal).send(session({ transcriptPath: transcript }), "1");

    expect(outcome).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("not showing the agent's prompt"),
    });
    expect(terminal.typed).toEqual([]);
  });

  it("refuses to paste over a draft", async () => {
    const transcript = writeTranscript(claudeTurn("go", "ok", "2026-09-25T13:29:00.000Z"));
    const drafted = screenFixture("claude-idle").replace(/❯\u00a0\n/u, "❯\u00a0half a thought\n");
    const terminal = new FakeTerminal(drafted);

    const outcome = await replier(terminal).send(session({ transcriptPath: transcript }), "hi");

    expect(outcome).toMatchObject({ status: "refused", reason: expect.stringContaining("draft") });
    expect(terminal.typed).toEqual([]);
  });

  it("says so, and never retypes, when the agent did not take what was typed", async () => {
    const transcript = writeTranscript(claudeTurn("go", "ok", "2026-09-25T13:29:00.000Z"));
    const terminal = new FakeTerminal(screenFixture("claude-idle"));

    const outcome = await replier(terminal).send(session({ transcriptPath: transcript }), "hi");

    expect(outcome).toMatchObject({ status: "refused", reason: expect.stringContaining("could not confirm") });
    expect(terminal.typed).toEqual(["hi"]);
  });

  it("confirms from the transcript when Squeak Hands died without a verdict", async () => {
    const transcript = writeTranscript(claudeTurn("go", "ok", "2026-09-25T13:29:00.000Z"));
    const terminal = new FakeTerminal(screenFixture("claude-idle"), (text) => {
      appendEntry(transcript, { type: "user", timestamp: "2026-09-25T13:30:01.000Z", message: { content: text } });
      return { ok: false, error: "helper-failed" };
    });

    expect(await replier(terminal).send(session({ transcriptPath: transcript }), "hi")).toEqual({
      status: "started",
      via: "terminal",
    });
  });

  it("refuses a session that is not a terminal agent", async () => {
    const terminal = new FakeTerminal(screenFixture("claude-idle"));
    const outcome = await replier(terminal).send(session({ origin: "desktop", transcriptPath: "/x" }), "hi");

    expect(outcome.status).toBe("refused");
    expect(terminal.typed).toEqual([]);
  });

  describe("Codex", () => {
    const THREAD = "01a0d8ba-e2c1-7771-b67d-a088c6a9f0b3";

    function codexProcesses(): TerminalProcessSources {
      const rows = processes();
      rows[2]!.command = "codex";
      return { ...sources({}, { 700: "/w" }), listProcesses: async () => rows, listClaudeSessions: () => [] };
    }

    /** A finished Codex turn, as 0.149 writes it: the user's words are a response_item. */
    function codexRollout(answer: string): string {
      return writeTranscript([
        {
          timestamp: "2026-09-25T13:22:13.706Z",
          type: "session_meta",
          payload: { id: THREAD, originator: "codex-tui" },
        },
        { timestamp: "2026-09-25T13:22:13.706Z", type: "event_msg", payload: { type: "task_started" } },
        {
          timestamp: "2026-09-25T13:22:14.540Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] },
        },
        {
          timestamp: "2026-09-25T13:22:14.701Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "two lines please" }] },
        },
        {
          timestamp: "2026-09-25T13:22:16.936Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] },
        },
        {
          timestamp: "2026-09-25T13:22:17.018Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: answer },
        },
      ]);
    }

    const codexSession = (transcriptPath: string) =>
      session({
        key: `codex-rollout:${THREAD}`,
        source: "codex-rollout",
        agent: "codex",
        sourceId: THREAD,
        agentSessionId: THREAD,
        transcriptPath,
      });

    it("types into the one Codex in the folder when its screen shows this session's last message", async () => {
      const rollout = codexRollout("First line here.\nAll done with **the test** now.");
      const terminal = new FakeTerminal(screenFixture("codex-after-turn"), (text) => {
        appendEntry(rollout, {
          timestamp: "2026-09-25T13:30:02.000Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        });
        return { ok: true };
      });

      expect(await replier(terminal, codexProcesses()).send(codexSession(rollout), "thanks")).toEqual({
        status: "started",
        via: "terminal",
      });
    });

    it("refuses when the screen does not show this session — a /new, or another thread", async () => {
      const rollout = codexRollout("Refactored the parser and pushed the branch.");
      const terminal = new FakeTerminal(screenFixture("codex-after-turn"));

      const outcome = await replier(terminal, codexProcesses()).send(codexSession(rollout), "thanks");

      expect(outcome).toMatchObject({ status: "refused", reason: expect.stringContaining("cannot confirm") });
      expect(terminal.typed).toEqual([]);
    });

    it("refuses Codex's update picker, whose first option runs curl | sh", async () => {
      const rollout = codexRollout("First line here.\nAll done with **the test** now.");
      const terminal = new FakeTerminal(screenFixture("codex-update-picker"));

      const outcome = await replier(terminal, codexProcesses()).send(codexSession(rollout), "1");

      expect(outcome.status).toBe("refused");
      expect(terminal.typed).toEqual([]);
    });

    it("refuses a Codex session the fleet sees working", async () => {
      const rollout = codexRollout("x");
      const terminal = new FakeTerminal(screenFixture("codex-after-turn"));

      const outcome = await replier(terminal, codexProcesses()).send(
        { ...codexSession(rollout), state: "working" },
        "hi",
      );

      expect(outcome).toMatchObject({ status: "refused", reason: expect.stringContaining("still working") });
    });
  });
});

describe("lastAgentMessage", () => {
  it("returns Claude's last text once the turn has ended, skipping tool results", () => {
    const transcript = writeTranscript([
      ...claudeTurn("first", "old answer", "2026-09-25T13:00:00.000Z"),
      { type: "user", timestamp: "2026-09-25T13:10:00.000Z", message: { content: "second" } },
      {
        type: "assistant",
        timestamp: "2026-09-25T13:10:01.000Z",
        message: { stop_reason: "tool_use", content: [{ type: "text", text: "Looking." }, { type: "tool_use" }] },
      },
      {
        type: "user",
        timestamp: "2026-09-25T13:10:02.000Z",
        message: { content: [{ type: "tool_result", content: "files" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-09-25T13:10:03.000Z",
        message: { stop_reason: "end_turn", content: [{ type: "text", text: "A) this\nB) that" }] },
      },
    ]);

    expect(lastAgentMessage("claude", transcript)).toBe("A) this\nB) that");
  });

  it("is null while a Claude turn is still running, so an old question is not resurfaced", () => {
    const transcript = writeTranscript([
      ...claudeTurn("first", "A) old question", "2026-09-25T13:00:00.000Z"),
      { type: "user", timestamp: "2026-09-25T13:10:00.000Z", message: { content: "B" } },
    ]);

    expect(lastAgentMessage("claude", transcript)).toBeNull();
  });
});

describe("lastAgentTurnId", () => {
  it("moves on when the human answers in the terminal, ignoring bookkeeping entries", () => {
    const asked = [...claudeTurn("first", "A) one\nB) two", "2026-09-25T13:00:00.000Z")].map((entry, index) => ({
      ...(entry as object),
      uuid: `u${index}`,
    }));
    const before = lastAgentTurnId("claude", writeTranscript(asked));
    expect(before).not.toBeNull();
    const withNoise = lastAgentTurnId("claude", writeTranscript([...asked, { type: "system", uuid: "noise" }]));
    expect(withNoise).toBe(before);
    const answered = lastAgentTurnId(
      "claude",
      writeTranscript([
        ...asked,
        { type: "user", uuid: "typed", timestamp: "2026-09-25T13:05:00.000Z", message: { content: "B" } },
      ]),
    );
    expect(answered).toBe("typed");
    expect(answered).not.toBe(before);
  });
});

describe("transcriptHasUserMessage", () => {
  it("only counts a message written since the reply was typed", () => {
    const transcript = writeTranscript(claudeTurn("hi", "hello", "2026-09-25T13:00:00.000Z"));

    expect(transcriptHasUserMessage("claude", transcript, "hi", "2026-09-25T12:59:00.000Z")).toBe(true);
    expect(transcriptHasUserMessage("claude", transcript, "hi", "2026-09-25T13:05:00.000Z")).toBe(false);
  });
});
