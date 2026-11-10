// Two pond identities over the real Catalyst relay (cloud.json), then every document of the test pond deleted.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CatalystStore } from "../src/cloud/catalyst-store.js";
import { readCloudConfig } from "../src/cloud/config.js";
import { FlotillaBridge, type HostPort } from "../src/flotilla/bridge.js";
import { HttpPondRelay } from "../src/flotilla/relay.js";
import { FlotillaService } from "../src/flotilla/service.js";
import type { HostEvent } from "../src/native/host.js";
import type { MessageRow, RequestRow, Resolution, SessionRow } from "../src/native/types.js";

const cfg = readCloudConfig(path.join(os.homedir(), "Library/Application Support/squeak"))!.catalyst!;
const RELAY = `${cfg.appUrl}/server/squeak_relay`;
const KEY = cfg.relayKey!;
const ownerLoc = { provider: "catalyst", relayUrl: RELAY, relayKey: KEY } as never;
const storeFor = (loc: unknown, token?: string | null) => {
  const l = loc as { relayUrl: string; relayKey?: string };
  if (token) return new CatalystStore({ baseUrl: l.relayUrl, pondToken: token });
  if (l.relayKey) return new CatalystStore({ baseUrl: l.relayUrl, relayKey: l.relayKey });
  throw new Error("no access");
};
class Host extends EventEmitter implements HostPort {
  sessions = new Map<string, SessionRow>();
  messages: MessageRow[] = [];
  sent: string[] = [];
  notes: string[] = [];
  onEvent(l: (e: HostEvent) => void) {
    this.on("event", l);
    return () => void this.off("event", l);
  }
  getSession = (id: string) => this.sessions.get(id) ?? null;
  messagesAfter = (id: string, seq: number) => this.messages.filter((m) => m.sessionId === id && m.seq > seq);
  openRequests = (_id: string): RequestRow[] => [];
  async send(_id: string, text: string) {
    this.sent.push(text);
    return { queued: true };
  }
  respond(_r: string, _x: Resolution) {}
  note(_i: string, t: string) {
    this.notes.push(t);
  }
  setGuestTurn() {}
  say(sessionId: string, kind: string, payload: unknown, role: "agent" | "user" = "agent") {
    const seq = this.messages.length + 1,
      createdAt = new Date().toISOString();
    this.messages.push({ seq, sessionId, role, kind, payload, createdAt });
    this.emit("event", { type: "message", sessionId, seq, role, kind, payload, createdAt });
  }
}
const dirs: string[] = [];
const mk = (name: string, owner: boolean) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pond-live-"));
  dirs.push(d);
  const service = new FlotillaService({
    store: owner
      ? storeFor(ownerLoc)
      : ({
          get: async () => null,
          set: async () => undefined,
          list: async () => [],
          delete: async () => undefined,
          watch: () => () => undefined,
        } as never),
    supportDir: d,
    displayName: name,
    nest: `${name}-mac`,
    storeFor,
    ...(owner ? { location: ownerLoc, relay: new HttpPondRelay(RELAY, KEY) } : {}),
  });
  const host = new Host();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
  bridge.start();
  return { service, host, bridge };
};
const ms = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  const r = await f();
  console.log(`ok  ${label} (${Date.now() - t} ms)`);
  return r;
};
const A = mk("Sibhi", true),
  B = mk("Aarav", false);
let pondId = "";
try {
  pondId = (await ms("create pond", () => A.service.createPond({ name: "Live test" }))).id;
  const { code } = await ms("invite", () => A.service.invite(pondId, "member"));
  if (code.includes(KEY)) throw new Error("invite carries the relay key");
  await ms("join (pending)", () => B.service.join(code, "Aarav"));
  const joins = (await A.service.view(pondId)).joins;
  if (joins.length !== 1) throw new Error(`expected 1 join, got ${joins.length}`);
  await ms("approve", () => A.service.decideJoin(pondId, joins[0]!.requestId, { approve: true }));
  await ms("member refresh (pond token)", () => B.service.refresh(pondId));
  const v = await B.service.view(pondId);
  console.log(
    "    flock seen by Aarav:",
    v.members
      .map((m) => m.name)
      .sort()
      .join(", "),
    "· role",
    v.me.role,
  );
  A.host.sessions.set("s1", {
    id: "s1",
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
  });
  A.host.say("s1", "user/text", { text: "Fix the login" }, "user");
  const thread = await ms("share thread", () => A.bridge.share(pondId, "s1"));
  A.host.say("s1", "assistant", { message: { content: [{ type: "text", text: "Looking at it." }] } });
  await A.bridge.flush();
  const ev = await ms("member reads events", () => B.service.readEvents(pondId, thread.id, 0));
  console.log("    events:", ev.events.map((e) => e.type).join(", "));
  await ms("member sends a message", () => B.bridge.message(pondId, thread.id, "Use port 4000"));
  const out = await ms("owner runs it", () => A.bridge.runCommands(pondId));
  console.log("    outcome:", JSON.stringify(out), "· host got:", JSON.stringify(A.host.sent));
  const hold1 = await B.service.hold(pondId, "q1"),
    hold2 = await A.service.hold(pondId, "q1");
  console.log(
    "    hold: Aarav",
    hold1.ok,
    "· Sibhi",
    hold2.ok,
    "held by",
    hold2.heldBy === B.service.me.id ? "Aarav" : hold2.heldBy,
  );
  await ms("remove member (key rotation, token revoked)", () => A.service.removeMember(pondId, B.service.me.id));
  const after = await B.service.view(pondId).then(
    () => "still reads",
    (e: Error) => `refused: ${e.message.slice(0, 60)}`,
  );
  console.log("    removed member:", after);
} catch (e) {
  console.log("FAIL", (e as Error).message);
} finally {
  if (pondId) {
    const s = storeFor(ownerLoc);
    let n = 0;
    for (const kind of [
      "pond",
      "members",
      "joins",
      "threads",
      "tevents",
      "presence",
      "holds",
      "tcmds",
      "ripples",
      "keys",
    ]) {
      for (const { id } of await s.list(`channels/${pondId}/${kind}`).catch(() => [])) {
        await s.delete(`channels/${pondId}/${kind}/${id}`);
        n++;
      }
    }
    console.log(`cleanup: deleted ${n} documents of the test pond`);
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  A.service.stop?.();
  B.service.stop?.();
  process.exit(0);
}
