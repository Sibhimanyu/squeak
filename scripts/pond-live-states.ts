// Every multiplayer STATE TRANSITION over the real Catalyst relay (cloud.json): what the host-level API returns at each step.
// Writes a transcript table to .context/audit-notes/4-live.md. Run: NODE_USE_ENV_PROXY=1 npx tsx scripts/pond-live-states.ts
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CatalystStore } from "../src/cloud/catalyst-store.js";
import { activeLocation, createCloudStore, readCloudConfig } from "../src/cloud/config.js";
import type { CloudLocation } from "../src/cloud/location.js";
import { FlotillaBridge, type HostPort } from "../src/flotilla/bridge.js";
import { HttpPondRelay } from "../src/flotilla/relay.js";
import { FlotillaService, type PondView } from "../src/flotilla/service.js";
import type { HostEvent } from "../src/native/host.js";
import type { MessageRow, RequestRow, Resolution, SessionRow } from "../src/native/types.js";
// @ts-expect-error plain JS modules of the web app
import { GuestPond } from "../web/js/guest-pond.js";
// @ts-expect-error plain JS
import { readInvite } from "../web/js/guest-invite.js";
// @ts-expect-error plain JS
import { KeyStore } from "../web/js/key-store.js";
// @ts-expect-error plain JS
import { fakeIndexedDB } from "../web/test/helpers.js";

const NOTES = process.env.POND_LIVE_NOTES ?? "/tmp/pond-live-states.md";
const config = readCloudConfig(path.join(os.homedir(), "Library/Application Support/squeak"))!;
const ownerLoc = activeLocation(config, null) as CloudLocation;
if (ownerLoc.provider !== "catalyst") throw new Error("the active location is not Catalyst");
const RELAY = ownerLoc.relayUrl;
const DEAD = "http://127.0.0.1:9/server/squeak_relay";

// ---- recorder
interface Row {
  scenario: string;
  step: string;
  actor: string;
  call: string;
  result: string;
  secs: string;
}
const rows: Row[] = [];
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const rec = async <T>(
  scenario: string,
  step: string,
  actor: string,
  call: string,
  fn: () => Promise<T>,
  fmt: (v: T) => string = (v) => JSON.stringify(v) ?? "undefined",
): Promise<{ ok: boolean; v?: T; err?: string }> => {
  const t = Date.now();
  let result: string;
  let out: { ok: boolean; v?: T; err?: string };
  try {
    const v = await fn();
    result = fmt(v);
    out = { ok: true, v };
  } catch (e) {
    const err = e as Error & { status?: number };
    result = `THROWS${err.status ? ` [${err.status}]` : ""}: ${err.message}`;
    out = { ok: false, err: err.message };
  }
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  rows.push({ scenario, step, actor, call, result, secs });
  console.log(`${scenario} | ${step} | ${actor} | ${call} | ${result.slice(0, 220)} | ${secs}s`);
  fs.writeFileSync("/tmp/pond-live-states.rows.json", JSON.stringify(rows, null, 1));
  return out;
};
const note = (scenario: string, step: string, text: string) => {
  rows.push({ scenario, step, actor: "-", call: "(note)", result: text, secs: "" });
  console.log(`${scenario} | ${step} | NOTE | ${text}`);
};

// ---- formatters (the fields the UIs render from)
const fmtSum = (s: Record<string, unknown> | undefined) =>
  s
    ? Object.entries({
        status: s.status,
        line: s.statusLine ? `"${s.statusLine}"` : undefined,
        role: s.role,
        requestedRole: s.requestedRole,
        members: s.memberCount,
        threads: s.threadCount,
        needsYou: s.needsYou,
        local: s.local,
        offline: s.offline,
        offlineLine: s.offlineLine ? `"${s.offlineLine}"` : undefined,
        asOf: s.asOf ? new Date(s.asOf as number).toISOString().slice(11, 19) : undefined,
      })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "(pond not listed)";
const listFmt = (pondId: string) => (l: Array<Record<string, unknown>>) =>
  `${l.length} ponds listed; this: ${fmtSum(l.find((p) => p.id === pondId))}`;
const fmtView = (v: PondView) =>
  [
    `pond{${fmtSum(v.pond as never)}}`,
    `me=${v.me.name}/${v.me.role}`,
    `members=[${v.members.map((m) => `${m.name}/${m.role}${m.you ? "*" : ""}`).join(",")}]`,
    `joins=[${v.joins.map((j) => `${j.name}/${j.role}/${j.client ?? "mac"}${j.decision ? `/decision:${JSON.stringify(j.decision)}` : ""}${j.verifiedEmail ? "/vEmail" : ""}`).join(",")}]`,
    v.invites ? `invites=[${v.invites.map((i) => `${i.role}:${i.state}`).join(",")}]` : "",
    `threads=[${v.threads.map((t) => `${t.title}:${t.state}`).join(",")}]`,
    `ripples=[${v.ripples.map((r) => `${r.actorName ?? "?"} ${r.text}`).join(" ; ")}]`,
    `holds=[${v.holds.map((h) => `${h.requestId}:${h.heldByName ?? h.byName}`).join(",")}]`,
    v.offline ? `OFFLINE asOf=${v.asOf ? new Date(v.asOf).toISOString().slice(11, 19) : "?"}` : "",
  ]
    .filter(Boolean)
    .join(" ");
