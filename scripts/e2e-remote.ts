// End-to-end test of the phone channel over the REAL Firebase project:
// the Mac's RemoteBridge and the phone's own Swift channel code (squeak-e2e),
// talking through live Firestore. The only fakes are the chat (a recorded
// replier, so no agent is touched) and your eyes on the pairing code.
//
//   npx tsx scripts/e2e-remote.ts [firebase-project-id]
//
// With SQUEAK_E2E_DATABASE_URL set, the channel runs on that Realtime
// Database instead (the emulator works: http://127.0.0.1:9000?ns=<name>).
// The bridge then runs on its own, woken only by the stream, so the run
// proves nothing waits for a poll.
//
// With SQUEAK_E2E_LOCAL=1 it runs the direct same-Wi-Fi path instead: an
// in-memory Realtime Database stands in for the cloud (no Firebase), the
// Mac's LocalChannelServer listens on 127.0.0.1, and the phone pairs through
// the "cloud", finds the Mac from its sealed view, and carries every command
// over the local path (the "cloud" must see none of them). Then the local
// server is stopped, and the phone must notice and send one more through the
// cloud.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FleetSnapshot } from "../src/fleet/fleet-monitor.js";
import { FakeRtdb } from "../src/remote/fake-rtdb.js";
import { FirestoreRest } from "../src/remote/firestore-rest.js";
import { LocalChannelServer } from "../src/remote/local-channel.js";
import { MirrorStore } from "../src/remote/mirror-store.js";
import { RemoteBridge } from "../src/remote/remote-bridge.js";
import { RtdbRest } from "../src/remote/rtdb-rest.js";

const project = process.argv[2] ?? "squeak-5c9gvo";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-e2e-"));
const codeFile = path.join(dir, "phone-code");
const phoneBin = path.resolve("ios/SqueakCore/.build/release/squeak-e2e");
const sends: Array<[string, string, string | undefined]> = [];
// A fake relay: the new-chat command is proven end to end without creating any chat.
const starts: Array<{ workspaceId: string; agent: string; text: string }> = [];

const session = {
  key: "claude-transcript:e2e",
  source: "claude-transcript",
  agent: "claude",
  origin: "conductor",
  sourceId: "e2e",
  agentSessionId: "e2e",
  conductorSessionId: "e2e-session",
  cwd: "/tmp",
  repoName: "farm",
  branch: "arm",
  title: "Farm",
  state: "finished",
  detail: "D1?",
  lastActivityAt: new Date().toISOString(),
  transcriptPath: null,
  pid: null,
  alive: false,
  stateSource: "transcript",
  contextPercent: null,
  retired: false,
  baseRef: null,
  costUsd: null,
  git: null,
};
const localMode = process.env.SQUEAK_E2E_LOCAL === "1";
const fake = localMode && !process.env.SQUEAK_E2E_DATABASE_URL ? new FakeRtdb() : null;
const databaseUrl = (await fake?.start()) ?? process.env.SQUEAK_E2E_DATABASE_URL ?? null;
const cloudStore = databaseUrl ? new RtdbRest(databaseUrl) : new FirestoreRest(project);
const mirror = localMode ? new MirrorStore(cloudStore) : null;
const store = mirror ?? cloudStore;
let localServer: LocalChannelServer | null = null;
const continueFile = path.join(dir, "continue");
const bridge = new RemoteBridge({
  localEndpoint: () => localServer?.endpoint() ?? null,
  onDevicesChanged: () => void localServer?.refresh(),
  configPath: path.join(dir, "remote.json"),
  projectId: project,
  store,
  replier: {
    lastTurnText: () => "**D1 — Arm it?**\n\n**A) Now.** a\n**B) Later.** b\n**C) Never.** c",
    lastTurnId: () => "turn-1",
    send: async (id, text, _onFailed, options) => {
      sends.push([id, text, options?.mode]);
      return { status: "started", via: "conductor", delivery: options?.mode === "steer" ? "steered" : "sent" };
    },
  },
  newChat: {
    workspaces: () => [
      {
        id: "e2e-ws",
        repoName: "farm",
        branch: "arm",
        lastActivityAt: new Date().toISOString(),
        defaultAgent: "codex",
      },
    ],
    start: async (args) => {
      starts.push(args);
      return { ok: true, sessionId: "e2e-new-session" };
    },
  },
  claudeLimits: () => ({
    fiveHour: { utilization: 0.42, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
    sevenDay: null,
    observedAt: new Date().toISOString(),
  }),
  // The phone's Refresh on Usage: a fake refresher, so no real Claude call.
  refreshUsage: async () => ({ refreshed: true, throttled: false }),
  // Verbose: a working turn with a thinking step longer than the snapshot's 200 characters.
  liveActivity: () => ({
    total: 2,
    steps: [
      { kind: "thinking", text: `Weighing whether to arm now. ${"Checking the timer path. ".repeat(30)}`, at: null },
      { kind: "tool", text: "Run npm test", at: null },
    ],
  }),
  snapshot: () =>
    ({
      sessions: [session],
      active: [session],
      attention: [],
      generatedAt: "",
      codexUsage: null,
    }) as unknown as FleetSnapshot,
  macName: "E2E Mac",
});

if (mirror) {
  localServer = new LocalChannelServer({
    mirror,
    access: () => bridge.localAccess(),
    host: "127.0.0.1",
    advertiser: null,
    hosts: () => ["127.0.0.1"],
  });
  await localServer.start();
  console.log(`mac:   direct path listening on 127.0.0.1:${localServer.port}`);
}
const { url } = bridge.startPairing();
if (databaseUrl) {
  bridge.start(); // streamed: the bridge reacts to the phone by itself
} else {
  bridge.stop(); // this script drives the ticks itself
}
const channelId = JSON.parse(Buffer.from(new URL(url).searchParams.get("d")!, "base64url").toString()).c as string;
console.log(
  `mac:   channel ${channelId.slice(0, 6)}… on ${databaseUrl ? `the Realtime Database at ${databaseUrl}` : project}`,
);

const phone = new Promise<{ code: number; out: string }>((resolve) => {
  const child = spawn(phoneBin, [url, codeFile], {
    env: {
      ...process.env,
      ...(databaseUrl ? { SQUEAK_E2E_DATABASE_URL: databaseUrl } : {}),
      ...(localMode ? { SQUEAK_E2E_LOCAL: "1", SQUEAK_E2E_CONTINUE_FILE: continueFile } : {}),
    },
  });
  let out = "";
  const timer = setTimeout(() => child.kill(), 180_000);
  const onData = (chunk: Buffer) => {
    out += chunk.toString();
    // The phone has run everything over the local path: take the path away and let it carry on.
    if (localServer && out.includes("phone: local phase done") && !fs.existsSync(continueFile)) {
      console.log("mac:   stopping the direct path");
      void localServer.stop().then(() => fs.writeFileSync(continueFile, "1"));
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? 1, out });
  });
});
let done = false;
void phone.then(() => (done = true));

