import { macClientHeaders, relayFetch } from "../cloud/client-version.js";
import { relayBaseUrl, relayKeyHeader } from "../cloud/location.js";

/**
 * The invite as the relay keeps it (cloud/catalyst-relay/functions/squeak_relay/people.js): the one record every surface
 * draws. Times are Unix milliseconds; `settledAt` is 0 while pending (an expired invite's is the moment it lapsed).
 */
export type InviteState = "pending" | "joined" | "declined" | "expired" | "withdrawn";
export interface InviteRecord {
  id: string;
  email: string;
  role: "member" | "viewer";
  state: InviteState;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  settledAt: number;
  /** The Squeak account's name for that address, when it has one. */
  name?: string;
  /** The account, once the address belongs to one. */
  userId?: string;
}

/** One address of a send: the invite, or the plain sentence it was refused with (already in, already invited, Pond full). */
export type InviteResult =
  | { email: string; ok: true; invite: InviteRecord; mailed: boolean }
  | { email: string; ok: false; message: string };

/** The relay refused an invite action; `message` is a plain sentence the surface can show as it is. */
export class InviteRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InviteRefused";
  }
}

/**
 * An invitation as the invited person's account reads it (`GET /invites`): pending ones to answer, and ones already
 * joined whose Pond the Owner's Mac has not opened to the account yet (`joined`: drawn as Connecting).
 */
export interface Invitation {
  id: string;
  pondId: string;
  pondName: string;
  /** Who invited them: the Owner's name. */
  inviter: string;
  role: "member" | "viewer";
  state: "pending" | "joined";
  expiresAt: number;
}

export interface PondInvites {
  /** The invitee's side (the Mac's own account): the invitations waiting for it, and the ones joined but not yet open. */
  mine?(): Promise<Invitation[]>;
  /** Join: the person is a Member in the cloud at once. */
  accept?(inviteId: string): Promise<InviteRecord>;
  decline?(inviteId: string): Promise<InviteRecord>;
  create(
    pondId: string,
    input: { emails: string[]; role: "member" | "viewer"; pondName: string },
  ): Promise<InviteResult[]>;
  list(pondId: string): Promise<InviteRecord[]>;
  resend(pondId: string, inviteId: string): Promise<{ invite: InviteRecord; mailed: boolean }>;
  withdraw(pondId: string, inviteId: string): Promise<InviteRecord>;
  again(
    pondId: string,
    inviteId: string,
    role?: "member" | "viewer",
  ): Promise<{ invite: InviteRecord; mailed: boolean }>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const COULD_NOT_REACH = "Squeak could not reach the cloud. Try again.";
const STATES: readonly InviteState[] = ["pending", "joined", "declined", "expired", "withdrawn"];

/** One record from the relay's JSON, or null when it is not the shape (a newer relay's extra fields are ignored). */
export function readInvite(raw: unknown): InviteRecord | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (
    typeof r.inviteId !== "string" ||
    typeof r.email !== "string" ||
    (r.role !== "member" && r.role !== "viewer") ||
    !STATES.includes(r.state as InviteState)
  )
    return null;
  return {
    id: r.inviteId,
    email: r.email,
    role: r.role,
    state: r.state as InviteState,
    invitedBy: typeof r.invitedBy === "string" ? r.invitedBy : "",
    createdAt: num(r.createdAt),
    expiresAt: num(r.expiresAt),
    settledAt: num(r.settledAt),
    ...(typeof r.name === "string" && r.name ? { name: r.name.slice(0, 100) } : {}),
    ...(typeof r.userId === "string" && r.userId ? { userId: r.userId } : {}),
  };
}

/** One invitation from the relay's JSON, or null when it is not the shape. */
export function readInvitation(raw: unknown): Invitation | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (
    typeof r.inviteId !== "string" ||
    typeof r.pondId !== "string" ||
    (r.role !== "member" && r.role !== "viewer") ||
    (r.state !== "pending" && r.state !== "joined")
  )
    return null;
  return {
    id: r.inviteId,
    pondId: r.pondId,
    pondName: typeof r.pond === "string" && r.pond ? r.pond.slice(0, 200) : "A pond",
    inviter: typeof r.inviter === "string" && r.inviter ? r.inviter.slice(0, 100) : "Someone",
    role: r.role,
    state: r.state,
    expiresAt: typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) ? r.expiresAt : 0,
  };
}

