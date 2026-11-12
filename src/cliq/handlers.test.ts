import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CliqHandlers } from "./handlers.js";
import { logger } from "../utils/logger.js";

const dirs: string[] = [];
function setup(env: string, cloud: Parameters<typeof makeCloud>[0] = "catalyst") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cliq-handlers-"));
  dirs.push(dir);
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  const restart = vi.fn();
  const handlers = new CliqHandlers({
    envPath,
    supportDir: dir,
    cloud: () => makeCloud(cloud),
    restart,
    now: () => Date.parse("2026-11-12T10:00:00Z"),
  });
  return { dir, envPath, handlers, restart };
}
function makeCloud(kind: "catalyst" | "none") {
  return kind === "catalyst"
    ? ({
        provider: "catalyst",
        relayUrl: "https://x.catalystserverless.in/server/squeak_relay",
        relayKey: "R".repeat(43),
      } as const)
    : null;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("CliqHandlers", () => {
  it("is not ready before a relay exists, then regenerate makes one and reports the key", async () => {
    const { handlers, envPath, dir, restart } = setup("");
    expect(handlers.view()).toMatchObject({ blocks: [], relayReady: false, inbox: "catalyst" });
    const outcome = await handlers.regenerate();
    expect(outcome).toMatchObject({ ok: true, needsRelayDeploy: true, restart: true });
    expect(restart).toHaveBeenCalledOnce();
    const env = fs.readFileSync(envPath, "utf8");
    expect(env).toContain("SQUEAK_CLIQ_RELAY_ID=");
    expect(env).toContain(`SQUEAK_CLIQ_KEY=${(outcome as { relayKey: string }).relayKey}`);
    expect(fs.existsSync(path.join(dir, "cliq-handlers.txt"))).toBe(true);
    const view = handlers.view();
    expect(view.relayReady).toBe(true);
    expect(view.blocks.map((b) => b.id)).toEqual(["message", "squeakbutton", "squeakreply"]);
    expect(view.blocks[1]!.where).toContain("squeakbutton");
    expect(view.blocks.every((b) => b.code.includes("x-squeak-cliq"))).toBe(true);
  });

  it("regenerate rotates the id and secret but keeps an existing Cliq key (no relay deploy)", async () => {
    const { handlers, envPath } = setup(
      "SQUEAK_CLIQ_RELAY_ID=old\nSQUEAK_CLIQ_RELAY_SECRET=oldsecret\nSQUEAK_CLIQ_KEY=keepme\n",
    );
    const outcome = await handlers.regenerate();
    expect(outcome).toEqual({ ok: true, needsRelayDeploy: false, restart: true });
    const env = fs.readFileSync(envPath, "utf8");
    expect(env).toContain("SQUEAK_CLIQ_KEY=keepme");
    expect(env).not.toContain("oldsecret");
    expect(env).not.toContain("RELAY_ID=old\n");
    expect(handlers.view().blocks[0]!.code).not.toContain("oldsecret");
  });

  it("answers a reason when there is no relay to make", async () => {
    const { handlers, restart } = setup("", "none");
    expect(await handlers.regenerate()).toMatchObject({ ok: false });
    expect(restart).not.toHaveBeenCalled();
  });

  it("records the first tap and clears it on regenerate; the secret is never logged", async () => {
    const spies = (["info", "warn", "debug", "error"] as const).map((m) => vi.spyOn(logger, m));
    const { handlers } = setup("SQUEAK_CLIQ_RELAY_ID=a\nSQUEAK_CLIQ_RELAY_SECRET=topsecret\nSQUEAK_CLIQ_KEY=k\n");
    expect(handlers.view().lastTapAt).toBeUndefined();
    handlers.recordTap();
    expect(handlers.view().lastTapAt).toBe("2026-11-12T10:00:00.000Z");
    await handlers.regenerate();
    expect(handlers.view().lastTapAt).toBeUndefined();
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain("topsecret");
  });
});

describe("CliqHandlers on a hosted Mac", () => {
  const MAC_KEY = "M".repeat(43);
  function hosted(env: string, replies: Array<number | "network"> = [200]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cliq-hosted-"));
    dirs.push(dir);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, env, { mode: 0o600 });
    const restart = vi.fn();
    const calls: Array<{ url: string; headers: Record<string, string>; body: { channel: string; token: string } }> = [];
    let n = 0;
    const handlers = new CliqHandlers({
      envPath,
      supportDir: dir,
      restart,
      cloud: () => ({
        provider: "catalyst",
        relayUrl: "https://x.catalystserverless.in/server/squeak_relay",
        relayKey: MAC_KEY,
        hosted: true,
      }),
      now: () => Date.parse("2026-11-12T10:00:00Z"),
      fetch: async (url, init) => {
        calls.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        });
        const reply = replies[Math.min(n++, replies.length - 1)]!;
        if (reply === "network") throw new Error("offline");
        return new Response("{}", { status: reply });
      },
    });
    return { dir, envPath, handlers, restart, calls };
  }
  const existing = "SQUEAK_CLIQ_RELAY_ID=rid\nSQUEAK_CLIQ_RELAY_SECRET=sec\n";

  it("registers a fresh per-Mac key on first use and then shows ready handlers without any manual step", async () => {
    const { handlers, envPath, calls, restart } = hosted(existing);
    expect(handlers.view().relayReady).toBe(false);
    await handlers.ensure();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://x.catalystserverless.in/server/squeak_relay/account/macs/cliq-token");
    expect(calls[0]!.headers["x-squeak-mac-key"]).toBe(MAC_KEY);
    expect(calls[0]!.body.channel).toBe("rid");
    const env = fs.readFileSync(envPath, "utf8");
    expect(env).toContain(`SQUEAK_CLIQ_KEY=${calls[0]!.body.token}`);
    expect(env).toContain("SQUEAK_CLIQ_KEY_FOR=rid");
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    const view = handlers.view();
    expect(view.relayReady).toBe(true);
    expect(view.automatic).toBe(true);
    expect(view.registerError).toBeUndefined();
    expect(view.blocks[0]!.code).toContain(`"x-squeak-cliq":"${calls[0]!.body.token}"`);
    expect(restart).not.toHaveBeenCalled();
    await handlers.ensure(); // already registered: no second call
    expect(calls).toHaveLength(1);
  });

  it("makes the relay itself when there is none, and restarts once", async () => {
    const { handlers, envPath, calls, restart } = hosted("");
    await handlers.ensure();
    expect(calls).toHaveLength(1);
    expect(restart).toHaveBeenCalledOnce();
    const env = fs.readFileSync(envPath, "utf8");
    expect(env).toContain(`SQUEAK_CLIQ_RELAY_ID=${calls[0]!.body.channel}`);
    expect(env).toContain(`SQUEAK_CLIQ_KEY_FOR=${calls[0]!.body.channel}`);
    expect(handlers.view().relayReady).toBe(true);
  });

  it("replaces a shared key that was never registered for this relay id", async () => {
    const { handlers, envPath, calls } = hosted(`${existing}SQUEAK_CLIQ_KEY=oldshared\n`);
    expect(handlers.view().relayReady).toBe(false);
    await handlers.ensure();
    const env = fs.readFileSync(envPath, "utf8");
    expect(env).not.toContain("oldshared");
    expect(env).toContain(`SQUEAK_CLIQ_KEY=${calls[0]!.body.token}`);
  });

  it("regenerate rotates the id, secret and key and registers the new key for the new id", async () => {
    const { handlers, envPath, calls, restart } = hosted(`${existing}SQUEAK_CLIQ_KEY=k1\nSQUEAK_CLIQ_KEY_FOR=rid\n`);
    expect(handlers.view().relayReady).toBe(true);
    const outcome = await handlers.regenerate();
    expect(outcome).toEqual({ ok: true, needsRelayDeploy: false, restart: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.channel).not.toBe("rid");
    const env = fs.readFileSync(envPath, "utf8");
    expect(env).toContain(`SQUEAK_CLIQ_RELAY_ID=${calls[0]!.body.channel}`);
    expect(env).toContain(`SQUEAK_CLIQ_KEY=${calls[0]!.body.token}`);
    expect(env).toContain(`SQUEAK_CLIQ_KEY_FOR=${calls[0]!.body.channel}`);
    expect(env).not.toContain("sec\n");
    expect(restart).toHaveBeenCalledOnce();
  });

  it("a failed registration changes nothing, says so with a fixed sentence, and Retry tries again", async () => {
    const { handlers, envPath, calls } = hosted(existing, [503, "network", 200]);
    const before = fs.readFileSync(envPath, "utf8");
    await handlers.ensure();
    expect(handlers.view()).toMatchObject({
      relayReady: false,
      registerError: "Squeak's cloud could not set up Cliq. Try again in a moment.",
    });
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
    await handlers.ensure(); // inside the wait: no new call
    expect(calls).toHaveLength(1);
    await handlers.ensure(true); // Retry skips the wait; the network is down this time
    expect(calls).toHaveLength(2);
    expect(handlers.view().registerError).toBeDefined();
    const rotated = await handlers.regenerate();
    expect(rotated).toEqual({ ok: true, needsRelayDeploy: false, restart: true }); // third reply is 200
    expect(handlers.view()).toMatchObject({ relayReady: true });
    expect(handlers.view().registerError).toBeUndefined();
  });

  it("a refused regenerate leaves the old relay untouched", async () => {
    const { handlers, envPath, restart } = hosted(`${existing}SQUEAK_CLIQ_KEY=k1\nSQUEAK_CLIQ_KEY_FOR=rid\n`, [403]);
    const before = fs.readFileSync(envPath, "utf8");
    expect(await handlers.regenerate()).toMatchObject({ ok: false });
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
    expect(restart).not.toHaveBeenCalled();
  });

  it("never logs the key, the secret or the relay's answer", async () => {
    const spies = (["info", "warn", "debug", "error"] as const).map((m) => vi.spyOn(logger, m));
    const { handlers, calls } = hosted(existing, [503, 200]);
    await handlers.ensure();
    await handlers.ensure(true);
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain("sec");
    expect(logged).not.toContain(MAC_KEY);
    expect(logged).not.toContain(calls[1]!.body.token);
  });

  it("leaves own-Catalyst Macs as they were: no registration call", async () => {
    const { handlers } = setup("SQUEAK_CLIQ_RELAY_ID=a\nSQUEAK_CLIQ_RELAY_SECRET=b\nSQUEAK_CLIQ_KEY=c\n");
    const spy = vi.spyOn(globalThis, "fetch");
    await handlers.ensure();
    expect(spy).not.toHaveBeenCalled();
    expect(handlers.view().relayReady).toBe(true);
  });
});
