// Small drawing helpers: a Pond's tint from its id (never in the duck's yellow band, DESIGN.md), and short ages.

const fnv = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

/** A hue 0..359 that is never in 25..75 (the duck's band, which is only ever the accent). */
export function hueOf(key: string): number {
  const x = fnv(key) % 310;
  return x < 25 ? x : x + 50;
}

export const initial = (name: string): string => (name.trim().charAt(0) || "?").toUpperCase();

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago": how long ago, in words (People and devices). */
export function ago(now: number, at: number): string {
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** "2 min ago" for an invitation (`ago`); the short form for a row: "4 min", "1 h", "Yesterday", "Mon", "3 Dec". */
export function age(now: number, at: number, ago = false): string {
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  const tail = ago ? " ago" : "";
  if (mins < 1) return ago ? "just now" : "now";
  if (mins < 60) return `${mins} min${tail}`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days < 1) return `${Math.floor(mins / 60)} h${tail}`;
  if (days === 1) return "Yesterday";
  if (days < 7) return DAYS[new Date(at).getDay()]!;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
