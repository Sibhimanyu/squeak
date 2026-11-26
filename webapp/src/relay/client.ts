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
export type RespondResult = { status: "ok"; pondId: string | null } | { status: "unauthorized" } | { status: "failed" };

export interface Relay {
  /** The Pond list, Invitations and Needs you in one read: `GET /account/overview` (assumed route, see docs/web-app-v2.md). */
  overview(token: string): Promise<OverviewResult>;
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
    async respond(token, inviteId, answer) {
      try {
        const res = await fetchFn(`${root}/account/invitations/${encodeURIComponent(inviteId)}/${answer}`, {
          method: "POST",
          headers: { [ACCOUNT_HEADER]: token },
          credentials: "omit",
        });
        if (res.status === 401) return { status: "unauthorized" };
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
