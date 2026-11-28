// The web app's calls to the relay. Every account call carries the account token as `x-squeak-account` and omits cookies
// (the web and the relay are on different origins; no cookie crosses domains). A relay that cannot be reached, or answers
// anything but the documented codes, is `unreachable`: only a clean 401 means signed out.

import {
  parseAccountInfo,
  parseInvitePreview,
  parsePondsOverview,
  type AccountInfo,
  type InvitePreview,
  type PondRole,
  type PondsOverview,
} from "../../../src/shared/shapes.js";

export type MeResult = { status: "ok"; account: AccountInfo } | { status: "unauthorized" } | { status: "unreachable" };

export type OverviewResult =
  | { status: "ok"; overview: PondsOverview }
  | { status: "unauthorized" }
  | { status: "unreachable" };

/** Join answers the Pond to open; Decline answers nothing. Both only after the cloud confirms. */
export type RespondResult =
  | { status: "ok"; pondId: string | null }
  | { status: "unauthorized" }
  /** The cloud said no on purpose: another address (`email`), a full Pond (`full`) or an invite already settled (`withdrawn`, `expired`, `joined`, `declined`). */
  | { status: "refused"; why: string; /** The relay's own plain sentence, when it gave one. */ message?: string }
  | { status: "failed" };

/** A sealed document as the relay stores it (`ChannelDoc` in src/cloud/store.ts). The relay never sees what is inside `box`. */
export interface SealedDoc {
  box: string;
  sig?: string;
  device?: string;
  at?: number;
}

export interface FeedChange {
  seq: number;
  kind: string;
  id: string;
  /** Null is a delete. */
  doc: SealedDoc | null;
  /** Epoch ms the change was written (a time, never content). */
  at?: number;
}

export type ChangesResult =
  | { status: "ok"; changes: FeedChange[]; next: number; more: boolean }
  | { status: "unauthorized" }
  /** Not (or no longer) a member of that Pond. */
  | { status: "forbidden" }
  | { status: "unreachable" };

export type AccessResult =
  | { status: "ok"; token: string; expiresAt: number }
  | { status: "unauthorized" }
  /** The account is not in the Pond (`pond`) or this device was removed from it (`removed`). */
  | { status: "refused"; why: string }
  | { status: "failed" };

export type WriteResult = "ok" | "unauthorized" | "failed";

/** The People sheet's data: `GET /ponds/<id>/people`. Invites come only for the Owner. */
export interface PondPerson {
  userId: string;
  name: string;
  email: string;
  role: PondRole;
  /** Epoch ms of the person's newest device activity; 0 when never. */
  lastSeenAt: number;
}
export type InviteState = "pending" | "joined" | "declined" | "expired" | "withdrawn";
export interface PondInvite {
  inviteId: string;
  email: string;
  role: "member" | "viewer";
  state: InviteState;
  createdAt: number;
  /** When it reached its state (the time shown: "Declined · 2 h ago"); `createdAt` while pending. */
  settledAt: number;
  expiresAt: number;
  /** The email could not be delivered after the relay's retries: the row says so and offers Resend. */
  emailFailed?: boolean;
}
export interface PondPeople {
  owner: string;
  name: string;
  cap: number;
  members: PondPerson[];
  invites: PondInvite[];
}
export type PeopleResult =
  | { status: "ok"; people: PondPeople }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "unreachable" };

/** One change by the Owner (or a leave): done only when the cloud says so; `message` is the relay's own plain sentence, if it gave one. */
export type ActResult = { status: "ok" } | { status: "unauthorized" } | { status: "failed"; message?: string };
export type InviteAction = "resend" | "withdraw" | "again";

/** One of the account's devices (`GET /account/devices`), shown in Settings and never in a Pond. */
export interface AccountDevice {
  deviceId: string;
  name: string;
  kind: "mac" | "web" | "iphone";
  createdAt: number;
  lastSeenAt: number;
  thisDevice: boolean;
}
export type DevicesResult =
  | { status: "ok"; devices: AccountDevice[] }
  | { status: "unauthorized" }
  | { status: "unreachable" };

