#!/usr/bin/env tsx
/**
 * Drive Conductor's desktop-relay locally, with no cloud, so a message can be
 * injected into a chat while the screen is locked and show live in the window.
 * See `.context/re/conductor-remote-control-protocol.md` and the module under
 * `src/fleet/conductor-relay/`.
 *
 * Commands:
 *   list                               recent chats (workspace id, session id, title)
 *   setup  --port <n>                  point Conductor's relay at us + enable mobile access (writes conductor.db; needs a Conductor restart)
 *   reset                              undo setup (writes conductor.db; needs a Conductor restart)
 *   run    --port <n> [--link <L>] [--workspace <id> --session <id> --text <t>]
 *                                      start the local relay+proxy; pair (first time, with the link) or auth; optionally send one message; stay up
 *
 * Nothing here touches the live app except `setup`/`reset`, which only write
 * settings rows; they print the restart reminder rather than restarting it.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import { ConductorRelayServer } from "../src/fleet/conductor-relay/relay-server.js";
import { parsePairingLink } from "../src/fleet/conductor-relay/pairing.js";
import type { DeviceCredentials, PhoneClient } from "../src/fleet/conductor-relay/phone.js";

const CONDUCTOR_DB = path.join(os.homedir(), "Library/Application Support/com.conductor.app/conductor.db");
const STATE_FILE = path.join(os.homedir(), "Library/Application Support/squeak/conductor-relay.json");
const OVERRIDE_KEY = "roundhouse_client_url_override";
const ENABLE_KEY = "internal_desktop_remote_access";
const UPSTREAM = "https://api.conductor.build";
// Conductor's Keychain (login) service for its settings/secrets, and the
// account under which it keeps the list of paired remote-control devices.
const KEYCHAIN_SERVICE = "com.conductor.app.production.settings";
const PAIRED_DEVICES_ACCOUNT = "desktop_relay_paired_devices";

interface RelayState {
  port: number;
  hostStaticPublicKey?: string; // base64url, learned on first connect
  credentials?: DeviceCredentials;
}

function readState(): RelayState | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RelayState;
  } catch {
    return undefined;
  }
}

function writeState(s: RelayState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function args(): Map<string, string> {
  const m = new Map<string, string>();
  const a = process.argv.slice(3);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) m.set(a[i].slice(2), a[i + 1] ?? "");
  }
  return m;
}

function cmdList(): void {
  const db = new Database(CONDUCTOR_DB, { readonly: true });
  const rows = db
    .prepare(
      `SELECT s.workspace_id AS ws, s.id AS sid, s.agent_type AS agent, substr(s.title,1,40) AS title
       FROM sessions s WHERE s.is_hidden IS NOT 1 ORDER BY s.updated_at DESC LIMIT 15`,
    )
    .all() as { ws: string; sid: string; agent: string; title: string }[];
  for (const r of rows) {
    console.log(`${r.ws}  ${r.sid}  [${r.agent ?? "?"}]  ${r.title ?? ""}`);
  }
  db.close();
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
  ).run(key, value);
}

function cmdSetup(): void {
  const port = Number(args().get("port"));
  if (!port) throw new Error("--port <n> required");
  const backup = `${CONDUCTOR_DB}.before-squeak-relay-${Date.now()}`;
  fs.copyFileSync(CONDUCTOR_DB, backup);
  const db = new Database(CONDUCTOR_DB);
  const prev = (db.prepare("SELECT value FROM settings WHERE key=?").get(OVERRIDE_KEY) as { value: string } | undefined)
    ?.value;
  setSetting(db, OVERRIDE_KEY, `http://127.0.0.1:${port}`);
  setSetting(db, ENABLE_KEY, "true");
  // Make the Remote-control settings page (with the "pair a device" button)
  // visible, so a pairing link can be generated.
  for (const flag of [
    "internal_settings_enabled",
    "remote_control_settings_enabled",
    "remote_control_out_of_experimental_enabled",
  ]) {
    setSetting(db, flag, "true");
  }
  db.close();
  console.log(`Backed up conductor.db → ${path.basename(backup)}`);
  console.log(`Set ${OVERRIDE_KEY} = http://127.0.0.1:${port} (was ${prev ?? "unset"})`);
  console.log(`Set ${ENABLE_KEY} = true; enabled internal + remote-control settings UI`);
  console.log("\nNEXT: start the relay (`run --port %d`), then QUIT AND REOPEN Conductor.", port);
  console.log("All Conductor cloud traffic now routes through the local relay+proxy while it runs.");
}

function cmdReset(): void {
  const db = new Database(CONDUCTOR_DB);
  db.prepare("DELETE FROM settings WHERE key=?").run(OVERRIDE_KEY);
  setSetting(db, ENABLE_KEY, "false");
  db.close();
  console.log(`Removed ${OVERRIDE_KEY}; set ${ENABLE_KEY}=false. Restart Conductor to restore normal cloud.`);
}

/**
 * Register a device directly in Conductor's Keychain, skipping the in-app
 * pairing screen. The host re-reads this list on every auth, so no restart is
 * needed. Harmless and reversible (`keychain-unpair`).
 */
function cmdKeychainPair(): void {
  const deviceId = crypto.randomUUID();
  const deviceToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(deviceToken, "utf8").digest().toString("base64url");
  const now = new Date().toISOString();
  const record = [{ deviceId, name: "Squeak", tokenHash, createdAt: now, lastSeenAt: now }];
  const value = JSON.stringify(record);
  // -U update if present, -A allow all apps (so Conductor can read without a
  // per-access prompt), -w value. Writes to the default (login) keychain.
  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-A",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    PAIRED_DEVICES_ACCOUNT,
    "-w",
    value,
  ]);
  const saved = readState();
  writeState({
    port: saved?.port ?? 0,
    ...(saved?.hostStaticPublicKey ? { hostStaticPublicKey: saved.hostStaticPublicKey } : {}),
    credentials: { deviceId, deviceToken },
  });
  console.log(`Wrote device ${deviceId} into Keychain (${KEYCHAIN_SERVICE} / ${PAIRED_DEVICES_ACCOUNT}).`);
  console.log("Saved credentials. Now run:  run --port <n>");
}

