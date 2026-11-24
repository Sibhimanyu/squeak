import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DucklingTracker, exitCodeOf, isTaskOutputPath, outputPathOf, tailOutput } from "./ducklings.js";
import { readAgentSteps, readShellOutput } from "./ducklings-output.js";
import type { MessageRow } from "./types.js";

// Shapes recorded from a live chat (a background `Bash` with run_in_background and its task events).
const OUT = "/private/tmp/claude-502/-Users-x-greenroom/9894b9d4-e088-4965-8c7b-c6c4b36f3fea/tasks/bv2r3tn32.output";
let seq = 0;
const at = (s: number) => new Date(Date.parse("2026-11-24T09:37:00Z") + s * 1000).toISOString();
const row = (role: MessageRow["role"], kind: string, payload: unknown, s: number): MessageRow => ({
  seq: ++seq,
  sessionId: "x",
  role,
  kind,
  payload,
  createdAt: at(s),
});
const command = 'for i in $(seq 1 30); do curl -s "$URL?x=$RANDOM" | grep -q "1.9.1)" && break; sleep 10; done';
const launch = () => [
  row(
    "agent",
    "assistant",
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_sh",
            name: "Bash",
            input: { command, description: "Wait up to 5 min for the appcast to show 1.9.1", run_in_background: true },
          },
        ],
      },
    },
    0,
  ),
  row(
    "agent",
    "user",
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sh",
            content: `Command running in background with ID: bv2r3tn32. Output is being written to: ${OUT}. You will be notified when it completes. To check interim output, use Read on that file path.\nSession cwd remains /x`,
          },
        ],
      },
      tool_use_result: { stdout: "", backgroundTaskId: "bv2r3tn32" },
    },
    1,
  ),
  row(
    "agent",
    "system/task_started",
    { task_id: "bv2r3tn32", tool_use_id: "toolu_sh", task_type: "local_bash", is_backgrounded: true },
    1,
  ),
];

describe("background shell ducklings", () => {
  it("is its own kind, keeps its command and the recorded output file, and runs until its notification", () => {
    const t = new DucklingTracker();
    for (const r of launch()) t.feed(r);
    const list = t.list(Date.parse(at(120)));
    expect(list.items[0]).toMatchObject({ id: "toolu_sh", kind: "shell", status: "running" });
    expect(list.items[0]?.exitCode).toBeUndefined();
    const d = t.detail("toolu_sh", Date.parse(at(120)), []);
    expect(d?.brief).toBe(command);
    expect(d?.steps).toEqual([]);
    expect(t.outputFileOf("toolu_sh")).toBe(OUT);
  });

  it("ends with the exit code from the task notification", () => {
    const t = new DucklingTracker();
    for (const r of launch()) t.feed(r);
    t.feed(
      row(
        "agent",
        "system/task_notification",
        {
          task_id: "bv2r3tn32",
          tool_use_id: "toolu_sh",
          status: "completed",
          output_file: OUT,
          summary: 'Background command "Wait" completed (exit code 0)',
        },
        200,
      ),
    );
    expect(t.list(Date.parse(at(201))).items[0]).toMatchObject({ status: "done", exitCode: 0, kind: "shell" });
  });

  it("a failed exit code and a killed one", () => {
    const t = new DucklingTracker();
    for (const r of launch()) t.feed(r);
    t.feed(
      row(
        "agent",
        "system/task_notification",
        { tool_use_id: "toolu_sh", status: "failed", summary: 'Background command "x" failed with exit code 2' },
        10,
      ),
    );
    expect(t.list(Date.parse(at(11))).items[0]?.status).toBe("failed");
    const k = new DucklingTracker();
    for (const r of launch()) k.feed(r);
    k.feed(
      row("agent", "system/task_notification", { tool_use_id: "toolu_sh", status: "killed", summary: "stopped" }, 10),
    );
    expect(k.list(Date.parse(at(11))).items[0]).toMatchObject({ status: "stopped" });
  });
});

describe("pure helpers", () => {
  it("parses exit codes and output paths", () => {
    expect(exitCodeOf('Background command "x" completed (exit code 0)')).toBe(0);
    expect(exitCodeOf("completed (exit code -9)")).toBe(-9);
    expect(exitCodeOf("Read the latest failure")).toBeUndefined();
    expect(outputPathOf(`ID: a. Output is being written to: ${OUT}. You will`)).toBe(OUT);
    expect(outputPathOf("output_file: /etc/passwd")).toBeUndefined();
  });

  it("only accepts Claude Code's task output files", () => {
    expect(isTaskOutputPath(OUT)).toBe(true);
    expect(isTaskOutputPath("/tmp/claude-502/a/tasks/x.output")).toBe(true);
    expect(isTaskOutputPath("/tmp/claude-502/a/../../../etc/tasks/x.output")).toBe(false);
    expect(isTaskOutputPath("/etc/passwd")).toBe(false);
    expect(isTaskOutputPath("/private/tmp/claude-502/a/tasks/x.txt")).toBe(false);
    expect(isTaskOutputPath(undefined)).toBe(false);
  });

  it("tails the last lines, drops a cut fragment and escape codes", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const out = tailOutput(text, false, 200);
    expect(out.text.split("\n")).toHaveLength(200);
    expect(out.text.endsWith("line 299")).toBe(true);
    expect(out.truncated).toBe(true);
    expect(tailOutput("tial\nfull\n", true).text).toBe("full");
    expect(tailOutput("a\n", false)).toEqual({ text: "a", truncated: false, exists: true });
    expect(tailOutput("\u001b[32mok\u001b[0m\r\n", false).text).toBe("ok");
    expect(tailOutput("", false).text).toBe("");
  });
});

describe("reading the files", () => {
  const uid = process.getuid?.() ?? 502;
  const root = `/private/tmp/claude-${uid}/zz-test-${process.pid}`;
  const tasks = `${root}/sess/tasks`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const sub = path.join(home, ".claude", "projects", "p", "s", "subagents");
  fs.mkdirSync(tasks, { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads a shell's output tail; nothing for a missing file or a symlink", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n") + "\n";
    fs.writeFileSync(`${tasks}/a.output`, lines);
    const out = readShellOutput(`${tasks}/a.output`);
    expect(out.exists).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.text.split("\n")).toHaveLength(200);
    expect(out.text.endsWith("row 4999")).toBe(true);
    expect(readShellOutput(`${tasks}/none.output`)).toEqual({ text: "", truncated: false, exists: false });
    fs.writeFileSync(`${root}/secret.txt`, "secret");
    fs.symlinkSync(`${root}/secret.txt`, `${tasks}/link.output`);
    expect(readShellOutput(`${tasks}/link.output`).exists).toBe(false);
  });

  it("reads a subagent's steps from its transcript link, only inside ~/.claude/projects", () => {
    const jsonl = path.join(sub, "agent-a1.jsonl");
    fs.writeFileSync(
      jsonl,
      JSON.stringify({
        type: "assistant",
        timestamp: at(5),
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x/Foo.swift" } }],
        },
      }) + "\n{half",
    );
    fs.symlinkSync(jsonl, `${tasks}/agent1.output`);
    expect(readAgentSteps(`${tasks}/agent1.output`, home).map((s) => s.text)).toEqual(["Read Foo.swift"]);
    // a link to anywhere else is not read
    fs.symlinkSync(`${root}/secret.txt`, `${tasks}/agent2.output`);
    expect(readAgentSteps(`${tasks}/agent2.output`, home)).toEqual([]);
    expect(readAgentSteps(undefined, home)).toEqual([]);
  });
});