export interface Relay {
  /** The Pond's people and (Owner) invites: `GET /ponds/<id>/people`. */
  people(token: string, pondId: string): Promise<PeopleResult>;
  /** Owner: one invite per address with the role. A per-address failure comes back as its own sentence. */
  invite(token: string, pondId: string, emails: string[], role: "member" | "viewer"): Promise<ActResult>;
  /** Owner: `POST /ponds/<id>/invites/<inviteId>/resend|withdraw|again`. */
  inviteAction(token: string, pondId: string, inviteId: string, action: InviteAction): Promise<ActResult>;
  /** Owner: `POST /ponds/<id>/members/<userId>/role`. */
  setRole(token: string, pondId: string, userId: string, role: "member" | "viewer"): Promise<ActResult>;
  /** Owner: `DELETE /ponds/<id>/members/<userId>`. */
  removeMember(token: string, pondId: string, userId: string): Promise<ActResult>;
  /** Member or Viewer: `POST /account/pond-leaves`. */
  leave(token: string, pondId: string): Promise<ActResult>;
  /** Owner: `DELETE /ponds/<id>` with the typed name. */
  deletePond(token: string, pondId: string, name: string): Promise<ActResult>;
  /** `GET /account/devices?deviceId=` (this device marked) and `DELETE /account/devices/<id>`. */
  devices(token: string, selfId: string | null): Promise<DevicesResult>;
  removeDevice(token: string, deviceId: string): Promise<ActResult>;
  /** The Pond list and Invitations, metadata only: `GET /account/overview` (assumed route, see docs/web-app-v2.md). */
  overview(token: string): Promise<OverviewResult>;
  /** Register this browser as a device of the account: `POST /account/devices {publicKey, name, kind: "web"}`. */
  registerDevice(token: string, device: { publicKey: string; name: string }): Promise<WriteResult>;
  /** Ask the Pond's Owner Mac to seal the Pond key to this device: `POST /account/pond-devices` (docs/ponds.md, "Members are accounts"). */
  requestAccess(token: string, request: { pondId: string; publicKey: string; boxKey: string }): Promise<AccessResult>;
  /** The Pond's change feed after `since`, oldest first: `GET /changes?pond=&since=`. Sealed documents; no content is readable here. */
  changes(token: string, pondId: string, since: number): Promise<ChangesResult>;
  /** Writes one sealed document with the Pond token the Owner's Mac granted: `PUT /doc?path=`. */
  putDoc(pondToken: string, path: string, doc: SealedDoc): Promise<WriteResult>;
  /** `POST /account/invitations/<id>/join|decline` (assumed route; the invitation lifecycle itself is #126). */
  respond(token: string, inviteId: string, answer: "join" | "decline"): Promise<RespondResult>;
  /** Who this token is: `GET /me`. */
  me(token: string): Promise<MeResult>;
  /** What an invite link is for, readable before sign-in: `GET /invites/preview?code=`. Null when unknown or unreachable. */
  invitePreview(code: string): Promise<InvitePreview | null>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const ACCOUNT_HEADER = "x-squeak-account";

export function createRelay(base: string, fetchFn: FetchLike = (url, init) => fetch(url, init)): Relay {
  const root = base.replace(/\/+$/, "");
  const act = async (url: string, init: RequestInit): Promise<ActResult> => {
    try {
      const res = await fetchFn(url, { ...init, credentials: "omit" });
      if (res.status === 401) return { status: "unauthorized" };
      if (res.ok) {
        // 200 from the invite routes can carry per-address failures: the first one's own sentence is the answer.
        const body =
          res.status === 200 ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
        const results = Array.isArray(body?.["results"]) ? (body["results"] as Record<string, unknown>[]) : [];
        const bad = results.find((r) => r["ok"] === false);
        return bad
          ? { status: "failed", ...(typeof bad["message"] === "string" ? { message: bad["message"] } : {}) }
          : { status: "ok" };
      }
      const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
      return { status: "failed", ...(typeof body?.message === "string" ? { message: body.message } : {}) };
    } catch {
      return { status: "failed" };
    }
  };
  const send = (token: string, url: string, body: unknown, method = "POST"): Promise<ActResult> =>
    act(url, {
      method,
      headers: { [ACCOUNT_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const pondUrl = (pondId: string): string => `${root}/ponds/${encodeURIComponent(pondId)}`;
  return {
    async people(token, pondId) {
      try {
        const res = await fetchFn(`${pondUrl(pondId)}/people`, {
          headers: { [ACCOUNT_HEADER]: token },
          credentials: "omit",
        });
        if (res.status === 401) return { status: "unauthorized" };
        if (res.status === 403 || res.status === 404) return { status: "forbidden" };
        if (res.status !== 200) return { status: "unreachable" };
        const b = (await res.json()) as Record<string, unknown>;
        if (!Array.isArray(b["members"])) return { status: "unreachable" };
        const members: PondPerson[] = [];
        for (const m of b["members"] as Record<string, unknown>[]) {
          const role = m?.["role"];
          if (typeof m?.["userId"] !== "string" || (role !== "owner" && role !== "member" && role !== "viewer"))
            continue;
          members.push({
            userId: m["userId"],
            name: typeof m["name"] === "string" ? m["name"] : "",
            email: typeof m["email"] === "string" ? m["email"] : "",
            role,
            lastSeenAt: num(m["lastSeenAt"]),
          });
        }
        const invites: PondInvite[] = [];
        for (const i of (Array.isArray(b["invites"]) ? b["invites"] : []) as Record<string, unknown>[]) {
          const state = i?.["state"];
          if (typeof i?.["inviteId"] !== "string" || typeof i["email"] !== "string") continue;
          if (!["pending", "joined", "declined", "expired", "withdrawn"].includes(String(state))) continue;
          invites.push({
            inviteId: i["inviteId"],
            email: i["email"],
            role: i["role"] === "viewer" ? "viewer" : "member",
            state: state as InviteState,
            createdAt: num(i["createdAt"]),
            settledAt: num(i["settledAt"]) || num(i["createdAt"]),
            expiresAt: num(i["expiresAt"]),
            ...(i["emailFailed"] === true ? { emailFailed: true } : {}),
          });
        }
        const owner = typeof b["owner"] === "string" ? b["owner"] : "";
        const name = typeof b["name"] === "string" ? b["name"] : "";
        return { status: "ok", people: { owner, name, cap: num(b["cap"]) || 10, members, invites } };
      } catch {
        return { status: "unreachable" };
      }
    },
    invite: (token, pondId, emails, role) => send(token, `${pondUrl(pondId)}/invites`, { emails, role }),
    inviteAction: (token, pondId, inviteId, action) =>
      send(token, `${pondUrl(pondId)}/invites/${encodeURIComponent(inviteId)}/${action}`, {}),
    setRole: (token, pondId, userId, role) =>
      send(token, `${pondUrl(pondId)}/members/${encodeURIComponent(userId)}/role`, { role }),
    removeMember: (token, pondId, userId) =>
      send(token, `${pondUrl(pondId)}/members/${encodeURIComponent(userId)}`, {}, "DELETE"),
    leave: (token, pondId) => send(token, `${root}/account/pond-leaves`, { pondId }),
    deletePond: (token, pondId, name) => send(token, pondUrl(pondId), { name }, "DELETE"),
    async devices(token, selfId) {
      try {
        const query = selfId ? `?deviceId=${encodeURIComponent(selfId)}` : "";
        const res = await fetchFn(`${root}/account/devices${query}`, {
          headers: { [ACCOUNT_HEADER]: token },
          credentials: "omit",
        });
        if (res.status === 401) return { status: "unauthorized" };
        if (res.status !== 200) return { status: "unreachable" };
        const b = (await res.json()) as { devices?: unknown };
        if (!Array.isArray(b.devices)) return { status: "unreachable" };
        const devices: AccountDevice[] = [];
        for (const d of b.devices as Record<string, unknown>[]) {
          if (typeof d?.["deviceId"] !== "string" || typeof d["name"] !== "string") continue;
          devices.push({
            deviceId: d["deviceId"],
            name: d["name"],
            kind: d["kind"] === "mac" || d["kind"] === "iphone" ? d["kind"] : "web",
            createdAt: num(d["createdAt"]),
            lastSeenAt: num(d["lastSeenAt"]),
            thisDevice: d["thisDevice"] === true,
          });
        }
        return { status: "ok", devices };
      } catch {
        return { status: "unreachable" };
      }
    },
    removeDevice: (token, deviceId) =>
      act(`${root}/account/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
        headers: { [ACCOUNT_HEADER]: token },
      }),
    async overview(token) {
      try {
        const res = await fetchFn(`${root}/account/overview`, {
          headers: { [ACCOUNT_HEADER]: token },
          credentials: "omit",
        });
        if (res.status === 401) return { status: "unauthorized" };
        if (res.status !== 200) return { status: "unreachable" };
        const overview = parsePondsOverview(await res.json());
        return overview ? { status: "ok", overview } : { status: "unreachable" };
      } catch {
        return { status: "unreachable" };
      }
    },
    async registerDevice(token, device) {
      try {
        const res = await fetchFn(`${root}/account/devices`, {
          method: "POST",
          headers: { [ACCOUNT_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ publicKey: device.publicKey, name: device.name, kind: "web" }),
          credentials: "omit",
        });
        return res.status === 401 ? "unauthorized" : res.status === 200 || res.status === 204 ? "ok" : "failed";
      } catch {
        return "failed";
      }
    },
    async requestAccess(token, request) {
      try {
        const res = await fetchFn(`${root}/account/pond-devices`, {
          method: "POST",
          headers: { [ACCOUNT_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ ...request, client: "web" }),
          credentials: "omit",
        });
        if (res.status === 401) return { status: "unauthorized" };
        if (res.status === 403) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          return { status: "refused", why: typeof body?.error === "string" ? body.error : "pond" };
        }
        if (res.status !== 200) return { status: "failed" };
        const body = (await res.json().catch(() => null)) as { token?: unknown; expiresAt?: unknown } | null;
        if (typeof body?.token !== "string" || typeof body.expiresAt !== "number") return { status: "failed" };
        return { status: "ok", token: body.token, expiresAt: body.expiresAt };
      } catch {
        return { status: "failed" };
      }
    },
    async changes(token, pondId, since) {
      try {
        const res = await fetchFn(`${root}/changes?pond=${encodeURIComponent(pondId)}&since=${since}&limit=100`, {
          headers: { [ACCOUNT_HEADER]: token },
          credentials: "omit",
        });
        if (res.status === 401) return { status: "unauthorized" };
        if (res.status === 403 || res.status === 404) return { status: "forbidden" };
        if (res.status !== 200) return { status: "unreachable" };
        const body = (await res.json()) as { changes?: unknown; next?: unknown; more?: unknown };
        if (!Array.isArray(body.changes) || typeof body.next !== "number") return { status: "unreachable" };
        const changes: FeedChange[] = [];
        for (const c of body.changes as Record<string, unknown>[]) {
          if (typeof c?.["seq"] !== "number" || typeof c["kind"] !== "string" || typeof c["id"] !== "string") continue;
          const doc = c["doc"];
          // `roomnote` is the relay's own plain note (nothing sealed): only that it exists matters.
          const sealed =
            doc && typeof doc === "object" && typeof (doc as SealedDoc).box === "string"
              ? (doc as SealedDoc)
              : doc && typeof doc === "object" && c["kind"] === "roomnote"
                ? { box: "" }
                : null;
          changes.push({
            seq: c["seq"],
            kind: c["kind"],
            id: c["id"],
            doc: sealed,
            ...(typeof c["at"] === "number" ? { at: c["at"] } : {}),
          });
        }
        return { status: "ok", changes, next: body.next, more: body.more === true };
      } catch {
        return { status: "unreachable" };
      }
    },
    async putDoc(pondToken, path, doc) {
      try {
        const res = await fetchFn(`${root}/doc?path=${encodeURIComponent(path)}`, {
          method: "PUT",
          headers: { "x-squeak-pond-token": pondToken, "content-type": "application/json" },
          body: JSON.stringify({ doc }),
          credentials: "omit",
        });
        return res.status === 401 ? "unauthorized" : res.status === 204 || res.status === 200 ? "ok" : "failed";
      } catch {
        return "failed";
      }
    },
    async respond(token, inviteId, answer) {
      try {
        const res = await fetchFn(`${root}/account/invitations/${encodeURIComponent(inviteId)}/${answer}`, {
          method: "POST",
          headers: { [ACCOUNT_HEADER]: token },
          credentials: "omit",
        });
        if (res.status === 401) return { status: "unauthorized" };
        if (res.status === 403 || res.status === 409) {
          const refusal = (await res.json().catch(() => null)) as {
            error?: unknown;
            state?: unknown;
            message?: unknown;
            invitation?: { state?: unknown } | null;
          } | null;
          // `error` keeps the words the web has always read; the relay's fresh `invitation` view says the same when it is there.
          const why = refusal?.error === "state" ? (refusal.state ?? refusal.invitation?.state) : refusal?.error;
          const message = typeof refusal?.message === "string" && refusal.message ? refusal.message : undefined;
          return typeof why === "string"
            ? { status: "refused", why, ...(message ? { message } : {}) }
            : { status: "failed" };
        }
        if (res.status !== 200 && res.status !== 204) return { status: "failed" };
        const body = res.status === 200 ? ((await res.json().catch(() => null)) as { pondId?: unknown } | null) : null;
        return { status: "ok", pondId: typeof body?.pondId === "string" ? body.pondId : null };
      } catch {
        return { status: "failed" };
      }
    },
    async me(token) {
      try {
        const res = await fetchFn(`${root}/me`, { headers: { [ACCOUNT_HEADER]: token }, credentials: "omit" });
        if (res.status === 401) return { status: "unauthorized" };
        if (res.status !== 200) return { status: "unreachable" };
        const account = parseAccountInfo(await res.json());
        return account ? { status: "ok", account } : { status: "unreachable" };
      } catch {
        return { status: "unreachable" };
      }
    },
    async invitePreview(code) {
      try {
        const res = await fetchFn(`${root}/invites/preview?code=${encodeURIComponent(code)}`, { credentials: "omit" });
        return res.status === 200 ? parseInvitePreview(await res.json()) : null;
      } catch {
        return null;
      }
    },
  };
}
