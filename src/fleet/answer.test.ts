import { describe, expect, it } from "vitest";

import {
  AnswerService,
  answerControl,
  answerMessage,
  conductorAnswersBody,
  NOT_CONFIRMED,
  parseAnswerInput,
  validateAnswer,
  type AnswerRelay,
} from "./answer.js";
import type { PendingAsk } from "./question.js";

const ask: PendingAsk = {
  toolUseId: "toolu_1",
  kind: "question",
  plan: null,
  questions: [
    {
      question: "Where should the switch go?",
      header: "Where",
      multiSelect: true,
      options: [
        { label: "Menu bar", description: null },
        { label: "iPhone app", description: null },
      ],
    },
    {
      question: "Battery too?",
      header: null,
      multiSelect: false,
      options: [
        { label: "Yes", description: null },
        { label: "No", description: null },
      ],
    },
  ],
};
const plan: PendingAsk = { toolUseId: "toolu_p", kind: "plan", questions: [], plan: "1. Do it" };
const good = {
  toolUseId: "toolu_1",
  answers: [
    { question: 0, picked: ["Menu bar", "iPhone app"] },
    { question: 1, picked: ["Yes"] },
  ],
};

describe("parseAnswerInput", () => {
  it("accepts the documented shape and refuses unknown fields anywhere", () => {
    expect(parseAnswerInput(good).ok).toBe(true);
    expect(parseAnswerInput({ ...good, extra: 1 }).ok).toBe(false);
    expect(parseAnswerInput({ toolUseId: "t", answers: [{ question: 0, picked: [], x: 1 }] }).ok).toBe(false);
    expect(parseAnswerInput({ toolUseId: "t", plan: { approve: true, note: "x" } }).ok).toBe(false);
    expect(parseAnswerInput({ toolUseId: "t", plan: { approve: false } }).ok).toBe(false);
    expect(parseAnswerInput({ toolUseId: "t", plan: { approve: false, note: "n" } }).ok).toBe(true);
    expect(parseAnswerInput({ answers: [] }).ok).toBe(false);
    expect(parseAnswerInput({ toolUseId: "t", answers: [{ question: 0.5, picked: [] }] }).ok).toBe(false);
    expect(parseAnswerInput("x").ok).toBe(false);
  });
});

describe("validateAnswer", () => {
  const reason = (a: PendingAsk, raw: unknown) => {
    const parsed = parseAnswerInput(raw);
    if (!parsed.ok) throw new Error("unparsed");
    const result = validateAnswer(a, parsed.input);
    return result.ok ? null : result.reason;
  };

  it("passes a good answer", () => {
    expect(reason(ask, good)).toBeNull();
    expect(reason(plan, { toolUseId: "toolu_p", plan: { approve: true } })).toBeNull();
  });

  it("refuses every way an answer can be wrong", () => {
    expect(reason(ask, { ...good, toolUseId: "old" })).toMatch(/moved on/);
    expect(reason(ask, { toolUseId: "toolu_1", answers: [good.answers[0]] })).toMatch(/every question/);
    expect(reason(ask, { toolUseId: "toolu_1", answers: [good.answers[0], { question: 0, picked: ["Yes"] }] })).toMatch(
      /once each/,
    );
    expect(
      reason(ask, { toolUseId: "toolu_1", answers: [good.answers[0], { question: 1, picked: ["Maybe"] }] }),
    ).toMatch(/not in the question/);
    expect(
      reason(ask, { toolUseId: "toolu_1", answers: [good.answers[0], { question: 1, picked: ["Yes", "No"] }] }),
    ).toMatch(/exactly one/);
    expect(reason(ask, { toolUseId: "toolu_1", answers: [good.answers[0], { question: 1, picked: [] }] })).toMatch(
      /exactly one/,
    );
    expect(
      reason(ask, { toolUseId: "toolu_1", answers: [good.answers[0], { question: 1, picked: ["Yes"], other: "hm" }] }),
    ).toMatch(/exactly one/);
    expect(reason(ask, { toolUseId: "toolu_1", answers: [{ question: 0, picked: [] }, good.answers[1]] })).toMatch(
      /at least one/,
    );
    expect(
      reason(ask, {
        toolUseId: "toolu_1",
        answers: [good.answers[0], { question: 1, picked: [], other: "x".repeat(2001) }],
      }),
    ).toMatch(/too long/);
    expect(
      reason(ask, { toolUseId: "toolu_1", answers: [good.answers[0], { question: 1, picked: [], other: "  " }] }),
    ).toMatch(/empty/);
    expect(
      reason(ask, { toolUseId: "toolu_1", answers: [good.answers[0], { question: 1, picked: ["Yes", "Yes"] }] }),
    ).toMatch(/twice/);
    expect(reason(ask, { toolUseId: "toolu_1", plan: { approve: true } })).toMatch(/not a plan/);
    expect(reason(plan, { toolUseId: "toolu_p", answers: [] })).toMatch(/not a question/);
    expect(reason(plan, { toolUseId: "toolu_p", plan: { approve: false, note: " " } })).toMatch(/change/);
    expect(reason(plan, { toolUseId: "toolu_p", plan: { approve: false, note: "n".repeat(2001) } })).toMatch(
      /too long/,
    );
  });

  it("takes your own words for a single-select, and alongside picks for a multi-select", () => {
    expect(
      reason(ask, {
        toolUseId: "toolu_1",
        answers: [
          { question: 0, picked: ["Menu bar"], other: "Dock" },
          { question: 1, picked: [], other: "Later" },
        ],
      }),
    ).toBeNull();
  });
});

