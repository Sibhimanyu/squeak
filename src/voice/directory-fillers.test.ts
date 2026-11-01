import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { FRIENDLY_FILLERS, TERSE_FILLERS, type Fillers } from "./fillers.js";
import { MemoInbox } from "./memo-inbox.js";
import { dirPath, readDirectory, sealDirectory, type DirectoryDoc } from "./memo-protocol.js";

const { channelId: channel, key } = generateChannel();
const clock = 1_800_000_000_000;

describe("the directory carries the waiting lines", () => {
  let db: FakeRtdb;
  let store: RtdbRest;
  let inbox: MemoInbox;
  let fillers: Fillers | null = null;

  beforeEach(async () => {
    db = new FakeRtdb();
    store = new RtdbRest(await db.start());
    fillers = TERSE_FILLERS;
    inbox = new MemoInbox({
      store,
      channel,
      key,
      transcriber: { transcribe: async () => "x" },
      targets: () => [{ target: "c1", label: "squeak voice", workspace: null }],
      canSend: () => true,
      send: async () => ({ status: "started", via: "conductor", delivery: "sent" }) as never,
      caller: () => "35210",
      note: () => undefined,
      now: () => clock,
      fillers: () => fillers,
    });
  });
  afterEach(async () => {
    inbox.stop();
    await db.stop();
  });

  const read = async (): Promise<DirectoryDoc> => readDirectory(key, (await store.get(dirPath(channel)))!, clock)!;

  it("publishes them, and a different set is a different version", async () => {
    await inbox.publish();
    const first = await read();
    expect(first.fillers).toEqual(TERSE_FILLERS);
    fillers = FRIENDLY_FILLERS;
    await inbox.publish();
    const second = await read();
    expect(second.fillers).toEqual(FRIENDLY_FILLERS);
    expect(second.version).not.toBe(first.version);
  });

  it("leaves them out for an add-on that does not say them", async () => {
    fillers = null;
    await inbox.publish();
    expect("fillers" in (await read())).toBe(false);
  });

  it("drops a set that breaks the rules when reading, keeping the list", async () => {
    const doc: DirectoryDoc = {
      v: 1,
      at: clock,
      version: "v",
      caller: null,
      items: [],
      fillers: { wait: ["http://x.test"], still: ["a"] },
    };
    const read = readDirectory(key, sealDirectory(key, doc), clock);
    expect(read).not.toBeNull();
    expect(read && "fillers" in read).toBe(false);
  });
});