const deadline = Date.now() + 180_000;
while (!done && Date.now() < deadline) {
  if (!databaseUrl) {
    await bridge.tick();
    bridge.stop();
  }
  const status = bridge.status() as { pending: Array<{ id: string; code: string }> };
  for (const request of status.pending) {
    const phoneCode = fs.existsSync(codeFile) ? fs.readFileSync(codeFile, "utf8") : null;
    if (phoneCode === request.code) {
      console.log(`mac:   codes match (${request.code}), approving`);
      await bridge.approve(request.id);
      await localServer?.refresh();
    } else {
      console.log(`mac:   code mismatch (${request.code} vs ${phoneCode}), rejecting`);
      await bridge.reject(request.id);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, databaseUrl ? 100 : 1000));
}
bridge.stop();

const result = await phone;
process.stdout.write(
  result.out
    .split("\n")
    .map((line) => (line ? `       ${line}\n` : ""))
    .join(""),
);
console.log(`mac:   replies delivered to the (fake) chat: ${JSON.stringify(sends)}`);

console.log(`mac:   chats started on the (fake) relay: ${JSON.stringify(starts)}`);

const cloudCommandWrites = fake?.requests.filter((request) => /^PUT .*\/commands\//.test(request)).length ?? 0;
if (localMode) {
  console.log(
    `mac:   commands the cloud saw written: ${cloudCommandWrites} (only the one sent after the local path went away)`,
  );
}

// Leave nothing behind in the real database. `live` exists only in the
// Realtime Database; Firestore's rules refuse to list it.
for (const kind of databaseUrl
  ? ["state", "pairing", "commands", "results", "live"]
  : ["state", "pairing", "commands", "results"]) {
  for (const { id } of await store.list(`channels/${channelId}/${kind}`)) {
    await store.delete(`channels/${channelId}/${kind}/${id}`);
  }
}
const ok =
  result.code === 0 &&
  sends.length === (localMode ? 3 : 2) &&
  sends[0]![1] === "B" &&
  sends[0]![2] === "queue" &&
  sends[1]![2] === "steer" &&
  (!localMode || (cloudCommandWrites === 1 && sends[2]![1] === "C")) &&
  starts.length === 1 &&
  starts[0]!.workspaceId === "e2e-ws" &&
  starts[0]!.agent === "codex" &&
  starts[0]!.text === "Add a timer";
await localServer?.stop();
await fake?.stop();
console.log(ok ? "E2E PASS" : "E2E FAIL");
process.exit(ok ? 0 : 1);
