// Email addresses for "Invite by email" (docs/ponds.md): the same simple strict rule as the relay's mail.js, so a
// refusal there is never a surprise here. Lower-cased and trimmed is how an address is compared everywhere.

export const MAX_EMAILS_PER_SEND = 10;

const STRICT =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.trim().length <= 254 && STRICT.test(value.trim());
}

/** "pat.lee@example.com" -> "p***@e***.com" (the relay's `maskEmail`). */
export function maskEmail(value: string): string {
  const e = normalizeEmail(value);
  const at = e.lastIndexOf("@");
  if (at < 1) return "***";
  const host = e.slice(at + 1);
  const dot = host.lastIndexOf(".");
  const name = dot > 0 ? host.slice(0, dot) : host;
  return `${e[0]}***@${name[0] ?? ""}***${dot > 0 ? host.slice(dot) : ""}`;
}
