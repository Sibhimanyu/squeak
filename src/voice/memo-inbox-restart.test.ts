import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { MemoInbox } from "./memo-inbox.js";
import {
  dirPath,
  downPath,
  newMessageId,
  readDirectory,
  readDown,
  sealUp,
  upPath,
  type UpMessage,
} from "./memo-protocol.js";

const { channelId: channel, key } = generateChannel();
type UpBody = UpMessage extends infer U ? (U extends UpMessage ? Omit<U, "id" | "at" | "expiresAt"> : never) : never;

describe("MemoInbox across a restart", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let dir: string;
  let file: string;
  let clock = 1_800_000_000_000;
  let targetsNow: Array<{ target: string; label: string; workspace: null }>;
  const sent: string[] = [];
  const inboxes: MemoInbox[] = [];

  const make = (): MemoInbox => {
    const inbox = new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => "go with B" },
      targets: () => targetsNow,
      canSend: () => true,
      send: async (target, text) => {
        sent.push(`${target}:${text}`);
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
      caller: () => "35210",
      note: () => undefined,
      converse: async () => ({ intent: "say", spoken: "ok" }) as never,
      stateFile: file,
      now: () => clock,
    });
    inboxes.push(inbox);
    return inbox;
  };

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-callstate-"));
    file = path.join(dir, "voice-call-state.json");
    clock = 1_800_000_000_000;
    targetsNow = [{ target: "c1", label: "squeak voice", workspace: null }];
    sent.length = 0;
  });
  afterEach(async () => {
    for (const inbox of inboxes.splice(0)) inbox.stop();
    await db.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function upload(inbox: MemoInbox, message: UpBody & { id?: string }) {
    const id = message.id ?? newMessageId();
    await store.set(
      upPath(channel, id),
      sealUp(key, { ...message, id, at: clock, expiresAt: clock + 60_000 } as UpMessage),
    );
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return doc ? readDown(key, id, doc) : null;
  }
  const memo = (dirVersion: string) =>
    ({ v: 1, kind: "memo", dirVersion, choice: 1, audio: Buffer.from("opus").toString("base64") }) as const;
  const talk = (dirVersion: string) =>
    ({
      v: 1,
      kind: "talk",
      dirVersion,
      choice: 1,
      callId: "call-1",
      phase: "say",
      audio: Buffer.from("opus").toString("base64"),
    }) as const;

  async function versionOf(): Promise<string> {
    return readDirectory(key, (await store.get(dirPath(channel)))!, clock)!.version;
  }

  it("keeps a call going: a talk turn, and a memo against the list the call heard", async () => {
    const first = make();
    await first.publish();
    const oldVersion = await versionOf();
    expect(await upload(first, talk(oldVersion))).toMatchObject({ status: "talk" });
    first.stop();

    // The daemon restarts with a different list (a new chat appeared), so a new version goes out.
    targetsNow = [...targetsNow, { target: "c2", label: "other", workspace: null }];
    const second = make();
    await second.publish();
    expect(await versionOf()).not.toBe(oldVersion);

    expect(await upload(second, talk(oldVersion))).toMatchObject({ status: "talk" });
    const heard = await upload(second, memo(oldVersion));
    expect(heard).toMatchObject({ status: "transcript", label: "squeak voice" });
    // Nothing is sent without the person's own confirm.
    expect(sent).toEqual([]);
  });

  it("a pending message still needs its confirm after a restart", async () => {
    const first = make();
    await first.publish();
    const version = await versionOf();
    const memoId = newMessageId();
    await upload(first, { ...memo(version), id: memoId });
    first.stop();

    const second = make();
    expect(sent).toEqual([]);
    expect(await upload(second, { v: 1, kind: "send", memoId } as UpBody)).toMatchObject({ status: "sent" });
    expect(sent).toEqual(["c1:go with B"]);
  });

  it("drops what has expired", async () => {
    const first = make();
    await first.publish();
    const version = await versionOf();
    await upload(first, talk(version));
    first.stop();

    clock += 31 * 60_000;
    const second = make();
    expect(await upload(second, memo(version))).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("out of date"),
    });
    expect(await upload(second, talk(version))).toMatchObject({ status: "refused" });
  });

  it("refuses a replayed message after a restart", async () => {
    const first = make();
    await first.publish();
    const version = await versionOf();
    const id = newMessageId();
    await upload(first, { ...memo(version), id });
    first.stop();

    await store.delete(downPath(channel, id));
    const second = make();
    // The same signed message written again: it is dropped, not run, and nothing answers it.
    expect(await upload(second, { ...memo(version), id })).toBeNull();
  });

  it("saves to a private file and reads busy from recent activity", async () => {
    const inbox = make();
    expect(inbox.busy()).toEqual({ busy: false });
    await inbox.publish();
    const version = await versionOf();
    await upload(inbox, talk(version));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(inbox.busy()).toEqual({ busy: true, since: clock });
    clock += 4 * 60_000;
    expect(inbox.busy()).toEqual({ busy: false });
  });
});
