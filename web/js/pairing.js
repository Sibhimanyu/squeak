// Pairing, step by step (Pairing.swift, Channel.requestPairing):
// 1. The pasted code gives the channel id, the channel secret and the Mac's
//    database. The secret is imported as a non-extractable AES-GCM key at once
//    and the string is dropped.
// 2. A P-256 signing key is generated, non-extractable; both keys are saved
//    in IndexedDB as "pending".
// 3. The device name and public key go to `pairing/<deviceId>`, sealed.
// 4. The Mac's owner sees a six-digit code, compares it with the one shown
//    here, and approves; the Mac answers at `results/pair-<deviceId>`.

import { Channel } from "./channel.js";
import { generateDeviceKey, importChannelKey, pairingCode } from "./channel-crypto.js";
import { parsePairingLink, PairingError } from "./pairing-link.js";
import { RtdbClient } from "./rtdb.js";

// Scanning the Mac's QR code only produces text for beginPairing, like the paste box.
export { scanControl, scanSupported } from "./qr-scanner.js";

/** "Web · Chrome", from the user agent: only a label on the Mac's device list. */
export function deviceNameFor(userAgent = "") {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "browser";
  return `Web · ${browser}`;
}

/**
 * Starts pairing from pasted text. Saves the pending record, writes the
 * request, and returns the code to compare. Throws PairingError for a code
 * the web app cannot use.
 */
export async function beginPairing(text, { store, name, fetchImpl, now }) {
  const link = parsePairingLink(text);
  if (!link.databaseUrl) {
    throw new PairingError(
      "This pairing code is from before Squeak moved to the Realtime Database. Make a new one on your Mac (Pair a phone).",
    );
  }
  const channelKey = await importChannelKey(link.key);
  const { privateKey, publicKeyX963 } = await generateDeviceKey();
  const deviceId = globalThis.crypto.randomUUID().toLowerCase();
  const record = {
    state: "pending",
    deviceId,
    deviceName: name,
    channelId: link.channelId,
    project: link.project,
    databaseUrl: link.databaseUrl,
    macName: link.macName,
    channelKey,
    signingKey: privateKey,
    publicKeyX963,
  };
  const channel = channelFor(record, { fetchImpl, now });
  await store.save(record);
  try {
    await channel.requestPairing(name, publicKeyX963);
  } catch (error) {
    await store.forget();
    throw error;
  }
  return { record, channel, code: await pairingCode(publicKeyX963) };
}

export function channelFor(record, { fetchImpl, now } = {}) {
  const db = new RtdbClient(record.databaseUrl, fetchImpl);
  return new Channel({ channelId: record.channelId, deviceId: record.deviceId, key: record.channelKey, db, now });
}

/**
 * Waits for the Mac's answer (polling, and woken by the results stream).
 * Resolves `{ approved, mac }`; honours `signal`.
 */
export async function awaitApproval(channel, { signal, intervalMs = 2_000 } = {}) {
  let wake = () => undefined;
  const stop = channel.db.watch(channel.resultsPath, (event) => {
    if (event.kind === "change") wake();
  });
  try {
    while (!signal?.aborted) {
      try {
        const answer = await channel.pairingAnswer();
        if (answer && typeof answer.approved === "boolean") {
          void channel.deleteResult(`pair-${channel.deviceId}`);
          return { approved: answer.approved, mac: typeof answer.mac === "string" ? answer.mac : null };
        }
      } catch {
        // Offline for a moment: keep asking.
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    return { approved: false, mac: null, cancelled: true };
  } finally {
    stop();
  }
}
