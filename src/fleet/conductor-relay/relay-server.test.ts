import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  _internal,
  b64urlDecode,
  b64urlEncode,
  generateX25519,
  hostIdFromStaticKey,
  transcriptHash,
} from "./crypto.js";
import { ConductorRelayServer } from "./relay-server.js";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
function importRaw(raw: Buffer) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Host-side crypto half (spec §3.3–3.5), used to answer the phone. */
class HostCrypto {
  readonly staticKey = generateX25519();
  private readonly ephemeral = generateX25519();
  private readonly hostNonce = crypto.randomBytes(32);
  private c2h?: Buffer;
  private h2c?: Buffer;
  private th?: Buffer;
  private sendCounter = 0;
  private recvCounter = 0;

  ready(hello: { clientEphemeralPublicKey: string; clientNonce: string }) {
    const clientEph = b64urlDecode(hello.clientEphemeralPublicKey);
    const clientNonce = b64urlDecode(hello.clientNonce);
    const th = transcriptHash({
      hostId: hostIdFromStaticKey(this.staticKey.publicKey),
      clientEphemeralPublicKey: clientEph,
      clientNonce,
      hostStaticPublicKey: this.staticKey.publicKey,
      hostEphemeralPublicKey: this.ephemeral.publicKey,
      hostNonce: this.hostNonce,
    });
    const a = crypto.diffieHellman({ privateKey: this.staticKey.privateKey, publicKey: importRaw(clientEph) });
    const c = crypto.diffieHellman({ privateKey: this.ephemeral.privateKey, publicKey: importRaw(clientEph) });
    const salt = crypto
      .createHash("sha256")
      .update(Buffer.from("conductor-desktop-relay-v1/salt", "utf8"))
      .update(clientNonce)
      .update(this.hostNonce)
      .digest();
    const info = Buffer.concat([Buffer.from("conductor-desktop-relay-v1/keys", "utf8"), th]);
    const okm = Buffer.from(crypto.hkdfSync("sha256", Buffer.concat([a, c]), salt, info, 64));
    this.c2h = okm.subarray(0, 32);
    this.h2c = okm.subarray(32, 64);
    this.th = th;
    return {
      t: "ready",
      v: 2,
      hostStaticPublicKey: b64urlEncode(this.staticKey.publicKey),
      hostEphemeralPublicKey: b64urlEncode(this.ephemeral.publicKey),
      hostNonce: b64urlEncode(this.hostNonce),
    };
  }

  decrypt(frame: { n: number; c: string }): Record<string, unknown> {
    const plain = _internal.xchachaDecrypt(
      this.c2h!,
      _internal.recordNonce(_internal.DIR_CLIENT_TO_HOST, this.recvCounter),
      this.th!,
      b64urlDecode(frame.c),
    );
    this.recvCounter += 1;
    return JSON.parse(plain.toString("utf8"));
  }

  encrypt(message: unknown): { t: "e"; n: number; c: string } {
    const box = _internal.xchachaEncrypt(
      this.h2c!,
      _internal.recordNonce(_internal.DIR_HOST_TO_CLIENT, this.sendCounter),
      this.th!,
      Buffer.from(JSON.stringify(message), "utf8"),
    );
    const f = { t: "e" as const, n: this.sendCounter, c: b64urlEncode(box) };
    this.sendCounter += 1;
    return f;
  }
}

