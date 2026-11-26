import fs from "node:fs";
import path from "node:path";

import type { InviteRecord } from "./invites-port.js";
import type { MemberView } from "./service.js";

/** Most people in a Pond, the Owner included, counting pending invitations (the relay enforces it; surfaces only say it). */
export const POND_CAP = 10;

/** One person in the People sheet. `connecting`: joined in the cloud, the Owner's Mac has not sealed the key yet. */
export interface PeopleMember {
  id: string;
  name: string;
  email?: string;
  role: "owner" | "member" | "viewer";
  online: boolean;
  lastSeenAt: number | null;
  you: boolean;
  connecting?: true;
}

/** What the Mac's People sheet and Dashboard avatars draw: members from the host, invites exactly as the relay holds them. */
export interface PeopleView {
  cap: number;
  members: PeopleMember[];
  invites: InviteRecord[];
}

/**
 * The People view of a Pond. Members are the host's own (names, roles and presence come from the live Pond); a person who
 * joined in the cloud but is not a Member document yet is listed as Connecting, from the relay's record of the invite. The
 * invites are passed through untouched: the relay's record is the only source of an invite's state and times.
 */
export function buildPeople(members: MemberView[], invites: InviteRecord[]): PeopleView {
  const out: PeopleMember[] = members.map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.email ? { email: m.email } : {}),
    role: m.role === "owner" || m.role === "viewer" ? m.role : "member",
    online: m.online,
    lastSeenAt: m.lastSeenAt ?? null,
    you: m.you,
  }));
  const known = new Set(members.map((m) => m.email?.toLowerCase()).filter((e): e is string => !!e));
  for (const i of invites) {
    if (i.state !== "joined" || known.has(i.email.toLowerCase())) continue;
    out.push({
      id: `acct:${i.userId ?? i.id}`,
      name: i.name ?? i.email,
      email: i.email,
      role: i.role,
      online: false,
      lastSeenAt: null,
      you: false,
      connecting: true,
    });
  }
  return { cap: POND_CAP, members: out, invites };
}

/** A line for the Room: who it is about, the words (the Owner's Mac writes it, "<name> joined"), and its kind. */
export interface InviteLine {
  inviteId: string;
  state: "joined" | "declined";
  who: { id: string; name: string };
  text: string;
  kind: "joined" | "invite";
}

/**
 * The Room lines still owed for these invites: one for a join and one for a decline, each once (`announced` maps an invite
 * id to the state already told). A withdrawal, an expiry and a pending invite say nothing.
 */
export function owedLines(invites: InviteRecord[], announced: Record<string, string>): InviteLine[] {
  const out: InviteLine[] = [];
  for (const i of invites) {
    if ((i.state !== "joined" && i.state !== "declined") || announced[i.id] === i.state) continue;
    out.push({
      inviteId: i.id,
      state: i.state,
      who: { id: i.userId ?? `invite:${i.id}`, name: i.name ?? i.email },
      text: i.state === "joined" ? "joined" : "declined the invitation",
      kind: i.state === "joined" ? "joined" : "invite",
    });
  }
  return out;
}

/** Which invite states this Mac has already put in the Room, kept in a small file beside the Ponds (never in the cloud). */
export class AnnouncedInvites {
  private readonly file: string;
  private map: Record<string, Record<string, string>> = {};

  constructor(dir: string) {
    this.file = path.join(dir, "invite-lines.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (raw && typeof raw === "object") this.map = raw as Record<string, Record<string, string>>;
    } catch {
      // first run, or a damaged file: lines may be told once more, never lost
    }
  }

  of(pondId: string): Record<string, string> {
    return { ...(this.map[pondId] ?? {}) };
  }

  mark(pondId: string, inviteId: string, state: string): void {
    this.map[pondId] = { ...(this.map[pondId] ?? {}), [inviteId]: state };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.map), { mode: 0o600 });
  }

  forget(pondId: string): void {
    delete this.map[pondId];
  }
}
