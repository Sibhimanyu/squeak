// Message shapes the web app and the daemon agree on, with a reader for each that accepts only what it can draw. Only the
// shapes the web needs today are here; the daemon's channel documents move in as web screens need them (never copied twice).

/** What `GET /me` says about a signed-in account (name and email come from sign-in and are not editable). */
export interface AccountInfo {
  userId: string;
  name: string;
  email: string;
}

/** What an invite link shows before sign-in: who invited you, to which Pond, for which address, until when. */
export interface InvitePreview {
  inviter: string;
  pond: string;
  /** The address the invitation was sent to; the person must sign in as it. */
  email: string;
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
  const email = text(value["email"], 320);
  const expiresAt = value["expiresAt"];
  if (!inviter || !pond || !email || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { inviter, pond, email, expiresAt };
}

/** The room a person was in when they had to sign in: a path in the app, never a full URL (no open redirect). */
export function isAppRoute(value: unknown): value is string {
  return (
    typeof value === "string" && /^\/[A-Za-z0-9/_~.-]*$/.test(value) && !value.includes("//") && value.length <= 200
  );
}
