import { describe, expect, it } from "vitest";
import { asSessionId } from "../core/types.js";
import { ClaudeEventTranslator, claudeToolCategory, parseStreamJsonLine } from "./claude-translate.js";

const sid = asSessionId("s1");
const at = () => "2026-11-09T10:00:00.000Z";
const mk = () => new ClaudeEventTranslator(sid, at);

// Shapes follow the Agent SDK messages used in src/native/claude-runner.test.ts and src/adapters/claude-code.test.ts.
const assistant = (content: unknown[], id = "msg_1") => ({ type: "assistant", message: { id, content } });

describe("ClaudeEventTranslator", () => {
  it("init starts the session", () => {
    expect(
      mk()
        .translate({ type: "system", subtype: "init", session_id: "abc" })
        .map((e) => e.type),
    ).toEqual(["sessionStarted"]);
  });

  it("text, thinking and tool use keep order with stable ids, deduped on replay by the channel key", () => {
    const t = mk();
    const msg = assistant([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
    ]);
    const a = t.translate(msg);
    expect(a.map((e) => e.type)).toEqual(["thinking", "agentMessage", "toolStarted"]);
    const b = mk().translate(msg);
    expect(b.map((e) => e.id)).toEqual(a.map((e) => e.id));
    expect(new Set(a.map((e) => e.id)).size).toBe(3);
    const started = a[2]!;
    expect(started.type === "toolStarted" && started.tool).toMatchObject({
      category: "shell",
      name: "Bash",
      detail: "ls",
      state: "running",
    });
  });

  it("file tools emit file events", () => {
    const t = mk();
    const kinds = t
      .translate(
        assistant([
          { type: "tool_use", id: "r", name: "Read", input: { file_path: "/a" } },
          { type: "tool_use", id: "e", name: "Edit", input: { file_path: "/b" } },
          { type: "tool_use", id: "w", name: "Write", input: { file_path: "/c" } },
        ]),
      )
      .map((e) => e.type);
    expect(kinds).toEqual(["toolStarted", "fileRead", "toolStarted", "fileEdited", "toolStarted", "fileCreated"]);
  });

  it("tool results complete the tool, failed when is_error", () => {
    const t = mk();
    t.translate(assistant([{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "false" } }]));
    const out = t.translate({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "boom", is_error: true }] },
    });
    expect(out.map((e) => e.type)).toEqual(["toolOutput", "toolCompleted"]);
    const done = out[1]!;
    expect(done.type === "toolCompleted" && done.tool.state).toBe("failed");
    // a result for an unknown tool is ignored
    expect(
      t.translate({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "zz", content: "x" }] } }),
    ).toEqual([]);
  });

  it("categories", () => {
    expect(claudeToolCategory("Bash", { command: "git status" })).toBe("git");
    expect(claudeToolCategory("Grep")).toBe("search");
    expect(claudeToolCategory("mcp__x__y")).toBe("mcp");
    expect(claudeToolCategory("Task")).toBe("task");
    expect(claudeToolCategory("WebFetch")).toBe("browser");
    expect(claudeToolCategory("Mystery")).toBe("unknown");
  });

  it("AskUserQuestion is a question, not a tool", () => {
    const t = mk();
    expect(t.translate(assistant([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }]))).toEqual([]);
    const e = t.question({
      toolName: "AskUserQuestion",
      toolUseID: "q1",
      input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] },
    })!;
    expect(e.type === "questionRequested" && e.question).toMatchObject({
      id: "q1",
      prompt: "Which?",
      options: [
        { id: "0", label: "A" },
        { id: "1", label: "B" },
      ],
      allowsFreeform: true,
    });
    expect(t.question({ input: {} })).toBeUndefined();
  });

  it("permission prompts", () => {
    const e = mk().permission("tool", {
      toolName: "Bash",
      toolUseID: "p1",
      input: { command: "rm -rf x" },
      title: "Run rm",
    })!;
    expect(e.type === "permissionRequested" && e.request).toMatchObject({
      id: "p1",
      category: "shell",
      command: "rm -rf x",
      summary: "Run rm",
      availableActions: ["allowOnce", "deny", "denyWithFeedback"],
    });
    expect(mk().permission("tool", "junk")).toBeUndefined();
  });

  it("result: success completes; error and refused turns fail", () => {
    expect(mk().translate({ type: "result", subtype: "success", result: "done", uuid: "r1" })[0]).toMatchObject({
      type: "completed",
      summary: "done",
    });
    expect(
      mk().translate({ type: "result", subtype: "success", is_error: true, result: "Not logged in", uuid: "r2" })[0],
    ).toMatchObject({
      type: "failed",
      message: "Not logged in",
    });
    expect(
      mk().translate({ type: "result", subtype: "error_during_execution", is_error: true, uuid: "r3" })[0],
    ).toMatchObject({
      type: "failed",
      message: "error_during_execution",
    });
  });

  it("is resilient to junk", () => {
    const t = mk();
    for (const junk of [
      null,
      5,
      "x",
      [],
      {},
      { type: "assistant" },
      { type: "assistant", message: { content: "no" } },
      assistant([null, 1, { type: "tool_use" }]),
    ]) {
      expect(t.translate(junk)).toEqual([]);
    }
  });

  it("parseStreamJsonLine skips garbage", () => {
    expect(parseStreamJsonLine('{"type":"result"}')).toEqual({ type: "result" });
    expect(parseStreamJsonLine("not json")).toBeUndefined();
    expect(parseStreamJsonLine("[1]")).toBeUndefined();
    expect(parseStreamJsonLine('{"broken"')).toBeUndefined();
  });
});
