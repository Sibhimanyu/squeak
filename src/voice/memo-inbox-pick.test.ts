import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { MemoInbox, type MemoTarget } from "./memo-inbox.js";
import {
  dirPath,
  downPath,
  newMessageId,
  readDirectory,
  readDown,
  readUp,
  sealDown,
  sealUp,
  upPath,
  type DirectoryDoc,
  type DownMessage,
  type UpMessage,
} from "./memo-protocol.js";

const { channelId: channel, key } = generateChannel();
const clock = 1_800_000_000_000;

const targets: MemoTarget[] = [
  { target: "c1", label: "voice", workspace: "w-squeak" },
  { target: "c2", label: "ui planning", workspace: "w-squeak" },
  { target: "c3", label: "hub", workspace: "w-blume" },
  { target: "c4", label: "telegram bot", workspace: "w-blume" },
];

describe("MemoInbox: a menu answered by voice", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let heard = "squeak";
  let transcribed = 0;
  let pickable = true;
  const sent: string[] = [];

  const make = (): MemoInbox =>
    new MemoInbox({
      store,
      channel,
      key,
      transcriber: {
        transcribe: async () => {
          transcribed += 1;
          return heard;
        },
      },
      targets: () => targets,
      canSend: () => {
        sent.push("canSend");
        return true;
      },
      send: async () => {
        sent.push("send");
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
      caller: () => "35210",
      note: () => sent.push("note"),
      favorites: () => [
        { n: 1, workspace: "w-squeak", label: "squeak" },
        { n: 2, workspace: "w-blume", label: "blume" },
      ],
      now: () => clock,
      pickByVoice: () => pickable,
    });

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    heard = "squeak";
    transcribed = 0;
    pickable = true;
    sent.length = 0;
    inbox = make();
    await inbox.publish();
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  const directory = async (): Promise<DirectoryDoc> => readDirectory(key, (await store.get(dirPath(channel)))!, clock)!;

  async function pick(
    menu: string,
    extra: Partial<Extract<UpMessage, { kind: "pick" }>> = {},
    at = clock,
  ): Promise<{ id: string; down: DownMessage | null }> {
    const id = newMessageId();
    const message = {
      v: 1,
      id,
      at,
      expiresAt: at + 60_000,
      kind: "pick",
      dirVersion: (await directory()).version,
      menu,
      audio: Buffer.from("opus").toString("base64"),
      ...extra,
    } as UpMessage;
    await store.set(upPath(channel, id), sealUp(key, message));
    await inbox.pass();
    const doc = await store.get(downPath(channel, id));
    return { id, down: doc ? readDown(key, id, doc) : null };
  }

  it("says in the directory that menus are answered by voice, only when asked to", async () => {
    expect((await directory()).pickByVoice).toBe(true);
    pickable = false;
    inbox.stop();
    inbox = make();
    await store.delete(dirPath(channel));
    await inbox.publish();
    expect("pickByVoice" in (await directory())).toBe(false);
  });

  it("answers a name with the digit the keypad would have pressed", async () => {
    heard = "the blume one";
    expect((await pick("workspaces")).down).toMatchObject({ status: "pick", choice: 2, heard: "the blume one" });
    heard = "telegram";
    expect((await pick("workspace:2")).down).toMatchObject({ status: "pick", choice: 2 });
    heard = "the second one";
    expect((await pick("workspace:1")).down).toMatchObject({ status: "pick", choice: 2 });
  });

  it("answers the menu's extras", async () => {
    heard = "go back";
    expect((await pick("workspace:1")).down).toMatchObject({ status: "pick", action: "back" });
    heard = "hang up";
    expect((await pick("workspaces")).down).toMatchObject({ status: "pick", action: "hangup" });
    heard = "say that again";
    expect((await pick("workspaces")).down).toMatchObject({ status: "pick", action: "repeat" });
  });

  it("answers with no choice for garbage, a tie, a name from another menu, and a list it no longer holds", async () => {
    heard = "the quick brown fox";
    const garbage = (await pick("workspaces")).down;
    expect(garbage).toMatchObject({ status: "pick", heard: "the quick brown fox" });
    expect(garbage && "choice" in garbage).toBe(false);
    expect(garbage && "action" in garbage).toBe(false);
    heard = "blume";
    const other = (await pick("workspace:1")).down;
    expect(other && "choice" in other).toBe(false);
    heard = "squeak";
    const stale = (await pick("workspaces", { dirVersion: "gone" })).down;
    expect(stale).toMatchObject({ status: "pick", heard: "" });
    expect(stale && "choice" in stale).toBe(false);
    const nothing = (await pick("workspace:9")).down;
    expect(nothing).toMatchObject({ status: "pick", heard: "" });
  });

  it("only ever selects: nothing is sent, checked or announced", async () => {
    heard = "voice";
    await pick("workspace:1");
    heard = "hang up";
    await pick("workspaces");
    expect(sent).toEqual([]);
  });

  it("drops an expired pick without answering, and does not run a replayed one twice", async () => {
    const old = await pick("workspaces", {}, clock - 10 * 60_000);
    expect(old.down).toBeNull();
    expect(transcribed).toBe(0);
    const id = newMessageId();
    const message = {
      v: 1,
      id,
      at: clock,
      expiresAt: clock + 60_000,
      kind: "pick",
      dirVersion: (await directory()).version,
      menu: "workspaces",
      audio: Buffer.from("opus").toString("base64"),
    } as UpMessage;
    await store.set(upPath(channel, id), sealUp(key, message));
    await inbox.pass();
    await store.delete(downPath(channel, id));
    await store.set(upPath(channel, id), sealUp(key, message));
    await inbox.pass();
    expect(transcribed).toBe(1);
    expect(await store.get(downPath(channel, id))).toBeNull();
  });
});

