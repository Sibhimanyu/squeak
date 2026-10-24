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

describe("PhoneClient startChat", () => {
  const WS = "/workspaces/ws";
  const start = { workspaceLocalId: "ws", sessionId: "s1", agent: "claude" as const, text: "Hello" };

  it("with no model, lets the first send create the chat with the workspace's usual settings", async () => {
    const { client, asked } = scripted([
      { status: 200, body: queueState(3) },
      { status: 200, body: queueState(3) },
    ]);
    const res = await client.startChat(start);
    expect(res.status).toBe(200);
    expect(asked.map((a) => `${a.method} ${a.target}`)).toEqual([`GET ${BASE}`, `POST ${BASE}/send`]);
    expect((asked[1]!.body as { config: unknown }).config).toEqual({ harness: "claude" });
  });

  it("with a model and level, registers the chat with both first, then sends into it", async () => {
    const { client, asked } = scripted([
      { status: 200, body: { updatedAt: "x", session: {} } },
      { status: 200, body: queueState(5) },
      { status: 200, body: queueState(5) },
    ]);
    const res = await client.startChat({ ...start, model: "opus-5-5-1m", thinkingLevel: "high" });
    expect(res.status).toBe(200);
    expect(asked.map((a) => `${a.method} ${a.target}`)).toEqual([
      `POST ${WS}/sessions/register`,
      `GET ${BASE}`,
      `POST ${BASE}/send`,
    ]);
    expect(asked[0]!.body).toEqual({
      sessionId: "s1",
      agentType: "claude",
      model: "opus-5-5-1m",
      thinkingLevel: "high",
      fastMode: false,
    });
    expect((asked[2]!.body as { config: unknown }).config).toEqual({ harness: "claude", model: "opus-5-5-1m" });
  });

  it("sends the agent's text as Conductor's agentMessage, so the chat shows what the person wrote", async () => {
    const { client, asked } = scripted([
      { status: 200, body: queueState(3) },
      { status: 200, body: queueState(3) },
    ]);
    await client.startChat({ ...start, agentText: "[brief]\n\nHello" });
    expect((asked[1]!.body as { deliveryPayload: unknown }).deliveryPayload).toEqual({
      message: "Hello",
      agentMessage: "[brief]\n\nHello",
    });
  });

  it("sends no agentMessage when there is no split", async () => {
    const { client, asked } = scripted([
      { status: 200, body: queueState(3) },
      { status: 200, body: queueState(3) },
    ]);
    await client.startChat(start);
    expect((asked[1]!.body as { deliveryPayload: unknown }).deliveryPayload).toEqual({ message: "Hello" });
  });

  it("stops when Conductor refuses to register the chat, and sends nothing", async () => {
    const { client, asked } = scripted([{ status: 400, body: { error: "bad model" } }]);
    const res = await client.startChat({ ...start, model: "nope" });
    expect(res.status).toBe(400);
    expect(asked).toHaveLength(1);
  });
});
