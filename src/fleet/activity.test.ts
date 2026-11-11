import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  claudeSteps,
  describeClaudeTool,
  describeCodexTool,
  readActivity,
  stripSystemInstruction,
} from "./activity.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function transcript(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-"));
  dirs.push(dir);
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

/** One block of an assistant message, the way Claude Code writes them: an entry per block, one id. */
function block(id: string, content: Record<string, unknown>, at = "2026-09-26T03:00:00.000Z") {
  return { type: "assistant", timestamp: at, message: { id, role: "assistant", content: [content] } };
}

/** The last block of a message that ended the turn, the way Claude Code stamps it. */
function ended(id: string, content: Record<string, unknown>, at = "2026-09-26T03:00:00.000Z") {
  const entry = block(id, content, at);
  return { ...entry, message: { ...entry.message, stop_reason: "end_turn" } };
}

const user = (content: unknown, at = "2026-09-26T02:59:00.000Z") => ({
  type: "user",
  timestamp: at,
  message: { content },
});

describe("readActivity for Claude", () => {
  it("lists the current turn's thinking, notes and tool calls in order, each block once", () => {
    const file = transcript([
      user("an earlier question"),
      ended("m0", { type: "text", text: "An earlier answer." }),
      user("fix the flaky test"),
      block("m1", { type: "thinking", thinking: "The retry loop races the timer." }),
      block("m1", { type: "text", text: "Found it; patching the timer." }),
      block("m1", { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/w/src/timer.ts" } }),
      // Written again as it streamed: must not appear twice.
      block("m1", { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/w/src/timer.ts" } }),
      user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
      block("m2", {
        type: "tool_use",
        id: "t2",
        name: "Bash",
        input: { command: "npm test", description: "Run tests" },
      }),
    ]);

    expect(readActivity("claude", file)).toEqual({
      total: 4,
      steps: [
        { kind: "thinking", text: "The retry loop races the timer.", at: "2026-09-26T03:00:00.000Z" },
        { kind: "note", text: "Found it; patching the timer.", at: "2026-09-26T03:00:00.000Z" },
        { kind: "tool", text: "Edit timer.ts", at: "2026-09-26T03:00:00.000Z" },
        { kind: "tool", text: "Run tests", at: "2026-09-26T03:00:00.000Z" },
      ],
    });
  });

  it("keeps a worker reporting in as part of the turn, not the start of a new one", () => {
    const file = transcript([
      user("render all nine scenes"),
      block("m1", {
        type: "tool_use",
        id: "a1",
        name: "Agent",
        input: { description: "scene 1", run_in_background: true },
      }),
      user(
        '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Agent "scene 1" finished</summary>',
      ),
      block("m2", { type: "text", text: "Scene 1 is in." }),
    ]);

    expect(readActivity("claude", file).steps.map((step) => [step.kind, step.text])).toEqual([
      ["tool", "Start scene 1 in the background"],
      ["background", 'Agent "scene 1" finished'],
      ["note", "Scene 1 is in."],
    ]);
  });

  it("leaves out subagents' own steps and keeps only the newest when the turn is long", () => {
    const entries: unknown[] = [user("go")];
    for (let index = 0; index < 20; index += 1) {
      entries.push(
        block(`m${index}`, {
          type: "tool_use",
          id: `t${index}`,
          name: "Read",
          input: { file_path: `/w/f${index}.ts` },
        }),
      );
    }
    entries.push({ ...block("side", { type: "text", text: "a subagent's note" }), isSidechain: true });
    const activity = readActivity("claude", transcript(entries), 5);

    expect(activity.total).toBe(20);
    expect(activity.steps.map((step) => step.text)).toEqual([
      "Read f15.ts",
      "Read f16.ts",
      "Read f17.ts",
      "Read f18.ts",
      "Read f19.ts",
    ]);
  });

  it("keeps whole thinking and notes when asked (the phone's verbose view), tool labels still short", () => {
    const long = "Considering the splitter. ".repeat(40).trim();
    const file = transcript([
      user("fix it"),
      block("m1", { type: "thinking", thinking: long }),
      block("m1", { type: "text", text: long }),
      block("m1", { type: "tool_use", id: "t1", name: "Bash", input: { command: `echo ${"x".repeat(400)}` } }),
    ]);
    const short = readActivity("claude", file);
    expect(short.steps[0]!.text.length).toBeLessThanOrEqual(280);
    const whole = readActivity("claude", file, 50, { stepChars: 4000 });
    expect(whole.steps.map((step) => step.text.length)).toEqual([long.length, long.length, expect.any(Number)]);
    expect(whole.steps[2]!.text.length).toBeLessThanOrEqual(120);
  });

  it("keeps a message sent into a running turn as a step of that turn, not a new one", () => {
    const file = transcript([
      user("fix the flaky test"),
      block("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/timer.ts" } }),
      user([{ type: "tool_result", tool_use_id: "t1", content: "…" }]),
      user("use the fake clock instead", "2026-09-26T03:00:30.000Z"),
      // Claude Code may write it again; it is one step.
      user("use the fake clock instead", "2026-09-26T03:00:30.000Z"),
      block("m2", { type: "text", text: "Switching to the fake clock." }),
    ]);

    expect(readActivity("claude", file).steps.map((step) => [step.kind, step.text])).toEqual([
      ["tool", "Read timer.ts"],
      ["you", "use the fake clock instead"],
      ["note", "Switching to the fake clock."],
    ]);
  });

  it("starts a new turn for a message sent after the last one ended", () => {
    const file = transcript([
      user("fix the flaky test"),
      ended("m1", { type: "text", text: "Fixed." }),
      user([{ type: "text", text: "now update the docs" }]),
      block("m2", { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/w/README.md" } }),
    ]);

    expect(readActivity("claude", file).steps.map((step) => [step.kind, step.text])).toEqual([
      ["tool", "Edit README.md"],
    ]);
  });

  it("ignores isMeta entries (a skill loading mid-turn does not wipe the feed)", () => {
    const file = transcript([
      user("ship it"),
      block("m1", { type: "tool_use", id: "t1", name: "Skill", input: { skill: "ship" } }),
      user([{ type: "tool_result", tool_use_id: "t1", content: "Launching skill: ship" }]),
      { ...user([{ type: "text", text: "Base directory for this skill: /x\n\n# Ship" }]), isMeta: true },
      block("m2", { type: "text", text: "Running the checks." }),
    ]);

    expect(readActivity("claude", file).steps.map((step) => [step.kind, step.text])).toEqual([
      ["tool", "Use the ship skill"],
      ["note", "Running the checks."],
    ]);
  });

  it("treats a message after an interruption as a new turn", () => {
    const file = transcript([
      user("fix it"),
      block("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/a.ts" } }),
      user([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      user("do something else"),
      block("m2", { type: "text", text: "Sure." }),
    ]);

    expect(readActivity("claude", file).steps.map((step) => [step.kind, step.text])).toEqual([["note", "Sure."]]);
  });

  it("is empty for a transcript that is not there", () => {
    expect(readActivity("claude", "/nonexistent/t.jsonl")).toEqual({ steps: [], total: 0 });
  });
});

describe("readActivity for Codex", () => {
  it("lists notes, shown reasoning and commands since the user's last message", () => {
    const item = (payload: Record<string, unknown>) => ({
      timestamp: "2026-09-26T03:00:00.000Z",
      type: "response_item",
      payload,
    });
    const file = transcript([
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] }),
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "check the speaker images" }] }),
      // Encrypted reasoning with no summary shows nothing.
      item({ type: "reasoning", summary: [], encrypted_content: "gAAA" }),
      item({ type: "reasoning", summary: [{ type: "summary_text", text: "Looking for the v3 folder." }] }),
      item({ type: "function_call", name: "shell", arguments: JSON.stringify({ cmd: ["bash", "-lc", "ls v3"] }) }),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "All three are there." }] }),
    ]);

    expect(readActivity("codex", file).steps.map((step) => [step.kind, step.text])).toEqual([
      ["thinking", "Looking for the v3 folder."],
      ["tool", "Run ls v3"],
      ["note", "All three are there."],
    ]);
  });
});

