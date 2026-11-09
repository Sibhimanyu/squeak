import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneClient, type TunnelResponse } from "./phone.js";
import { ConductorRelayService } from "./service.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-start-chat-"));
  dbPath = path.join(dir, "conductor.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("PhoneClient.startChat", () => {
  type Req = { method: string; target: string; body?: Record<string, unknown> | undefined };
  function fake(handler: (r: Req) => { status: number; body?: unknown }) {
    const client = new PhoneClient({ send: () => undefined, close: () => undefined });
    const seen: Req[] = [];
    vi.spyOn(client, "request").mockImplementation(async (a) => {
      const r = { method: a.method, target: a.target, body: a.body as Record<string, unknown> | undefined };
      seen.push(r);
      const out = handler(r);
      return { status: out.status, headers: {}, body: JSON.stringify(out.body ?? {}) } satisfies TunnelResponse;
    });
    return { client, seen };
  }
  const args = {
    workspaceLocalId: "ws1",
    sessionId: "11111111-1111-4111-8111-111111111111",
    agent: "codex" as const,
    text: "hello",
  };

  it("sends with harness config when the host reports a generation", async () => {
    const { client, seen } = fake((r) =>
      r.method === "GET" ? { status: 200, body: { generation: 7 } } : { status: 200, body: {} },
    );
    expect((await client.startChat(args)).status).toBe(200);
    const post = seen[1]!;
    expect(post.target).toBe(`/workspaces/ws1/sessions/${args.sessionId}/pending-messages/send`);
    expect(post.body).toMatchObject({
      deliveryPayload: { message: "hello" },
      config: { harness: "codex" },
      mode: "queue",
      expectedGeneration: 7,
    });
  });

  it("404 on the unknown session registers it, then sends", async () => {
    let registered = false;
    const { client, seen } = fake((r) => {
      if (r.target.endsWith("/sessions/register")) {
        registered = true;
        return { status: 200 };
      }
      if (!registered) return { status: 404, body: { reason: "not-found" } };
      return r.method === "GET" ? { status: 200, body: { generation: 3 } } : { status: 200 };
    });
    expect((await client.startChat(args)).status).toBe(200);
    const reg = seen.find((s) => s.target.endsWith("/register"))!;
    expect(reg.body).toEqual({ sessionId: args.sessionId, agentType: "codex" });
    expect(seen.at(-1)!.body).toMatchObject({ expectedGeneration: 3 });
  });

  it("409 generation retries with the state's generation, same messageId", async () => {
    let n = 0;
    const { client, seen } = fake((r) => {
      if (r.method === "GET") return { status: 404 };
      return n++ === 0 ? { status: 409, body: { reason: "generation", state: { generation: 99 } } } : { status: 200 };
    });
    expect((await client.startChat(args)).status).toBe(200);
    const posts = seen.filter((s) => s.method === "POST");
    expect(posts[1]!.body).toMatchObject({ expectedGeneration: 99 });
    expect(posts[1]!.body!.messageId).toBe(posts[0]!.body!.messageId);
  });

  it("stops on a hard failure", async () => {
    const { client } = fake((r) => (r.method === "GET" ? { status: 200, body: { generation: 1 } } : { status: 400 }));
    expect((await client.startChat(args)).status).toBe(400);
  });
});

describe("ConductorRelayService.startChat", () => {
  it("explains when the relay is not connected", async () => {
    vi.useFakeTimers();
    try {
      const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath: path.join(dir, "s.json") });
      const pending = svc.startChat({ workspaceId: "w", agent: "claude", text: "hi" });
      await vi.advanceTimersByTimeAsync(9_000); // it waits for Conductor's host to reconnect first
      expect(await pending).toEqual({
        ok: false,
        reason: "Conductor's relay isn't connected",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
