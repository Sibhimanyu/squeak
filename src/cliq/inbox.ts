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

/** The Firestore calls the relay needs; `FirestoreRest` in real use. */
export interface RelayStore {
  list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>>;
  delete(path: string): Promise<void>;
}

/** Signatures already acted on, so a copied record cannot run twice. */
export interface SeenSignatures {
  hasSeenCliqSignature(sig: string): boolean;
  markCliqSignatureSeen(sig: string): void;
}

/**
 * The Mac's side of the Cliq relay. Zoho would not let the Mac read Cliq
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
  private readonly collection: string;
  private readonly secret: string;
  private readonly seen: SeenSignatures;
  /** Signatures of the records the last `list` returned, by document id. */
  private readonly pending = new Map<string, string>();

  constructor(options: { store: RelayStore; relayId: string; secret: string; seen: SeenSignatures }) {
    this.store = options.store;
    this.collection = `cliq/${options.relayId}/inbox`;
    this.secret = options.secret;
    this.seen = options.seen;
  }

  async list(): Promise<CliqInboxRecord[]> {
    const records: CliqInboxRecord[] = [];
    for (const { id, doc } of await this.store.list(this.collection)) {
      const record = this.verify(id, doc);
      if (record) {
        records.push(record);
      } else {
        await this.store.delete(`${this.collection}/${id}`).catch(() => undefined);
      }
    }
    return records.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
  }

  /** Claim a record: delete it, and remember its signature so a copy is refused. */
  async delete(id: string): Promise<void> {
    await this.store.delete(`${this.collection}/${id}`);
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