describe("what is sent", () => {
  it("builds the desktop body and an unambiguous message", () => {
    const resolved = [
      { picked: ["Menu bar", "iPhone app"], other: "Dock" },
      { picked: [], other: "Later" },
    ];
    expect(conductorAnswersBody(ask, resolved)).toEqual({ answers: [["Menu bar", "iPhone app", "Dock"], "Later"] });
    expect(answerMessage(ask, resolved, null)).toBe(
      [
        "This is my answer to the question you just asked (the question was interrupted so I could reply):",
        "",
        '"Where should the switch go?": Menu bar, iPhone app, Dock',
        '"Battery too?": Later',
        "",
        "Please continue with these answers; don't ask again.",
      ].join("\n"),
    );
    expect(answerMessage(plan, [], { approve: true })).toBe("I approve your plan. Go ahead.");
    expect(answerMessage(plan, [], { approve: false, note: "Use SQLite" })).toBe("Keep planning. Use SQLite");
  });
});

interface Calls {
  controls: Array<{ route: string; body?: unknown }>;
  sends: string[];
}

function harness(options: {
  routeStatus?: number | "dead";
  stopStatus?: number;
  /** Status after stop; "stuck" never leaves needs_user_input. */
  afterStop?: string;
  sendOk?: boolean;
  /** Whether Conductor records what was sent / answered. */
  records?: boolean;
  ready?: boolean;
  pending?: PendingAsk | null;
  version?: string;
}) {
  const calls: Calls = { controls: [], sends: [] };
  let status = "needs_user_input";
  const recorded: Array<{ role: string; content: string; sentAt: string | null }> = [];
  let pendingAsk: PendingAsk | null = options.pending === undefined ? ask : options.pending;
  const relay: AnswerRelay = {
    isReady: () => options.ready !== false,
    async send({ text }) {
      calls.sends.push(text);
      if (options.sendOk === false) return { ok: false, reason: "relay HTTP 500" };
      if (options.records !== false) {
        recorded.push({ role: "user", content: text, sentAt: "9999-01-01T00:00:00" });
      }
      return { ok: true };
    },
    async control({ route, body }) {
      calls.controls.push({ route, body });
      if (route === "stop") {
        status = options.afterStop === "stuck" ? "needs_user_input" : (options.afterStop ?? "idle");
        return { ok: true, status: options.stopStatus ?? 200 };
      }
      if (options.routeStatus === "dead") return { ok: false, reason: "timed out" };
      const code = options.routeStatus ?? 501;
      if (code === 200 && options.records !== false) {
        recorded.push({
          role: "user",
          content: `[{"type":"tool_result","tool_use_id":"${pendingAsk?.toolUseId}"}]`,
          sentAt: null,
        });
        pendingAsk = null;
      }
      return { ok: true, status: code };
    },
  };
  const service = new AnswerService({
    registry: {
      getSessionById: () => ({ id: "s", workspaceId: "w", status }) as never,
      listSessionMessages: () => recorded as never,
    },
    relay,
    readAsk: () => pendingAsk,
    conductorVersion: () => options.version ?? "9.9.9",
    sleep: async () => undefined,
  });
  return { service, calls };
}

const input = parseAnswerInput(good) as { ok: true; input: Parameters<AnswerService["answer"]>[1] };