/** The Owner's Mac talking to the relay's invite routes with its own key. Failures are plain sentences, never a body or a key. */
export class HttpPondInvites implements PondInvites {
  private readonly url: string;
  private readonly keyHeader: string;

  constructor(
    baseUrl: string,
    private readonly relayKey: string,
    private readonly fetchImpl: FetchLike = relayFetch,
    hosted = false,
  ) {
    const checked = relayBaseUrl(baseUrl);
    if (!checked) throw new Error("not a Catalyst relay address");
    this.url = checked;
    this.keyHeader = relayKeyHeader(hosted);
  }

  private async call(method: "GET" | "POST", route: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${route}`, {
        method,
        headers: {
          [this.keyHeader]: this.relayKey,
          ...macClientHeaders(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new InviteRefused(COULD_NOT_REACH, 503);
    }
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof json?.message === "string" && json.message ? json.message.slice(0, 300) : "";
      if (response.status === 429)
        throw new InviteRefused("That is a lot of invitations for today. Try again tomorrow.", 429);
      if (response.status === 401) throw new InviteRefused("Sign in to Squeak to invite people.", 401);
      throw new InviteRefused(message || COULD_NOT_REACH, response.status >= 500 ? 503 : response.status);
    }
    if (!json) throw new InviteRefused(COULD_NOT_REACH, 503);
    return json;
  }

  async mine(): Promise<Invitation[]> {
    const body = await this.call("GET", "/invites");
    if (!Array.isArray(body.invites)) throw new InviteRefused(COULD_NOT_REACH, 503);
    return body.invites.flatMap((row: unknown) => {
      const one = readInvitation(row);
      return one ? [one] : [];
    });
  }

  async accept(inviteId: string): Promise<InviteRecord> {
    return (await this.one(`/invites/${encodeURIComponent(inviteId)}/accept`)).invite;
  }

  async decline(inviteId: string): Promise<InviteRecord> {
    return (await this.one(`/invites/${encodeURIComponent(inviteId)}/decline`)).invite;
  }

  private base = (pondId: string): string => `/ponds/${encodeURIComponent(pondId)}/invites`;

  async create(
    pondId: string,
    input: { emails: string[]; role: "member" | "viewer"; pondName: string },
  ): Promise<InviteResult[]> {
    const body = await this.call("POST", this.base(pondId), input);
    if (!Array.isArray(body.results)) throw new InviteRefused(COULD_NOT_REACH, 503);
    return body.results.flatMap((row: unknown): InviteResult[] => {
      const r = row as Record<string, unknown> | null;
      if (!r || typeof r.email !== "string") return [];
      if (r.ok === true) {
        const invite = readInvite(r.invite);
        return invite ? [{ email: r.email, ok: true, invite, mailed: r.mailed === true }] : [];
      }
      return [
        {
          email: r.email,
          ok: false,
          message: typeof r.message === "string" && r.message ? r.message : COULD_NOT_REACH,
        },
      ];
    });
  }

  async list(pondId: string): Promise<InviteRecord[]> {
    const body = await this.call("GET", this.base(pondId));
    if (!Array.isArray(body.invites)) throw new InviteRefused(COULD_NOT_REACH, 503);
    return body.invites.flatMap((row: unknown) => {
      const invite = readInvite(row);
      return invite ? [invite] : [];
    });
  }

  private async one(route: string, body?: unknown): Promise<{ invite: InviteRecord; mailed: boolean }> {
    const answer = await this.call("POST", route, body ?? {});
    const invite = readInvite(answer.invite);
    if (!invite) throw new InviteRefused(COULD_NOT_REACH, 503);
    return { invite, mailed: answer.mailed === true };
  }

  resend(pondId: string, inviteId: string) {
    return this.one(`${this.base(pondId)}/${encodeURIComponent(inviteId)}/resend`);
  }

  async withdraw(pondId: string, inviteId: string): Promise<InviteRecord> {
    return (await this.one(`${this.base(pondId)}/${encodeURIComponent(inviteId)}/withdraw`)).invite;
  }

  again(pondId: string, inviteId: string, role?: "member" | "viewer") {
    return this.one(`${this.base(pondId)}/${encodeURIComponent(inviteId)}/again`, role ? { role } : {});
  }
}
