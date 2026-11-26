import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HostEvent } from "../native/host.js";
import type { TimelineEvent } from "../native/timeline.js";
import { readTimelineEvent } from "../native/timeline.js";
import type { MessageRow, RequestRow, SessionRow } from "../native/types.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { FlotillaBridge, type HostPort } from "./bridge.js";
import { FlotillaService } from "./service.js";
import { readThreadEvent } from "./types.js";
import { named, verifying } from "./named-account.test-fixture.js";

class FakeHost extends EventEmitter implements HostPort {
  sessions = new Map<string, SessionRow>();
  tail: TimelineEvent[] = [];
  onEvent(l: (e: HostEvent) => void) {
    this.on("event", l);
    return () => void this.off("event", l);
  }
  getSession = (id: string) => this.sessions.get(id) ?? null;
  messagesAfter = (): MessageRow[] => [];
  openRequests = (): RequestRow[] => [];
  timelineTail = () => this.tail;
  async send() {
    return { queued: false };
  }
  respond(): void {}
  note(): void {}
  setGuestTurn(): void {}
}

const session = (id: string): SessionRow => ({
  id,
  workspaceId: null,
  cwd: "/w",
  agent: "claude",
  agentSessionId: null,
  title: "Fix login",
  model: "m",
  effort: null,
  permissionMode: "default",
  status: "idle",
  createdAt: "",
  updatedAt: "",
  lastTurnEndedAt: null,
  prunedThrough: 0,
  archivedAt: null,
});

let rtdb: FakeRtdb;
let url: string;
const dirs: string[] = [];
beforeAll(async () => {
  rtdb = new FakeRtdb();
  url = await rtdb.start();
});
afterAll(async () => {
  await rtdb.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function mac(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-tl-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: verifying(new RtdbRest(url)),
    supportDir: dir,
    account: named(name),
    nest: name + "-mac",
    inviteLinkBase: "https://x.test/join",
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
  bridge.start();
  return { service, host, bridge };
}

const at = "2026-11-14T10:00:00.000Z";
const emit = (host: FakeHost, event: unknown) => host.emit("event", { type: "timeline", sessionId: "s1", event });

describe("the timeline across a pond", () => {
  let A: ReturnType<typeof mac>;
  let B: ReturnType<typeof mac>;
  let pondId = "";
  let threadId = "";
  beforeAll(async () => {
    A = mac("Sibhi");
    B = mac("Aarav");
    pondId = (await A.service.createPond({ name: "Site", projectId: "proj-Site" })).id;
    await B.service.join((await A.service.invite(pondId, "member")).code);
    for (const j of (await A.service.view(pondId)).joins)
      await A.service.decideJoin(pondId, j.requestId, { approve: true });
    await B.service.refresh(pondId);
    A.host.sessions.set("s1", session("s1"));
    threadId = (await A.bridge.share(pondId, "s1")).id;
  });

  it("sends the host's ordered events with authors named, no nonce and no live text", async () => {
    emit(A.host, {
      type: "turn.started",
      seq: 1,
      turnId: "t1",
      promptMessageId: "native-1",
      text: "mine",
      clientNonce: "secret-nonce",
      at,
    });
    emit(A.host, { type: "reply.delta", turnId: "t1", blockKey: "m:0", offset: 0, text: "Hel" });
    emit(A.host, {
      type: "step.added",
      seq: 2,
      turnId: "t1",
      stepId: "x",
      kind: "tool",
      label: "Run ls",
      status: "running",
      at,
    });
    emit(A.host, { type: "turn.ended", seq: 3, turnId: "t1", outcome: "done", at });
    emit(A.host, {
      type: "turn.started",
      seq: 4,
      turnId: "t4",
      promptMessageId: "native-4",
      text: "from aarav",
      author: { id: B.service.me.id, name: "Aarav", initial: "A" },
      at,
    });
    await A.bridge.flush();
    const read = await B.service.readEvents(pondId, threadId, 0);
    const timeline = read.events
      .filter((e) => e.type === "timeline")
      .map((e) => (e as unknown as { ev: TimelineEvent }).ev);
    expect(timeline.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(timeline.some((e) => (e.type as string) === "reply.delta")).toBe(false);
    expect(timeline[0]).toMatchObject({
      type: "turn.started",
      author: { id: A.service.me.id, name: "Sibhi", initial: "S" },
    });
    expect(timeline[0]).not.toHaveProperty("clientNonce");
    expect(timeline[3]).toMatchObject({ author: { name: "Aarav" } });
  });

  it("a member that reads the page twice, or after a gap, sees the same events by the host's seq", async () => {
    const first = await B.service.readEvents(pondId, threadId, 0);
    const again = await B.service.readEvents(pondId, threadId, 0);
    expect(again.events).toEqual(first.events);
    const hostSeqs = (r: typeof first) =>
      r.events.filter((e) => e.type === "timeline").map((e) => (e as unknown as { ev: TimelineEvent }).ev.seq);
    const resumed = await B.service.readEvents(pondId, threadId, first.events[1]!.seq);
    expect(hostSeqs(resumed)).toEqual(
      hostSeqs(first).filter((s) => s > (first.events[1] as unknown as { ev: TimelineEvent }).ev.seq),
    );
  });

  it("backfills the newest turns from the host's log when a thread is shared", async () => {
    A.host.sessions.set("s9", session("s9"));
    A.host.tail = [
      { type: "turn.started", seq: 1, turnId: "t1", promptMessageId: "native-1", text: "old", at } as TimelineEvent,
      { type: "turn.ended", seq: 2, turnId: "t1", outcome: "done", at } as TimelineEvent,
    ];
    const t = await A.bridge.share(pondId, "s9");
    const read = await B.service.readEvents(pondId, t.id, 0);
    expect(read.events.filter((e) => e.type === "timeline")).toHaveLength(2);
  });
});

describe("reading a timeline event from a pond", () => {
  it("rebuilds a well-formed event and drops a malformed one", () => {
    expect(readTimelineEvent({ seq: 3, type: "turn.ended", turnId: "t1", outcome: "done", at, extra: "x" })).toEqual({
      seq: 3,
      type: "turn.ended",
      turnId: "t1",
      outcome: "done",
      at,
    });
    expect(readTimelineEvent({ seq: 0, type: "turn.ended", turnId: "t1", outcome: "done", at })).toBeNull();
    expect(
      readTimelineEvent({
        seq: 1,
        type: "step.added",
        turnId: "t1",
        stepId: "s",
        kind: "evil",
        label: "x",
        status: "done",
        at,
      }),
    ).toBeNull();
    expect(readThreadEvent({ seq: 1, at: 1, type: "timeline", ev: { seq: 1, type: "nope", at } })).toBeNull();
    expect(
      readThreadEvent({ seq: 1, at: 1, type: "timeline", ev: { seq: 1, type: "prompt.dequeued", queuedId: "q", at } }),
    ).toMatchObject({ type: "timeline", ev: { type: "prompt.dequeued" } });
  });
});
