// One Pond's change feed, read and opened in the browser. `sync()` reads `GET /changes` from where it left off (sealed documents
// only) and keeps the newest copy of each; `data()` opens them with the Pond keys this device was granted, checks each signature
// against the keys the Pond pins (the Owner's key for the Owner's documents, the members' keys for theirs), and hands back what
// the screens draw. The relay never sees a word of it.
//
// Nothing here moves under a reader: a document that has been opened keeps its opened value until a newer copy opens, so a
// partial read, a key that arrives late or a document that fails to open never makes something already drawn vanish.

import { open, importChannelKey } from "../../../src/shared/box.js";
import { deviceIdOf, signedText, verifyText } from "../../../src/shared/member-box.js";
import type { FetchLike, Relay, SealedDoc } from "../relay/client.js";
import { readDuck, readDuckEvents, threadOfEventDoc, type Duck, type DuckEvent } from "./duck-format.js";
import { readMemberDoc, type Member } from "./people-format.js";
import { readMemberPost, readRoomPost, readRoomTask, type RoomPost, type RoomTask } from "./room-format.js";

export type { FetchLike };

export interface PondKeys {
  /** Pond key versions this device holds (a document's box names its version). */
  versions: Map<number, string>;
  current: number;
  token: { value: string; expiresAt: number } | null;
}

export interface PondData {
  /** The newest feed sequence read. */
  head: number;
  members: Member[];
  ducks: Duck[];
  /** Per Duck, its events in order. */
  events: Map<string, DuckEvent[]>;
  /** The Room's posts in the order the Room reads: `seq`, then id. Oldest first. */
  posts: RoomPost[];
  tasks: RoomTask[];
  /** The cloud has paged the oldest Room messages out (25 MB cap): the Room says so above its first post. */
  earlier: boolean;
}

export type SyncResult = "ok" | "unauthorized" | "forbidden" | "unreachable";

const KINDS = new Set(["members", "threads", "tevents", "room", "rtasks", "rposts", "roomnote"]);

interface Held {
  seq: number;
  doc: SealedDoc;
}
interface Opened {
  box: string;
  /** The sealed document this value came from (its signature and signer): a newer copy that will not open does not replace it. */
  doc: SealedDoc;
  value: unknown;
  /** The signature check's outcome and the fingerprint of the keys it was made against. */
  checked: { fp: string; ok: boolean } | null;
}

export interface PondFeedOptions {
  relay: Relay;
  token: string;
  pondId: string;
  ownerKey: string;
  deviceId: string;
}

export interface PondFeed {
  sync(): Promise<SyncResult>;
  data(keys: PondKeys | null): Promise<PondData>;
  /** The sealed grant the Owner's Mac wrote for this device, if it has. */
  grant(): SealedDoc | null;
  head(): number;
  /** Epoch ms of the newest change the relay stamped (null when it stamps none). */
  lastChangeAt(): number | null;
}

