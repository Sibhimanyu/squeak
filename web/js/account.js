// An owner's account on the Catalyst relay: who is signed in, which Macs are linked to them, and asking one of those Macs
// to let this browser in. Signing in never opens a Mac by itself: the browser makes its own device key and a fresh ECDH key,
// asks the Mac (`POST /account/device-request`), shows the six-digit code the QR pairing shows for that key, and the Mac's
// owner approves there. The Mac answers with the pairing payload sealed to the ECDH key (the flotilla ECDH seal, opened by
// guest-crypto.js `openFromMember`), which gets the same checks as a scanned code and is stored exactly like one.

import { DEVICE_ID } from "./channel.js";
import { generateDeviceKey, importChannelKey, pairingCode } from "./channel-crypto.js";
import { openFromMember } from "./guest-crypto.js";
import { fetchMe, relayFetch } from "./guest-relay.js";
import { toBase64 } from "./encoding.js";
import { parsePairingPayload, PairingError } from "./pairing-link.js";

export const POLL_MS = 2_000;
const subtle = () => globalThis.crypto.subtle;

/** Plain sentences for what the account calls can answer. */
export const SENTENCES = {
  mac: "That Mac is no longer linked to your account.",
  busy: "That Mac already has a request waiting. Try again in a minute.",
  network: "Could not reach Squeak's server. Check your connection and try again.",
  gone: "That request ran out. Ask again.",
  expired: "Your Mac did not answer in time. Ask again.",
  signin: "Your sign-in ran out. Sign in again.",
};

export const deniedSentence = (mac) => `${mac || "Your Mac"} said no.`;

/** A relay answered with a status (and its `{error}` word). */
export class AccountError extends Error {
  constructor(status, code = null) {
    super(`account call failed: ${status}`);
    this.status = status;
    this.code = code;
  }
}

/** What a failed account call says, for the screen. */
export function accountSentence(error) {
  if (error instanceof AccountError) {
    if (error.status === 403) return SENTENCES.mac;
    if (error.status === 429) return SENTENCES.busy;
    if (error.status === 401) return SENTENCES.signin;
    if (error.status === 410) return SENTENCES.gone;
  }
  if (error instanceof PairingError) return error.message;
  return SENTENCES.network;
}

/** The expiry as epoch ms, whether the relay counts seconds or milliseconds. */
export const expiryMs = (value) =>
  typeof value === "number" && value > 0 ? (value < 1e12 ? value * 1000 : value) : null;