const guestFmtView = (v: {
  pond: { name: string };
  me: { name: string; role: string };
  members: Array<{ name: string; role: string }>;
  threads: Array<{ title?: string; state?: string }>;
  holds: Array<{ requestId: string; byName: string }>;
}) =>
  `pond=${v.pond.name} me=${v.me.name}/${v.me.role} members=[${v.members.map((m) => `${m.name}/${m.role}`).join(",")}] threads=[${v.threads.map((t) => `${t.title}:${t.state}`).join(",")}] holds=[${v.holds.map((h) => `${h.requestId}:${h.byName}`).join(",")}]`;

// ---- identities
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
interface Id {
  service: FlotillaService;
  host: Host;
  bridge: FlotillaBridge;
  clk: { off: number };
  sw: { down: boolean };
}
const mk = (name: string, owner: boolean): Id => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pond-states-"));
  dirs.push(d);
  const clk = { off: 0 };
  const sw = { down: false };
  const storeFor = (loc: unknown, token?: string | null) => {
    const real = token
      ? new CatalystStore({ baseUrl: (loc as { relayUrl: string }).relayUrl, pondToken: token })
      : createCloudStore(loc as CloudLocation);
    const dead = new CatalystStore({ baseUrl: DEAD, pondToken: token ?? "x" });
    return new Proxy(real, {
      get: (_t, prop) => {
        const target = (sw.down ? dead : real) as unknown as Record<string | symbol, unknown>;
        const v = target[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
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
    now: () => Date.now() + clk.off,
    ...(owner
      ? { location: ownerLoc, relay: new HttpPondRelay(RELAY, ownerLoc.relayKey, undefined, ownerLoc.hosted === true) }
      : {}),
  });
  const host = new Host();
  const bridge = new FlotillaBridge(service, host, { flushMs: 600_000 });
  bridge.start();
  return { service, host, bridge, clk, sw };
};
const session = (id: string, title: string, mode: string): SessionRow =>
  ({
    id,
    workspaceId: null,
    cwd: "/w",
    agent: "claude",
    agentSessionId: null,
    title,
    model: "m",
    effort: null,
    permissionMode: mode,
    status: "idle",
    createdAt: "",
    updatedAt: "",
    lastTurnEndedAt: null,
    prunedThrough: 0,
  }) as unknown as SessionRow;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PONDS_FILE = "/tmp/pond-live-ponds.json";
const ponds: string[] = [];
const keepPond = (id: string) => {
  ponds.push(id);
  fs.writeFileSync(PONDS_FILE, JSON.stringify(ponds));
};
const all: Id[] = [];
const newId = (name: string, owner = false) => {
  const i = mk(name, owner);
  all.push(i);
  return i;
};

const A = newId("Owner", true);

// joiner helper: invite -> join, with the joiner's own sight recorded
const sightOf = async (sc: string, step: string, who: string, J: Id, pondId: string) => {
  await rec(sc, step, who, "list()", () => J.service.list(), listFmt(pondId) as never);
  await rec(sc, step, who, "view()", () => J.service.view(pondId), fmtView);
};

async function main() {
  // ================= Pond 1: Mac joiners
  const P = (await A.service.createPond({ name: "States test 1" })).id;
  keepPond(P);
  const B = newId("Aarav"),
    C = newId("Chitra"),
    V = newId("Veena");

  // ---------- 1: Mac joiner
  let s = "1 join+approve";
  const inv1 = (
    await rec(
      s,
      "invite member",
      "Owner",
      "invite(P,'member')",
      () => A.service.invite(P, "member"),
      (x) => `code(${x.code.length} chars) id=${x.id} expiresAt=+${Math.round((x.expiresAt - Date.now()) / 3600000)}h`,
    )
  ).v!;
  await rec(s, "join", "Aarav", "join(code,'Aarav')", () => B.service.join(inv1.code, "Aarav"));
  await sightOf(s, "pending joiner sees", "Aarav", B, P);
  const ov = await rec(s, "owner sees request", "Owner", "view(P)", () => A.service.view(P), fmtView);
  const reqId = ov.v!.joins[0]?.requestId ?? "";
  await rec(s, "joiner refresh while pending", "Aarav", "refresh(P)", () => B.service.refresh(P).then(() => "ok"));
  await rec(s, "joiner list after refresh", "Aarav", "list()", () => B.service.list(), listFmt(P) as never);
  await rec(
    s,
    "owner invites view",
    "Owner",
    "view(P).invites",
    async () => (await A.service.view(P)).invites,
    (x) => JSON.stringify(x),
  );
  // decision outcome during approval
  const t0 = Date.now();
  A.service.startJoinDecision(P, reqId, { approve: true });
  await rec(
    s,
    "owner view during approval",
    "Owner",
    "view(P) right after startJoinDecision",
    () => A.service.view(P),
    fmtView,
  );
  for (let i = 0; i < 30; i++) {
    const v = await A.service.view(P);
    const j = v.joins.find((x) => x.requestId === reqId);
    if (!j) break;
    rows.push({
      scenario: s,
      step: "poll during approval",
      actor: "Owner",
      call: "view(P).joins",
      result: JSON.stringify(j.decision ?? null),
      secs: ((Date.now() - t0) / 1000).toFixed(1),
    });
    await sleep(1500);
  }
  note(
    s,
    "approval total",
    `startJoinDecision -> request gone from joins after ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  await rec(s, "owner view after approval", "Owner", "view(P)", () => A.service.view(P), fmtView);
  await rec(s, "joiner list before its refresh", "Aarav", "list()", () => B.service.list(), listFmt(P) as never);
  await rec(s, "joiner refresh", "Aarav", "refresh(P)", () => B.service.refresh(P).then(() => "ok"));
  await sightOf(s, "active joiner sees", "Aarav", B, P);

  // second member Chitra, viewer Veena (for 7)
  const inv2 = (await A.service.invite(P, "member")).code;
  await C.service.join(inv2, "Chitra");
  let rj = (await A.service.view(P)).joins.find((j) => j.name === "Chitra");
  await A.service.decideJoin(P, rj!.requestId, { approve: true });
  await C.service.refresh(P);
  const inv3 = (await A.service.invite(P, "viewer")).code;
  await V.service.join(inv3, "Veena");
  rj = (await A.service.view(P)).joins.find((j) => j.name === "Veena");
  await A.service.decideJoin(P, rj!.requestId, { approve: true });
  await V.service.refresh(P);
  note(s, "setup", "Chitra (member) and Veena (viewer) joined and approved for scenario 7");

  // ---------- 7: shared threads
  s = "7 shared thread";
  A.host.sessions.set("s1", session("s1", "Fix login", "default"));
  A.host.sessions.set("s2", session("s2", "Bypass chat", "bypassPermissions"));
  A.host.say("s1", "user/text", { text: "Fix the login" }, "user");
  A.host.say("s2", "user/text", { text: "Do it all" }, "user");
  const th1 = (
    await rec(
      s,
      "owner shares thread",
      "Owner",
      "bridge.share(P,s1)",
      () => A.bridge.share(P, "s1"),
      (t) => `id=${t.id} state=${t.state}`,
    )
  ).v!;
  const th2 = (
    await rec(
      s,
      "owner shares bypass thread",
      "Owner",
      "bridge.share(P,s2)",
      () => A.bridge.share(P, "s2"),
      (t) => `id=${t.id}`,
    )
  ).v!;
  A.host.say("s1", "assistant", { message: { content: [{ type: "text", text: "Looking at it." }] } });
  await rec(s, "flush", "Owner", "bridge.flush()", () => A.bridge.flush().then(() => "ok"));
  await rec(s, "member view lists thread", "Aarav", "view(P)", () => B.service.view(P), fmtView);
  await rec(
    s,
    "member reads events",
    "Aarav",
    "readEvents(P,thread,0)",
    () => B.service.readEvents(P, th1.id, 0),
    (e) => e.events.map((x) => x.type).join(","),
  );
  await rec(s, "member message", "Aarav", "bridge.message(P,t,'Use port 4000')", () =>
    B.bridge.message(P, th1.id, "Use port 4000"),
  );
  await rec(
    s,
    "owner runs commands",
    "Owner",
    "bridge.runCommands(P)",
    () => A.bridge.runCommands(P),
    (o) => `${JSON.stringify(o)} hostGot=${JSON.stringify(A.host.sent)}`,
  );
  await rec(s, "viewer message", "Veena", "bridge.message(P,t,'hi')", () => V.bridge.message(P, th1.id, "hi"));
  await rec(s, "viewer steer", "Veena", "service.sendCommand(steer)", () =>
    V.service.sendCommand(P, th1.id, { kind: "steer", text: "x" }),
  );
  await rec(s, "viewer hold", "Veena", "hold(P,q1)", () => V.service.hold(P, "q1"));
  await rec(s, "viewer answer", "Veena", "bridge.answer(P,t,q1,'yes')", () => V.bridge.answer(P, th1.id, "q1", "yes"));
  await rec(s, "message unknown thread", "Aarav", "bridge.message(P,'nope','x')", () =>
    B.bridge.message(P, "nope", "x"),
  );
  await rec(s, "owner message own thread via member path", "Owner", "service.sendCommand(own thread)", () =>
    A.service.sendCommand(P, th1.id, { kind: "message", text: "x" }),
  );
  await rec(s, "member message bypass thread", "Aarav", "bridge.message(P,bypass,'x')", () =>
    B.bridge.message(P, th2.id, "do x"),
  );
  await rec(
    s,
    "owner runs commands (bypass)",
    "Owner",
    "bridge.runCommands(P)",
    () => A.bridge.runCommands(P),
    (o) => JSON.stringify(o),
  );
  await rec(s, "Aarav holds q1", "Aarav", "hold(P,q1)", () => B.service.hold(P, "q1"));
  await rec(s, "Chitra holds q1 (collision)", "Chitra", "hold(P,q1)", () => C.service.hold(P, "q1"));
  await rec(s, "Chitra answers q1 (collision)", "Chitra", "bridge.answer(P,t,q1,'no')", () =>
    C.bridge.answer(P, th1.id, "q1", "no"),
  );
  await rec(s, "owner answers q1 (collision)", "Owner", "bridge.answer(P,t,q1,'no')", () =>
    A.bridge.answer(P, th1.id, "q1", "no"),
  );
  await rec(s, "Aarav answers (holder)", "Aarav", "bridge.answer(P,t,q1,'yes')", () =>
    B.bridge.answer(P, th1.id, "q1", "yes"),
  );
  await rec(
    s,
    "owner runs commands (answer, no open request)",
    "Owner",
    "bridge.runCommands(P)",
    () => A.bridge.runCommands(P),
    (o) => JSON.stringify(o),
  );
  await rec(
    s,
    "everyone sees hold",
    "Chitra",
    "view(P).holds",
    async () => (await C.service.view(P)).holds,
    (h) => JSON.stringify(h.map((x) => `${x.requestId}:${x.byName}`)),
  );
  await rec(s, "owner view ripples", "Owner", "view(P)", () => A.service.view(P), fmtView);

  // ---------- 8: relay failure (before removals; Aarav/Veena/Owner)
  s = "8 relay failure";
  await rec(s, "baseline", "Veena", "list()", () => V.service.list(), listFmt(P) as never);
  await rec(s, "baseline view", "Aarav", "view(P)", () => B.service.view(P), fmtView);
  await rec(s, "baseline view", "Owner", "view(P)", () => A.service.view(P), fmtView);
  for (const i of [A, B, V]) i.sw.down = true;
  note(s, "relay", `Owner, Aarav and Veena now point at ${DEAD} (connection refused)`);
  await rec(s, "list (Veena, list-only cache)", "Veena", "list()", () => V.service.list(), listFmt(P) as never);
  await rec(s, "view (Veena, never viewed -> no snapshot view)", "Veena", "view(P)", () => V.service.view(P), fmtView);
  await rec(s, "list", "Aarav", "list()", () => B.service.list(), listFmt(P) as never);
  await rec(s, "view", "Aarav", "view(P)", () => B.service.view(P), fmtView);
  await rec(s, "list", "Owner", "list()", () => A.service.list(), listFmt(P) as never);
  await rec(s, "view", "Owner", "view(P)", () => A.service.view(P), fmtView);
  await rec(s, "write: message", "Aarav", "bridge.message(P,t,'x')", () => B.bridge.message(P, th1.id, "x"));
  await rec(s, "write: hold", "Aarav", "hold(P,q2)", () => B.service.hold(P, "q2"));
  await rec(s, "write: ripple", "Aarav", "ripple(P,'x')", () => B.service.ripple(P, "x"));
  await rec(s, "write: setPresence", "Aarav", "setPresence(P,{online})", () =>
    B.service.setPresence(P, { online: true }).then(() => "ok"),
  );
  await rec(s, "write: refresh", "Aarav", "refresh(P)", () => B.service.refresh(P).then(() => "ok"));
  await rec(s, "write: ripple", "Owner", "ripple(P,'x')", () => A.service.ripple(P, "x"));
  await rec(
    s,
    "write: invite (relay.issue still up)",
    "Owner",
    "invite(P,'member')",
    () => A.service.invite(P, "member"),
    (x) => `ok id=${x.id}`,
  );
  await rec(s, "write: remove member", "Owner", "removeMember(P,Veena)", () =>
    A.service.removeMember(P, V.service.me.id),
  );
  await rec(s, "write: decideJoin", "Owner", "decideJoin(P,nonexistent)", () =>
    A.service.decideJoin(P, "zzz", { approve: true }),
  );
  for (const i of [A, B, V]) i.sw.down = false;
  note(s, "relay", "relay reachable again");
  await rec(
    s,
    "recovered, owner write BEFORE any owner list/view (stale unreachable flag?)",
    "Owner",
    "removeMember(P,'none')",
    () => A.service.removeMember(P, "none"),
  );
  await rec(s, "recovered: owner list() clears it", "Owner", "list()", () => A.service.list(), listFmt(P) as never);
  await rec(s, "recovered list", "Aarav", "list()", () => B.service.list(), listFmt(P) as never);
  await rec(s, "recovered view", "Aarav", "view(P)", () => B.service.view(P), fmtView);
  await rec(s, "recovered write: ripple", "Aarav", "ripple(P,'back')", () =>
    B.service.ripple(P, "back").then(() => "ok"),
  );

  // ---------- 5: removed after joining
  s = "5 removed member";
  await rec(s, "owner removes Aarav", "Owner", "removeMember(P,Aarav)", () =>
    A.service.removeMember(P, B.service.me.id).then(() => "ok"),
  );
  await rec(s, "owner view", "Owner", "view(P)", () => A.service.view(P), fmtView);
  await rec(s, "DEBUG owner raw liveView error (private)", "Owner", "liveView(pond)", async () => {
    const sv = A.service as never as { liveView(p: unknown): Promise<unknown>; pond(id: string): unknown };
    return await sv.liveView(sv.pond(P)).then(() => "no error");
  });
  await rec(s, "removed member list (before refresh)", "Aarav", "list()", () => B.service.list(), listFmt(P) as never);
  await rec(s, "removed member view (before refresh)", "Aarav", "view(P)", () => B.service.view(P), fmtView);
  await rec(s, "removed member refresh", "Aarav", "refresh(P)", () => B.service.refresh(P).then(() => "ok"));
  await rec(s, "removed member list (after refresh)", "Aarav", "list()", () => B.service.list(), listFmt(P) as never);
  await rec(s, "removed member view (after refresh)", "Aarav", "view(P)", () => B.service.view(P), fmtView);
  await rec(s, "removed member message", "Aarav", "bridge.message", () => B.bridge.message(P, th1.id, "still here?"));
  await rec(s, "removed member hold", "Aarav", "hold(P,q9)", () => B.service.hold(P, "q9"));
  await rec(s, "remaining member sees", "Chitra", "view(P)", () => C.service.view(P), fmtView);
  await rec(
    s,
    "NOT removed; pond key rotated, no refresh yet: list",
    "Veena",
    "list()",
    () => V.service.list(),
    listFmt(P) as never,
  );

  await rec(
    s,
    "WORKAROUND: owner deletes removed member's leftover holds q1,q9",
    "Owner",
    "releaseHold x2",
    async () => {
      await A.service.releaseHold(P, "q1");
      await A.service.releaseHold(P, "q9");
      return "ok";
    },
  );
  await rec(s, "owner view after deleting leftover holds", "Owner", "view(P)", () => A.service.view(P), fmtView);
  await rec(s, "Chitra refresh (picks up rotated key)", "Chitra", "refresh(P)", () =>
    C.service.refresh(P).then(() => "ok"),
  );
  await rec(s, "Chitra view after refresh", "Chitra", "view(P)", () => C.service.view(P), fmtView);

  // ---------- 2: decline
  s = "2 decline";
  const D1 = newId("Dev");
  const inv4 = (await A.service.invite(P, "member")).code;
  await rec(s, "join", "Dev", "join(code,'Dev')", () => D1.service.join(inv4, "Dev"));
  const dj = (await A.service.view(P)).joins.find((j) => j.name === "Dev")!;
  await rec(s, "bogus request id", "Owner", "decideJoin(P,'nope',{approve:false})", () =>
    A.service.decideJoin(P, "nope", { approve: false }),
  );
  await rec(s, "decline", "Owner", "decideJoin(P,req,{approve:false})", () =>
    A.service.decideJoin(P, dj.requestId, { approve: false }).then(() => "ok"),
  );
  await rec(s, "owner view", "Owner", "view(P)", () => A.service.view(P), fmtView);
  await rec(s, "joiner list before refresh", "Dev", "list()", () => D1.service.list(), listFmt(P) as never);
  await rec(s, "joiner refresh", "Dev", "refresh(P)", () => D1.service.refresh(P).then(() => "ok"));
  await rec(s, "joiner list after refresh", "Dev", "list()", () => D1.service.list(), listFmt(P) as never);
  await rec(s, "joiner view", "Dev", "view(P)", () => D1.service.view(P), fmtView);
  await rec(s, "joiner re-join with the same (declined) invite", "Dev", "join(code)", () =>
    D1.service.join(inv4, "Dev"),
  );
  await rec(s, "owner view after rejoin attempt", "Owner", "view(P)", () => A.service.view(P), fmtView);
  await rec(s, "dismiss declined", "Dev", "cancelJoin(P)", () => D1.service.cancelJoin(P).then(() => "ok"));
  await rec(s, "joiner list after dismiss", "Dev", "list()", () => D1.service.list(), listFmt(P) as never);

  // ---------- 3: expired / revoked
  s = "3 expired+revoked";
  const E = newId("Eli"),
    F = newId("Farah"),
    G = newId("Gita"),
    H = newId("Hari");
  // expired: joiner clock +25h
  const invE = (await A.service.invite(P, "member")).code;
  G.clk.off = 25 * 3600_000;
  await rec(s, "join with expired invite (joiner clock +25h)", "Gita", "join(code)", () =>
    G.service.join(invE, "Gita"),
  );
  await rec(s, "list after", "Gita", "list()", () => G.service.list(), listFmt(P) as never);
  G.clk.off = 0;
  // pending join whose invite expires (owner clock +25h)
  await rec(s, "join before expiry", "Hari", "join(code)", () => H.service.join(invE, "Hari"));
  A.clk.off = 25 * 3600_000;
  await rec(
    s,
    "owner view after invite lapses (owner clock +25h)",
    "Owner",
    "view(P)",
    () => A.service.view(P),
    fmtView,
  );
  const hj = await (async () => (await A.service.view(P)).joins.find((j) => j.name === "Hari"))();
  await rec(s, "owner approves lapsed-invite request", "Owner", "decideJoin(P,req,{approve:true})", () =>
    A.service.decideJoin(P, hj?.requestId ?? "none", { approve: true }).then(() => "ok"),
  );
  A.clk.off = 0;
  await rec(s, "owner view clock back", "Owner", "view(P)", () => A.service.view(P), fmtView);
  await rec(s, "joiner refresh (request still in store)", "Hari", "refresh(P)", () =>
    H.service.refresh(P).then(() => "ok"),
  );
  await rec(s, "joiner list", "Hari", "list()", () => H.service.list(), listFmt(P) as never);
  // revoked before use
  const invR = (await A.service.invite(P, "member")).id;
  const invRfull = (await A.service.view(P)).invites!.find((i) => i.id === invR);
  void invRfull;
  const invRcode = await A.service.invite(P, "member");
  await rec(s, "owner revokes unused invite", "Owner", "revokeInvite(P,id)", () =>
    A.service.revokeInvite(P, invRcode.id),
  );
  await rec(s, "owner revokes again", "Owner", "revokeInvite(P,id)", () => A.service.revokeInvite(P, invRcode.id));
  await rec(s, "joiner joins with revoked invite", "Eli", "join(code)", () => E.service.join(invRcode.code, "Eli"));
  await rec(s, "joiner list after", "Eli", "list()", () => E.service.list(), listFmt(P) as never);
  await rec(s, "joiner view after", "Eli", "view(P)", () => E.service.view(P), fmtView);
  await rec(s, "joiner refresh after", "Eli", "refresh(P)", () => E.service.refresh(P).then(() => "ok"));
  await rec(s, "joiner list after refresh", "Eli", "list()", () => E.service.list(), listFmt(P) as never);
  // revoked after the request is pending
  const invF = await A.service.invite(P, "member");
  await rec(s, "join before revoke", "Farah", "join(code)", () => F.service.join(invF.code, "Farah"));
  await rec(s, "owner revokes invite with request waiting", "Owner", "revokeInvite(P,id)", () =>
    A.service.revokeInvite(P, invF.id),
  );
  await rec(s, "owner view", "Owner", "view(P)", () => A.service.view(P), fmtView);
  await rec(s, "joiner list before refresh", "Farah", "list()", () => F.service.list(), listFmt(P) as never);
  await rec(s, "joiner refresh", "Farah", "refresh(P)", () => F.service.refresh(P).then(() => "ok"));
  await rec(s, "joiner list after refresh", "Farah", "list()", () => F.service.list(), listFmt(P) as never);
  await rec(s, "joiner view", "Farah", "view(P)", () => F.service.view(P), fmtView);
  // revoke an accepted invite
  await rec(s, "revoke an accepted invite", "Owner", "revokeInvite(P, inv1.id)", () =>
    A.service.revokeInvite(P, inv1.id),
  );
  await rec(
    s,
    "owner invites list",
    "Owner",
    "view(P).invites",
    async () => (await A.service.view(P)).invites,
    (x) => JSON.stringify(x?.map((i) => `${i.role}:${i.state}`)),
  );

  // ---------- 4: cancel join
  s = "4 cancel join";
  const K = newId("Kiran");
  const invK = await A.service.invite(P, "member");
  await rec(s, "join", "Kiran", "join(code)", () => K.service.join(invK.code, "Kiran"));
  await rec(
    s,
    "owner sees pending",
    "Owner",
    "view(P).joins",
    async () => (await A.service.view(P)).joins.map((j) => j.name),
    (x) => JSON.stringify(x),
  );
  await rec(s, "cancel", "Kiran", "cancelJoin(P)", () => K.service.cancelJoin(P).then(() => "ok"));
  await rec(s, "joiner list", "Kiran", "list()", () => K.service.list(), listFmt(P) as never);
  await rec(s, "joiner view", "Kiran", "view(P)", () => K.service.view(P), fmtView);
  await rec(s, "cancel again", "Kiran", "cancelJoin(P)", () => K.service.cancelJoin(P));
  await rec(
    s,
    "owner view after cancel",
    "Owner",
    "view(P).joins",
    async () => (await A.service.view(P)).joins.map((j) => j.name),
    (x) => JSON.stringify(x),
  );
  await rec(s, "owner approve cancelled request", "Owner", "decideJoin(P,gone)", () =>
    A.service.decideJoin(P, "gone", { approve: true }),
  );
  await rec(s, "re-join after cancel with same invite", "Kiran", "join(code)", () =>
    K.service.join(invK.code, "Kiran"),
  );
  await rec(
    s,
    "owner sees pending again",
    "Owner",
    "view(P).joins",
    async () => (await A.service.view(P)).joins.map((j) => j.name),
    (x) => JSON.stringify(x),
  );
  await rec(s, "cancel an ACTIVE pond", "Chitra", "cancelJoin(P)", () => C.service.cancelJoin(P));
  await rec(s, "cancel unknown pond", "Kiran", "cancelJoin('zzz')", () => K.service.cancelJoin("zzz"));
  await K.service.cancelJoin(P).catch(() => undefined);

  // ================= 6: web guest (pond 2)
  s = "6 web guest";
  const P2 = (await A.service.createPond({ name: "States test 2" })).id;
  keepPond(P2);
  A.host.sessions.set("s3", session("s3", "Web thread", "default"));
  A.host.say("s3", "user/text", { text: "hello" }, "user");
  const wth = await A.bridge.share(P2, "s3");
  const guestFetch = async (raw: string, init: RequestInit = {}) =>
    fetch(new URL(raw, new URL(RELAY).origin).href, init);
  const parse = async (role: "member" | "viewer") => {
    const inv = await A.service.invite(P2, role);
    const p = readInvite(inv.link ?? inv.code, Date.now(), new URL(RELAY).origin);
    if (!p.ok) throw new Error(`guest cannot read invite: ${p.reason}`);
    return { inv, invite: p.invite };
  };
  const mkVault = () => new KeyStore(fakeIndexedDB());

  const m1 = await parse("member");
  const vault1 = mkVault();
  const g1 = (
    await rec(
      s,
      "guest join (member invite)",
      "WebGuest",
      "GuestPond.join",
      () => GuestPond.join(m1.invite, "Webby", { vault: vault1, fetch: guestFetch }),
      (g: { status: string }) => `status=${g.status}`,
    )
  ).v!;
  {
    const mp = await parse("member");
    const gp = await GuestPond.join(mp.invite, "Early", { vault: mkVault(), fetch: guestFetch });
    await rec(
      s,
      "guest view while pending (separate guest)",
      "WebGuestP",
      "guest.view()",
      () => gp.view(),
      guestFmtView,
    );
    await rec(s, "same guest refresh afterwards", "WebGuestP", "guest.refresh()", () => gp.refresh());
    const ej = (await A.service.view(P2)).joins.find((j) => j.name === "Early");
    await rec(s, "owner approves it after the early view()", "Owner", "decideJoin", () =>
      A.service.decideJoin(P2, ej?.requestId ?? "none", { approve: true }).then(() => "ok"),
    );
    await rec(s, "same guest refresh after approval", "WebGuestP", "guest.refresh()", () => gp.refresh());
  }
  await rec(s, "guest refresh while pending", "WebGuest", "guest.refresh()", () => g1.refresh());
  await rec(s, "owner sees request", "Owner", "view(P2)", () => A.service.view(P2), fmtView);
  const wj = (await A.service.view(P2)).joins.find((j) => j.name === "Webby");
  // reopen with the same vault while pending
  await rec(
    s,
    "reopen: join again, same vault+invite (pending)",
    "WebGuest",
    "GuestPond.join",
    () => GuestPond.join(m1.invite, "Webby", { vault: vault1, fetch: guestFetch }),
    (g: { status: string; record: { requestId: string } }) =>
      `status=${g.status} requestId same=${g.record.requestId === wj?.requestId}`,
  );
  await rec(
    s,
    "reopen: owner joins (duplicate?)",
    "Owner",
    "view(P2).joins",
    async () => (await A.service.view(P2)).joins.map((j) => j.requestId),
    (x) => `${x.length} request(s) ${JSON.stringify(x)}`,
  );
  await rec(
    s,
    "reopen: GuestPond.load",
    "WebGuest",
    "GuestPond.load({vault})",
    async () => GuestPond.load({ vault: vault1, fetch: guestFetch }),
    (g: { status: string } | null) => (g ? `status=${g.status}` : "null"),
  );
  await rec(s, "owner approves", "Owner", "decideJoin", () =>
    A.service.decideJoin(P2, wj!.requestId, { approve: true }).then(() => "ok"),
  );
  await rec(s, "guest refresh", "WebGuest", "guest.refresh()", () => g1.refresh());
  await rec(s, "guest view", "WebGuest", "guest.view()", () => g1.view(), guestFmtView);
  await rec(
    s,
    "guest sendCommand",
    "WebGuest",
    "guest.sendCommand(message)",
    () => g1.sendCommand(wth.id, { kind: "message", text: "from web" }),
    (id: string) => `id=${id}`,
  );
  await rec(s, "guest sendCommand: approve kind", "WebGuest", "guest.sendCommand(diff)", () =>
    g1.sendCommand(wth.id, { kind: "diff" }),
  );
  await rec(s, "guest sendCommand: unknown thread", "WebGuest", "guest.sendCommand", () =>
    g1.sendCommand("nope", { kind: "message", text: "x" }),
  );
  await rec(
    s,
    "owner runs commands",
    "Owner",
    "bridge.runCommands(P2)",
    () => A.bridge.runCommands(P2),
    (o) => JSON.stringify(o),
  );
  await rec(s, "guest hold", "WebGuest", "guest.hold(q1)", () => g1.hold("q1"));
  await rec(s, "owner hold (collision)", "Owner", "hold(P2,q1)", () => A.service.hold(P2, "q1"));
  await rec(s, "owner view with guest", "Owner", "view(P2)", () => A.service.view(P2), fmtView);
  // reopen after active
  await rec(
    s,
    "reopen: join again with used invite + same vault (active guest)",
    "WebGuest",
    "GuestPond.join",
    () => GuestPond.join(m1.invite, "Webby", { vault: vault1, fetch: guestFetch }),
    (g: { status: string }) => `status=${g.status}`,
  );
  await rec(s, "reopen after active: owner joins", "Owner", "view(P2)", () => A.service.view(P2), fmtView);
  await rec(
    s,
    "reopen after active: GuestPond.load",
    "WebGuest",
    "GuestPond.load",
    async () => GuestPond.load({ vault: vault1, fetch: guestFetch }),
    (g: { status: string } | null) => (g ? `status=${g.status}` : "null"),
  );
  // removed
  const wMember = (await A.service.view(P2)).members.find((m) => m.name === "Webby");
  await rec(s, "owner removes guest", "Owner", "removeMember(P2,guest)", () =>
    A.service.removeMember(P2, wMember?.id ?? "none").then(() => "ok"),
  );
  await rec(s, "guest view after removal", "WebGuest", "guest.view()", () => g1.view(), guestFmtView);
  await rec(s, "guest refresh after removal", "WebGuest", "guest.refresh()", () => g1.refresh());
  await rec(s, "guest sendCommand after removal", "WebGuest", "guest.sendCommand", () =>
    g1.sendCommand(wth.id, { kind: "message", text: "x" }),
  );
  await rec(s, "guest refresh again (terminal?)", "WebGuest", "guest.refresh()", () => g1.refresh());
  await rec(s, "WORKAROUND: owner deletes removed guest's leftover hold q1", "Owner", "releaseHold(P2,q1)", () =>
    A.service.releaseHold(P2, "q1").then(() => "ok"),
  );
  await rec(s, "owner view after deleting it", "Owner", "view(P2)", () => A.service.view(P2), fmtView);
  // declined
  const m2 = await parse("viewer");
  const vault2 = mkVault();
  const g2 = (
    await rec(
      s,
      "guest join (viewer invite)",
      "WebGuest2",
      "GuestPond.join",
      () => GuestPond.join(m2.invite, "Vie", { vault: vault2, fetch: guestFetch }),
      (g: { status: string }) => `status=${g.status}`,
    )
  ).v!;
  await rec(s, "owner view with Vie's request", "Owner", "view(P2)", () => A.service.view(P2), fmtView);
  const vj = (await A.service.view(P2)).joins.find((j) => j.name === "Vie");
  await rec(s, "owner declines", "Owner", "decideJoin(approve:false)", () =>
    A.service.decideJoin(P2, vj!.requestId, { approve: false }).then(() => "ok"),
  );
  await rec(s, "guest refresh", "WebGuest2", "guest.refresh()", () => g2.refresh());
  await rec(s, "guest view after decline", "WebGuest2", "guest.view()", () => g2.view(), guestFmtView);
  await rec(
    s,
    "reopen after decline: join same invite+vault",
    "WebGuest2",
    "GuestPond.join",
    () => GuestPond.join(m2.invite, "Vie", { vault: vault2, fetch: guestFetch }),
    (g: { status: string }) => `status=${g.status}`,
  );
  await rec(
    s,
    "reopen after decline: owner joins",
    "Owner",
    "view(P2).joins",
    async () => (await A.service.view(P2)).joins.map((j) => j.name),
    (x) => JSON.stringify(x),
  );
  // viewer guest approved
  const m3 = await parse("viewer");
  const vault3 = mkVault();
  const g3 = await GuestPond.join(m3.invite, "Viewy", { vault: vault3, fetch: guestFetch });
  const v3j = (await A.service.view(P2)).joins.find((j) => j.name === "Viewy");
  await A.service.decideJoin(P2, v3j!.requestId, { approve: true });
  await rec(s, "viewer guest refresh", "WebGuest3", "guest.refresh()", () => g3.refresh());
  await rec(s, "viewer guest sendCommand", "WebGuest3", "guest.sendCommand", () =>
    g3.sendCommand(wth.id, { kind: "message", text: "x" }),
  );
  await rec(s, "viewer guest hold", "WebGuest3", "guest.hold(q5)", () => g3.hold("q5"));
  // revoked invite
  const m4 = await parse("member");
  await A.service.revokeInvite(P2, m4.inv.id);
  await rec(
    s,
    "guest join with revoked invite",
    "WebGuest4",
    "GuestPond.join",
    () => GuestPond.join(m4.invite, "Rev", { vault: mkVault(), fetch: guestFetch }),
    (g: { status: string }) => `status=${g.status}`,
  );
  // expired (guest clock)
  const m5 = await parse("member");
  const parsedLate = readInvite(m5.inv.link ?? m5.inv.code, Date.now() + 25 * 3600_000, new URL(RELAY).origin);
  await rec(
    s,
    "readInvite 25h later (expired)",
    "WebGuest5",
    "readInvite(link, now+25h)",
    async () => parsedLate,
    (p: { ok: boolean; reason?: string }) => JSON.stringify({ ok: p.ok, reason: p.reason }),
  );
  // offline guest
  const m6 = await parse("member");
  const g6 = await GuestPond.join(m6.invite, "Offy", { vault: mkVault(), fetch: guestFetch });
  const off = new GuestPond({
    record: g6.record,
    vault: mkVault(),
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await rec(s, "guest refresh with relay unreachable", "WebGuest6", "guest.refresh()", () => off.refresh());
  await rec(s, "guest view with relay unreachable", "WebGuest6", "guest.view()", () => off.view(), guestFmtView);
}

/** Retries a slow or flaky relay call a few times; the last failure is thrown. */
async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  console.log(`cleanup: gave up on ${label}: ${String(last)}`);
  throw last;
}

async function cleanup() {
  const s = createCloudStore(ownerLoc);
  let n = 0;
  let failed = 0;
  // Ponds the run made are remembered in a file as they are made, so a crashed run can still be cleaned (CLEAN_ONLY=1).
  const remembered: string[] = fs.existsSync(PONDS_FILE) ? JSON.parse(fs.readFileSync(PONDS_FILE, "utf8")) : [];
  for (const pondId of new Set([...ponds, ...remembered])) {
    for (const kind of [
      "members",
      "keys",
      "joins",
      "joinids",
      "threads",
      "tevents",
      "presence",
      "holds",
      "tcmds",
      "ripples",
      "tasks",
      "claims",
      "locks",
      "grants",
      "pond",
    ]) {
      const items = await retry(`list ${pondId}/${kind}`, () => s.list(`channels/${pondId}/${kind}`)).catch(() => []);
      for (const { id } of items) {
        await retry(`delete ${pondId}/${kind}/${id}`, () => s.delete(`channels/${pondId}/${kind}/${id}`))
          .then(() => n++)
          .catch(() => failed++);
      }
    }
  }
  if (failed === 0) fs.rmSync(PONDS_FILE, { force: true });
  console.log(`cleanup: deleted ${n} documents of ${ponds.length} test ponds (${failed} failed)`);
  return n;
}

let fail = "";
try {
  if (process.env.CLEAN_ONLY !== "1") await main();
} catch (e) {
  fail = (e as Error).stack ?? String(e);
  console.log("SCRIPT FAILURE", fail);
} finally {
  const n = await cleanup().catch((e) => {
    console.log("cleanup failed", e);
    return -1;
  });
  const md = [
    "# 4 - Live multiplayer state transitions (real hosted Catalyst relay)",
    "",
    `Run ${new Date().toISOString()} against ${RELAY} (owner location: ${ownerLoc.hosted ? "hosted mac key" : "relay key"}). Throwaway identities, temp support dirs. Cleanup deleted ${n} documents.${fail ? `\n\nSCRIPT FAILURE (later steps missing): ${fail.split("\n")[0]}` : ""}`,
    "",
    "| scenario | step | actor | call | result | s |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${cell(r.scenario)} | ${cell(r.step)} | ${cell(r.actor)} | \`${cell(r.call)}\` | ${cell(r.result)} | ${r.secs} |`,
    ),
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(NOTES), { recursive: true });
  fs.writeFileSync(NOTES, md);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  for (const i of all) i.service.stop?.();
  process.exit(fail ? 1 : 0);
}
