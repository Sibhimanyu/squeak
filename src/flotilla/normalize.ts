import { clip, describeClaudeTool } from "../fleet/activity.js";
import type { ThreadEventBody } from "./types.js";

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Host messages (Claude's SDK messages and Codex's items, verbatim) into the thread events a pond shows. Only
 * what a person reads leaves: text, a tool's plain label, never a tool's raw input or its output.
 */
export class Normalizer {
  private readonly labels = new Map<string, string>();

  message(role: string, kind: string, payload: unknown): ThreadEventBody[] {
    const p = rec(payload);
    if (!p) return [];
    if (kind === "user/text") {
      const text = str(p.text);
      return text ? [{ type: "user", by: "", text }] : [];
    }
    if (kind === "assistant") return this.claudeBlocks(rec(p.message)?.content, true);
    if (kind === "user" && role !== "system") return this.claudeBlocks(rec(p.message)?.content, false);
    if (kind === "item/agentMessage") {
      const text = str(p.text)?.trim();
      return text ? [{ type: "agent", text }] : [];
    }
    if (kind === "item/reasoning") {
      const summary = Array.isArray(p.summary) ? p.summary.map(String).join("\n").trim() : "";
      return summary ? [{ type: "thinking", text: summary }] : [];
    }
    if (kind === "item/commandExecution") {
      const command = str(p.command)?.split("\n")[0] ?? "";
      const failed = p.status === "failed" || (typeof p.exitCode === "number" && p.exitCode !== 0);
      return [
        {
          type: "tool",
          label: clip(command ? `Run ${command}` : "Run a command", 120),
          state: failed ? "error" : "done",
        },
      ];
    }
    if (kind === "item/fileChange") return [{ type: "tool", label: "Edit files", state: "done" }];
    if (kind === "item/mcpToolCall") {
      return [
        {
          type: "tool",
          label: clip(`Use ${str(p.tool) ?? "a tool"}`, 120),
          state: p.status === "failed" ? "error" : "done",
        },
      ];
    }
    if (kind === "item/webSearch") return [{ type: "tool", label: "Search the web", state: "done" }];
    return [];
  }

  private claudeBlocks(content: unknown, fromAgent: boolean): ThreadEventBody[] {
    if (!Array.isArray(content)) return [];
    const out: ThreadEventBody[] = [];
    for (const raw of content) {
      const block = rec(raw);
      if (!block) continue;
      if (fromAgent && block.type === "text" && str(block.text)?.trim())
        out.push({ type: "agent", text: str(block.text)!.trim() });
      else if (fromAgent && block.type === "thinking" && str(block.thinking)?.trim()) {
        out.push({ type: "thinking", text: str(block.thinking)!.trim() });
      } else if (fromAgent && block.type === "tool_use") {
        const id = str(block.id) ?? undefined;
        const label = describeClaudeTool(str(block.name) ?? "tool", rec(block.input) ?? {});
        if (id) this.labels.set(id, label);
        out.push({ type: "tool", label, state: "running", ...(id ? { id } : {}) });
      } else if (!fromAgent && block.type === "tool_result") {
        const id = str(block.tool_use_id) ?? undefined;
        out.push({
          type: "tool",
          label: (id && this.labels.get(id)) || "Tool",
          state: block.is_error === true ? "error" : "done",
          ...(id ? { id } : {}),
        });
      }
    }
    return out;
  }

  /** An open request: a question a member may answer, anything else shown and left to the starter. */
  request(id: string, kind: string, payload: unknown): ThreadEventBody {
    const p = rec(payload);
    if (kind === "question") {
      const questions = Array.isArray(rec(p?.input)?.questions) ? (rec(p?.input)!.questions as unknown[]) : [];
      const first = rec(questions[0]);
      const options = Array.isArray(first?.options)
        ? first.options.map((o) => str(rec(o)?.label) ?? str(o) ?? "").filter(Boolean)
        : [];
      return {
        type: "question",
        requestId: id,
        text: clip(str(first?.question) ?? "The agent has a question", 2000),
        options: options.slice(0, 12),
      };
    }
    const tool = str(p?.toolName);
    const label =
      kind === "plan"
        ? "A plan is waiting for approval"
        : kind === "command"
          ? `Run ${clip(str(p?.command)?.split("\n")[0] ?? "a command", 100)}`
          : kind === "file_change"
            ? "Change files"
            : tool
              ? describeClaudeTool(tool, rec(p?.input) ?? {})
              : "An action is waiting for approval";
    return { type: "approval", requestId: id, label };
  }

  /** The agent's answer shaped as the host's `answers` for this question (question text to the chosen label). */
  static answersFor(payload: unknown, answer: string): unknown {
    const questions = rec(rec(payload)?.input)?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return { answer };
    return Object.fromEntries(questions.map((q) => [str(rec(q)?.question) ?? "question", answer]));
  }
}
