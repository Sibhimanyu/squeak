import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { QueueAction, ReplyOptions } from "../fleet/session-reply.js";
import type { FleetSession } from "../fleet/types.js";
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
  steerCommandId: string;
  steerCommand: { box: string; sig: string; device: string };
  startCommandId: string;
  startCommand: { box: string; sig: string; device: string };
  answerCommandId: string;
  answerCommand: { box: string; sig: string; device: string };
  queuedCommandId: string;
  queuedCommand: { box: string; sig: string; device: string };
  promoteCommandId: string;
  promoteCommand: { box: string; sig: string; device: string };
};

const QUEUED_ID = "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31";

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
  const sends: Array<[string, string, string | undefined]> = [];
  const sent: Array<ReplyOptions | undefined> = [];
  const queueActions: Array<[string, string, QueueAction]> = [];
  const starts: Array<{ workspaceId: string; agent: string; text: string }> = [];
  const answers: Array<[string, unknown]> = [];
  const remote = new RemoteBridge({
    configPath,
    projectId: "squeak-test",
    store: { get: async () => null, set: async () => {}, list: async () => [], delete: async () => {} },
    replier: {
      lastTurnText: () => null,
      lastTurnId: () => turn,
      send: async (sessionId, text, _onFailed, options) => {
        sends.push([sessionId, text, options?.mode]);
        sent.push(options);
        return { status: "started", via: "conductor", delivery: options?.mode === "steer" ? "steered" : "sent" };
      },
      queue: async () => [{ id: QUEUED_ID, text: "Then add tests", mode: "queue", position: 0 }],
      queueAction: async (sessionId, messageId, action) => {
        queueActions.push([sessionId, messageId, action]);
        return { ok: true };
      },
    },
    // The chat the phone's commands name, as the Mac's own snapshot shows it.
    snapshot: () =>
      ({
        sessions: [],
        active: [{ key: "claude-transcript:s1", conductorSessionId: "s1" } as FleetSession],
      }) as unknown as FleetSnapshot,
    newChat: {
      workspaces: () => [
        { id: "w1", repoName: "farm", branch: "arm", lastActivityAt: "", defaultAgent: "claude" as const },
      ],
      start: async (args) => {
        starts.push(args);
        return { ok: true, sessionId: "new-1" };
      },
    },
    // Records what the phone's answer asks for; delivery itself is answer-command's business.
    answerer: {
      answer: async (sessionId: string, input: unknown) => {
        answers.push([sessionId, input]);
        return { status: "answered", via: "stopped-and-sent" } as const;
      },
    } as never,
    // As of when the phone made it, so the fixture never expires.
    now: () => fixture.madeAt + 1_000,
  });
  return { remote, config, sends, sent, starts, queueActions, answers };
}

describe("a reply made on the iPhone", () => {
  it("is accepted by the Mac and sent exactly as typed", async () => {
    const { remote, config, sends } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.commandId, fixture.command);
    expect(verdict.result).toMatchObject({ status: "sent" });
    expect(sends).toEqual([["s1", "B", "queue"]]);
  });

  it("carries a signed steer mode through to the replier and reports the delivery", async () => {
    const { remote, config, sends } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.steerCommandId, fixture.steerCommand);
    expect(verdict.result).toMatchObject({ status: "sent", delivery: "steered" });
    expect(sends).toEqual([["s1", "Use the timer instead", "steer"]]);
  });

  it("delivers an answer the phone signed, picks and its own words as typed", async () => {
    const { remote, config, answers } = bridge("turn-9");
    const verdict = await remote.handleCommand(config, fixture.answerCommandId, fixture.answerCommand);
    expect(verdict.result).toMatchObject({ id: fixture.answerCommandId, status: "answered", via: "stopped-and-sent" });
    expect(answers).toHaveLength(1);
    expect(answers[0]![0]).toBe("s1");
    expect(JSON.stringify(answers[0]![1])).toContain("toolu_fixture");
    expect(JSON.stringify(answers[0]![1])).toContain("Red");
    expect(JSON.stringify(answers[0]![1])).toContain("and a bit of blue");
  });

  it("starts a new chat when the phone signs a start command", async () => {
    const { remote, config, sends, starts } = bridge("turn-9");
    const verdict = await remote.handleCommand(config, fixture.startCommandId, fixture.startCommand);
    expect(verdict.result).toEqual({ id: fixture.startCommandId, status: "sent", sessionId: "new-1" });
    expect(starts).toEqual([{ workspaceId: "w1", agent: "codex", text: "Add a timer" }]);
    expect(sends).toEqual([]);
  });

  it("carries the phone's own message id for a queued reply", async () => {
    const { remote, config, sends, sent } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.queuedCommandId, fixture.queuedCommand);
    expect(verdict.result).toMatchObject({ status: "sent" });
    expect(sends).toEqual([["s1", "Then add tests", "queue"]]);
    expect(sent).toEqual([{ mode: "queue", messageId: QUEUED_ID }]);
  });

  it("steers a queued message in when the phone signs a queue command", async () => {
    const { remote, config, sends, queueActions } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.promoteCommandId, fixture.promoteCommand);
    expect(verdict.result).toEqual({ id: fixture.promoteCommandId, status: "sent" });
    expect(queueActions).toEqual([["s1", QUEUED_ID, "promote"]]);
    expect(sends).toEqual([]);
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
