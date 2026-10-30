import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { HookIngressServer } from "./hook-ingress.js";
import { defaultNotifySettings, NotifySettingsStore } from "./notify-settings.js";
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
        "x-squeak-token": harness.token,
        "x-squeak-agent": "claude",
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
      headers: { "content-type": "application/json", "x-squeak-agent": "claude" },
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
        "x-squeak-token": `${harness.token.slice(0, -1)}x`,
        "x-squeak-agent": "claude",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  it("does not fail the request when the body is unparseable", async () => {
    const harness = await startServer();

    const response = await fetch(`http://127.0.0.1:${harness.port}/hook`, {
      method: "POST",
      headers: { "x-squeak-token": harness.token, "x-squeak-agent": "claude" },
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
    expect(Date.now() - startedAt).toBeLessThan(5000);
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
      headers: { "x-squeak-token": harness.token, "x-squeak-agent": "claude" },
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
    const replies: Array<{ id: string; text: string; mode?: string; answersTurn?: string | null }> = [];
    const powerChoices: unknown[] = [];
    server.setControl({
      sessionMessage: (id) => ({ id, text: "A) yes\nB) no" }),
      transcript: (id, limit, before) => ({
        messages: [{ id: "m1", role: "user", text: id, at: null, turnId: String(limit) }],
        complete: true,
        ...(before ? { nextBefore: `got-${before}` } : {}),
      }),
      activity: (key) => ({ key, steps: [{ kind: "tool", text: "Run tests", at: null }], total: 1 }),
      subagentActivity: (key, taskId) =>
        taskId === "toolu_known0001" ? { taskId, key, status: "running", steps: [], total: 0 } : null,
      reply: async (id, text, mode, answersTurn) => {
        replies.push({ id, text, ...(mode ? { mode } : {}), ...(answersTurn ? { answersTurn } : {}) });
        return { status: "started", via: "conductor" };
      },
      power: async (choice) => {
        powerChoices.push(choice);
        return choice === "auto" || choice === "low" || choice === "high"
          ? { ok: true }
          : { ok: false, reason: "That energy mode isn't available." };
      },
    });
    const base = `http://127.0.0.1:${harness.port}/control/session/abc-123`;
    const auth = { "x-squeak-token": harness.token };
    return { harness, base, auth, replies, powerChoices };
  }

  it("applies only the energy mode choice provided by the authenticated Mac app", async () => {
    const { harness, auth, powerChoices } = await withControl();
    const url = `http://127.0.0.1:${harness.port}/control/power`;
    expect((await fetch(url, { method: "POST", body: JSON.stringify({ choice: "high" }) })).status).toBe(403);
    const applied = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ choice: "high" }) });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ ok: true });
    const rejected = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ choice: "turbo" }) });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "That energy mode isn't available." });
    expect(powerChoices).toEqual(["high", "turbo"]);
  });

  it("accepts a terminal agent's fleet key as the target, as /state hands it out", async () => {
    const { harness, auth, replies } = await withControl();
    const base = `http://127.0.0.1:${harness.port}/control/session/claude-transcript:8ed8b2c9-29d6-443e-ab31-85495508d53d`;
    const response = await fetch(`${base}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "B" }),
    });
    expect(response.status).toBe(200);
    expect(replies).toEqual([{ id: "claude-transcript:8ed8b2c9-29d6-443e-ab31-85495508d53d", text: "B" }]);
    // Still nothing that could climb out of the route.
    expect(
      (await fetch(`http://127.0.0.1:${harness.port}/control/session/a%2F..%2Fb/message`, { headers: auth })).status,
    ).toBe(404);
  });

  it("serves a session's activity only with the token, and never to a web page", async () => {
    const { harness, auth } = await withControl();
    const url = `http://127.0.0.1:${harness.port}/control/session/claude-transcript:t1/activity`;
    expect((await fetch(url)).status).toBe(403);
    const response = await fetch(url, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      key: "claude-transcript:t1",
      steps: [{ kind: "tool", text: "Run tests", at: null }],
      total: 1,
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves one subagent's activity only with the token, with no CORS header, and 404s an unknown one", async () => {
    const { harness, auth } = await withControl();
    const base = `http://127.0.0.1:${harness.port}/control/session/claude-transcript:t1/subagent`;
    expect((await fetch(`${base}/toolu_known0001/activity`)).status).toBe(403);
    const response = await fetch(`${base}/toolu_known0001/activity`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      taskId: "toolu_known0001",
      key: "claude-transcript:t1",
      status: "running",
      steps: [],
      total: 0,
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/toolu_other0002/activity`, { headers: auth })).status).toBe(404);
    // A task id that is not a tool-use id never reaches the reader.
    expect((await fetch(`${base}/..%2F..%2Fx/activity`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/short/activity`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/toolu_known0001/activity`, { method: "POST", headers: auth })).status).toBe(405);
  });

  it("lists and changes a chat queue only with the token, checks the id is still queued, and sends no CORS header", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const actions: string[] = [];
    server.setControl({
      sessionMessage: () => ({}),
      reply: async () => ({}),
      queue: async (id) => (id === "gone" ? null : [{ id: "m_1", text: "x".repeat(5000), mode: "queue", position: 1 }]),
      queueAction: async (id, messageId, action) => {
        actions.push(`${id}/${messageId}/${action}`);
        return { ok: true };
      },
    });
    const base = `http://127.0.0.1:${harness.port}/control/session/abc-123/queue`;
    const auth = { "x-squeak-token": harness.token };
    expect((await fetch(base)).status).toBe(403);
    expect((await fetch(`${base}/m_1/promote`, { method: "POST" })).status).toBe(403);
    const list = await fetch(base, { headers: auth });
    expect(list.status).toBe(200);
    expect(list.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await list.json()) as { items: Array<{ id: string; text: string }> };
    expect(body.items[0]!.id).toBe("m_1");
    expect(body.items[0]!.text).toHaveLength(4000);
    expect((await fetch(`http://127.0.0.1:${harness.port}/control/session/gone/queue`, { headers: auth })).status).toBe(
      404,
    );
    expect((await fetch(`${base}/m_1/promote`, { method: "POST", headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/m_1/cancel`, { method: "POST", headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/m_9/promote`, { method: "POST", headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/bad%2Fid/promote`, { method: "POST", headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/m_1/promote`, { headers: auth })).status).toBe(405);
    expect(actions).toEqual(["abc-123/m_1/promote", "abc-123/m_1/cancel"]);
  });

  it("answers 503 for queue routes when the wiring cannot read a queue", async () => {
    const { base, auth } = await withControl();
    expect((await fetch(`${base}/queue`, { headers: auth })).status).toBe(503);
  });

  it("serves a transcript only with the token, clamps the limit, and sends no CORS header", async () => {
    const { base, auth } = await withControl();
    expect((await fetch(`${base}/transcript`)).status).toBe(403);
    const limitOf = async (query: string): Promise<string | null> => {
      const response = await fetch(`${base}/transcript${query}`, { headers: auth });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const body = (await response.json()) as { messages: Array<{ turnId: string | null }>; complete: boolean };
      return body.messages[0]?.turnId ?? null;
    };
    const first = await fetch(`${base}/transcript`, { headers: auth });
    expect(await first.json()).toEqual({
      messages: [{ id: "m1", role: "user", text: "abc-123", at: null, turnId: "40" }],
      complete: true,
    });
    expect(await limitOf("?limit=5")).toBe("5");
    expect(await limitOf("?limit=9999")).toBe("200");
    expect(await limitOf("?limit=0")).toBe("40");
    expect(await limitOf("?limit=-3")).toBe("40");
    expect(await limitOf("?limit=abc")).toBe("40");
    const paged = await fetch(`${base}/transcript?limit=5&before=123`, { headers: auth });
    expect(((await paged.json()) as { nextBefore: string }).nextBefore).toBe("got-123");
    for (const bad of ["abc", "-1", "0", "1.5", "12%20", "1e3"]) {
      expect((await fetch(`${base}/transcript?before=${bad}`, { headers: auth })).status).toBe(400);
    }
    expect((await fetch(`${base}/transcripts`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/transcript`, { method: "POST", headers: auth })).status).toBe(405);
  });

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

  it("passes a steer or queue mode through, and refuses any other", async () => {
    const { base, auth, replies } = await withControl();
    for (const mode of ["steer", "queue"]) {
      const response = await fetch(`${base}/reply`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: "go", mode }),
      });
      expect(response.status).toBe(200);
    }
    const bad = await fetch(`${base}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "go", mode: "interrupt" }),
    });
    expect(bad.status).toBe(400);
    expect(replies).toEqual([
      { id: "abc-123", text: "go", mode: "steer" },
      { id: "abc-123", text: "go", mode: "queue" },
    ]);
  });

  it("refreshes Claude's usage only for a caller with the token, and only by POST", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    let calls = 0;
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      refreshClaudeUsage: async () => {
        calls += 1;
        return { claudeLimits: null, throttled: false, refreshed: false };
      },
    });
    const url = `http://127.0.0.1:${harness.port}/control/usage/claude-refresh`;
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    expect((await fetch(url, { headers: { "x-squeak-token": harness.token } })).status).toBe(405);
    expect(calls).toBe(0);
    const ok = await fetch(url, { method: "POST", headers: { "x-squeak-token": harness.token } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(await ok.json()).toEqual({ claudeLimits: null, throttled: false, refreshed: false });
    expect(calls).toBe(1);
  });

  it("serves Squeak Hands' grants only to a caller with the token, by GET", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      handsGrants: async () => ({ outdated: true }),
    });
    const url = `http://127.0.0.1:${harness.port}/control/hands/grants`;
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { "x-squeak-token": harness.token } })).status).toBe(405);
    const ok = await fetch(url, { headers: { "x-squeak-token": harness.token } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(await ok.json()).toEqual({ outdated: true });
  });

  it("changes the awake session only for a caller with the token, and says why not", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const requests: unknown[] = [];
    const state = { startedAt: "2026-10-19T10:00:00.000Z", until: "2026-10-19T11:00:00.000Z" };
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      awake: (request) => {
        requests.push(request);
        return (request as { action?: string }).action === "start"
          ? { ok: true, state }
          : { ok: false, reason: "No awake session is running to add time to." };
      },
    });
    const url = `http://127.0.0.1:${harness.port}/control/keep-awake`;
    const auth = { "x-squeak-token": harness.token };
    const start = JSON.stringify({ action: "start", minutes: 60 });
    expect((await fetch(url, { method: "POST", body: start })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    expect(requests).toEqual([]);
    const ok = await fetch(url, { method: "POST", headers: auth, body: start });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(await ok.json()).toEqual({ keepAwake: true, awake: state });
    const refused = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ action: "extend" }) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "No awake session is running to add time to." });
  });

  it("sets up the hotspot only for a caller with the token, and never echoes the password", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const requests: unknown[] = [];
    const state = { configured: true, ssid: "Phone", enabled: true, onHotspot: false, last: null };
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      hotspot: async (request) => {
        requests.push(request);
        return (request as { action?: string }).action === "configure"
          ? { ok: true, state }
          : { ok: false, reason: "Not a hotspot request this Mac understands." };
      },
    });
    const url = `http://127.0.0.1:${harness.port}/control/hotspot`;
    const auth = { "x-squeak-token": harness.token };
    const body = JSON.stringify({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect((await fetch(url, { method: "GET", headers: auth })).status).toBe(405);
    expect((await fetch(url, { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    expect(requests).toEqual([]);
    const ok = await fetch(url, { method: "POST", headers: auth, body });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    const text = await ok.text();
    expect(JSON.parse(text)).toEqual({ hotspot: state });
    expect(text).not.toContain("secret-pass");
    const refused = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ action: "nope" }) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Not a hotspot request this Mac understands." });
  });

  it("serves the relay setup routes only with the token, 503 unwired, 409 on refusal", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const base = `http://127.0.0.1:${harness.port}/control/relay`;
    const auth = { "x-squeak-token": harness.token };
    const status = { state: "off", port: 8788 };
    server.setControl({ sessionMessage: () => null, reply: async () => null });
    expect((await fetch(base, { headers: auth })).status).toBe(503);
    const calls: unknown[] = [];
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      relay: {
        status: () => status,
        setup: async (request) => {
          calls.push(request);
          return request.force ? { ok: true, status } : { ok: false, reason: "no", status };
        },
        reset: async () => ({ ok: true, status }),
      },
    });
    expect((await fetch(base)).status).toBe(403);
    expect((await fetch(`${base}/setup`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/reset`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/setup`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/setup`, { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    expect(calls).toEqual([]);
    const got = await fetch(base, { headers: auth });
    expect(got.status).toBe(200);
    expect(got.headers.get("access-control-allow-origin")).toBeNull();
    expect(await got.json()).toEqual(status);
    const refused = await fetch(`${base}/setup`, { method: "POST", headers: auth, body: "{}" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, reason: "no", status });
    const forced = await fetch(`${base}/setup`, { method: "POST", headers: auth, body: '{"force":true}' });
    expect(await forced.json()).toEqual({ ok: true, status });
    expect((await fetch(`${base}/reset`, { method: "POST", headers: auth })).status).toBe(200);
  });

  it("serves the hooks routes only with the token, 503 unwired, 405/400, 409 on refusal, no CORS", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const base = `http://127.0.0.1:${harness.port}/control/hooks`;
    const auth = { "x-squeak-token": harness.token };
    const status = { state: "missing" };
    server.setControl({ sessionMessage: () => null, reply: async () => null });
    expect((await fetch(base, { headers: auth })).status).toBe(503);
    let installs = 0;
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      hooks: {
        status: () => status,
        install: async () => {
          installs += 1;
          return { ok: true, status };
        },
        uninstall: async () => ({ ok: false, reason: "no", status }),
      },
    });
    expect((await fetch(base)).status).toBe(403);
    expect((await fetch(`${base}/install`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/install`, { headers: auth })).status).toBe(405);
    expect((await fetch(base, { method: "POST", headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/install`, { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    expect(installs).toBe(0);
    const got = await fetch(base, { headers: auth });
    expect(got.headers.get("access-control-allow-origin")).toBeNull();
    expect(await got.json()).toEqual(status);
    const ok = await fetch(`${base}/install`, { method: "POST", headers: auth, body: "{}" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, status });
    const refused = await fetch(`${base}/uninstall`, { method: "POST", headers: auth });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, reason: "no", status });
  });

  it("answers 500 without the request when the hotspot call fails, and 503 when none is wired", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const url = `http://127.0.0.1:${harness.port}/control/hotspot`;
    const auth = { "x-squeak-token": harness.token };
    const body = JSON.stringify({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true });
    server.setControl({ sessionMessage: () => null, reply: async () => null });
    expect((await fetch(url, { method: "POST", headers: auth, body })).status).toBe(503);
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      hotspot: async () => {
        throw new Error("keychain said secret-pass");
      },
    });
    const failed = await fetch(url, { method: "POST", headers: auth, body });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("secret-pass");
  });

  it("reads and changes notification settings only with the token, strictly", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const store = new NotifySettingsStore(path.join(makeDir(), "notify-settings.json"));
    const view = () => ({ ...store.snapshot(), channels: { telegram: true, cliq: false } });
    const url = `http://127.0.0.1:${harness.port}/control/notify`;
    const auth = { "x-squeak-token": harness.token };
    server.setControl({ sessionMessage: () => null, reply: async () => null });
    expect((await fetch(url, { headers: auth })).status).toBe(503);
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      notify: {
        read: view,
        apply: (request) => {
          const outcome = store.apply(request);
          return outcome.ok ? { ok: true, state: view() } : outcome;
        },
      },
    });
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(url, { method: "DELETE", headers: auth })).status).toBe(405);
    const read = await fetch(url, { headers: auth });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    expect(await read.json()).toEqual({ ...defaultNotifySettings(), channels: { telegram: true, cliq: false } });
    expect((await fetch(url, { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    const post = (body: unknown) => fetch(url, { method: "POST", headers: auth, body: JSON.stringify(body) });
    for (const bad of [
      { channel: "telegram", change: { error: true } },
      { channel: "telegram", change: { muted: "yes" } },
      { channel: "telegram", change: { muted: true, stalled: false } },
      { channel: "phone", change: { muted: true } },
      { channel: "telegram", change: { muted: true }, extra: 1 },
      { channel: "cliq", change: { quiet: { from: "25:00", to: "07:00" } } },
    ]) {
      const refused = await post(bad);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "Not a notification setting this Mac understands." });
    }
    expect(store.settings).toEqual(defaultNotifySettings());
    const ok = await post({ channel: "cliq", change: { finished: "off" } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { cliq: { finished: string }; telegram: { finished: string } };
    expect(body.cliq.finished).toBe("off");
    expect(body.telegram.finished).toBe("conductor");
  });

  it("takes pin actions on /control/voice only with the token, awaits them, and never echoes a pin", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const url = `http://127.0.0.1:${harness.port}/control/voice`;
    const auth = { "x-squeak-token": harness.token };
    const seen: unknown[] = [];
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      voice: {
        read: () => ({ mode: "gateway", pin: "set" }),
        apply: async (request) => {
          seen.push(request);
          const pin = (request as { pin?: { action?: string; current?: string } }).pin;
          if (pin?.action === "disable" && pin.current !== "4821") {
            return { ok: false, reason: "That is not your current pin." };
          }
          return { ok: true, state: { mode: "gateway", pin: pin?.action === "disable" ? "off" : "set" } };
        },
      },
    });
    const post = (body: unknown) => fetch(url, { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403);
    expect(await (await fetch(url, { headers: auth })).json()).toEqual({ mode: "gateway", pin: "set" });
    const wrong = await post({ pin: { action: "disable", current: "0000" } });
    expect(wrong.status).toBe(400);
    const wrongText = await wrong.text();
    expect(wrongText).toBe(JSON.stringify({ error: "That is not your current pin." }));
    expect(wrongText).not.toContain("0000");
    const ok = await post({ pin: { action: "disable", current: "4821" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(await ok.json()).toEqual({ mode: "gateway", pin: "off" });
    expect(seen).toHaveLength(2);
  });

  it("answers 500 without detail when a voice change throws", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      voice: {
        read: () => ({}),
        apply: async () => {
          throw new Error("pin 4821 leaked");
        },
      },
    });
    const res = await fetch(`http://127.0.0.1:${harness.port}/control/voice`, {
      method: "POST",
      headers: { "x-squeak-token": harness.token },
      body: JSON.stringify({ pin: { action: "reset", next: null } }),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("4821");
  });

  it("sets the Telegram photo only with the token, strictly, rate-limited, without CORS", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const url = `http://127.0.0.1:${harness.port}/control/telegram/avatar`;
    const auth = { "x-squeak-token": harness.token };
    server.setControl({ sessionMessage: () => null, reply: async () => null });
    expect((await fetch(url, { method: "POST", headers: auth })).status).toBe(503);
    const calls: unknown[] = [];
    let next: { ok: true; message: string } | { ok: false; reason: string; retry?: boolean } = {
      ok: true,
      message: "Done",
    };
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      telegramAvatar: async (request) => {
        calls.push(request);
        return next;
      },
    });
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    expect((await fetch(url, { headers: auth })).status).toBe(405);
    expect((await fetch(url, { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    const ok = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ which: "logo" }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(await ok.json()).toEqual({ message: "Done" });
    expect((await fetch(url, { method: "POST", headers: auth })).status).toBe(200);
    expect(calls).toEqual([{ which: "logo" }, {}]);
    next = { ok: false, reason: "Telegram is not set up" };
    const failed = await fetch(url, { method: "POST", headers: auth });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "Telegram is not set up" });
    next = { ok: false, reason: "Try again in a minute", retry: true };
    expect((await fetch(url, { method: "POST", headers: auth })).status).toBe(429);
  });

  it("serves fan control's sudoers rule only with the token, and 503 when none is wired", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const url = `http://127.0.0.1:${harness.port}/control/heat/fan-rule`;
    const auth = { "x-squeak-token": harness.token };
    server.setControl({ sessionMessage: () => null, reply: async () => null });
    expect((await fetch(url, { headers: auth })).status).toBe(503);
    const rule = { path: "/etc/sudoers.d/squeak-fans", rule: "me ALL=(root) NOPASSWD: x\n", helperPath: "/x" };
    server.setControl({ sessionMessage: () => null, reply: async () => null, fanRule: () => rule });
    expect((await fetch(url)).status).toBe(403);
    const ok = await fetch(url, { headers: auth });
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(await ok.json()).toEqual(rule);
  });

  it("passes the turn a reply answers through, and rejects one that is not a string", async () => {
    const { base, auth, replies } = await withControl();
    const ok = await fetch(`${base}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "B", answersTurn: "turn-7" }),
    });
    expect(ok.status).toBe(200);
    expect(replies).toEqual([{ id: "abc-123", text: "B", answersTurn: "turn-7" }]);
    const bad = await fetch(`${base}/reply`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "B", answersTurn: 7 }),
    });
    expect(bad.status).toBe(400);
    expect(replies).toHaveLength(1);
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
      headers: { "x-squeak-token": harness.token },
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
    const auth = { "x-squeak-token": harness.token };

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

describe("HookIngressServer answer routes", () => {
  async function withAnswer() {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const answered: Array<{ id: string; body: unknown }> = [];
    server.setControl({
      sessionMessage: () => ({}),
      reply: async () => ({}),
      question: (id) => (id === "abc" ? { toolUseId: "t1", kind: "question", questions: [], plan: null } : null),
      answer: async (id, body) => {
        answered.push({ id, body });
        return { status: "answered", via: "conductor" };
      },
    });
    const base = `http://127.0.0.1:${harness.port}/control/session/abc`;
    return { base, auth: { "x-squeak-token": harness.token }, answered };
  }

  it("serves the pending question and takes an answer, only with the token and never to a web page", async () => {
    const { base, auth, answered } = await withAnswer();
    expect((await fetch(`${base}/question`)).status).toBe(403);
    const read = await fetch(`${base}/question`, { headers: auth });
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    expect(await read.json()).toMatchObject({ toolUseId: "t1" });
    expect(
      await (
        await fetch(`http://127.0.0.1:${new URL(base).port}/control/session/zzz/question`, { headers: auth })
      ).json(),
    ).toBeNull();

    expect((await fetch(`${base}/answer`, { method: "POST", body: "{}" })).status).toBe(403);
    const body = { toolUseId: "t1", plan: { approve: true } };
    const response = await fetch(`${base}/answer`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({ status: "answered", via: "conductor" });
    expect(answered).toEqual([{ id: "abc", body }]);
    expect((await fetch(`${base}/answer`, { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    expect((await fetch(`${base}/answer`, { headers: auth })).status).toBe(405);
  });
});

describe("HookIngressServer chat actions and workspaces", () => {
  it("routes stop, setup and pr to the chat action, behind the token", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const calls: unknown[][] = [];
    server.setControl({
      sessionMessage: () => ({}),
      reply: async () => ({ status: "started", via: "conductor" }),
      sessionAction: async (id, action, body) => {
        calls.push([id, action, body]);
        return { ok: true };
      },
      chatModels: () => [{ id: "opus-5-5" }],
      workspaceRepos: () => ({ repos: [{ id: "r1", name: "farm" }] }),
      workspaceAction: async (body) => ({ ok: true, echoed: body.action }),
    });
    const url = (route: string) => `http://127.0.0.1:${harness.port}${route}`;
    const auth = { "x-squeak-token": harness.token };
    for (const action of ["stop", "setup", "pr"]) {
      const response = await fetch(url(`/control/session/s-1/${action}`), {
        method: "POST",
        headers: auth,
        body: JSON.stringify(action === "setup" ? { model: "opus-5-5" } : {}),
      });
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(calls).toEqual([
      ["s-1", "stop", {}],
      ["s-1", "setup", { model: "opus-5-5" }],
      ["s-1", "pr", {}],
    ]);
    expect(await (await fetch(url("/control/models"), { headers: auth })).json()).toEqual({
      models: [{ id: "opus-5-5" }],
    });
    expect(await (await fetch(url("/control/workspace-repos"), { headers: auth })).json()).toEqual({
      repos: [{ id: "r1", name: "farm" }],
    });
    const made = await fetch(url("/control/workspace-action"), {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "create", repoId: "r1" }),
    });
    expect(await made.json()).toEqual({ ok: true, echoed: "create" });
    const refused = await fetch(url("/control/session/s-1/stop"), { method: "POST", body: "{}" });
    expect(refused.status).toBe(403);
    expect(calls).toHaveLength(3);
  });
});

describe("HookIngressServer gateway pairing routes", () => {
  it("gates, shapes and answers /control/voice/gateway*", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const approvals: boolean[] = [];
    const base = `http://127.0.0.1:${harness.port}/control/voice/gateway`;
    const auth = { "x-squeak-token": harness.token };
    server.setControl({ sessionMessage: () => null, reply: async () => null });
    expect((await fetch(base, { headers: auth })).status).toBe(503);
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      voiceGateway: {
        read: () => ({ pairing: null, status: { state: "none" } }),
        pair: () => ({ ok: true, code: "SQ1-abc", expiresAt: 42 }),
        approve: async (approve) => {
          approvals.push(approve);
          return approve ? { ok: true } : { ok: false, reason: "No gateway has asked to pair yet." };
        },
      },
    });
    for (const url of [base, `${base}/pair`, `${base}/approve`]) {
      expect((await fetch(url, url === base ? { method: "GET" } : { method: "POST", body: "{}" })).status).toBe(403);
    }
    expect((await fetch(`${base}/pair`, { headers: auth })).status).toBe(405);
    expect((await fetch(base, { method: "POST", headers: auth, body: "{}" })).status).toBe(405);
    const read = await fetch(base, { headers: auth });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    expect(await read.json()).toEqual({ pairing: null, status: { state: "none" } });
    const pair = await fetch(`${base}/pair`, { method: "POST", headers: auth, body: "{}" });
    expect(pair.headers.get("access-control-allow-origin")).toBeNull();
    expect(await pair.json()).toEqual({ ok: true, code: "SQ1-abc", expiresAt: 42 });
    expect((await fetch(`${base}/pair`, { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    const approve = (body: unknown) =>
      fetch(`${base}/approve`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    for (const bad of [{}, { approve: "yes" }, { approve: true, extra: 1 }]) {
      expect((await approve(bad)).status).toBe(400);
    }
    expect(approvals).toEqual([]);
    expect(await (await approve({ approve: true })).json()).toEqual({ ok: true });
    const declined = await approve({ approve: false });
    expect(declined.status).toBe(400);
    expect(await declined.json()).toEqual({ error: "No gateway has asked to pair yet." });
    expect(approvals).toEqual([true, false]);
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      voiceGateway: {
        read: () => null,
        pair: () => ({ ok: false, reason: "needs a database", unavailable: true }),
        approve: async () => ({ ok: true }),
      },
    });
    expect((await fetch(`${base}/pair`, { method: "POST", headers: auth, body: "{}" })).status).toBe(503);
  });
});

describe("HookIngressServer gateway claim route", () => {
  it("gates and shapes POST /control/voice/gateway/claim", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const url = `http://127.0.0.1:${harness.port}/control/voice/gateway/claim`;
    const auth = { "x-squeak-token": harness.token };
    const post = (body: string, headers: Record<string, string> = auth) =>
      fetch(url, { method: "POST", headers, body });
    const seen: string[] = [];
    const base = {
      read: () => null,
      pair: () => ({ ok: false as const, reason: "x" }),
      approve: async () => ({ ok: true as const }),
    };
    server.setControl({ sessionMessage: () => null, reply: async () => null, voiceGateway: base });
    expect((await post(JSON.stringify({ code: "K7M2-QX9P" }))).status).toBe(404);
    server.setControl({
      sessionMessage: () => null,
      reply: async () => null,
      voiceGateway: {
        ...base,
        claim: async (code) => {
          seen.push(code);
          if (code === "NOPE") return { ok: false, status: 400, reason: "That code isn't showing on an add-on." };
          if (code === "SHARED") return { ok: false, status: 503, reason: "Phone calls need your own Firebase" };
          return { ok: true, name: "Squeak Voice", version: "0.9.0" };
        },
      },
    });
    expect((await post(JSON.stringify({ code: "K7M2-QX9P" }), {})).status).toBe(403);
    expect((await fetch(url, { headers: auth })).status).toBe(405);
    for (const bad of ["{nope", "{}", JSON.stringify({ code: 1 }), JSON.stringify({ code: "A", x: 1 })]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(seen).toEqual([]);
    const ok = await post(JSON.stringify({ code: "K7M2-QX9P" }));
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(await ok.json()).toEqual({ ok: true, name: "Squeak Voice", version: "0.9.0" });
    const bad = await post(JSON.stringify({ code: "NOPE" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "That code isn't showing on an add-on." });
    expect((await post(JSON.stringify({ code: "SHARED" }))).status).toBe(503);
  });
});

describe("HookIngressServer call history route", () => {
  it("gates, shapes and answers /control/voice/calls", async () => {
    const harness = await startServer();
    const server = servers.at(-1)!;
    const url = `http://127.0.0.1:${harness.port}/control/voice/calls`;
    const auth = { "x-squeak-token": harness.token };
    server.setControl({ sessionMessage: () => null, reply: async () => null });
    expect((await fetch(url, { headers: auth })).status).toBe(503);
    const body = { calls: [{ id: "a", at: 1, kind: "test", outcome: "unanswered", durationMs: 5 }], gatewayLog: null };
    server.setControl({ sessionMessage: () => null, reply: async () => null, voiceCalls: async () => body });
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: auth, body: "{}" })).status).toBe(405);
    const read = await fetch(url, { headers: auth });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    expect(await read.json()).toEqual(body);
  });
});
