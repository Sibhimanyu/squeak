import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DucklingTracker, modelLabel } from "./ducklings.js";
import type { MessageRow } from "./types.js";

let seq = 0;
const at = (s: number) => new Date(Date.parse("2026-11-12T07:00:00Z") + s * 1000).toISOString();
const row = (role: MessageRow["role"], kind: string, payload: unknown, s: number): MessageRow => ({
  seq: ++seq,
  sessionId: "x",
  role,
  kind,
  payload,
  createdAt: at(s),
});
const call = (id: string, input: Record<string, unknown>, s: number, name = "Agent") =>
  row("agent", "assistant", { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }, s);
const result = (id: string, text: string, s: number, extra: Record<string, unknown> = {}) =>
  row(
    "agent",
    "user",
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] }, ...extra },
    s,
  );

describe("a helper's one model", () => {
  const recorded = JSON.parse(
    readFileSync(new URL("./fixtures/duckling-model-recorded.json", import.meta.url), "utf8"),
  ) as Array<{ role: MessageRow["role"]; kind: string; createdAt: string; payload: unknown }>;
  const feedAll = (t: DucklingTracker, upTo = recorded.length) =>
    recorded.slice(0, upTo).forEach((r) => t.feed({ seq: ++seq, sessionId: "x", ...r }));
  const now = Date.parse("2026-11-25T04:17:00Z");

  it("a recorded chat on Opus whose call names haiku: the helper is Haiku, not inherited", () => {
    const t = new DucklingTracker();
    feedAll(t, 1); // only the launching row: the call's model
    expect(t.list(now).items[0]).toMatchObject({ title: "Build and deploy to Firebase", model: "Haiku" });
    expect(t.list(now).items[0]?.modelInherited).toBeUndefined();
  });

  it("the helper's own reported model beats the call's alias", () => {
    const t = new DucklingTracker();
    feedAll(t);
    const item = t.list(now).items[0];
    expect(item?.model).toBe("Haiku 5.5");
    expect(item?.modelInherited).toBeUndefined();
    expect(t.detail("toolu_018U4qNtJxUTxmnkNUTEaf2s", now, [])?.model).toBe("Haiku 5.5");
  });

  it("a call that names no model runs on the chat's, marked inherited, until the helper reports its own", () => {
    const t = new DucklingTracker();
    t.feed(
      row(
        "agent",
        "assistant",
        {
          type: "assistant",
          message: {
            model: "claude-opus-5-5",
            content: [{ type: "tool_use", id: "toolu_i", name: "Agent", input: { description: "d", prompt: "p" } }],
          },
        },
        0,
      ),
    );
    expect(t.list(Date.parse(at(1))).items[0]).toMatchObject({ model: "Opus 5.5", modelInherited: true });
    t.feed(
      row(
        "agent",
        "assistant",
        { type: "assistant", parent_tool_use_id: "toolu_i", message: { model: "claude-sonnet-5-5", content: [] } },
        2,
      ),
    );
    const item = t.list(Date.parse(at(3))).items[0];
    expect(item?.model).toBe("Sonnet 5.5");
    expect(item?.modelInherited).toBeUndefined();
  });

  it("`inherit` is the chat's model; a shell has none", () => {
    const t = new DucklingTracker();
    t.feed(
      row(
        "agent",
        "assistant",
        {
          type: "assistant",
          message: {
            model: "claude-opus-5-5",
            content: [
              {
                type: "tool_use",
                id: "toolu_h",
                name: "Agent",
                input: { description: "d", prompt: "p", model: "inherit" },
              },
              { type: "tool_use", id: "toolu_s", name: "Bash", input: { command: "sleep 9", run_in_background: true } },
            ],
          },
        },
        0,
      ),
    );
    const items = t.list(Date.parse(at(1))).items;
    expect(items.find((i) => i.id === "toolu_h")).toMatchObject({ model: "Opus 5.5", modelInherited: true });
    expect(items.find((i) => i.id === "toolu_s")?.model).toBeUndefined();
  });
});

