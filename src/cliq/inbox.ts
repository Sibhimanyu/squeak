import { createHmac, timingSafeEqual } from "node:crypto";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { logger } from "../utils/logger.js";

/**
 * One thing done in Cliq, written by one of the bot's Deluge handlers
 * (docs/cliq.md): a message typed to the bot, a button tapped, a reply form
 * sent. `msgid` is the card it acted on, when there is one.
 */
export interface CliqInboxRecord {
  id: string;
  kind: "message" | "button" | "reply" | "unknown";
  arg: string;
  msgid: string | null;
  body: string;
  userId: string;
  sentAt: number | null;
}

/**
 * Cliq spells one message id three ways: `1790492118179%2033850494115` from
 * the post API, a space once that is decoded, and `1606715211110_614577765734`
 * in handler payloads. Keyed on the digits alone, all three are one card.
 */
export function canonicalMessageId(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded after all.
  }
  const parts = decoded.split(/\D+/).filter(Boolean);
  return parts.length > 0 ? parts.join("_") : null;
}

/** What the handlers sign: `zoho.encryption.hmacsha256(secret, box, "hex")`. */
export function signCliqBox(secret: string, box: string): string {
  return createHmac("sha256", secret).update(box, "utf8").digest("hex");
}

/** The calls the relay needs: `RtdbRest` (streamed) or `FirestoreRest` (polled) in real use. */
export interface RelayStore {
  list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>>;
  delete(path: string): Promise<void>;
  watch?(path: string, onChange: () => void, options?: { onError?: (error: Error) => void }): () => void;
}

/** Ids of records read from the legacy store carry this, so a delete goes back to where they came from. */
const LEGACY = "legacy~";
/** Ids of records read from the Firebase inbox a Catalyst Mac still reads during the switch. */
const FIREBASE = "firebase~";
const FIREBASE_LEGACY = "firebase-legacy~";

/** Signatures already acted on, so a copied record cannot run twice. */
export interface SeenSignatures {
  hasSeenCliqSignature(sig: string): boolean;
  markCliqSignatureSeen(sig: string): void;
}

/**
 * The Mac's side of the Cliq relay. On Catalyst the handlers PUT `{box, sig, at}` to the relay's `cliq` kind and this
 * lists, watches (Data Streams) and deletes it through the daemon's cloud store; the rest of this comment is the
 * original Firebase design, which is kept while a Mac is still on Firebase.
 * Zoho would not let the Mac read Cliq
 * (`oauth_app_blocked` for a Self Client on a managed org), but Cliq's
 * handlers can post out, so they write each record to
 * `cliq/<relay>/inbox` in the Firebase project the phone channel already
 * uses, and this reads it.
 *
 * Firestore is an untrusted pipe here, as it is for the phone. A record
 * counts only if its box carries a valid HMAC from the secret that lives in
 * the handlers and in Squeak's `.env`; anything else is deleted unread. The
 * channel then checks who sent it, how old it is, and which card it names.
 */
export class CliqRelayInbox {
  private readonly store: RelayStore;
  /**
   * Firestore, read as well while the relay lives in the Realtime Database:
   * handlers pasted before the move still post there until they are pasted
   * again, and their records must not be stranded.
   */
  private readonly legacy: RelayStore | null;
  private readonly collection: string;
  /**
   * During the move to Catalyst: the Firebase inbox (`cliq/<relay>/inbox`) the bot's handlers still post to until
   * the owner pastes the new ones. Read as well as the Catalyst kind, same verification, one seen-set.
   */
  private readonly firebase: { store: RelayStore; legacy: RelayStore | null; collection: string } | null;
  private readonly secret: string;
  private readonly seen: SeenSignatures;
  /** Signatures of the records the last `list` returned, by document id. */
  private readonly pending = new Map<string, string>();

  constructor(options: {
    store: RelayStore;
    legacy?: RelayStore | null;
    relayId: string;
    secret: string;
    seen: SeenSignatures;
    /** The relay is the Catalyst relay's `cliq` kind (channels/<relayId>/cliq), not `cliq/<relayId>/inbox`. */
    catalyst?: boolean;
    /** Catalyst only: the Firebase stores to keep reading while handlers are not yet re-pasted. */
    firebase?: { store: RelayStore; legacy?: RelayStore | null } | null;
  }) {
    this.store = options.store;
    this.legacy = options.legacy ?? null;
    this.collection = options.catalyst ? `channels/${options.relayId}/cliq` : `cliq/${options.relayId}/inbox`;
    this.firebase =
      options.catalyst && options.firebase
        ? {
            store: options.firebase.store,
            legacy: options.firebase.legacy ?? null,
            collection: `cliq/${options.relayId}/inbox`,
          }
        : null;
    this.secret = options.secret;
    this.seen = options.seen;
  }

