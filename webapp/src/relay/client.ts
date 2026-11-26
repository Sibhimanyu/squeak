// The web app's calls to the relay. Every account call carries the account token as `x-squeak-account` and omits cookies
// (the web and the relay are on different origins; no cookie crosses domains). A relay that cannot be reached, or answers
// anything but the documented codes, is `unreachable`: only a clean 401 means signed out.

import {
  parseAccountInfo,
  parseInvitePreview,
  parsePondsOverview,
  type AccountInfo,
  type InvitePreview,
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
  | { status: "refused"; why: string }
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

export interface Relay {
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
  return {
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
          const refusal = (await res.json().catch(() => null)) as { error?: unknown; state?: unknown } | null;
          const why = refusal?.error === "state" ? refusal.state : refusal?.error;
          return typeof why === "string" ? { status: "refused", why } : { status: "failed" };
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