describe("the pick messages", () => {
  const at = clock;
  const base = { v: 1, id: "p1", at, expiresAt: at + 60_000, kind: "pick", dirVersion: "v1", menu: "workspaces" };
  const open = (body: Record<string, unknown>) => readUp(key, "p1", sealUp(key, body as unknown as UpMessage), at);

  it("takes a pick with audio, or the pieces' hashes, for a known menu", () => {
    expect(open({ ...base, audio: "AAAA" })).toMatchObject({ ok: true, message: { kind: "pick", menu: "workspaces" } });
    expect(open({ ...base, menu: "workspace:3", audioParts: ["a".repeat(64)] })).toMatchObject({ ok: true });
    expect(open({ ...base, menu: "chats", audio: "AAAA" })).toMatchObject({ ok: true });
  });

  it("refuses an unknown menu, a missing or doubled recording, and a version it cannot read", () => {
    expect(open({ ...base, menu: "everything", audio: "AAAA" })).toMatchObject({ ok: false });
    expect(open({ ...base, menu: "workspace:0", audio: "AAAA" })).toMatchObject({ ok: false });
    expect(open({ ...base, menu: "workspace:10", audio: "AAAA" })).toMatchObject({ ok: false });
    expect(open({ ...base })).toMatchObject({ ok: false });
    expect(open({ ...base, audio: "AAAA", audioParts: ["a".repeat(64)] })).toMatchObject({ ok: false });
    expect(open({ ...base, dirVersion: "", audio: "AAAA" })).toMatchObject({ ok: false });
    expect(open({ ...base, dirVersion: 7, audio: "AAAA" })).toMatchObject({ ok: false });
  });

  it("refuses a pick that is expired or from the future", () => {
    expect(open({ ...base, expiresAt: at - 1, audio: "AAAA" })).toMatchObject({ ok: false, reason: "expired" });
    expect(open({ ...base, at: at + 60 * 60_000, expiresAt: at + 61 * 60_000, audio: "AAAA" })).toMatchObject({
      ok: false,
    });
  });

  it("is not read under another id or another key", () => {
    const sealed = sealUp(key, { ...base, audio: "AAAA" } as unknown as UpMessage);
    expect(readUp(key, "p2", sealed, at)).toMatchObject({ ok: false });
    expect(readUp(generateChannel().key, "p1", sealed, at)).toMatchObject({ ok: false });
  });
});

describe("what a pick answers", () => {
  const down = (body: Record<string, unknown>) =>
    readDown(
      key,
      "d1",
      sealDown(key, { v: 1, id: "d1", at: clock, status: "pick", heard: "x", ...body } as DownMessage),
    );

  it("round-trips a choice, an action, or neither", () => {
    expect(down({ choice: 3 })).toMatchObject({ status: "pick", choice: 3 });
    expect(down({ action: "other" })).toMatchObject({ status: "pick", action: "other" });
    expect(down({})).toEqual({ v: 1, id: "d1", at: clock, status: "pick", heard: "x" });
  });

  it("refuses a choice out of range, an unknown action, both at once, or no transcript", () => {
    expect(down({ choice: 0 })).toBeNull();
    expect(down({ choice: 10 })).toBeNull();
    expect(down({ choice: 1.5 })).toBeNull();
    expect(down({ action: "send" })).toBeNull();
    expect(down({ choice: 1, action: "new" })).toBeNull();
    expect(down({ heard: undefined })).toBeNull();
  });
});
