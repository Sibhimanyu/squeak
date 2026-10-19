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
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FleetSnapshot } from "../src/fleet/fleet-monitor.js";
import { FirestoreRest } from "../src/remote/firestore-rest.js";
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
const databaseUrl = process.env.SQUEAK_E2E_DATABASE_URL ?? null;
const store = databaseUrl ? new RtdbRest(databaseUrl) : new FirestoreRest(project);
const bridge = new RemoteBridge({
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
  execFile(phoneBin, [url, codeFile], { timeout: 180_000, env: { ...process.env } }, (error, stdout, stderr) =>
    resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
  );
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

// Leave nothing behind in the real database.
for (const kind of ["state", "pairing", "commands", "results"]) {
  for (const { id } of await store.list(`channels/${channelId}/${kind}`)) {
    await store.delete(`channels/${channelId}/${kind}/${id}`);
  }
}
const ok =
  result.code === 0 &&
  sends.length === 2 &&
  sends[0]![1] === "B" &&
  sends[0]![2] === "queue" &&
  sends[1]![2] === "steer" &&
  starts.length === 1 &&
  starts[0]!.workspaceId === "e2e-ws" &&
  starts[0]!.agent === "codex" &&
  starts[0]!.text === "Add a timer";
console.log(ok ? "E2E PASS" : "E2E FAIL");
process.exit(ok ? 0 : 1);
