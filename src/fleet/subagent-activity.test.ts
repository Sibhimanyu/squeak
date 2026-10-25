import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  agentIdFromMeta,
  SubagentActivityReader,
  subagentTranscriptPath,
  TASK_ID_PATTERN,
} from "./subagent-activity.js";
import { backgroundTasks } from "./background-work.js";
import { parseJsonLines, readTailLines } from "./observers/tail.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "subagent");
const parent = path.join(fixtures, "session-1.jsonl");
const NOW = Date.parse("2026-01-01T10:01:00.000Z");
const A = "a1b2c3d4e5f607182";

describe("agentId on a background task", () => {
  const tasks = backgroundTasks(parseJsonLines(readTailLines(parent)), NOW);

  it("comes from toolUseResult.agentId for an async launch and for a finished foreground agent", () => {
    expect(tasks.find((task) => task.id === "toolu_AAAAAAAA1")?.agentId).toBe(A);
    const foreground = tasks.find((task) => task.id === "toolu_BBBBBBBB2");
    expect(foreground?.agentId).toBe("b9c8d7e6f5a403921");
    expect(foreground?.status).toBe("done");
  });

  it("is absent when the launch names none, and never set on a shell", () => {
    expect(tasks.find((task) => task.id === "toolu_CCCCCCCC3")?.agentId).toBeUndefined();
  });

  it("falls back to the agentId line of the result text, and refuses a malformed one", () => {
    const line = (id: string) => [
      {
        type: "assistant",
        timestamp: "2026-01-01T10:00:00.000Z",
        message: { content: [{ type: "tool_use", id: "toolu_X1234567", name: "Agent", input: {} }] },
      },
      {
        type: "user",
        timestamp: "2026-01-01T10:00:01.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_X1234567",
              content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${id} (internal)` }],
            },
          ],
        },
      },
    ];
    expect(backgroundTasks(line("abc123def456"), NOW)[0]?.agentId).toBe("abc123def456");
    expect(backgroundTasks(line("a"), NOW)[0]?.agentId).toBeUndefined();
  });
});

describe("subagentTranscriptPath", () => {
  it("finds a real agent's file", () => {
    expect(subagentTranscriptPath(parent, A)).toBe(
      fs.realpathSync(path.join(fixtures, "session-1", "subagents", `agent-${A}.jsonl`)),
    );
  });

  it("refuses traversal, odd ids and missing files", () => {
    for (const id of ["../../session-1", "a/../b", "", "x", "a1b2c3d4e5f607182.jsonl", "nopenopenope1"]) {
      expect(subagentTranscriptPath(parent, id)).toBeNull();
    }
  });

  it("refuses a symlink that leaves the subagents directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-sub-"));
    try {
      const transcript = path.join(tmp, "s.jsonl");
      fs.writeFileSync(transcript, "");
      fs.mkdirSync(path.join(tmp, "s", "subagents"), { recursive: true });
      const outside = path.join(tmp, "outside.jsonl");
      fs.writeFileSync(outside, "{}\n");
      fs.symlinkSync(outside, path.join(tmp, "s", "subagents", "agent-abcdef123456.jsonl"));
      expect(subagentTranscriptPath(transcript, "abcdef123456")).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("agentIdFromMeta", () => {
  it("maps a tool-use id to its agent through the meta file", () => {
    expect(agentIdFromMeta(parent, "toolu_CCCCCCCC3")).toBe("c0ffee1234567890a");
    expect(agentIdFromMeta(parent, "toolu_unknownxx")).toBeNull();
    expect(agentIdFromMeta(parent, "../x")).toBeNull();
  });
});

describe("SubagentActivityReader", () => {
  const reader = new SubagentActivityReader();

  it("returns the subagent's steps as the main feed would, labels only", () => {
    const read = reader.read(parent, "toolu_AAAAAAAA1", NOW)!;
    expect(read.agentId).toBe(A);
    expect(read.status).toBe("running");
    expect(read.available).toBe(true);
    expect(read.steps.map((step) => [step.kind, step.text])).toEqual([
      ["thinking", "Looking at which tests matter."],
      ["tool", "Read radar.test.ts"],
      ["note", "Found two slow suites."],
      ["tool", "Run the tests"],
    ]);
    expect(JSON.stringify(read)).not.toContain("rm -rf");
    expect(JSON.stringify(read)).not.toContain("SECRET PROMPT");
  });

  it("resolves an agent through its meta file when the launch result names none", () => {
    const read = reader.read(parent, "toolu_CCCCCCCC3", NOW)!;
    expect(read.agentId).toBe("c0ffee1234567890a");
    expect(read.steps.map((step) => step.text)).toEqual(["Search for “TODO”"]);
  });

  it("reports an ended foreground agent as done with its steps", () => {
    const read = reader.read(parent, "toolu_BBBBBBBB2", NOW)!;
    expect(read.status).toBe("done");
    expect(read.steps.map((step) => step.text)).toEqual(["Checked."]);
  });

  it("is null for an unknown or malformed task id", () => {
    expect(reader.read(parent, "toolu_unknownxx", NOW)).toBeNull();
    expect(reader.read(parent, "../../etc/passwd", NOW)).toBeNull();
    expect(TASK_ID_PATTERN.test("toolu_01UF9fXzUsPhhQYSesfD4GZv")).toBe(true);
  });

  it("limits to the newest steps and says how many there were", () => {
    const read = reader.read(parent, "toolu_AAAAAAAA1", NOW, { limit: 2 })!;
    expect(read.steps).toHaveLength(2);
    expect(read.total).toBe(4);
  });

  it("marks tasks whose transcript can be read", () => {
    const tasks = reader.tasks(parent, NOW);
    expect(tasks.every((task) => task.hasSteps === true)).toBe(true);
  });
});
