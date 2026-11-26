/**
 * Regenerate the Mac client's fixtures of every pond route's real answer
 * (macos/Tests/SqueakMacCoreTests/Fixtures/ponds/*.json): two Macs (an owner and a member) and a browser member over an
 * in-memory Realtime Database, each Mac behind a real NativeServer with the Flotilla routes mounted. The Swift tests
 * decode exactly these files through PondsClient. Run after changing a route's shape:
 *
 *   npx tsx scripts/make-pond-fixtures.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { admitMember } from "../src/flotilla/admit-member.test-fixture.js";
import { FlotillaBridge } from "../src/flotilla/bridge.js";
import { hostPortFor } from "../src/flotilla/index.js";
import { FlotillaRoutes } from "../src/flotilla/mount.js";
import { FlotillaService } from "../src/flotilla/service.js";
import { SessionHost } from "../src/native/host.js";
import { NativeServer } from "../src/native/server.js";
import { NativeStore } from "../src/native/store.js";
import type { Runner, RunnerHooks } from "../src/native/types.js";
import { WorkspaceManager } from "../src/native/workspaces.js";
import { FakeRtdb } from "../src/remote/fake-rtdb.js";
import { RtdbRest } from "../src/remote/rtdb-rest.js";

const out = path.resolve("macos/Tests/SqueakMacCoreTests/Fixtures/ponds");
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pond-fixtures-"));

const rtdb = new FakeRtdb();
const dbUrl = await rtdb.start();

async function mac(name: string, nest: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new NativeStore(":memory:");
  const host = new SessionHost({
    store,
    runnerFactory: (_s, h: RunnerHooks): Runner => ({
      canSteer: false,
      send: async () => h.onStatus("working"),
      steer: async () => false,
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: async () => {},
    }),
  });
  const service = new FlotillaService({
    store: new RtdbRest(dbUrl),
    supportDir: dir,
    displayName: name,
    nest,
  });
  const bridge = new FlotillaBridge(service, hostPortFor({ host, store, tools: {} as never }), { flushMs: 60_000 });
  bridge.start();
  const routes = new FlotillaRoutes({
    service,
    bridge,
    remoteOf: async () => "git@github.com:acme/orchard.git",
    startOwn: async () => {
      throw new Error("unused");
    },
    heartbeatMs: 50,
  });
  const tokenPath = path.join(dir, "token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    routines: false,
    flotilla: routes,
  });
  const port = await server.start();
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), "x-squeak-token": token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return {
    service,
    bridge,
    host,
    store,
    call,
    stop: async () => {
      bridge.stop();
      service.stop();
      await server.stop();
      await host.stop();
    },
  };
}

const saved: string[] = [];
function save(name: string, r: { status: number; json: unknown }, expect = 200): void {
  if (r.status !== expect) throw new Error(`${name}: wanted ${expect}, got ${r.status} ${JSON.stringify(r.json)}`);
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(r.json, null, 2) + "\n");
  saved.push(name);
}

const A = await mac("Sibhi", "Sibhi's Mac");
const B = await mac("Aarav", "Aarav's Mac");
// A browser member: no Nest, no server.
const W = new FlotillaService({
  store: new RtdbRest(dbUrl),
  supportDir: path.join(tmp, "web"),
  displayName: "Vera",
  nest: null,
});

// 1. create, list
const made = await A.call("POST", "/native/ponds", { name: "Orchard", projectId: "proj-1", rootPath: "/w/orchard" });
save("create", made, 201);
const id = made.json.pond.id as string;
save("list-empty-flock", await A.call("GET", "/native/ponds"));
// 2. the people: a member and a viewer in a browser (the way in is email through the relay; here they are written)
await admitMember(A.service, B.service, id, "member");
await admitMember(A.service, W, id, "viewer");
save("detail-owner-people", await A.call("GET", `/native/ponds/${id}`));

// 4. a shared thread with events, a question, and a private one
const s = A.store.createSession({
  cwd: "/w/orchard",
  agent: "claude",
  model: "opus-5",
  permissionMode: "default",
  title: "Fix irrigation",
});
await A.host.send(s.id, "Fix the irrigation timer");
A.host.post(s.id, "assistant", {
  message: {
    content: [
      { type: "text", text: "Looking at the timer." },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/w/orchard/timer.ts" } },
    ],
  },
});
A.host.post(s.id, "user", { message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } });
const shared = await A.call("POST", `/native/ponds/${id}/share`, { sessionId: s.id });
save("share", shared, 201);
const tid = shared.json.thread.id as string;
const q = A.store.createRequest(s.id, "question", {
  toolName: "AskUserQuestion",
  input: { questions: [{ question: "Which port?", options: [{ label: "3000" }, { label: "4000" }] }] },
});
A.host.emit("event", { type: "request", sessionId: s.id, request: q });
await A.bridge.flush();
save("events", await A.call("GET", `/native/ponds/${id}/threads/${tid}/events?after=0`));
save("events-resume", await B.call("GET", `/native/ponds/${id}/threads/${tid}/events?after=3`));
save(
  "message",
  await B.call("POST", `/native/ponds/${id}/threads/${tid}/messages`, { text: "Use port 4000", mode: "queue" }),
);
save(
  "message-own",
  await A.call("POST", `/native/ponds/${id}/threads/${tid}/messages`, { text: "Carry on", mode: "steer" }),
);

// 5. holds: B holds the question; A is refused and so is A's answer
save("hold", await B.call("POST", `/native/ponds/${id}/threads/${tid}/hold`, { requestId: q.id }));
save("hold-conflict", await A.call("POST", `/native/ponds/${id}/threads/${tid}/hold`, { requestId: q.id }), 409);
save(
  "answer-conflict",
  await A.call("POST", `/native/ponds/${id}/threads/${tid}/answers`, { requestId: q.id, answer: "3000" }),
  409,
);
save("presence", await B.call("POST", `/native/ponds/${id}/presence`, { viewing: tid, typing: tid }));
await A.service.setPresence(id, { viewing: tid });

// 6. a private thread of the owner's
const p = A.store.createSession({
  cwd: "/w/orchard",
  agent: "codex",
  model: "gpt-5",
  permissionMode: "default",
  title: "Scratch",
});
save("share-private", await A.call("POST", `/native/ponds/${id}/share`, { sessionId: p.id, private: true }), 201);
await A.bridge.flush();

// 7. every view of the pond
save("detail-owner", await A.call("GET", `/native/ponds/${id}`));
save("detail-member", await B.call("GET", `/native/ponds/${id}`));
save("list", await A.call("GET", "/native/ponds"));

// 8. a visibility change, and a removal
save("visibility", await A.call("POST", `/native/ponds/${id}/threads/${tid}/visibility`, { private: false }));
const members = (await A.service.view(id)).members;
const vera = members.find((m) => m.name === "Vera")!;
save("remove-member", await A.call("DELETE", `/native/ponds/${id}/members/${vera.id}`));

await A.stop();
await B.stop();
await rtdb.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`saved ${saved.length} fixtures to ${out}`);
