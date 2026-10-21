// A paired browser's side of the channel: read the Mac's view, say it is
// open, ask to pair, and send signed replies. Paths and shapes mirror
// ios/SqueakCore Channel.swift and src/remote/remote-bridge.ts.

import { CAPABILITIES, open, pairingCode, seal, sign } from "./channel-crypto.js";
import { toHex } from "./encoding.js";
import { CHANNEL_ID } from "./pairing-link.js";

/** A device id is a path segment too (the rules allow 1 to 80 of these). */
export const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Commands live a few minutes; the Mac refuses anything past ten. */
export const COMMAND_LIFETIME_MS = 5 * 60_000;
/** The most a reply may be (the Mac refuses more than 20,000 after trimming). */
export const MAX_REPLY_CHARS = 20_000;

export class Channel {
  /**
   * @param channelId the path segment from the pairing code
   * @param deviceId  this browser's id on the Mac (a lowercase UUID)
   * @param key       the channel's AES-GCM CryptoKey (non-extractable)
   * @param db        an RtdbClient
   */
  constructor({ channelId, deviceId, key, db, now = () => Date.now() }) {
    if (!CHANNEL_ID.test(channelId) || !DEVICE_ID.test(deviceId)) {
      throw new Error("bad channel or device id");
    }
    this.channelId = channelId;
    this.deviceId = deviceId;
    this.key = key;
    this.db = db;
    this.now = now;
  }

  path(kind, id) {
    return `channels/${this.channelId}/${kind}/${id}`;
  }

  get statePath() {
    return `channels/${this.channelId}/state`;
  }

  get resultsPath() {
    return `channels/${this.channelId}/results`;
  }

  async #read(path) {
    const doc = await this.db.get(path);
    return doc ? open(this.key, doc.box) : null;
  }

  /** The Mac's view, with a split view's recent document folded in (`PhoneSnapshot.merged`). Null until the Mac writes one. */
  async view() {
    const [snapshot, recent] = await Promise.all([
      this.#read(this.path("state", "snapshot")),
      this.#read(this.path("state", "recent")).catch(() => null),
    ]);
    if (!snapshot) return null;
    if (snapshot.split !== true) return snapshot;
    return { ...snapshot, recent: recent?.recent, recentMore: recent?.recentMore, workspaces: recent?.workspaces };
  }

  /** The Mac's last answer to a presence ping (`{ at }`), or null from a Mac that never answers. */
  alive() {
    return this.#read(this.path("state", "alive"));
  }

  /** Tells the Mac a browser is looking, so it polls and publishes faster. */
  async touchPresence() {
    const presence = { at: this.now(), caps: CAPABILITIES };
    await this.db.set(this.path("state", "presence"), { box: await seal(this.key, presence) });
  }

  /** Asks to be paired: the name and public key, sealed, for the Mac's owner to approve. */
  async requestPairing(name, publicKeyX963) {
    const box = await seal(this.key, { name, publicKey: publicKeyX963 });
    await this.db.set(this.path("pairing", this.deviceId), { box });
  }

  /** The six digits to compare with the Mac's screen. */
  pairingCode(publicKeyX963) {
    return pairingCode(publicKeyX963);
  }

  /** `{ approved, mac }` once the Mac has answered, else null. */
  pairingAnswer() {
    return this.#read(this.path("results", `pair-${this.deviceId}`));
  }

  /** Withdraws a pairing request. Best effort. */
  async cancelPairing() {
    await this.db.delete(this.path("pairing", this.deviceId)).catch(() => undefined);
  }

  /**
   * The signed document for a reply (Channel.replyDocument on the phone). The
   * command carries the chat, the turn it answers, a nonce and an expiry, and
   * is signed as the exact box string. A plain reply: no `kind`, no `mode`.
   */
  async replyDocument(session, text, privateKey) {
    if (!session.conductorSessionId) throw new Error("not a chat that can be answered");
    const nonce = toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const command = {
      v: 1,
      sessionId: session.conductorSessionId,
      answersTurn: session.turnId ?? null,
      text,
      nonce,
      expiresAt: Math.trunc(this.now() + COMMAND_LIFETIME_MS),
    };
    const box = await seal(this.key, command);
    return {
      id: globalThis.crypto.randomUUID().toLowerCase(),
      document: { box, sig: await sign(privateKey, box), device: this.deviceId },
    };
  }

  send(id, document) {
    return this.db.set(this.path("commands", id), document);
  }

  /** The Mac's answer to a command, or null while it has not answered. */
  result(id) {
    return this.#read(this.path("results", id));
  }

  /** Removes a result once read, so it does not wait for the Mac's sweep. Best effort. */
  async deleteResult(id) {
    await this.db.delete(this.path("results", id)).catch(() => undefined);
  }
}