export class AccountApi {
  constructor({ baseUrl, fetch: fetchImpl = relayFetch }) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  async call(route, init = {}) {
    return this.fetchImpl(`${this.base}${route}`, {
      ...init,
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** `{ state: "in", user } | { state: "out" } | { state: "unknown" }` (guest-relay.js `fetchMe`). */
  me() {
    return fetchMe({ baseUrl: this.base, fetch: this.fetchImpl });
  }

  async #json(response) {
    return response.json().catch(() => ({}));
  }

  async macs() {
    const response = await this.call("/account/macs");
    if (!response.ok) throw new AccountError(response.status);
    const body = await this.#json(response);
    return (Array.isArray(body.macs) ? body.macs : []).flatMap((m) =>
      m && typeof m.macId === "string" && m.macId
        ? [
            {
              macId: m.macId,
              name: typeof m.name === "string" && m.name ? m.name : "Your Mac",
              linkedAt: m.linkedAt ?? null,
            },
          ]
        : [],
    );
  }

  async linkTicket() {
    const response = await this.call("/account/link-ticket", { method: "POST" });
    if (!response.ok) throw new AccountError(response.status);
    const body = await this.#json(response);
    if (typeof body.ticket !== "string" || !body.ticket) throw new AccountError(502);
    return body.ticket;
  }

  /** `{ value: token, user: { email, name } }` for the native app's sign-in; throws AccountError. */
  async appToken() {
    const response = await this.call("/account/app-token", { method: "POST" });
    if (!response.ok) throw new AccountError(response.status);
    const body = await this.#json(response);
    if (typeof body.token !== "string" || !body.token) throw new AccountError(502);
    return {
      value: body.token,
      user: {
        email: typeof body.email === "string" ? body.email : "",
        name: typeof body.name === "string" ? body.name : "",
      },
    };
  }

  /** `{ reqId, expiresAt }`; throws AccountError (403 `mac`, 429 `busy`). */
  async deviceRequest({ macId, name, publicKey, boxKey }) {
    const response = await this.call("/account/device-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ macId, name, publicKey, boxKey }),
    });
    const body = await this.#json(response);
    if (!response.ok) throw new AccountError(response.status, typeof body.error === "string" ? body.error : null);
    if (typeof body.reqId !== "string" || !body.reqId) throw new AccountError(502);
    return { reqId: body.reqId, expiresAt: expiryMs(body.expiresAt) };
  }

  /** `{ pending: true } | { box } | { denied: true } | { gone: true }`; other statuses throw. */
  async deviceAnswer(macId, reqId) {
    const response = await this.call(
      `/account/device-request?macId=${encodeURIComponent(macId)}&id=${encodeURIComponent(reqId)}`,
    );
    if (response.status === 202) return { pending: true };
    if (response.status === 410) return { gone: true };
    if (!response.ok) throw new AccountError(response.status);
    const result = (await this.#json(response)).result;
    if (result?.denied === true) return { denied: true };
    if (typeof result?.box === "string") return { box: result.box };
    return { pending: true };
  }
}

/** A fresh P-256 ECDH pair: the private half cannot be read out; `boxKey` is the public half, base64 x963 (a member key). */
export async function newBoxKey() {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return {
    ecdhKey: pair.privateKey,
    boxKey: toBase64(new Uint8Array(await subtle().exportKey("raw", pair.publicKey))),
  };
}

/**
 * Makes the device key and the ECDH key and asks the Mac. Returns what the waiting screen and the poll need; throws
 * AccountError (see `accountSentence`).
 */
export async function requestDevice(api, { mac, name }) {
  const { privateKey, publicKeyX963 } = await generateDeviceKey();
  const { ecdhKey, boxKey } = await newBoxKey();
  const { reqId, expiresAt } = await api.deviceRequest({
    macId: mac.macId,
    name,
    publicKey: publicKeyX963,
    boxKey,
  });
  return {
    mac,
    reqId,
    expiresAt,
    name,
    signingKey: privateKey,
    publicKeyX963,
    ecdhKey,
    code: await pairingCode(publicKeyX963),
  };
}

/** The browser's tab visibility, in the shape `awaitDevice` takes. */
export function pageVisibility(doc = globalThis.document) {
  return {
    hidden: () => doc?.visibilityState === "hidden",
    onVisible(fn) {
      doc?.addEventListener?.("visibilitychange", fn);
      return () => doc?.removeEventListener?.("visibilitychange", fn);
    },
  };
}

/**
 * Polls every 2 s until the Mac answers. Resolves one of
 * `{ box }`, `{ denied: true }`, `{ gone: true }`, `{ expired: true }`, `{ cancelled: true }`. While the tab is hidden it
 * does not ask (it resumes when the tab shows again); the request's own expiry still ends it.
 */
export async function awaitDevice(
  api,
  { mac, request, signal, intervalMs = POLL_MS, now = () => Date.now(), visibility = pageVisibility() },
) {
  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      let off = () => undefined;
      function done() {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
      // A hidden tab waits for it to show (or for the expiry); a shown tab waits only the interval.
      if (visibility.hidden()) off = visibility.onVisible(done);
    });
  while (!signal?.aborted) {
    if (request.expiresAt !== null && now() >= request.expiresAt) return { expired: true };
    if (!visibility.hidden()) {
      try {
        const answer = await api.deviceAnswer(mac.macId, request.reqId);
        if (signal?.aborted) break;
        if (!answer.pending) return answer;
      } catch (error) {
        if (error instanceof AccountError && (error.status === 401 || error.status === 403)) throw error;
        // Offline for a moment: keep asking.
      }
    }
    const wait = request.expiresAt === null ? intervalMs : Math.max(0, Math.min(intervalMs, request.expiresAt - now()));
    await sleep(visibility.hidden() && request.expiresAt !== null ? Math.max(0, request.expiresAt - now()) : wait);
  }
  return { cancelled: true };
}

/**
 * Opens the Mac's sealed answer, checks it as a scanned code is checked (a Catalyst payload: same relay host and key rules),
 * and returns the device record a QR pairing saves once the Mac approves. Throws PairingError for anything else; the ECDH key
 * is the caller's to drop.
 */
export async function recordFromBox(request, box) {
  let payload;
  try {
    payload = await openFromMember(request.ecdhKey, box);
  } catch {
    throw new PairingError("Your Mac's answer could not be read. Ask again.");
  }
  const link = parsePairingPayload(payload);
  // The request carries no device id (the contract names only the keys), so the Mac's record for this browser is under the
  // request's id unless the sealed payload names one (`d`). Commands name their device by this id.
  const named = typeof payload.d === "string" && DEVICE_ID.test(payload.d) ? payload.d : null;
  const deviceId = named ?? request.reqId;
  if (!DEVICE_ID.test(deviceId)) throw new PairingError("Your Mac's answer could not be read. Ask again.");
  if (link.provider !== "catalyst") throw new PairingError("That Mac is not on Squeak's cloud relay.");
  return {
    state: "paired",
    deviceId,
    deviceName: request.name,
    channelId: link.channelId,
    project: link.project,
    provider: link.provider,
    databaseUrl: link.databaseUrl,
    relayUrl: link.relayUrl,
    relayKey: link.relayKey,
    macName: link.macName || request.mac.name,
    channelKey: await importChannelKey(link.key),
    signingKey: request.signingKey,
    publicKeyX963: request.publicKeyX963,
  };
}
