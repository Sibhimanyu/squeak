// Message shapes the web app and the daemon agree on, with a reader for each that accepts only what it can draw. Only the
// shapes the web needs today are here; the daemon's channel documents move in as web screens need them (never copied twice).

/** What `GET /me` says about a signed-in account (name and email come from sign-in and are not editable). */
export interface AccountInfo {
  userId: string;
  name: string;
  email: string;
}

export type InviteState = "pending" | "joined" | "declined" | "expired" | "withdrawn";
const INVITE_STATES: readonly string[] = ["pending", "joined", "declined", "expired", "withdrawn"];

/** What an invite link shows before sign-in: who invited you, to which Pond, who is in it, for which (masked) address. */
export interface InvitePreview {
  inviter: string;
  pond: string;
  /** First names of the Pond's members, at most 10. */
  members: string[];
  state: InviteState;
  /** The invited address masked ("a***@g***.com"); the full address is never sent. */
  masked: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

export function parseAccountInfo(value: unknown): AccountInfo | null {
  if (!isRecord(value)) return null;
  const userId = text(value["userId"] ?? value["id"], 100);
  const email = text(value["email"], 320);
  if (!userId || !email) return null;
  return { userId, email, name: text(value["name"]) ?? email };
}

export function parseInvitePreview(value: unknown): InvitePreview | null {
  if (!isRecord(value)) return null;
  const inviter = text(value["inviter"], 100);
  const pond = text(value["pond"], 100);
  const state = value["state"];
  const masked = typeof value["masked"] === "string" && value["masked"].length <= 320 ? value["masked"] : "";
  const expiresAt = value["expiresAt"];
  if (!inviter || !pond || typeof state !== "string" || !INVITE_STATES.includes(state)) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  const members = Array.isArray(value["members"])
    ? value["members"].flatMap((m) => text(m, 100) ?? []).slice(0, 10)
    : [];
  return { inviter, pond, members, state: state as InviteState, masked, expiresAt };
}

/** The room a person was in when they had to sign in: a path in the app, never a full URL (no open redirect). */
export function isAppRoute(value: unknown): value is string {
  return (
    typeof value === "string" && /^\/[A-Za-z0-9/_~.-]*$/.test(value) && !value.includes("//") && value.length <= 200
  );
}

// ---- The Pond list (issue #136, reshaped in #137): what the relay may say about an account's Ponds is metadata only. The cloud never
// reads content (ADR 0005), so a Pond's summary line, its working and waiting marks and Needs you are worked out in the browser from
// the Pond's decrypted documents; the relay sends ids, names, roles, the owner, invitations, how far the change feed has got and counts. ----

export type PondRole = "owner" | "member" | "viewer";

export interface PondSummary {
  pondId: string;
  name: string;
  /** Whose Pond it is (first name); the web draws their avatar on a Pond that is not yours. */
  ownerName: string;
  /** The Owner Mac's signing key (x963 base64) the Pond is pinned to: what the web checks a key grant's signature against. */
  ownerKey: string;
  /** True when this account owns it. */
  mine: boolean;
  role: PondRole;
  /** Other people are in it (the filter's "Shared"). */
  shared: boolean;
  /** Epoch ms of the Pond's newest change (the time of the last feed row, never its content); the list is newest first by it. */
  lastActivityAt: number;
  /** The newest `seq` in the Pond's change feed: unread is this beyond what this browser last opened. */
  seqHead: number;
  counts: { members: number; ducks: number };
}

/** An invitation waiting on this account: Join or Decline. */
export interface Invitation {
  inviteId: string;
  pondName: string;
  inviterName: string;
  /** Epoch ms the invitation was sent. */
  at: number;
}

export interface PondsOverview {
  ponds: PondSummary[];
  invitations: Invitation[];
}

const ROLES: readonly string[] = ["owner", "member", "viewer"];
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const count = (value: unknown): number | null => {
  const n = num(value);
  return n !== null && n >= 0 && Number.isInteger(n) ? n : null;
};
const list = <T>(value: unknown, read: (item: unknown) => T | null): T[] =>
  Array.isArray(value) ? value.flatMap((item) => read(item) ?? []) : [];

function parsePondSummary(value: unknown): PondSummary | null {
  if (!isRecord(value)) return null;
  const pondId = text(value["pondId"], 100);
  const name = text(value["name"]);
  const ownerName = text(value["ownerName"], 100);
  const ownerKey = text(value["ownerKey"], 200);
  const lastActivityAt = num(value["lastActivityAt"]);
  const seqHead = count(value["seqHead"]);
  const counts = isRecord(value["counts"]) ? value["counts"] : {};
  const role = value["role"];
  if (!pondId || !name || !ownerName || !ownerKey || lastActivityAt === null || seqHead === null) return null;
  if (typeof role !== "string" || !ROLES.includes(role)) return null;
  return {
    pondId,
    name,
    ownerName,
    ownerKey,
    mine: value["mine"] === true,
    role: role as PondRole,
    shared: value["shared"] === true,
    lastActivityAt,
    seqHead,
    counts: { members: count(counts["members"]) ?? 0, ducks: count(counts["ducks"]) ?? 0 },
  };
}

function parseInvitation(value: unknown): Invitation | null {
  if (!isRecord(value)) return null;
  const inviteId = text(value["inviteId"], 100);
  const pondName = text(value["pondName"]);
  const inviterName = text(value["inviterName"], 100);
  const at = num(value["at"]);
  return inviteId && pondName && inviterName && at !== null ? { inviteId, pondName, inviterName, at } : null;
}

/** `GET /account/overview`: anything that cannot be drawn is dropped, never a half row; any content field is ignored. */
export function parsePondsOverview(value: unknown): PondsOverview | null {
  if (!isRecord(value)) return null;
  return {
    ponds: list(value["ponds"], parsePondSummary).slice(0, 200),
    invitations: list(value["invitations"], parseInvitation).slice(0, 50),
  };
}
