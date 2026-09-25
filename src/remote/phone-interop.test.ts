import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import { RemoteBridge, type RemoteConfig } from "./remote-bridge.js";

/**
 * A reply built and signed by the iPhone's own code (ios/SqueakCore,
 * `swift run squeak-fixtures`), fed to the Mac's real verifier. If the two
 * sides ever drift — encoding, signature format, field names — this fails.
 */
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "swift-command.json"), "utf8")) as {
  madeAt: number;
  key: string;
  channelId: string;
  deviceId: string;
  publicKey: string;
  commandId: string;
  command: { box: string; sig: string; device: string };
};

function bridge(turn: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-interop-"));
  const configPath = path.join(dir, "remote.json");
  const config: RemoteConfig = {
    projectId: "squeak-test",
    channelId: fixture.channelId,
    key: fixture.key,
    devices: [{ id: fixture.deviceId, name: "iPhone", publicKey: fixture.publicKey, pairedAt: "2026-09-25T00:00:00Z" }],
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const sends: Array<[string, string]> = [];
  const remote = new RemoteBridge({
    configPath,
    projectId: "squeak-test",
    store: { get: async () => null, set: async () => {}, list: async () => [], delete: async () => {} },
    replier: {
      lastTurnText: () => null,
      lastTurnId: () => turn,
      send: async (sessionId, text) => {
        sends.push([sessionId, text]);
        return { status: "started", via: "conductor" };
      },
    },
    snapshot: () => ({}) as FleetSnapshot,
    // As of when the phone made it, so the fixture never expires.
    now: () => fixture.madeAt + 1_000,
  });
  return { remote, config, sends };
}

describe("a reply made on the iPhone", () => {
  it("is accepted by the Mac and sent exactly as typed", async () => {
    const { remote, config, sends } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.commandId, fixture.command);
    expect(verdict.result).toMatchObject({ status: "sent" });
    expect(sends).toEqual([["s1", "B"]]);
  });

  it("is refused once the chat has moved to another turn", async () => {
    const { remote, config, sends } = bridge("turn-2");
    const verdict = await remote.handleCommand(config, fixture.commandId, fixture.command);
    expect(verdict.result).toMatchObject({ status: "refused" });
    expect(sends).toEqual([]);
  });

  it("is ignored if a single byte of it is changed", async () => {
    const { remote, config, sends } = bridge("turn-1");
    const raw = Buffer.from(fixture.command.box, "base64");
    raw[20] = raw[20]! ^ 1;
    await remote.handleCommand(config, fixture.commandId, { ...fixture.command, box: raw.toString("base64") });
    expect(sends).toEqual([]);
  });
});
