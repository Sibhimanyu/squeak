import { describe, expect, it, vi } from "vitest";
import { PhoneClient, type TunnelResponse } from "./phone.js";

const ID = "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31";
const BASE = "/workspaces/ws/sessions/s1/pending-messages";

/** A client whose tunnel is a script of Conductor's answers, recording what was asked. */
function scripted(answers: Array<{ status: number; body: unknown }>) {
  const client = new PhoneClient({ send: () => undefined, close: () => undefined });
  const asked: Array<{ method: string; target: string; body?: unknown }> = [];
  vi.spyOn(client, "request").mockImplementation(async (args) => {
    asked.push({ method: args.method, target: args.target, ...(args.body ? { body: args.body } : {}) });
    const next = answers.shift() ?? { status: 500, body: {} };
    return { status: next.status, headers: {}, body: JSON.stringify(next.body) } satisfies TunnelResponse;
  });
  return { client, asked };
}

const queueState = (generation: number, revision = 0) => ({
  sessionId: "s1",
  generation,
  paused: false,
  messages: [
    {
      messageId: ID,
      deliveryPayload: { message: "x" },
      mode: "queue",
      position: 0,
      revision,
      deliveryStatus: "pending",
    },
  ],
});

describe("PhoneClient queue", () => {
  it("reads a chat's queue", async () => {
    const { client, asked } = scripted([{ status: 200, body: queueState(7) }]);
    const read = await client.pendingMessages({ workspaceLocalId: "ws", sessionId: "s1" });
    expect(read.state).toMatchObject({ generation: 7, messages: [{ messageId: ID }] });
    expect(asked).toEqual([{ method: "GET", target: BASE }]);
  });

  it("gives no state for an error or a body that is not a queue", async () => {
    const { client } = scripted([
      { status: 404, body: {} },
      { status: 200, body: { generation: "7" } },
    ]);
    expect(await client.pendingMessages({ workspaceLocalId: "ws", sessionId: "s1" })).toEqual({
      status: 404,
      state: null,
    });
    expect((await client.pendingMessages({ workspaceLocalId: "ws", sessionId: "s1" })).state).toBeNull();
  });

  it("promotes with the revision and generation it was given, retrying once on a conflict with the new ones", async () => {
    const { client, asked } = scripted([
      { status: 409, body: { reason: "generation", state: queueState(9, 1) } },
      { status: 200, body: queueState(9, 1) },
    ]);
    const res = await client.promoteMessage({
      workspaceLocalId: "ws",
      sessionId: "s1",
      messageId: ID,
      expectedRevision: 0,
      expectedGeneration: 7,
    });
    expect(res.status).toBe(200);
    expect(asked).toEqual([
      { method: "POST", target: `${BASE}/${ID}/promote`, body: { expectedRevision: 0, expectedGeneration: 7 } },
      { method: "POST", target: `${BASE}/${ID}/promote`, body: { expectedRevision: 1, expectedGeneration: 9 } },
    ]);
  });

  it("does not retry a cancel for a message that has left the queue", async () => {
    const { client, asked } = scripted([
      { status: 409, body: { reason: "generation", state: { generation: 9, messages: [] } } },
    ]);
    const res = await client.cancelMessage({
      workspaceLocalId: "ws",
      sessionId: "s1",
      messageId: ID,
      expectedRevision: 0,
      expectedGeneration: 7,
    });
    expect(res.status).toBe(409);
    expect(asked.map((request) => request.target)).toEqual([`${BASE}/${ID}/cancel`]);
  });

  it("sends with the caller's message id, the same one on the retry", async () => {
    const { client, asked } = scripted([
      { status: 200, body: queueState(7) },
      { status: 409, body: { reason: "generation", state: { generation: 8 } } },
      { status: 200, body: queueState(8) },
    ]);
    await client.sendChatMessage({ workspaceLocalId: "ws", sessionId: "s1", text: "hi", messageId: ID });
    const posts = asked.filter((request) => request.method === "POST").map((request) => request.body);
    expect(posts).toMatchObject([
      { messageId: ID, expectedGeneration: 7 },
      { messageId: ID, expectedGeneration: 8 },
    ]);
  });
});