export function createPondFeed(o: PondFeedOptions): PondFeed {
  const held = new Map<string, Held>();
  const opened = new Map<string, Opened>();
  const imported = new Map<string, Promise<CryptoKey>>();
  let cursor = 0;
  let head = 0;
  let lastAt: number | null = null;
  let grantDoc: SealedDoc | null = null;
  let running: Promise<SyncResult> | null = null;
  let again = false;
  let ownerId: Promise<string> | null = null;

  const pathOf = (kind: string, id: string): string => `channels/${o.pondId}/${kind}/${id}`;
  const keyOf = (pondKey: string): Promise<CryptoKey> => {
    let k = imported.get(pondKey);
    if (!k) imported.set(pondKey, (k = importChannelKey(pondKey)));
    return k;
  };

  const readAll = async (): Promise<SyncResult> => {
    for (;;) {
      const result = await o.relay.changes(o.token, o.pondId, cursor);
      if (result.status !== "ok") return result.status;
      for (const c of result.changes) {
        head = Math.max(head, c.seq);
        if (c.at !== undefined) lastAt = Math.max(lastAt ?? 0, c.at);
        if (c.kind === "keys") {
          if (c.id === o.deviceId) grantDoc = c.doc;
        } else if (KINDS.has(c.kind)) {
          // A rewritten document keeps the place it first had: nothing already drawn moves when its newer copy arrives.
          if (c.doc) held.set(`${c.kind}/${c.id}`, { seq: held.get(`${c.kind}/${c.id}`)?.seq ?? c.seq, doc: c.doc });
          else {
            held.delete(`${c.kind}/${c.id}`);
            opened.delete(`${c.kind}/${c.id}`);
          }
        }
      }
      cursor = Math.max(cursor, result.next);
      if (!result.more) return "ok";
    }
  };

  // One read at a time; a notice that lands during a read asks for exactly one more.
  const sync = (): Promise<SyncResult> => {
    if (running) {
      again = true;
      return running;
    }
    running = readAll().finally(() => {
      running = null;
      if (again) {
        again = false;
        void sync();
      }
    });
    return running;
  };

  /** Opens one held document with the key its box names, keeping an earlier opened copy when this one will not open. */
  const openOne = async (name: string, kind: string, id: string, h: Held, keys: PondKeys): Promise<Opened | null> => {
    const prior = opened.get(name);
    if (prior && prior.box === h.doc.box) return prior;
    const dot = h.doc.box.indexOf(".");
    const pondKey = dot > 0 ? keys.versions.get(Number(h.doc.box.slice(0, dot))) : undefined;
    if (!pondKey) return prior ?? null;
    try {
      const value = await open(await keyOf(pondKey), h.doc.box.slice(dot + 1), pathOf(kind, id));
      const next: Opened = { box: h.doc.box, doc: h.doc, value, checked: null };
      opened.set(name, next);
      return next;
    } catch {
      return prior ?? null;
    }
  };

  const signedBy = async (
    kind: string,
    id: string,
    h: Held,
    o2: Opened,
    signers: string[],
    fp: string,
  ): Promise<boolean> => {
    if (o2.checked?.fp === fp) return o2.checked.ok;
    const { sig } = o2.doc;
    let ok = false;
    if (sig) {
      const text = signedText(pathOf(kind, id), o2.doc.box);
      for (const key of signers) {
        if (await verifyText(key, text, sig)) {
          ok = true;
          break;
        }
      }
    }
    o2.checked = { fp, ok };
    return ok;
  };

  const data = async (keys: PondKeys | null): Promise<PondData> => {
    const out: PondData = { head, members: [], ducks: [], events: new Map(), posts: [], tasks: [], earlier: false };
    if (!keys) return out;
    const owner = await (ownerId ??= deviceIdOf(o.ownerKey));
    const sorted = [...held.entries()].sort((a, b) => a[1].seq - b[1].seq);
    const ofKind = (kind: string) => sorted.filter(([name]) => name.startsWith(`${kind}/`));
    const idOf = (name: string): string => name.slice(name.indexOf("/") + 1);

    // The Owner's documents: members (who is in, with which keys), the Room and its Tasks.
    for (const [name, h] of ofKind("members")) {
      const id = idOf(name);
      const op = await openOne(name, "members", id, h, keys);
      if (!op || op.doc.device !== owner || !(await signedBy("members", id, h, op, [o.ownerKey], o.ownerKey))) continue;
      const member = readMemberDoc(op.value);
      if (member && member.id === id) out.members.push(member);
    }
    const memberFp = out.members.map((m) => `${m.id}:${m.keys.join(",")}`).join("|");
    const keysOfMember = (id: string): string[] => out.members.find((m) => m.id === id)?.keys ?? [];
    // The Owner's own key counts for the Owner's member id even before a member document says so.
    const keysOfDevice = (id: string): string[] => (id === owner ? [o.ownerKey] : keysOfMember(id));

    for (const [name, h] of ofKind("room")) {
      const id = idOf(name);
      const op = await openOne(name, "room", id, h, keys);
      if (!op || op.doc.device !== owner || !(await signedBy("room", id, h, op, [o.ownerKey], o.ownerKey))) continue;
      const post = readRoomPost(op.value, h.seq);
      if (post && post.id === id) out.posts.push(post);
    }
    for (const [name, h] of ofKind("rtasks")) {
      const id = idOf(name);
      const op = await openOne(name, "rtasks", id, h, keys);
      if (!op || op.doc.device !== owner || !(await signedBy("rtasks", id, h, op, [o.ownerKey], o.ownerKey))) continue;
      const task = readRoomTask(op.value);
      if (task) out.tasks.push(task);
    }
    // Members' own documents: a Duck, and who is online. Signed by a key of the member named in `device`.
    for (const [name, h] of ofKind("threads")) {
      const id = idOf(name);
      const op = await openOne(name, "threads", id, h, keys);
      const device = op?.doc.device ?? "";
      if (!op || !(await signedBy("threads", id, h, op, keysOfDevice(device), `${device}:${memberFp}`))) continue;
      const duck = readDuck(op.value);
      if (duck && duck.id === id && !duck.private && duck.starter === device) out.ducks.push(duck);
    }
    // Members' own Room messages (`rposts`), readable by every Member at once: signed by a key of the member the document names.
    for (const [name, h] of ofKind("rposts")) {
      const id = idOf(name);
      const op = await openOne(name, "rposts", id, h, keys);
      const device = op?.doc.device ?? "";
      const from = out.members.find((m) => m.id === device);
      if (!op || !from || !(await signedBy("rposts", id, h, op, from.keys, `${device}:${memberFp}`))) continue;
      const post = readMemberPost(op.value, h.seq, { id: from.id, name: from.name });
      if (post && post.id === id) out.posts.push(post);
    }
    out.earlier = held.has("roomnote/trim");
    // A Duck's events are the starter's: signed by a key of the Duck's starter.
    const starters = new Map(out.ducks.map((d) => [d.id, d.starter]));
    for (const [name, h] of ofKind("tevents")) {
      const id = idOf(name);
      const threadId = threadOfEventDoc(id);
      const starter = threadId ? starters.get(threadId) : undefined;
      if (!threadId || !starter) continue;
      const op = await openOne(name, "tevents", id, h, keys);
      if (!op || op.doc.device !== starter) continue;
      if (!(await signedBy("tevents", id, h, op, keysOfDevice(starter), `${starter}:${memberFp}`))) continue;
      const list = out.events.get(threadId) ?? [];
      list.push(...readDuckEvents(op.value));
      out.events.set(threadId, list);
    }
    // Every list is in a fixed order, so a re-read of the same documents is the same screen.
    for (const [id, list] of out.events) {
      const seen = new Set<number>();
      out.events.set(
        id,
        list.filter((e) => !seen.has(e.seq) && seen.add(e.seq)).sort((a, b) => a.seq - b.seq),
      );
    }
    out.posts.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.ducks.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    out.tasks.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    out.head = head;
    return out;
  };

  return { sync, data, grant: () => grantDoc, head: () => head, lastChangeAt: () => lastAt };
}
