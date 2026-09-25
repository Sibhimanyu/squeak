import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { HookIngressServer } from "./hook-ingress.js";
import { renderHookScript } from "./hook-install.js";
import type { HookEvent } from "./types.js";

const execFileAsync = promisify(execFile);

const servers: HookIngressServer[] = [];
const dirs: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ingress-"));
  dirs.push(dir);
  return dir;
}

interface Harness {
  port: number;
  tokenPath: string;
  token: string;
  events: HookEvent[];
}

async function startServer(): Promise<Harness> {
  const dir = makeDir();
  const tokenPath = path.join(dir, "hook-token");
  const port = await freePort();
  const events: HookEvent[] = [];

  const server = new HookIngressServer({ port, tokenPath, onEvent: (event) => events.push(event) });
  await server.start();
  servers.push(server);

  return { port, tokenPath, token: fs.readFileSync(tokenPath, "utf8").trim(), events };
}

/**
 * The handler acknowledges before dispatching, and the installed hook script
 * backgrounds its curl, so delivery is asynchronous by design. Wait for the
 * outcome rather than for a fixed number of milliseconds — a fixed sleep
 * passes on an idle machine and fails on a busy one.
 */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** For the cases that assert nothing arrived, where there is no edge to wait on. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("HookIngressServer", () => {
  it("accepts an authorised hook post and normalizes it", async () => {
    const harness = await startServer();

    const response = await fetch(`http://127.0.0.1:${harness.port}/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conductor-tg-token": harness.token,
        "x-conductor-tg-agent": "claude",
      },
      body: JSON.stringify({
        hook_event_name: "Notification",
        session_id: "abc",
        message: "Claude needs your permission to use Bash",
      }),
    });
    await waitFor(() => harness.events.length > 0);

    expect(response.status).toBe(200);
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]?.event).toBe("Notification");
    expect(harness.events[0]?.sessionId).toBe("abc");
  });

  it("rejects a post without the shared token", async () => {
    const harness = await startServer();

    const response = await fetch(`http://127.0.0.1:${harness.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conductor-tg-agent": "claude" },
      body: "{}",
    });
    await settle();

    expect(response.status).toBe(403);
    expect(harness.events).toHaveLength(0);
  });

  it("rejects a token that is merely close", async () => {
    const harness = await startServer();

    const response = await fetch(`http://127.0.0.1:${harness.port}/hook`, {
      method: "POST",
      headers: {
        "x-conductor-tg-token": `${harness.token.slice(0, -1)}x`,
        "x-conductor-tg-agent": "claude",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  it("does not fail the request when the body is unparseable", async () => {
    const harness = await startServer();

    const response = await fetch(`http://127.0.0.1:${harness.port}/hook`, {
      method: "POST",
      headers: { "x-conductor-tg-token": harness.token, "x-conductor-tg-agent": "claude" },
      body: "not json at all",
    });
    await settle();

    // The agent must never see an error from us, even when we cannot use the payload.
    expect(response.status).toBe(200);
    expect(harness.events).toHaveLength(0);
  });

  it("keeps the token stable across restarts so installed hooks keep working", async () => {
    const dir = makeDir();
    const tokenPath = path.join(dir, "hook-token");

    const first = HookIngressServer.ensureToken(tokenPath);
    const second = HookIngressServer.ensureToken(tokenPath);

    expect(second).toBe(first);
    expect(fs.statSync(tokenPath).mode & 0o077).toBe(0);
  });
});

describe("the installed hook script", () => {
  it("delivers a real agent payload end to end", async () => {
    const harness = await startServer();
    const dir = makeDir();
    const scriptPath = path.join(dir, "fleet-notify.sh");
    fs.writeFileSync(
      scriptPath,
      renderHookScript({ agent: "claude", port: harness.port, tokenPath: harness.tokenPath }),
      { mode: 0o755 },
    );

    await execFileAsync("/bin/sh", [
      "-c",
      `printf '%s' '${JSON.stringify({ hook_event_name: "Stop", session_id: "xyz" })}' | ${scriptPath}`,
    ]);
    await waitFor(() => harness.events.length > 0);

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]?.event).toBe("Stop");
    expect(harness.events[0]?.sessionId).toBe("xyz");
    expect(harness.events[0]?.agent).toBe("claude");
  });

  it("exits cleanly and quickly when nothing is listening", async () => {
    const dir = makeDir();
    const tokenPath = path.join(dir, "hook-token");
    HookIngressServer.ensureToken(tokenPath);
    const scriptPath = path.join(dir, "fleet-notify.sh");
    // Point at a port with no server: this is the bridge-is-down case, and the
    // agent must not notice.
    fs.writeFileSync(scriptPath, renderHookScript({ agent: "claude", port: await freePort(), tokenPath }), {
      mode: 0o755,
    });

    const startedAt = Date.now();
    const result = await execFileAsync("/bin/sh", ["-c", `printf '{}' | ${scriptPath}; echo "exit=$?"`]);

    expect(result.stdout).toContain("exit=0");
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe("local state endpoint", () => {
  it("serves the current fleet state to a local UI without a token", async () => {
    const dir = makeDir();
    const port = await freePort();
    const server = new HookIngressServer({
      port,
      tokenPath: path.join(dir, "hook-token"),
      onEvent: () => undefined,
      readState: () => ({ active: [{ key: "a", state: "working" }], trackedCount: 26 }),
    });
    await server.start();
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/state`);
    const body = (await response.json()) as { active: { key: string }[]; trackedCount: number };

    expect(response.status).toBe(200);
    // A page polling this needs CORS; without it the duck sees nothing.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.trackedCount).toBe(26);
    expect(body.active[0]?.key).toBe("a");
  });

  it("says so rather than crashing when no state source is wired", async () => {
    const dir = makeDir();
    const port = await freePort();
    const server = new HookIngressServer({
      port,
      tokenPath: path.join(dir, "hook-token"),
      onEvent: () => undefined,
    });
    await server.start();
    servers.push(server);

    expect((await fetch(`http://127.0.0.1:${port}/state`)).status).toBe(503);
  });

  it("does not accept a hook post on the state path", async () => {
    const harness = await startServer();

    const response = await fetch(`http://127.0.0.1:${harness.port}/state`, {
      method: "POST",
      headers: { "x-conductor-tg-token": harness.token, "x-conductor-tg-agent": "claude" },
      body: JSON.stringify({ hook_event_name: "Stop", session_id: "x" }),
    });
    await settle();

    expect(response.status).toBe(404);
    expect(harness.events).toHaveLength(0);
  });
});

describe("HookIngressServer control routes", () => {
  async function withControl() {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const replies: Array<{ id: string; text: string }> = [];
    server.setControl({
      sessionMessage: (id) => ({ id, text: "A) yes\nB) no" }),
      reply: async (id, text) => {
        replies.push({ id, text });
        return { status: "started", via: "conductor" };
      },
    });
    const base = `http://127.0.0.1:${harness.port}/control/session/abc-123`;
    const auth = { "x-conductor-tg-token": harness.token };
    return { harness, base, auth, replies };
  }

  it("refuses control requests without the token", async () => {
    const { base, replies } = await withControl();
    expect((await fetch(`${base}/message`)).status).toBe(403);
    const reply = await fetch(`${base}/reply`, { method: "POST", body: JSON.stringify({ text: "A" }) });
    expect(reply.status).toBe(403);
    expect(replies).toEqual([]);
  });

  it("serves a chat's message to a caller with the token, without opening it to web pages", async () => {
    const { base, auth } = await withControl();
    const response = await fetch(`${base}/message`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "abc-123", text: "A) yes\nB) no" });
    // No CORS header: a browser page must not be able to read this.
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("passes a reply through and returns its outcome", async () => {
    const { base, auth, replies } = await withControl();
    const response = await fetch(`${base}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "B" }),
    });
    expect(await response.json()).toEqual({ status: "started", via: "conductor" });
    expect(replies).toEqual([{ id: "abc-123", text: "B" }]);
  });

  it("rejects an empty reply and an unknown route", async () => {
    const { base, auth, replies } = await withControl();
    const empty = await fetch(`${base}/reply`, { method: "POST", headers: auth, body: JSON.stringify({ text: "  " }) });
    expect(empty.status).toBe(400);
    const odd = await fetch(`${base.replace("abc-123", "../etc")}/message`, { headers: auth });
    expect(odd.status).toBe(404);
    expect(replies).toEqual([]);
  });

  it("says so when nothing can answer yet", async () => {
    const harness = await startServer();
    const response = await fetch(`http://127.0.0.1:${harness.port}/control/session/x/message`, {
      headers: { "x-conductor-tg-token": harness.token },
    });
    expect(response.status).toBe(503);
  });
});

describe("HookIngressServer remote routes", () => {
  it("routes pairing actions to the remote handler, token-gated, with the right methods", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const calls: Array<[string, string | null]> = [];
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      remote: async (action, id) => {
        calls.push([action, id]);
        return { action, id };
      },
    });
    const base = `http://127.0.0.1:${harness.port}/control/remote`;
    const auth = { "x-conductor-tg-token": harness.token };

    expect((await fetch(`${base}/status`)).status).toBe(403);
    expect(await (await fetch(`${base}/status`, { headers: auth })).json()).toEqual({ action: "status", id: null });
    expect((await fetch(`${base}/approve/phone-1`, { headers: auth })).status).toBe(405);
    await fetch(`${base}/approve/phone-1`, { method: "POST", headers: auth });
    expect(calls).toEqual([
      ["status", null],
      ["approve", "phone-1"],
    ]);
  });
});