describe("DucklingTracker", () => {
  it("reportedAt is the agent's next assistant row after the notification, not a helper's own row", () => {
    const t = new DucklingTracker();
    t.feed(call("toolu_r", { description: "scan", prompt: "p", run_in_background: true }, 0));
    t.feed(result("toolu_r", "Async agent launched successfully. agentId: abc", 1));
    t.feed(row("agent", "system/task_notification", { tool_use_id: "toolu_r", status: "completed", summary: "ok" }, 9));
    expect(t.list(Date.parse(at(10))).items[0]?.reportedAt).toBeUndefined();
    t.feed(
      row(
        "agent",
        "assistant",
        { type: "assistant", parent_tool_use_id: "toolu_r", message: { model: "claude-sonnet-5-5", content: [] } },
        10,
      ),
    );
    expect(t.list(Date.parse(at(11))).items[0]?.reportedAt).toBeUndefined();
    t.feed(
      row("agent", "assistant", { type: "assistant", message: { content: [{ type: "text", text: "got it" }] } }, 12),
    );
    expect(t.list(Date.parse(at(13))).items[0]).toMatchObject({ status: "done", reportedAt: at(12) });
    t.feed(row("agent", "assistant", { type: "assistant", message: { content: [] } }, 20));
    expect(t.list(Date.parse(at(21))).items[0]?.reportedAt).toBe(at(12));
  });

  it("an async Agent call runs until its notification, which carries the report", () => {
    const t = new DucklingTracker();
    t.feed(
      call("toolu_a", { description: "scan", prompt: "look around", run_in_background: true, model: "sonnet" }, 0),
    );
    t.feed(result("toolu_a", "Async agent launched successfully. agentId: abc123", 1));
    t.feed(row("agent", "system/task_started", { task_id: "t1", tool_use_id: "toolu_a" }, 1));
    expect(t.list(Date.parse(at(5)))).toMatchObject({
      running: 1,
      items: [{ id: "toolu_a", kind: "agent", title: "scan", model: "Sonnet", status: "running" }],
    });
    t.feed(
      row(
        "agent",
        "system/task_notification",
        { task_id: "t1", tool_use_id: "toolu_a", status: "completed", summary: "ok" },
        9,
      ),
    );
    t.feed(
      row(
        "agent",
        "user",
        {
          type: "user",
          message: {
            content:
              "<task-notification><tool-use-id>toolu_a</tool-use-id><status>completed</status><result>Found a.txt</result></task-notification>",
          },
        },
        9,
      ),
    );
    const list = t.list(Date.parse(at(10)));
    expect(list.running).toBe(0);
    expect(list.items[0]).toMatchObject({ status: "done", endedAt: at(9), summary: "Found a.txt" });
    expect(t.detail("toolu_a", Date.parse(at(10)), [])).toMatchObject({ brief: "look around", report: "Found a.txt" });
    // finished ones leave after 10 minutes
    expect(t.list(Date.parse(at(9)) + 11 * 60_000).items).toEqual([]);
  });

  it("a foreground call ends with its result; a background shell is a shell; Stop ends the rest", () => {
    const t = new DucklingTracker();
    t.feed(call("toolu_f", { description: "quick", prompt: "p" }, 0));
    t.feed(call("toolu_s", { command: "npm run dev\nmore", run_in_background: true }, 1, "Bash"));
    t.feed(call("toolu_plain", { command: "ls" }, 1, "Bash"));
    expect(t.list(Date.parse(at(2))).running).toBe(2);
    t.feed(result("toolu_f", "done by it", 3));
    expect(t.list(Date.parse(at(4))).items.find((i) => i.id === "toolu_f")?.status).toBe("done");
    t.feed(row("agent", "error", { type: "error", content: "aborted by user" }, 5));
    const shell = t.list(Date.parse(at(6))).items.find((i) => i.id === "toolu_s");
    expect(shell).toMatchObject({ kind: "shell", status: "stopped" });
    expect(t.list(Date.parse(at(6))).running).toBe(0);
  });

  it("steps come from the helper's own rows", () => {
    const t = new DucklingTracker();
    const launch = call("toolu_a", { description: "scan", prompt: "p", run_in_background: true }, 0);
    t.feed(launch);
    const own = row(
      "agent",
      "assistant",
      {
        type: "assistant",
        parent_tool_use_id: "toolu_a",
        message: {
          model: "claude-sonnet-5-5",
          content: [{ type: "tool_use", id: "i1", name: "Bash", input: { command: "ls" } }],
        },
      },
      2,
    );
    t.feed(own);
    const detail = t.detail("toolu_a", Date.parse(at(3)), [own]);
    expect(detail?.model).toBe("Sonnet 5.5");
    expect(detail?.steps.length).toBeGreaterThan(0);
    expect(t.detail("nope", 0, [])).toBeNull();
  });

  it("names models", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-opus-5-5-20260101")).toBe("Opus 5.5");
    expect(modelLabel("haiku")).toBe("Haiku");
  });

  describe("SendMessage resume", () => {
    const AID = "a033929437e8b4b8b";
    const note = (taskId: string, toolId: string, s: number) =>
      row(
        "agent",
        "user",
        {
          type: "user",
          message: {
            content: `<task-notification><task-id>${taskId}</task-id><tool-use-id>${toolId}</tool-use-id><status>completed</status><summary>ok</summary></task-notification>`,
          },
        },
        s,
      );
    const launched = () => {
      const t = new DucklingTracker();
      t.feed(call("toolu_L", { description: "menu bug", prompt: "p", model: "sonnet" }, 0));
      t.feed(
        result("toolu_L", `Async agent launched successfully.\nagentId: ${AID}`, 1, {
          toolUseResult: { isAsync: true, status: "async_launched", agentId: AID },
        }),
      );
      t.feed(note(AID, "toolu_L", 5));
      return t;
    };
    const send = (t: DucklingTracker, to: string, payload: unknown, tr: Record<string, unknown>) => {
      t.feed(call("toolu_S", { to, summary: "s", message: "go again" }, 10, "SendMessage"));
      t.feed(result("toolu_S", JSON.stringify(payload), 11, { toolUseResult: tr }));
    };

    it("a resumed agent is the same duckling, running again, then done at its notification", () => {
      const t = launched();
      const ok = { success: true, resumedAgentId: AID };
      send(t, AID, ok, { ...ok, revivedAgentId: AID });
      const items = t.list(Date.parse(at(12))).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: "toolu_L",
        kind: "agent",
        title: "menu bug",
        model: "Sonnet",
        status: "running",
      });
      expect(items[0]?.endedAt).toBeUndefined();
      t.feed(note(AID, "toolu_S", 20));
      expect(t.list(Date.parse(at(21))).items).toMatchObject([{ id: "toolu_L", status: "done" }]);
    });

    it("messages queued to a running subagent add nothing (live shape: pin.id, two follow-ups)", () => {
      const t = new DucklingTracker();
      t.feed(call("toolu_L", { description: "popup panel", prompt: "p", model: "opus" }, 0));
      t.feed(
        result("toolu_L", `Async agent launched successfully.\nagentId: ${AID}`, 1, {
          toolUseResult: { isAsync: true, status: "async_launched", agentId: AID },
        }),
      );
      const queued = { success: true, message: "Message queued", pin: { id: AID, name: AID, ref: "12f217" } };
      for (const [i, id] of ["toolu_S1", "toolu_S2"].entries()) {
        t.feed(call(id, { to: AID, summary: "s", message: "more" }, 10 + i * 5, "SendMessage"));
        t.feed(result(id, JSON.stringify(queued), 11 + i * 5, { toolUseResult: queued }));
      }
      expect(t.list(Date.parse(at(30)))).toMatchObject({ running: 1, items: [{ id: "toolu_L", status: "running" }] });
      t.feed(note(AID, "toolu_L", 40));
      expect(t.list(Date.parse(at(41)))).toMatchObject({ running: 0, items: [{ id: "toolu_L", status: "done" }] });
    });

    it("resumes by name through `to` when the result names no id", () => {
      const t = launched();
      send(t, AID, { success: true }, {});
      expect(t.list(Date.parse(at(12))).running).toBe(1);
    });

    it("a failed or unknown resume adds nothing", () => {
      const t = launched();
      send(t, AID, { success: false }, { success: false });
      expect(t.list(Date.parse(at(12))).running).toBe(0);
      const u = launched();
      send(u, "zzzzzz", { success: true, resumedAgentId: "zzzzzz" }, { success: true, resumedAgentId: "zzzzzz" });
      expect(u.list(Date.parse(at(12))).running).toBe(0);
    });
  });

  describe("never losing a started subagent", () => {
    const launchedBg = (t: DucklingTracker) => {
      t.feed(call("toolu_a", { description: "scan", prompt: "p", run_in_background: true }, 0));
    };

    it("is listed from its tool call alone, before any result or progress event", () => {
      const t = new DucklingTracker();
      launchedBg(t);
      expect(t.list(Date.parse(at(1)))).toMatchObject({ running: 1, items: [{ id: "toolu_a", status: "running" }] });
    });

    it("with no live agent process it is unknown with its last-seen time, still listed a day later, never dropped", () => {
      const t = new DucklingTracker();
      launchedBg(t);
      t.feed(row("agent", "system/task_started", { task_id: "t1", tool_use_id: "toolu_a" }, 3));
      t.settle(false);
      const l = t.list(Date.parse(at(60)));
      expect(l.running).toBe(0);
      expect(l.items).toMatchObject([{ id: "toolu_a", status: "unknown", lastSeenAt: at(3) }]);
      expect(t.list(Date.parse(at(60 * 60 * 20))).items).toHaveLength(1);
    });

    it("one launched before the live process started is stopped then: it died with the old process", () => {
      const t = new DucklingTracker();
      launchedBg(t);
      t.feed(row("agent", "system/task_started", { task_id: "t1", tool_use_id: "toolu_a" }, 3));
      t.settle(true, Date.parse(at(10)));
      const l = t.list(Date.parse(at(60)));
      expect(l.running).toBe(0);
      expect(l.items).toMatchObject([{ id: "toolu_a", status: "stopped", endedAt: at(10) }]);
      // a finished helper leaves the list like any other, not a day later
      expect(t.list(Date.parse(at(60 * 11))).items).toHaveLength(0);
    });

    it("an unknown one is stopped once a newer process runs the chat", () => {
      const t = new DucklingTracker();
      launchedBg(t);
      t.settle(false);
      t.settle(true, Date.parse(at(30)));
      expect(t.list(Date.parse(at(31))).items).toMatchObject([{ id: "toolu_a", status: "stopped", endedAt: at(30) }]);
    });

    it("with no live process, last seen is the chat's latest agent row, not the launch (no '0s')", () => {
      const t = new DucklingTracker();
      launchedBg(t);
      t.feed(
        row("agent", "assistant", { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }, 2820),
      );
      t.settle(false);
      expect(t.list(Date.parse(at(3000))).items).toMatchObject([{ status: "unknown", lastSeenAt: at(2820) }]);
    });

    it("one launched or last seen since the live process started keeps running", () => {
      const t = new DucklingTracker();
      launchedBg(t);
      t.feed(call("toolu_b", { description: "later", prompt: "p", run_in_background: true }, 20));
      t.feed(row("agent", "assistant", { type: "assistant", parent_tool_use_id: "toolu_a", message: {} }, 15));
      t.settle(true, Date.parse(at(10)));
      expect(t.list(Date.parse(at(30))).running).toBe(2);
    });

    it("an unknown one still ends at its notification, and shows done", () => {
      const t = new DucklingTracker();
      launchedBg(t);
      t.settle(false);
      t.feed(
        row("agent", "system/task_notification", { tool_use_id: "toolu_a", status: "completed", summary: "ok" }, 9),
      );
      expect(t.list(Date.parse(at(10))).items).toMatchObject([{ id: "toolu_a", status: "done" }]);
    });

    it("running ones are never the ones cut off by the list limit", () => {
      const t = new DucklingTracker();
      for (let i = 0; i < 15; i++)
        t.feed(call(`toolu_${i}`, { description: `d${i}`, prompt: "p", run_in_background: true }, i));
      expect(t.list(Date.parse(at(20))).items).toHaveLength(15);
    });
  });
});
