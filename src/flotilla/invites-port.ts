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
  /** The email could not be delivered after the relay's retries: the People list says so and offers Resend. */
  emailFailed?: true;
}

/** What happened to one address of a send. */
export type InviteOutcome = "invited" | "already-member" | "already-invited" | "refused";

/**
 * One address of a send: the invite (`ok`), or the plain sentence it was refused with. The email is queued at the relay and
 * sent after its answer, so `ok` means the row is written. An address that is already invited carries the waiting invite.
 */
export type InviteResult =
  | { email: string; ok: true; status: "invited"; invite: InviteRecord }
  | { email: string; ok: false; status: Exclude<InviteOutcome, "invited">; message: string; invite?: InviteRecord };

/**
 * The relay refused an invite action; `message` is a plain sentence the surface can show as it is. `invitation` is the fresh
 * view the relay attached (what the invitation is now), so the caller redraws from the refusal instead of guessing.
 */
export class InviteRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly invitation?: Invitation,
  ) {
    super(message);
    this.name = "InviteRefused";
  }
}

/**
 * An invitation as the relay's Invitation module computes it for the viewer (`InvitationView`, people.js): every field is the
 * relay's, nothing here is decided. `GET /account/invitations` lists the pending ones to answer and the ones already joined
 * whose Pond the Owner's Mac has not opened to the account yet (`joined`: drawn as Connecting); every action answers the fresh one.
 */
export type InvitationState = "pending" | "joined" | "declined" | "withdrawn" | "expired";
export interface Invitation {
  id: string;
  pondId: string;
  pondName: string;
  /** Who invited them: the inviter's name, or their email masked when they have no name; never blank. */
  inviter: string;
  role: "member" | "viewer";
  state: InvitationState;
  /** This account is a Member of the Pond now. */
  youAreMember: boolean;
  expiresAt: number;
}

/** What Join answers: the Pond to open, and the invitation as it is now. */
export interface JoinAnswer {
  pondId: string;
  pondName: string;
  invitation: Invitation;
}

export interface PondInvites {
  /** The invitee's side (the Mac's own account): the invitations waiting for it, and the ones joined but not yet open. */
  mine?(): Promise<Invitation[]>;
  /** Join, idempotent: the person is a Member in the cloud at once (already joined or already a Member is success). */
  accept?(inviteId: string): Promise<JoinAnswer>;
  decline?(inviteId: string): Promise<Invitation>;
  /**
   * Makes the Pond exist at the relay with this account as Owner (`POST /ponds/<id>/share`); idempotent. "unsupported" is a
   * relay that has no such route yet: the first invite then names the Pond (`pondName`) and the relay makes it, as before.
   */
  ensurePond?(pondId: string, name: string): Promise<"shared" | "unsupported">;
  /** `pondName` is sent only to a relay without the share route; a current relay refuses an invite to a Pond it does not know. */
  create(
    pondId: string,
    input: { emails: string[]; role: "member" | "viewer"; pondName?: string },
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
const ACCOUNT_NAME_HEADER = "x-squeak-account-name";

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
    ...(r.emailFailed === true ? { emailFailed: true as const } : {}),
  };
}

