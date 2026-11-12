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
  it("is not ready before a relay exists, then regenerate makes one and reports the key", () => {
    const { handlers, envPath, dir, restart } = setup("");
    expect(handlers.view()).toMatchObject({ blocks: [], relayReady: false, inbox: "catalyst" });
    const outcome = handlers.regenerate();
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

  it("regenerate rotates the id and secret but keeps an existing Cliq key (no relay deploy)", () => {
    const { handlers, envPath } = setup(
      "SQUEAK_CLIQ_RELAY_ID=old\nSQUEAK_CLIQ_RELAY_SECRET=oldsecret\nSQUEAK_CLIQ_KEY=keepme\n",
    );
    const outcome = handlers.regenerate();
    expect(outcome).toEqual({ ok: true, needsRelayDeploy: false, restart: true });
    const env = fs.readFileSync(envPath, "utf8");
    expect(env).toContain("SQUEAK_CLIQ_KEY=keepme");
    expect(env).not.toContain("oldsecret");
    expect(env).not.toContain("RELAY_ID=old\n");
    expect(handlers.view().blocks[0]!.code).not.toContain("oldsecret");
  });

  it("answers a reason when there is no relay to make", () => {
    const { handlers, restart } = setup("", "none");
    expect(handlers.regenerate()).toMatchObject({ ok: false });
    expect(restart).not.toHaveBeenCalled();
  });

  it("records the first tap and clears it on regenerate; the secret is never logged", () => {
    const spies = (["info", "warn", "debug", "error"] as const).map((m) => vi.spyOn(logger, m));
    const { handlers } = setup("SQUEAK_CLIQ_RELAY_ID=a\nSQUEAK_CLIQ_RELAY_SECRET=topsecret\nSQUEAK_CLIQ_KEY=k\n");
    expect(handlers.view().lastTapAt).toBeUndefined();
    handlers.recordTap();
    expect(handlers.view().lastTapAt).toBe("2026-11-12T10:00:00.000Z");
    handlers.regenerate();
    expect(handlers.view().lastTapAt).toBeUndefined();
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain("topsecret");
  });
});
