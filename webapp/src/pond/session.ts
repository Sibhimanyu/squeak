// One Pond, open in this browser: the access flow, the feed, and what a person may send.
//
// Access: the web is a device like any other. It asks (`POST /account/pond-devices`), the Owner's Mac seals the Pond key(s) to this
// device's box key and signs the grant, and the grant arrives as `keys/<deviceId>` in the change feed. Until then the Pond is
// "connecting: waiting for <Owner>'s Mac" and nothing is readable. A grant is only believed when the Pond's pinned Owner key signed
// it (the relay could otherwise hand us a key of its own choosing).
//
// Writes: a sealed, signed document written with the Pond token the grant carried. Nothing readable by the cloud is ever sent.

import { importChannelKey, seal } from "../../../src/shared/box.js";
import { deviceIdOf, openFromMember, signedText, signText, verifyText } from "../../../src/shared/member-box.js";
import type { PondSummary } from "../../../src/shared/shapes.js";
import type { Relay, WriteResult } from "../relay/client.js";
import type { DeviceIdentity } from "../device/vault.js";
import { commandDoc, type CommandInput } from "./duck-format.js";
import { createPondFeed, type PondData, type PondFeed, type PondKeys } from "./feed.js";
import { readGrant } from "./people-format.js";
import { inboxDoc, ROOM_WRITE_KIND, startDuckDoc, taskRequestDoc } from "./room-format.js";

export type Access = "connecting" | "ready" | "removed" | "failed";

export interface SessionState {
  access: Access;
  /** What the Pond is waiting on while it connects: the Owner's first name. */
  waitingOn: string;
  data: PondData | null;
  /** This device's member id (the member whose device it is), or the device id before the Owner's Mac lists it. */
  selfId: string;
  /** False when no sync has finished yet. */
  loaded: boolean;
  /** The Owner's Mac is not running (its presence has lapsed): messages wait and arrive in order. */
  ownerOffline: boolean;
}

export type SendResult = "sent" | "failed" | "signed-out";

export interface PondSession {
  state(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  /** Reads what changed and opens it. Safe to call as often as notices arrive. */
  refresh(): Promise<void>;
  /** A fresh, time-ordered id for a Room message: the caller keeps it to find the message again when it lands (`roomPostIdOf`). */
  newPostId(): string;
  post(id: string, text: string, replyTo?: string): Promise<SendResult>;
  makeTask(messageId: string): Promise<SendResult>;
  command(input: CommandInput): Promise<SendResult>;
  /** Asks the Owner's Mac to start a Duck: a queued `rposts` ask (it waits for the Mac). */
  startDuck(request: { requestId: string; text: string }): Promise<SendResult>;
  stop(): void;
}

export interface SessionDeps {
  relay: Relay;
  token: string;
  pond: PondSummary;
  device: () => Promise<DeviceIdentity>;
  now?: () => number;
  /** Who of the Pond is online now (the live service); absent or null when unknown. */
  presence?: () => Promise<{ userId: string; online: boolean }[] | null>;
  /** The session ended (a 401). */
  onSignedOut?: () => void;
  /** Something the lists draw from changed. */
  onChange?: () => void;
}

/** Re-ask the Owner's Mac this often while connecting (the relay allows 10 requests a minute per account). */
export const REQUEST_AGAIN_MS = 60_000;
const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

const randomId = (bytes: number): string => {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export function createSession(deps: SessionDeps): PondSession {
  const now = deps.now ?? Date.now;
  const { pond } = deps;
  let state: SessionState = {
    access: "connecting",
    waitingOn: firstName(pond.ownerName),
    data: null,
    selfId: "",
    loaded: false,
    ownerOffline: false,
  };
  const listeners = new Set<(s: SessionState) => void>();
  const set = (patch: Partial<SessionState>): void => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
    deps.onChange?.();
  };

  let feed: PondFeed | null = null;
  let identity: DeviceIdentity | null = null;
  let keys: PondKeys | null = null;
  let grantBox = "";
  let joinToken: string | null = null;
  let askedAt = 0;
  let stopped = false;
  let reading: Promise<void> | null = null;
  let again = false;

  /** Opens the grant if the Owner's Mac has written one for this device and it is the Owner's. */
  const takeGrant = async (id: DeviceIdentity, f: PondFeed): Promise<void> => {
    const doc = f.grant();
    if (!doc || doc.box === grantBox) return;
    const path = `channels/${pond.pondId}/keys/${id.deviceId}`;
    const ownerId = await deviceIdOf(pond.ownerKey);
    if (!doc.sig || doc.device !== ownerId || !(await verifyText(pond.ownerKey, signedText(path, doc.box), doc.sig)))
      return;
    let grant;
    try {
      grant = readGrant(await openFromMember(id.keys.box.privateKey, doc.box));
    } catch {
      return; // sealed to another key: not ours
    }
    if (!grant) return;
    grantBox = doc.box;
    if (grant.removed) {
      keys = null;
      set({ access: "removed" });
      return;
    }
    keys = {
      versions: new Map([...(keys?.versions ?? []), ...grant.keys]),
      current: Math.max(keys?.current ?? 0, grant.current),
      token: grant.token ?? keys?.token ?? null,
    };
  };

  const ask = async (id: DeviceIdentity): Promise<void> => {
    if (now() - askedAt < REQUEST_AGAIN_MS && askedAt > 0) return;
    askedAt = now();
    const result = await deps.relay.requestAccess(deps.token, {
      pondId: pond.pondId,
      publicKey: id.publicKey,
      boxKey: id.boxKey,
    });
    if (result.status === "ok") joinToken = result.token;
    else if (result.status === "unauthorized") deps.onSignedOut?.();
    else if (result.status === "refused" && result.why === "removed") set({ access: "removed" });
    else if (result.status === "failed") askedAt = 0; // try again on the next read
  };

  const read = async (): Promise<void> => {
    if (stopped) return;
    const id = (identity ??= await deps.device());
    const f = (feed ??= createPondFeed({
      relay: deps.relay,
      token: deps.token,
      pondId: pond.pondId,
      ownerKey: pond.ownerKey,
      deviceId: id.deviceId,
    }));
    const synced = await f.sync();
    if (synced === "unauthorized") return deps.onSignedOut?.();
    if (synced === "forbidden") return set({ access: "failed", loaded: true });
    if (synced === "unreachable") {
      if (!state.loaded) set({ loaded: true, access: state.access === "ready" ? "ready" : "connecting" });
      return;
    }
    await takeGrant(id, f);
    if (state.access === "removed") return set({ loaded: true });
    if (!keys) {
      await ask(id);
      return set({ access: "connecting", loaded: true, selfId: id.deviceId });
    }
    const data = await f.data(keys);
    const self = data.members.find((m) => m.deviceIds.includes(id.deviceId));
    const owner = data.members.find((m) => m.role === "owner");
    // Who is online comes from the live service's connections (#122), not from any document: unknown means no banner.
    const people = owner?.accountId ? await deps.presence?.() : null;
    const ownerPresence = people?.find((p) => p.userId === owner?.accountId);
    set({
      access: "ready",
      data,
      loaded: true,
      selfId: self?.id ?? id.deviceId,
      ownerOffline: ownerPresence ? !ownerPresence.online : false,
    });
  };

  const refresh = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = read()
      .catch(() => undefined)
      .finally(() => {
        reading = null;
        if (again && !stopped) {
          again = false;
          void refresh();
        }
      });
    return reading;
  };

