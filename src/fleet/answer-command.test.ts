import { describe, expect, it } from "vitest";

import { ANSWER_MIN_GAP_MS, AnswerRateLimit, runAnswerCommand, type Answerer } from "./answer-command.js";
import { AnswerService } from "./answer.js";
import type { PendingAsk } from "./question.js";

const ask: PendingAsk = {
  toolUseId: "toolu_1",
  kind: "question",
  plan: null,
  questions: [
    {
      question: "Pick",
      header: null,
      multiSelect: false,
      options: [
        { label: "A", description: null },
        { label: "B", description: null },
      ],
    },
  ],
};

function setup() {
  const sent: string[] = [];
  let recorded: Array<{ role: string; content: string; sentAt: string | null }> = [];
  const service = new AnswerService({
    registry: {
      getSessionById: () => ({ id: "s", workspaceId: "w", status: "idle" }) as never,
      listSessionMessages: () => recorded as never,
    },
    relay: {
      isReady: () => true,
      send: async ({ text }) => {
        sent.push(text);
        recorded = [{ role: "user", content: text, sentAt: "9999-01-01T00:00:00" }];
        return { ok: true };
      },
      control: async ({ route }) => ({ ok: true, status: route === "stop" ? 200 : 501 }),
    },
    readAsk: (id) => (id === "chat-1" ? ask : null),
    conductorVersion: () => "9.9.9",
    sleep: async () => undefined,
  });
  return { service, sent, limit: new AnswerRateLimit() };
}

const command = {
  v: 1,
  kind: "answer",
  sessionId: "chat-1",
  toolUseId: "toolu_1",
  answers: [{ question: 0, picked: ["B"] }],
  nonce: "n".repeat(16),
  expiresAt: 1,
};
const ctx = (s: ReturnType<typeof setup>, now = 1_000) => ({
  answerer: s.service as Answerer,
  limit: s.limit,
  deviceId: "d1",
  now,
});

describe("runAnswerCommand", () => {
  it("delivers a valid answer through the service", async () => {
    const s = setup();
    const result = await runAnswerCommand(command, ctx(s));
    expect(result).toMatchObject({ status: "answered", via: "stopped-and-sent" });
    expect(s.sent[0]).toContain('"Pick": B');
  });

  it("refuses unknown fields, a bad version, a bad session id and a missing answerer", async () => {
    const s = setup();
    expect(await runAnswerCommand({ ...command, extra: 1 }, ctx(s))).toMatchObject({ status: "refused" });
    expect(await runAnswerCommand({ ...command, v: 2 }, ctx(s))).toMatchObject({ status: "refused" });
    expect(await runAnswerCommand({ ...command, sessionId: "../x" }, ctx(s))).toMatchObject({ status: "refused" });
    expect(
      await runAnswerCommand({ ...command, answers: [{ question: 0, picked: ["B"], z: 1 }] }, ctx(s)),
    ).toMatchObject({ status: "refused" });
    expect(await runAnswerCommand(command, { ...ctx(s), answerer: null })).toMatchObject({ status: "refused" });
    expect(s.sent).toEqual([]);
  });

  it("refuses a stale toolUseId, an invalid pick, and a chat with nothing pending", async () => {
    const s = setup();
    expect(await runAnswerCommand({ ...command, toolUseId: "old" }, ctx(s))).toMatchObject({
      reason: expect.stringMatching(/moved on/),
    });
    expect(
      await runAnswerCommand({ ...command, answers: [{ question: 0, picked: ["C"] }] }, ctx(s, 100_000)),
    ).toMatchObject({ reason: expect.stringMatching(/not in the question/) });
    expect(await runAnswerCommand({ ...command, sessionId: "other" }, ctx(s, 200_000))).toMatchObject({
      reason: expect.stringMatching(/not waiting/),
    });
    expect(s.sent).toEqual([]);
  });

  it("rate-limits a device to one answer per window, without burning it on a malformed command", async () => {
    const s = setup();
    expect(await runAnswerCommand({ ...command, extra: 1 }, ctx(s, 1_000))).toMatchObject({ status: "refused" });
    expect(await runAnswerCommand(command, ctx(s, 1_000))).toMatchObject({ status: "answered" });
    expect(await runAnswerCommand(command, ctx(s, 2_000))).toMatchObject({
      reason: expect.stringMatching(/Wait a few seconds/),
    });
    // Past the window it is allowed again (and then finds nothing pending to answer twice).
    expect(await runAnswerCommand(command, ctx(s, 1_000 + ANSWER_MIN_GAP_MS))).not.toMatchObject({
      reason: expect.stringMatching(/Wait a few seconds/),
    });
  });
});
