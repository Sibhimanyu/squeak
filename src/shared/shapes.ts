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
