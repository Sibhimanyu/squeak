import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HookIngressServer } from "../fleet/hook-ingress.js";
import { dropEarlyServer, listenEarly, shutdownOnSignals } from "./early-listen.js";

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

const dirs: string[] = [];
const ingresses: HookIngressServer[] = [];
afterEach(async () => {
  dropEarlyServer();
  for (const ingress of ingresses.splice(0)) await ingress.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("early listener", () => {
  it("answers /state as starting and control routes 503 before the ingress exists", async () => {
    const port = await freePort();
    expect(await listenEarly(port)).toBe(true);
    const state = await fetch(`http://127.0.0.1:${port}/state`);
    expect(state.status).toBe(200);
    expect(state.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await state.json()) as Record<string, unknown>;
    expect(body.starting).toBe(true);
    expect(body.active).toEqual([]);
    expect(body.others).toEqual([]);
    const control = await fetch(`http://127.0.0.1:${port}/control/session/x/message`);
    expect(control.status).toBe(503);
    expect(await control.json()).toEqual({ error: "starting" });
    const hook = await fetch(`http://127.0.0.1:${port}/hook`, { method: "POST", body: "{}" });
    expect(hook.status).toBe(503);
  });

  it("is adopted by the real ingress on the same socket, which then answers for real", async () => {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-early-"));
    dirs.push(dir);
    await listenEarly(port);
    const ingress = new HookIngressServer({
      port,
      tokenPath: path.join(dir, "token"),
      onEvent: () => undefined,
      readState: () => ({ ready: true }),
    });
    ingresses.push(ingress);
    await ingress.start();
    const state = await fetch(`http://127.0.0.1:${port}/state`);
    expect(await state.json()).toEqual({ ready: true });
    // No control wired yet: the ingress says 503 (not a hang) for a token holder.
    const token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
    const control = await fetch(`http://127.0.0.1:${port}/control/session/x/message`, {
      headers: { "x-squeak-token": token },
    });
    expect(control.status).toBe(503);
  });

  it("leaves a busy port to the real ingress", async () => {
    const port = await freePort();
    const holder = net.createServer().listen(port, "127.0.0.1");
    await new Promise((r) => holder.once("listening", r));
    expect(await listenEarly(port)).toBe(false);
    holder.close();
  });
});

describe("shutdownOnSignals", () => {
  it("exits after a clean stop, and hard-exits when stop hangs", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      shutdownOnSignals(async () => undefined, 5000, done)("SIGTERM");
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toHaveBeenCalledWith(0);

      const hung = vi.fn();
      const handler = shutdownOnSignals(() => new Promise<void>(() => undefined), 5000, hung);
      handler("SIGTERM");
      handler("SIGTERM");
      await vi.advanceTimersByTimeAsync(4999);
      expect(hung).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(hung).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