/** A WebSocket client that behaves like Conductor's host over the relay. */
function runFakeHost(port: number, host: HostCrypto, received: { messages: unknown[] }): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/desktop-relay/v1/host?hostId=x&accessToken=y`);
  let connId: string | undefined;
  const sendData = (frame: unknown) => ws.send(JSON.stringify({ type: "data", connId, data: JSON.stringify(frame) }));

  const serve = (req: { id: string; method: string; target: string; body?: { data: string } }) => {
    const path = req.target.split("?")[0] ?? "";
    let status = 404;
    let body: unknown = { error: "not found" };
    if (req.method === "GET" && path.endsWith("/pending-messages")) {
      status = 200;
      body = { sessionId: "s", generation: 7, paused: false, messages: [] };
    } else if (req.method === "POST" && path.endsWith("/pending-messages/send")) {
      const sent = JSON.parse(req.body!.data);
      received.messages.push(sent.deliveryPayload);
      status = 200;
      body = { sessionId: "s", generation: 7, messages: [] };
    }
    sendData(host.encrypt({ type: "responseHead", id: req.id, status, headers: {} }));
    sendData(
      host.encrypt({
        type: "responseBody",
        id: req.id,
        body: { encoding: "utf8", data: JSON.stringify(body) },
        final: true,
      }),
    );
  };

  ws.addEventListener("message", (ev) => {
    const env = JSON.parse(String(ev.data)) as { type: string; connId: string; data?: string };
    if (env.type === "open") {
      connId = env.connId;
      return;
    }
    if (env.type !== "data" || !env.data) return;
    const frame = JSON.parse(env.data);
    if (frame.t === "hello") {
      sendData(host.ready(frame));
      return;
    }
    if (frame.t === "e") {
      const msg = host.decrypt(frame);
      if (msg.type === "pair") {
        sendData(
          host.encrypt({
            type: "paired",
            deviceId: "dev-1",
            deviceToken: "tok-1",
            hostName: "Mac",
            appVersion: "0.91.1",
          }),
        );
      } else if (msg.type === "auth") {
        sendData(host.encrypt({ type: "authOk", hostName: "Mac", appVersion: "0.91.1" }));
      } else if (msg.type === "request") {
        serve(msg as never);
      }
    }
  });
  return ws;
}

describe("ConductorRelayServer end-to-end (phone ⇄ from-spec host)", () => {
  let server: ConductorRelayServer | undefined;
  let fakeHost: WebSocket | undefined;

  afterEach(async () => {
    fakeHost?.close();
    await server?.close();
  });

  it("pairs and sends a chat message that reaches the host", async () => {
    const host = new HostCrypto();
    const received = { messages: [] as unknown[] };

    const result = await new Promise<{ status: number }>((resolve, reject) => {
      server = new ConductorRelayServer({
        hostStaticPublicKey: host.staticKey.publicKey,
        onHost: async ({ client }) => {
          try {
            await client.handshake();
            const creds = await client.pair("pairing-token", "Squeak");
            expect(creds.deviceId).toBe("dev-1");
            const r = await client.sendChatMessage({
              workspaceLocalId: "ws-local-1",
              sessionId: "sess-1",
              text: "hello from squeak",
            });
            resolve({ status: r.status });
          } catch (e) {
            reject(e);
          }
        },
      });
      server
        .listen(0)
        .then((port) => {
          fakeHost = runFakeHost(port, host, received);
        })
        .catch(reject);
    });

    expect(result.status).toBe(200);
    expect(received.messages).toEqual([{ message: "hello from squeak" }]);
  });

  it("trusts the host key on first connect when none is pinned", async () => {
    const host = new HostCrypto();
    const received = { messages: [] as unknown[] };
    const observed = await new Promise<string>((resolve, reject) => {
      server = new ConductorRelayServer({
        // no hostStaticPublicKey → trust on first connect
        onHost: async ({ client }) => {
          try {
            await client.handshake();
            resolve(client.hostStaticKey!.toString("base64url"));
          } catch (e) {
            reject(e);
          }
        },
      });
      server
        .listen(0)
        .then((port) => {
          fakeHost = runFakeHost(port, host, received);
        })
        .catch(reject);
    });
    expect(observed).toBe(host.staticKey.publicKey.toString("base64url"));
  });

  it("answers /auth/exchange so the host will connect", async () => {
    server = new ConductorRelayServer({
      hostStaticPublicKey: new Uint8Array(32),
      onHost: () => {},
    });
    const port = await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/auth/exchange`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
    expect(body.accessToken).toBeTruthy();
  });
});