describe("readActivity for Codex steers", () => {
  const at = "2026-09-26T03:00:00.000Z";
  const item = (payload: Record<string, unknown>) => ({ timestamp: at, type: "response_item", payload });
  const event = (type: string) => ({ timestamp: at, type: "event_msg", payload: { type } });
  const said = (text: string) => item({ type: "message", role: "user", content: [{ type: "input_text", text }] });

  it("keeps a message sent mid-task as a step; the injected context and first prompt still start the turn", () => {
    const file = transcript([
      event("task_started"),
      said("# AGENTS.md instructions for /w"),
      said("<system_instruction>…</system_instruction>"),
      said("check the speaker images"),
      item({ type: "function_call", name: "shell", arguments: JSON.stringify({ cmd: ["ls", "v3"] }) }),
      said("only the v3 folder"),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Just v3, then." }] }),
    ]);

    expect(readActivity("codex", file).steps.map((step) => [step.kind, step.text])).toEqual([
      ["tool", "Run ls v3"],
      ["you", "only the v3 folder"],
      ["note", "Just v3, then."],
    ]);
  });

  it("starts a new turn for a message after task_complete", () => {
    const file = transcript([
      event("task_started"),
      said("check the speaker images"),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "All there." }] }),
      event("task_complete"),
      event("task_started"),
      said("now resize them"),
      item({ type: "function_call", name: "shell", arguments: JSON.stringify({ cmd: ["sips", "-Z", "800"] }) }),
    ]);

    expect(readActivity("codex", file).steps.map((step) => [step.kind, step.text])).toEqual([
      ["tool", "Run sips -Z 800"],
    ]);
  });
});

