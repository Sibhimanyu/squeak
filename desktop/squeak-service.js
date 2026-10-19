// Everything the Squeak window needs from outside itself: the daemon's state,
// the token-gated control routes, launchd, and Squeak Hands. Main process
// only — the renderer reaches these through app-preload.js and never gets a
// token, a shell, or a URL of its own.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = process.env.FLEET_HOOK_PORT || "8477";
const BASE = `http://127.0.0.1:${PORT}`;
const SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "squeak");
const TOKEN_PATH = path.join(SUPPORT_DIR, "hook-token");
const HANDS_APP = path.join(SUPPORT_DIR, "Squeak Hands.app");
const DAEMON_LABEL = "com.squeak.daemon";
const DAEMON_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
const TOKEN_HEADER = "x-squeak-token";

/** Conductor ids are UUIDs; anything else never reaches a URL or a file. */
// A Conductor chat id, or a terminal agent's fleet key (`claude-transcript:<uuid>`);
// the same shape the ingress accepts.
const SESSION_ID = /^[A-Za-z0-9_:-]{1,120}$/;

function run(command, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return null;
  }
}

async function fetchJson(url, init = {}, timeoutMs = 5_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
  return response.json();
}

/** Null when the daemon is not reachable, which the window shows as offline. */
async function readState() {
  try {
    return await fetchJson(`${BASE}/state`);
  } catch {
    return null;
  }
}

async function control(pathname, init = {}, timeoutMs = 5_000) {
  const token = readToken();
  if (!token) {
    throw new Error("Squeak has not created its token yet. Is the service running?");
  }
  return fetchJson(
    `${BASE}/control/${pathname}`,
    { ...init, headers: { ...(init.headers ?? {}), [TOKEN_HEADER]: token, "content-type": "application/json" } },
    timeoutMs,
  );
}

async function sessionMessage(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    return { text: null, choices: null };
  }
  try {
    return await control(`session/${sessionId}/message`);
  } catch {
    return { text: null, choices: null };
  }
}

/** The current turn of a session, step by step; empty when it cannot be read. */
async function sessionActivity(sessionKey) {
  if (typeof sessionKey !== "string" || !SESSION_ID.test(sessionKey)) {
    return { steps: [], total: 0 };
  }
  try {
    return await control(`session/${sessionKey}/activity`);
  } catch {
    return { steps: [], total: 0 };
  }
}

/**
 * A reply types into Conductor or a terminal through Squeak Hands, which can
 * take several seconds, and confirms against the database or transcript
 * afterwards — hence the long timeout. The outcome is Squeak's own: started (and how) or refused (and why).
 */
async function reply(sessionId, text) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || typeof text !== "string" || !text.trim()) {
    return { status: "refused", reason: "There is nothing to send." };
  }
  try {
    return await control(`session/${sessionId}/reply`, { method: "POST", body: JSON.stringify({ text }) }, 60_000);
  } catch (error) {
    return {
      status: "refused",
      reason: `Squeak did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** What launchd says about the daemon, without needing a terminal. */
async function serviceStatus() {
  const uid = os.userInfo().uid;
  const result = await run("/bin/launchctl", ["print", `gui/${uid}/${DAEMON_LABEL}`]);
  if (!result.ok) {
    return { installed: fs.existsSync(DAEMON_PLIST), running: false, pid: null };
  }
  const pid = /\bpid = (\d+)/.exec(result.stdout);
  const running = /\bstate = running\b/.test(result.stdout);
  return { installed: true, running, pid: pid ? Number(pid[1]) : null };
}

/**
 * Start the daemon if it is stopped, restart it if it is running. Loads the
 * launch agent first when it has been unloaded, which `kickstart` alone
 * cannot do.
 */
async function restartService() {
  const uid = os.userInfo().uid;
  const status = await serviceStatus();
  if (!status.installed) {
    return { ok: false, message: "Squeak's service is not installed. Run scripts/install-squeak-agents.sh once." };
  }
  const loaded = await run("/bin/launchctl", ["print", `gui/${uid}/${DAEMON_LABEL}`]);
  if (!loaded.ok) {
    const boot = await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, DAEMON_PLIST]);
    if (!boot.ok) {
      return { ok: false, message: boot.stderr.trim() || "launchctl bootstrap failed" };
    }
    return { ok: true, message: "Started." };
  }
  const kick = await run("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${DAEMON_LABEL}`]);
  return kick.ok
    ? { ok: true, message: status.running ? "Restarted." : "Started." }
    : { ok: false, message: kick.stderr.trim() };
}