  /** Seals a value to this Pond's current key, signs it as this device and writes it. */
  const write = async (kind: string, docId: string, value: unknown): Promise<SendResult> => {
    const id = identity;
    const token = keys?.token?.value ?? joinToken;
    if (!id || !keys || !token || state.access !== "ready") return "failed";
    const path = `channels/${pond.pondId}/${kind}/${docId}`;
    try {
      const key = await importChannelKey(keys.versions.get(keys.current)!);
      const box = `${keys.current}.${await seal(key, value, path)}`;
      const sig = await signText(id.keys.sign.privateKey, signedText(path, box));
      const result: WriteResult = await deps.relay.putDoc(token, path, { box, sig, device: state.selfId, at: now() });
      if (result === "unauthorized") {
        // The Pond token lapsed: ask the Owner's Mac for a fresh grant, and say this one did not go.
        askedAt = 0;
        void refresh();
        return "failed";
      }
      return result === "ok" ? "sent" : "failed";
    } catch {
      return "failed";
    }
  };

  /** A time-ordered id: the Owner's Mac drains the inbox oldest first. */
  const orderedId = (): string => `${now().toString(36).padStart(9, "0")}-${randomId(6)}`;

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    newPostId: orderedId,
    post: (id, text, replyTo) => write(ROOM_WRITE_KIND, id, inboxDoc(id, text, now(), replyTo)),
    makeTask: (messageId) => {
      const id = orderedId();
      return write(ROOM_WRITE_KIND, id, taskRequestDoc(id, messageId, now()));
    },
    startDuck: ({ requestId, text }) => {
      const id = orderedId();
      return write(
        ROOM_WRITE_KIND,
        id,
        startDuckDoc(id, now(), { requestId, text, agent: "claude", model: "default" }),
      );
    },
    command: (input) => {
      const id = randomId(12);
      return write("tcmds", id, commandDoc(input, id, randomId(12), now()));
    },
    stop() {
      stopped = true;
      listeners.clear();
      // What this Pond held in this browser goes with it: the keys, the Pond token, the opened documents.
      keys = null;
      joinToken = null;
      grantBox = "";
      feed = null;
      state = { ...state, data: null };
    },
  };
}