  async list(): Promise<CliqInboxRecord[]> {
    const listed = (await this.store.list(this.collection)).map(({ id, doc }) => ({ id, doc }));
    if (this.legacy) {
      // A legacy store that is down must not hold up the live one.
      const old = await this.legacy.list(this.collection).catch(() => []);
      listed.push(...old.map(({ id, doc }) => ({ id: `${LEGACY}${id}`, doc })));
    }
    if (this.firebase) {
      // A Firebase that is down must not hold up Catalyst.
      const fb = await this.firebase.store.list(this.firebase.collection).catch(() => []);
      listed.push(...fb.map(({ id, doc }) => ({ id: `${FIREBASE}${id}`, doc })));
      if (this.firebase.legacy) {
        const old = await this.firebase.legacy.list(this.firebase.collection).catch(() => []);
        listed.push(...old.map(({ id, doc }) => ({ id: `${FIREBASE_LEGACY}${id}`, doc })));
      }
    }
    const records: CliqInboxRecord[] = [];
    const inThisPass = new Set<string>();
    for (const { id, doc } of listed) {
      // The same record on two inboxes is one record: the first is handled, the copy is left and removed as a
      // replay once the first is claimed.
      if (typeof doc.sig === "string" && inThisPass.has(doc.sig) && this.validSig(doc)) {
        continue;
      }
      const record = this.verify(id, doc);
      if (record && doc.sig) {
        inThisPass.add(doc.sig);
      }
      if (record) {
        records.push(record);
      } else {
        await this.remove(id).catch(() => undefined);
      }
    }
    return records.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
  }

  /**
   * Calls `onChange` when a record lands, when the store can stream (the
   * Realtime Database); null when it can only be polled. A change only wakes
   * a pass: every record is still verified as it is listed.
   */
  watch(onChange: () => void): (() => void) | null {
    const onError = (error: Error) => logger.debug("cliq relay watch dropped; reconnecting", { error: error.message });
    const stops: Array<() => void> = [];
    if (this.store.watch) stops.push(this.store.watch(this.collection, onChange, { onError }));
    if (this.firebase?.store.watch) {
      stops.push(this.firebase.store.watch(this.firebase.collection, onChange, { onError }));
    }
    if (stops.length === 0) {
      return null;
    }
    return () => stops.forEach((stop) => stop());
  }

  /** Names the inboxes this reads, for the start-up log line. */
  describe(): string {
    return this.firebase
      ? `${this.collection} (Catalyst) and ${this.firebase.collection} (Firebase, until the handlers are re-pasted)`
      : this.collection;
  }

  private validSig(doc: ChannelDoc): boolean {
    const sig = doc.sig ?? "";
    return (
      /^[0-9a-f]{64}$/.test(sig) &&
      timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(signCliqBox(this.secret, doc.box), "hex"))
    );
  }

  private remove(id: string): Promise<void> {
    if (this.firebase) {
      if (id.startsWith(FIREBASE))
        return this.firebase.store.delete(`${this.firebase.collection}/${id.slice(FIREBASE.length)}`);
      if (id.startsWith(FIREBASE_LEGACY) && this.firebase.legacy)
        return this.firebase.legacy.delete(`${this.firebase.collection}/${id.slice(FIREBASE_LEGACY.length)}`);
    }
    if (this.legacy && id.startsWith(LEGACY)) {
      return this.legacy.delete(`${this.collection}/${id.slice(LEGACY.length)}`);
    }
    return this.store.delete(`${this.collection}/${id}`);
  }

  /** Claim a record: delete it, and remember its signature so a copy is refused. */
  async delete(id: string): Promise<void> {
    await this.remove(id);
    const sig = this.pending.get(id);
    this.pending.delete(id);
    if (sig) {
      this.seen.markCliqSignatureSeen(sig);
    }
  }

  private verify(id: string, doc: ChannelDoc): CliqInboxRecord | null {
    const sig = doc.sig ?? "";
    const expected = signCliqBox(this.secret, doc.box);
    const valid = /^[0-9a-f]{64}$/.test(sig) && timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
    if (!valid) {
      logger.warn("cliq relay record with a bad signature dropped");
      return null;
    }
    if (this.seen.hasSeenCliqSignature(sig)) {
      logger.warn("cliq relay record replayed; dropped");
      return null;
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(doc.box) as Record<string, unknown>;
    } catch {
      return null;
    }
    this.pending.set(id, sig);
    const kind = asString(value.kind);
    const sentAt = Number(value.sentat);
    return {
      id,
      kind: kind === "message" || kind === "button" || kind === "reply" ? kind : "unknown",
      arg: asString(value.arg),
      msgid: canonicalMessageId(asString(value.msgid)),
      body: asString(value.body),
      userId: asString(value.userid),
      sentAt: Number.isFinite(sentAt) && sentAt > 0 ? sentAt : null,
    };
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
