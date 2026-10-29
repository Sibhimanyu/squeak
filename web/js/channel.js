// A paired browser's side of the channel: read the Mac's view, say it is
// open, ask to pair, and send signed replies. Paths and shapes mirror
// ios/SqueakCore Channel.swift and src/remote/remote-bridge.ts.

import { CAPABILITIES, open, pairingCode, seal, sign } from "./channel-crypto.js";
import { COMMAND_KINDS, shape } from "./command-shapes.js";
import { toHex } from "./encoding.js";
import { foldHistory, liveHandle, liveHistoryHandle, readTurn } from "./live.js";
import { CHANNEL_ID } from "./pairing-link.js";

/** A device id is a path segment too (the rules allow 1 to 80 of these). */
export const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Commands live a few minutes; the Mac refuses anything past ten. */
export const COMMAND_LIFETIME_MS = 5 * 60_000;
/** The most a reply may be (the Mac refuses more than 20,000 after trimming). */
export const MAX_REPLY_CHARS = 20_000;
/** A message id is a lowercase UUID (the Mac checks the same shape). */
export const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most recent chats a browser may ask the Mac for (its default is 10; the Mac caps at 50). */
export const RECENT_DEFAULT = 10;
export const RECENT_MAX = 50;
/** A chat's name is one short line (the Mac refuses more than 120 characters). */
export const RENAME_MAX_CHARS = 120;

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

  /** Where the Mac writes the one chat a browser watches (`live/<handle>` and `live/<handle>-h`). */
  get livePath() {
    return `channels/${this.channelId}/live`;
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
    return {
      ...snapshot,
      recent: recent?.recent,
      recentMore: recent?.recentMore,
      workspaces: recent?.workspaces,
      projectIcons: recent?.projectIcons,
      chatModels: recent?.chatModels,
      chatWorkers: recent?.chatWorkers,
    };
  }

  /** The Mac's last answer to a presence ping (`{ at }`), or null from a Mac that never answers. */
  alive() {
    return this.#read(this.path("state", "alive"));
  }

  /**
   * Tells the Mac a browser is looking, so it polls and publishes faster.
   * `watching` names the chat open on screen, only with "Show thinking live" on
   * (the Mac then publishes that chat's whole turn, history and queue until it
   * is nil); `recent` asks for more than the default ten recent chats.
   */
  async touchPresence({ watching = null, recent = null } = {}) {
    const presence = { at: this.now(), caps: CAPABILITIES };
    if (typeof watching === "string" && watching !== "") presence.watching = watching;
    if (typeof recent === "number" && recent > RECENT_DEFAULT)
      presence.recent = Math.min(RECENT_MAX, Math.trunc(recent));
    await this.db.set(this.path("state", "presence"), { box: await seal(this.key, presence) });
  }

  /**
   * The verbose view of one chat: `live/<handle>`, with a split turn's
   * history folded in from `live/<handle>-h`. Null when the Mac has written
   * none for this chat (or it is some other chat's).
   */
  async liveTurn(sessionKey) {
    const handle = await liveHandle(sessionKey);
    const [turnDoc, historyDoc] = await Promise.all([
      this.#read(this.path("live", handle)),
      this.#read(this.path("live", liveHistoryHandle(handle))).catch(() => null),
    ]);
    const turn = readTurn(turnDoc, sessionKey);
    return turn ? foldHistory(turn, historyDoc, sessionKey) : null;
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

  /** Seals a command and signs the exact box string; the id is the document's name in `commands`. */
  async #signed(command, privateKey) {
    const box = await seal(this.key, command);
    return {
      id: globalThis.crypto.randomUUID().toLowerCase(),
      document: { box, sig: await sign(privateKey, box), device: this.deviceId },
    };
  }

  #envelope() {
    return {
      nonce: toHex(globalThis.crypto.getRandomValues(new Uint8Array(16))),
      expiresAt: Math.trunc(this.now() + COMMAND_LIFETIME_MS),
    };
  }

  /**
   * The signed document for a reply (Channel.replyDocument on the phone). The
   * command carries the chat, the turn it answers, a nonce and an expiry, and
   * is signed as the exact box string. `mode: "steer"` puts it into the running
   * turn; a queued reply carries no mode at all, byte-for-byte a plain reply.
   * `messageId` (a lowercase UUID the browser chose) lets the browser find the
   * message in the chat's queue later to steer or delete it.
   */
  async replyDocument(session, text, privateKey, { mode, messageId } = {}) {
    if (!session.conductorSessionId) throw new Error("not a chat that can be answered");
    if (messageId !== undefined && !MESSAGE_ID.test(messageId)) throw new Error("bad message id");
    const { nonce, expiresAt } = this.#envelope();
    return this.#signed(
      {
        v: 1,
        sessionId: session.conductorSessionId,
        answersTurn: session.turnId ?? null,
        text,
        ...(mode === "steer" ? { mode: "steer" } : {}),
        nonce,
        expiresAt,
        ...(messageId ? { messageId } : {}),
      },
      privateKey,
    );
  }

  /** The signed document that stops a working chat's turn (the same as Conductor's Stop). */
  async stopDocument(session, privateKey) {
    if (!session.conductorSessionId) throw new Error("not a chat that can be stopped");
    const { nonce, expiresAt } = this.#envelope();
    return this.#signed(
      {
        v: 1,
        kind: "stop",
        sessionId: session.conductorSessionId,
        ...(session.turnId ? { answersTurn: session.turnId } : {}),
        nonce,
        expiresAt,
      },
      privateKey,
    );
  }

  /** The signed document that renames a Conductor chat (the same as renaming it in Conductor). */
  async renameDocument(session, title, privateKey) {
    if (!session.conductorSessionId) throw new Error("not a chat that can be renamed");
    const name = typeof title === "string" ? title.trim() : "";
    if (name === "" || name.length > RENAME_MAX_CHARS) throw new Error("not a name this Mac accepts");
    const { nonce, expiresAt } = this.#envelope();
    return this.#signed(
      { v: 1, kind: "rename", sessionId: session.conductorSessionId, title: name, nonce, expiresAt },
      privateKey,
    );
  }

  /** The signed document that steers a queued message into the turn now (`promote`) or deletes it (`cancel`). */
  async queueDocument(sessionId, messageId, action, privateKey) {
    if (!sessionId || !MESSAGE_ID.test(messageId) || (action !== "promote" && action !== "cancel")) {
      throw new Error("not a queued message this Mac can change");
    }
    const { nonce, expiresAt } = this.#envelope();
    return this.#signed({ v: 1, kind: "queue", sessionId, messageId, action, nonce, expiresAt }, privateKey);
  }

  /**
   * The signed document for any command kind in `command-shapes.js` (start, answer, attach, history,
   * subagent, diff, close, workspace, setup, usage, stats, awake, lidActions, controls, notify, voice,
   * telegramAvatar, hotspot, workflow, film, media, image). `input` is checked the way the Mac checks it
   * (strict types, exactly its keys; a CommandInputError names what is wrong) before anything is sealed.
   * Each kind also has a named method: `channel.startDocument(input, privateKey)`, and so on.
   */
  async commandDocument(kind, input, privateKey) {
    const fields = shape(kind, input);
    const { nonce, expiresAt } = this.#envelope();
    return this.#signed({ v: 1, kind, ...fields, nonce, expiresAt }, privateKey);
  }

  send(id, document) {
    return this.db.set(this.path("commands", id), document);
  }

  /** Takes a command back so the Mac can never run it. True only if the channel confirmed the delete. */
  async deleteCommand(id) {
    try {
      await this.db.delete(this.path("commands", id));
      return true;
    } catch {
      return false;
    }
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

for (const kind of COMMAND_KINDS) {
  Channel.prototype[`${kind}Document`] = function commandOfKind(input, privateKey) {
    return this.commandDocument(kind, input, privateKey);
  };
}