describe("describing tools", () => {
  it("says what a Claude tool call does without quoting its whole input", () => {
    expect(describeClaudeTool("Bash", { command: "npm run ci\necho done" })).toBe("Run npm run ci");
    expect(describeClaudeTool("Grep", { pattern: "TODO" })).toBe("Search for “TODO”");
    expect(describeClaudeTool("WebFetch", { url: "https://example.com/a/b" })).toBe("Fetch example.com");
    expect(describeClaudeTool("mcp__figma__get_screenshot", {})).toBe("Use figma get_screenshot");
    expect(describeClaudeTool("Write", {})).toBe("Write a file");
  });

  it("finds the command inside Codex's exec tool, and the file inside a patch", () => {
    const exec = { name: "exec", input: 'const r = await tools.exec_command({"cmd":"sed -n 1,40p README.md"})' };
    expect(describeCodexTool(exec)).toBe("Run sed -n 1,40p README.md");
    const patch = { name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/app.ts\n@@" };
    expect(describeCodexTool(patch)).toBe("Edit app.ts");
  });

  it('names what Codex\'s exec script really does, not just "exec"', () => {
    const run = (input: string) => describeCodexTool({ name: "exec", input });
    expect(
      run('const r = await tools.exec_command({cmd:"npm run ci",workdir:"/x",yield_time_ms:10000}); text(r.output);'),
    ).toBe("Run npm run ci");
    expect(run('text(await tools.apply_patch("*** Begin Patch\\n*** Update File: work/plan.py\\n@@"))')).toBe(
      "Edit plan.py",
    );
    expect(run('await tools.view_image({path:"/tmp/shots/home.png"})')).toBe("View home.png");
    expect(run("await tools.write_stdin({session_id: 1, chars: ''})")).toBe("Send input to a running command");
    expect(run("await tools.web__run({search_query:[{q:'x'}]})")).toBe("Search the web");
    expect(run("await tools.mcp__codex_apps__github_fetch({})")).toBe("Use codex_apps github_fetch");
    expect(run("const keys = [1,2]; text(keys.length)")).toBe("Run a script");
  });

  it("says what Codex's subagent tools do", () => {
    const call = (name: string, args: Record<string, unknown>) =>
      describeCodexTool({ name, arguments: JSON.stringify(args) });
    expect(call("spawn_agent", { task_name: "popover_redesign", model: "x", message: "gAAAA" })).toBe(
      "Start duckling popover redesign",
    );
    expect(call("send_message", { target: "settings_redesign", message: "gAAAA" })).toBe("Message settings redesign");
    expect(call("followup_task", { target: "/root/web_copy", message: "gAAAA" })).toBe("Follow up with web copy");
    expect(call("wait_agent", { timeout_ms: 20000 })).toBe("Wait for ducklings");
    expect(call("list_agents", {})).toBe("List ducklings");
    expect(call("send_message", { target: "/root", message: "gAAAA" })).toBe("Report to the main agent");
  });
});

describe("readActivity for Claude messages queued mid-turn", () => {
  const queued = (prompt: string, at: string, commandMode = "prompt") => ({
    type: "attachment",
    timestamp: at,
    attachment: { type: "queued_command", prompt, commandMode, origin: { kind: "human" } },
  });
  const tool = (id: string, at: string) =>
    block(id, { type: "tool_use", id: `t-${id}`, name: "Bash", input: { description: "Step" } }, at);
  const read = (entries: unknown[]) =>
    readActivity("claude", transcript(entries), 10).steps.map((s) => [s.kind, s.text]);

  it("shows a queued_command as a you step between steps", () => {
    expect(
      read([
        user("go", "2026-09-26T02:59:00.000Z"),
        tool("m1", "2026-09-26T03:00:00.000Z"),
        queued("also do X", "2026-09-26T03:00:05.000Z"),
        tool("m2", "2026-09-26T03:00:10.000Z"),
      ]),
    ).toEqual([
      ["tool", "Step"],
      ["you", "also do X"],
      ["tool", "Step"],
    ]);
  });

  it("does not show task notifications or other command modes as you", () => {
    expect(
      read([
        user("go"),
        tool("m1", "2026-09-26T03:00:00.000Z"),
        queued(
          "<task-notification><summary>x</summary></task-notification>",
          "2026-09-26T03:00:01.000Z",
          "task-notification",
        ),
        queued("plain but other mode", "2026-09-26T03:00:02.000Z", "bash"),
      ]),
    ).toEqual([["tool", "Step"]]);
  });

  it("does not show a continuation recap as you", () => {
    expect(
      read([
        user("go"),
        tool("m1", "2026-09-26T03:00:00.000Z"),
        user("This session is being continued from a previous conversation that ran out of context."),
        tool("m2", "2026-09-26T03:00:10.000Z"),
      ]).filter(([kind]) => kind === "you"),
    ).toEqual([]);
  });

  it("does not repeat a steer when a user copy follows", () => {
    expect(
      read([
        user("go"),
        tool("m1", "2026-09-26T03:00:00.000Z"),
        queued("also do X", "2026-09-26T03:00:05.000Z"),
        user("also do X", "2026-09-26T03:00:06.000Z"),
      ]).filter(([kind]) => kind === "you"),
    ).toEqual([["you", "also do X"]]);
  });

  const queuedFull = (attachment: Record<string, unknown>, uuid: string, at: string) => ({
    type: "attachment",
    uuid,
    timestamp: at,
    attachment: { type: "queued_command", prompt: "x", ...attachment },
  });
  const youOf = (entries: unknown[]) => read(entries).filter(([kind]) => kind === "you");
  const base = [user("go"), tool("m1", "2026-09-26T03:00:00.000Z")];

  it("reads a message with files as the text typed after the system_instruction block", () => {
    const withFiles =
      "\n<system_instruction>\nFiles: .context/attachments/a1/image.png (17.8 KB)\n</system_instruction>\n\n\n\nlook at this one";
    expect(youOf([...base, queued(withFiles, "2026-09-26T03:00:05.000Z")])).toEqual([["you", "look at this one"]]);
    expect(youOf([...base, user(withFiles, "2026-09-26T03:00:05.000Z")])).toEqual([["you", "look at this one"]]);
    expect(youOf([...base, user([{ type: "text", text: withFiles }], "2026-09-26T03:00:05.000Z")])).toEqual([
      ["you", "look at this one"],
    ]);
  });

  it("is no step when only the system_instruction block was sent", () => {
    const only = "\n<system_instruction>\nFiles\n</system_instruction>\n\n\n";
    expect(youOf([...base, queued(only, "2026-09-26T03:00:05.000Z")])).toEqual([]);
    expect(youOf([...base, user(only, "2026-09-26T03:00:05.000Z")])).toEqual([]);
  });

  it("strips only a leading block, and leaves a text that is anything else in tags alone", () => {
    expect(stripSystemInstruction("\n<system_instruction>a</system_instruction>\n\nhello")).toBe("hello");
    expect(stripSystemInstruction("  plain <system_instruction>a</system_instruction> text ")).toBe(
      "plain <system_instruction>a</system_instruction> text",
    );
    expect(stripSystemInstruction("<system_instruction>never closed")).toBe("<system_instruction>never closed");
    expect(youOf([...base, queued("<system_instruction>never closed", "2026-09-26T03:00:05.000Z")])).toEqual([]);
  });

  it("keeps two identical messages as two steps, each at its own place", () => {
    expect(
      read([
        ...base,
        queuedFull({ prompt: "again", commandMode: "prompt" }, "u1", "2026-09-26T03:00:05.000Z"),
        tool("m2", "2026-09-26T03:00:20.000Z"),
        queuedFull({ prompt: "again", commandMode: "prompt" }, "u2", "2026-09-26T03:00:40.000Z"),
      ]),
    ).toEqual([
      ["tool", "Step"],
      ["you", "again"],
      ["tool", "Step"],
      ["you", "again"],
    ]);
  });

  it("falls back to the timestamp and position for an entry with no uuid", () => {
    expect(
      youOf([
        ...base,
        queued("again", "2026-09-26T03:00:05.000Z"),
        queued("again", "2026-09-26T03:00:40.000Z"),
        queued("again", "2026-09-26T03:00:40.000Z"),
      ]),
    ).toEqual([
      ["you", "again"],
      ["you", "again"],
    ]);
  });

  it("shows one message written as a queued_command and again as a user entry only once", () => {
    // Equal text within 2 s.
    expect(
      youOf([
        ...base,
        queuedFull({ prompt: "same", commandMode: "prompt" }, "u1", "2026-09-26T03:00:05.000Z"),
        user("same", "2026-09-26T03:00:06.500Z"),
      ]),
    ).toEqual([["you", "same"]]);
    // The user entry's uuid is the attachment's source_uuid, whatever the clock says.
    expect(
      youOf([
        ...base,
        queuedFull({ prompt: "same", commandMode: "prompt", source_uuid: "src-1" }, "u1", "2026-09-26T03:00:05.000Z"),
        { ...user("same", "2026-09-26T03:05:00.000Z"), uuid: "src-1" },
      ]),
    ).toEqual([["you", "same"]]);
    // The same text a minute later is a new message.
    expect(
      youOf([
        ...base,
        queuedFull({ prompt: "same", commandMode: "prompt" }, "u1", "2026-09-26T03:00:05.000Z"),
        user("same", "2026-09-26T03:01:06.000Z"),
      ]),
    ).toEqual([
      ["you", "same"],
      ["you", "same"],
    ]);
  });

  it("does not show a system notice as the person", () => {
    const notices: Record<string, unknown>[] = [
      { commandMode: "prompt", isMeta: true, origin: { kind: "coordinator" } },
      { commandMode: "prompt", isMeta: true },
      { commandMode: "prompt", origin: { kind: "peer", from: "uds:/tmp/cc-socks/1.sock" } },
      { commandMode: "prompt", origin: { kind: "coordinator" } },
      { commandMode: "prompt", origin: { kind: "task-notification", producer: "agent" } },
      { origin: { kind: "coordinator" } },
      {},
    ];
    for (const [i, notice] of notices.entries()) {
      expect(
        youOf([...base, queuedFull({ prompt: "do this", ...notice }, `n${i}`, "2026-09-26T03:00:05.000Z")]),
      ).toEqual([]);
    }
    // Human, and Conductor's own sends with no origin, are the person.
    expect(
      youOf([
        ...base,
        queuedFull({ prompt: "me", commandMode: "prompt", origin: { kind: "human" } }, "h", "2026-09-26T03:00:05.000Z"),
      ]),
    ).toEqual([["you", "me"]]);
    expect(
      youOf([...base, queuedFull({ prompt: "me", commandMode: "prompt" }, "h", "2026-09-26T03:00:05.000Z")]),
    ).toEqual([["you", "me"]]);
  });

  it("never shows the coordinator's instructions to a subagent as you", () => {
    const side = (entry: Record<string, unknown>) => ({ ...entry, isSidechain: true });
    const steps = claudeSteps(
      [
        side(user("Investigate the build")),
        side(tool("s1", "2026-09-26T03:00:00.000Z")),
        side(queuedFull({ prompt: "Also check the logs", commandMode: "prompt" }, "q1", "2026-09-26T03:00:05.000Z")),
        side(user("Also check the tests", "2026-09-26T03:00:09.000Z")),
        side(tool("s2", "2026-09-26T03:00:10.000Z")),
      ],
      280,
      { sidechain: true },
    );
    expect(steps.map((step) => step.kind)).toEqual(["tool", "tool"]);
  });
});