/**
 * Bring a chat up in Conductor. Conductor has no link that opens an existing
 * chat, so this is Squeak Hands navigating — verified by Conductor's own
 * route, typing nothing.
 */
async function openInConductor(target) {
  if (!target || !SESSION_ID.test(target.sessionId ?? "") || !SESSION_ID.test(target.workspaceId ?? "")) {
    return { ok: false, message: "That session is not a Conductor chat." };
  }
  if (!fs.existsSync(HANDS_APP)) {
    await run("/usr/bin/open", ["-a", "Conductor"]);
    return { ok: false, message: "Opened Conductor. Squeak Hands is not installed, so it cannot pick the chat." };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-open-"));
  try {
    const requestPath = path.join(dir, "request.json");
    const resultPath = path.join(dir, "result.json");
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        sessionTitle: target.title ?? null,
        text: "",
        navigateOnly: true,
      }),
      { mode: 0o600 },
    );
    await run("/usr/bin/open", ["-W", "-n", HANDS_APP, "--args", "send", requestPath, resultPath], 30_000);
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : null;
    if (result?.ok) {
      return { ok: true, message: "Opened in Conductor." };
    }
    await run("/usr/bin/open", ["-a", "Conductor"]);
    const why = result?.error === "chat-not-open" ? "that chat is not open as a tab" : (result?.error ?? "no answer");
    return { ok: false, message: `Opened Conductor, but could not select the chat: ${why}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const REMOTE_ACTIONS = new Set(["status", "approve", "reject", "revoke", "reset"]);

/** Pairing and device management for the phone channel (docs/remote-channel.md). */
async function remote(action, deviceId) {
  if (!REMOTE_ACTIONS.has(action) || (deviceId != null && !/^[A-Za-z0-9_-]{1,64}$/.test(deviceId))) {
    return { ok: false };
  }
  try {
    return await control(`remote/${action}${deviceId ? `/${deviceId}` : ""}`, {
      method: action === "status" ? "GET" : "POST",
    });
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Open the pairing window and draw its QR code. The code carries the channel
 * key, so it is made here and handed to the window as an image, never as text
 * a web page could lift.
 */
async function pairingQr() {
  try {
    const { url } = await control("remote/pair", { method: "POST" });
    const QRCode = require("qrcode");
    return { ok: true, image: await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const AWAKE_ACTIONS = new Set(["start", "extend", "end"]);
const MAX_AWAKE_MINUTES = 7 * 24 * 60;

/**
 * Starts, extends or ends the awake session (src/fleet/awake-session.ts).
 * `minutes` is whole minutes, or null to start one that lasts until ended.
 * Answers `{ ok, awake }` with the session after, or `{ ok: false, message }`.
 */
async function awake(request) {
  const action = request?.action;
  const minutes = request?.minutes ?? null;
  const validMinutes = Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_AWAKE_MINUTES;
  if (
    !AWAKE_ACTIONS.has(action) ||
    (action === "extend" && !validMinutes) ||
    (action === "start" && minutes !== null && !validMinutes)
  ) {
    return { ok: false, message: "That is not a length of time Squeak can stay awake for." };
  }
  const body = action === "end" ? { action } : { action, minutes };
  try {
    const result = await control("keep-awake", { method: "POST", body: JSON.stringify(body) });
    return { ok: true, awake: result.awake ?? null };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = {
  openInConductor,
  pairingQr,
  readState,
  remote,
  reply,
  restartService,
  serviceStatus,
  sessionActivity,
  sessionMessage,
  awake,
};