describe("AnswerService", () => {
  it("refuses without the relay, for a vanished question, and for an invalid answer", async () => {
    expect(await harness({ ready: false }).service.answer("s", input.input)).toEqual({
      status: "refused",
      reason: "Conductor's relay isn't connected",
    });
    const gone = await harness({ pending: null }).service.answer("s", input.input);
    expect(gone).toMatchObject({ status: "refused", reason: expect.stringMatching(/not waiting/) });
    const h = harness({});
    const wrong = await h.service.answer("s", { toolUseId: "old", answers: [] });
    expect(wrong.status).toBe("refused");
    expect(h.calls.controls).toEqual([]);
  });

  it("answers through Conductor's API when it accepts, and confirms the tool_result", async () => {
    const h = harness({ routeStatus: 200 });
    const result = await h.service.answer("s", input.input);
    expect(result).toEqual({ status: "answered", via: "conductor" });
    expect(h.calls.controls).toEqual([
      { route: "answer-question", body: { answers: [["Menu bar", "iPhone app"], "Yes"] } },
    ]);
    expect(h.calls.sends).toEqual([]);
  });

  it("says so when Conductor accepted but its record does not show it", async () => {
    const h = harness({ routeStatus: 200, records: false });
    expect(await h.service.answer("s", input.input)).toEqual({
      status: "answered",
      via: "conductor",
      note: NOT_CONFIRMED,
    });
  });

  it("does not guess when nothing came back, and never falls through to a second delivery", async () => {
    const h = harness({ routeStatus: "dead", records: false });
    const result = await h.service.answer("s", input.input);
    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining(NOT_CONFIRMED) });
    expect(h.calls.controls.map((c) => c.route)).toEqual(["answer-question"]);
    expect(h.calls.sends).toEqual([]);
  });

  it("surfaces a refusal from Conductor (not 501) without stopping the chat", async () => {
    const h = harness({ routeStatus: 409 });
    expect(await h.service.answer("s", input.input)).toMatchObject({ status: "refused", reason: /HTTP 409/ });
    expect(h.calls.controls.map((c) => c.route)).toEqual(["answer-question"]);
  });

  it("on 501 stops the question, waits, sends the answer as a message, and remembers 501 for that version", async () => {
    const h = harness({});
    const first = await h.service.answer("s", input.input);
    expect(first).toMatchObject({ status: "answered", via: "stopped-and-sent" });
    expect(first).not.toHaveProperty("note", NOT_CONFIRMED);
    expect(h.calls.controls.map((c) => c.route)).toEqual(["answer-question", "stop"]);
    expect(h.calls.sends).toHaveLength(1);
    expect(h.calls.sends[0]).toContain('"Battery too?": Yes');
    expect(h.service.pending("s")?.delivery).toBe("stop-and-send");
  });

  it("never retries 501 on the same version, and probes again on a new one", async () => {
    const calls: string[] = [];
    let version = "1.0.0";
    const service = new AnswerService({
      registry: {
        getSessionById: () => ({ workspaceId: "w", status: "idle" }) as never,
        listSessionMessages: () => [],
      },
      relay: {
        isReady: () => true,
        send: async () => ({ ok: true }),
        control: async ({ route }) => {
          calls.push(route);
          return { ok: true, status: route === "stop" ? 200 : 501 };
        },
      },
      readAsk: () => ask,
      conductorVersion: () => version,
      sleep: async () => undefined,
      confirmMs: 0,
    });
    await service.answer("s", input.input);
    await service.answer("s", input.input);
    expect(calls).toEqual(["answer-question", "stop", "stop"]);
    version = "1.0.1";
    (service as unknown as { cachedVersion: null }).cachedVersion = null;
    await service.answer("s", input.input);
    expect(calls.slice(3)).toEqual(["answer-question", "stop"]);
  });

  it("sends nothing when the stop is refused or the chat does not settle", async () => {
    const refused = harness({ stopStatus: 500 });
    expect(await refused.service.answer("s", input.input)).toMatchObject({ status: "refused" });
    expect(refused.calls.sends).toEqual([]);
    const stuck = harness({ afterStop: "stuck" });
    expect(await stuck.service.answer("s", input.input)).toMatchObject({ status: "refused", reason: /did not stop/ });
    expect(stuck.calls.sends).toEqual([]);
  });

  it("reports a failed send after the stop, and an unconfirmed one without resending", async () => {
    const failed = harness({ sendOk: false });
    expect(await failed.service.answer("s", input.input)).toMatchObject({ status: "refused", reason: /stopped/ });
    const unconfirmed = harness({ records: false });
    expect(await unconfirmed.service.answer("s", input.input)).toMatchObject({
      status: "answered",
      via: "stopped-and-sent",
      note: NOT_CONFIRMED,
    });
    expect(unconfirmed.calls.sends).toHaveLength(1);
  });

  it("answers a plan: approve and keep planning", async () => {
    const approve = harness({ pending: plan });
    await approve.service.answer("s", { toolUseId: "toolu_p", plan: { approve: true } });
    expect(approve.calls.sends).toEqual(["I approve your plan. Go ahead."]);
    expect(approve.calls.controls[0]!.route).toBe("respond-to-plan");
    const revise = harness({ pending: plan, routeStatus: 200 });
    await revise.service.answer("s", { toolUseId: "toolu_p", plan: { approve: false, note: "Use SQLite" } });
    expect(revise.calls.controls[0]!.body).toMatchObject({ approved: false, feedback: "Use SQLite" });
  });

  it("serves the pending question with its delivery, and the control wrapper refuses a malformed body", async () => {
    const h = harness({ version: "0.91.1" });
    expect(h.service.pending("s")).toMatchObject({ toolUseId: "toolu_1", delivery: "stop-and-send" });
    expect(harness({ ready: false }).service.pending("s")?.delivery).toBe("unavailable");
    expect(harness({ pending: null }).service.pending("s")).toBeNull();
    expect(await answerControl(h.service).answer("s", { toolUseId: "x", nope: 1 })).toMatchObject({
      status: "refused",
    });
  });

  it("does not let two answers run for one chat", async () => {
    const h = harness({ routeStatus: 200 });
    const [a, b] = await Promise.all([h.service.answer("s", input.input), h.service.answer("s", input.input)]);
    expect([a.status, b.status].sort()).toEqual(["answered", "refused"]);
  });
});