function cmdKeychainUnpair(): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", PAIRED_DEVICES_ACCOUNT]);
    console.log("Removed the paired-devices Keychain item.");
  } catch {
    console.log("No paired-devices Keychain item to remove.");
  }
}

async function cmdRun(): Promise<void> {
  const a = args();
  const link = a.get("link");
  const saved = readState();
  const port = Number(a.get("port") ?? saved?.port ?? 0);
  if (!port) throw new Error("--port <n> required (or run setup first)");

  // Host key: from the link, or a previously saved one, or trust-on-first-
  // connect (loopback). The pairing token, when present, lets us pair.
  const linkInfo = link ? parsePairingLink(link) : undefined;
  let hostKeyB64 = linkInfo
    ? Buffer.from(linkInfo.hostStaticPublicKey).toString("base64url")
    : saved?.hostStaticPublicKey;
  const pinnedKey = hostKeyB64 ? Buffer.from(hostKeyB64, "base64url") : undefined;

  let credentials = saved?.credentials;
  let pairingToken = linkInfo?.pairingToken.toString("base64url");
  const oneShot = { workspace: a.get("workspace"), session: a.get("session"), text: a.get("text") };

  const persist = () => {
    if (hostKeyB64) writeState({ port, hostStaticPublicKey: hostKeyB64, credentials });
  };

  const drive = async (client: PhoneClient): Promise<void> => {
    await client.handshake();
    // Learn and pin the host key if we didn't already have it.
    if (!hostKeyB64 && client.hostStaticKey) {
      hostKeyB64 = client.hostStaticKey.toString("base64url");
    }
    if (credentials) {
      await client.authenticate(credentials);
      console.log("[relay] authenticated with saved device credentials");
    } else if (pairingToken) {
      credentials = await client.pair(pairingToken, "Squeak");
      console.log(`[relay] paired; device ${credentials.deviceId} saved`);
    } else {
      console.log("[relay] host connected but not paired yet. Run `keychain-pair` (no UI needed), then restart this.");
    }
    persist();

    // Read-only proof the tunnel works end-to-end, no side effects.
    if (credentials) {
      try {
        const health = await client.request({ method: "GET", target: "/desktop-remote-access/health" });
        console.log(`[relay] TUNNEL OK — health HTTP ${health.status}: ${health.body.slice(0, 160)}`);
      } catch (e) {
        console.error("[relay] tunnel health check failed:", e instanceof Error ? e.message : e);
      }
    }

    const send = async (workspace: string, session: string, text: string) => {
      const res = await client.sendChatMessage({ workspaceLocalId: workspace, sessionId: session, text });
      console.log(`[relay] send → HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    };
    if (credentials && oneShot.workspace && oneShot.session && oneShot.text) {
      await send(oneShot.workspace, oneShot.session, oneShot.text);
    }
    console.log("[relay] commands:  pair <link>  |  <workspaceId> <sessionId> <message…>   (Ctrl-C to stop)");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      if (t.startsWith("pair ")) {
        const info = parsePairingLink(t.slice(5).trim());
        pairingToken = info.pairingToken.toString("base64url");
        hostKeyB64 = Buffer.from(info.hostStaticPublicKey).toString("base64url");
        void client
          .pair(pairingToken, "Squeak")
          .then((c) => {
            credentials = c;
            persist();
            console.log(`[relay] paired; device ${c.deviceId} saved`);
          })
          .catch((e) => console.error("[relay] pair failed:", e.message));
        return;
      }
      const sp = t.indexOf(" ");
      const sp2 = t.indexOf(" ", sp + 1);
      if (sp < 0 || sp2 < 0) {
        console.log("usage:  pair <link>   OR   <workspaceId> <sessionId> <message>");
        return;
      }
      void send(t.slice(0, sp), t.slice(sp + 1, sp2), t.slice(sp2 + 1)).catch((e) =>
        console.error("[relay] send failed:", e.message),
      );
    });
  };

  const server = new ConductorRelayServer({
    ...(pinnedKey ? { hostStaticPublicKey: pinnedKey } : {}),
    upstreamBaseUrl: UPSTREAM,
    onHost: ({ client }) => {
      console.log("[relay] Conductor host connected");
      drive(client).catch((e) => console.error("[relay] error:", e.message));
    },
  });
  await server.listen(port);
  console.log(`[relay] listening on http://127.0.0.1:${port} (proxying other traffic to ${UPSTREAM})`);
  console.log("[relay] waiting for Conductor to connect (reopen Conductor if you haven't)…");
}

const cmd = process.argv[2];
void (async () => {
  try {
    if (cmd === "list") cmdList();
    else if (cmd === "setup") cmdSetup();
    else if (cmd === "reset") cmdReset();
    else if (cmd === "keychain-pair") cmdKeychainPair();
    else if (cmd === "keychain-unpair") cmdKeychainUnpair();
    else if (cmd === "run") await cmdRun();
    else {
      console.log(
        "commands: list | setup --port <n> | reset | keychain-pair | keychain-unpair | run --port <n> [--link <L>] [--workspace <id> --session <id> --text <t>]",
      );
      process.exit(1);
    }
  } catch (e) {
    console.error("error:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();

void crypto; // reserved for future per-send ids at this layer