/** One invitation view from the relay's JSON, or null when it is not the shape. */
export function readInvitation(raw: unknown): Invitation | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (
    typeof r.inviteId !== "string" ||
    typeof r.pondId !== "string" ||
    (r.role !== "member" && r.role !== "viewer") ||
    !STATES.includes(r.state as InviteState)
  )
    return null;
  const inviter = (r.inviter as { name?: unknown } | null)?.name;
  return {
    id: r.inviteId,
    pondId: r.pondId,
    pondName: typeof r.pondName === "string" && r.pondName ? r.pondName.slice(0, 200) : "A pond",
    inviter: typeof inviter === "string" && inviter.trim() ? inviter.slice(0, 100) : "A teammate",
    role: r.role,
    state: r.state as InvitationState,
    youAreMember: r.youAreMember === true,
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
    /** This Mac's account name, sent with its own key so an invite names who sent it and a name is never blanked. */
    private readonly accountName: () => string | null = () => null,
  ) {
    const checked = relayBaseUrl(baseUrl);
    if (!checked) throw new Error("not a Catalyst relay address");
    this.url = checked;
    this.keyHeader = relayKeyHeader(hosted);
  }

  private nameHeader(): Record<string, string> {
    const name = this.accountName()?.trim();
    return name ? { [ACCOUNT_NAME_HEADER]: encodeURIComponent(name.slice(0, 100)) } : {};
  }

  private async call(method: "GET" | "POST", route: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${route}`, {
        method,
        headers: {
          [this.keyHeader]: this.relayKey,
          ...macClientHeaders(),
          ...this.nameHeader(),
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
      const invitation = readInvitation(json?.invitation) ?? undefined;
      throw new InviteRefused(message || COULD_NOT_REACH, response.status >= 500 ? 503 : response.status, invitation);
    }
    if (!json) throw new InviteRefused(COULD_NOT_REACH, 503);
    return json;
  }

  async mine(): Promise<Invitation[]> {
    const body = await this.call("GET", "/account/invitations");
    if (!Array.isArray(body.invitations)) throw new InviteRefused(COULD_NOT_REACH, 503);
    return body.invitations.flatMap((row: unknown) => {
      const one = readInvitation(row);
      return one ? [one] : [];
    });
  }

  private async answer(route: string): Promise<Record<string, unknown>> {
    return this.call("POST", route, {});
  }

  async accept(inviteId: string): Promise<JoinAnswer> {
    const body = await this.answer(`/account/invitations/${encodeURIComponent(inviteId)}/join`);
    const invitation = readInvitation(body.invitation);
    const pond = body.pond as { pondId?: unknown; name?: unknown } | null;
    if (!invitation || typeof pond?.pondId !== "string") throw new InviteRefused(COULD_NOT_REACH, 503);
    return {
      pondId: pond.pondId,
      pondName: typeof pond.name === "string" ? pond.name : invitation.pondName,
      invitation,
    };
  }

  async decline(inviteId: string): Promise<Invitation> {
    const invitation = readInvitation(
      (await this.answer(`/account/invitations/${encodeURIComponent(inviteId)}/decline`)).invitation,
    );
    if (!invitation) throw new InviteRefused(COULD_NOT_REACH, 503);
    return invitation;
  }

  private base = (pondId: string): string => `/ponds/${encodeURIComponent(pondId)}/invites`;

  async ensurePond(pondId: string, name: string): Promise<"shared" | "unsupported"> {
    try {
      await this.call("POST", `/ponds/${encodeURIComponent(pondId)}/share`, { name });
      return "shared";
    } catch (error) {
      // A relay from before this route answers 404 or 405 to it: the first invite creates the Pond there.
      if (error instanceof InviteRefused && (error.status === 404 || error.status === 405)) return "unsupported";
      throw error;
    }
  }

  async create(
    pondId: string,
    input: { emails: string[]; role: "member" | "viewer"; pondName?: string },
  ): Promise<InviteResult[]> {
    const body = await this.call("POST", this.base(pondId), input);
    if (!Array.isArray(body.results)) throw new InviteRefused(COULD_NOT_REACH, 503);
    return body.results.flatMap((row: unknown): InviteResult[] => {
      const r = row as Record<string, unknown> | null;
      if (!r || typeof r.email !== "string") return [];
      const invite = readInvite(r.invitation ?? r.invite) ?? undefined;
      if (r.ok === true) return invite ? [{ email: r.email, ok: true, status: "invited", invite }] : [];
      const status = r.status === "already-member" || r.status === "already-invited" ? r.status : "refused";
      return [
        {
          email: r.email,
          ok: false,
          status,
          message: typeof r.message === "string" && r.message ? r.message : COULD_NOT_REACH,
          ...(invite ? { invite } : {}),
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
    const invite = readInvite(answer.invitation ?? answer.invite);
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
