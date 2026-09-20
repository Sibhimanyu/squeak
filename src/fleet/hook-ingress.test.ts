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

/** The handler acknowledges before dispatching, so give it a tick to land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
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
    await settle();

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
    await settle();

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
