// What the screens draw, worked out in the browser from a Pond's opened documents (the cloud cannot: it never reads content,
// ADR 0005). Pure: the same documents always give the same lines, so a re-read never moves anything.

import { canOf } from "./can.js";
import type { PondSummary } from "../../../src/shared/shapes.js";
import type { Duck, DuckEvent } from "./duck-format.js";
import type { PondData } from "./feed.js";
import type { RoomPost, RoomTask } from "./room-format.js";

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;
const oneLine = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// ---- Needs you: a question a Duck waits on, answered here ----

export interface NeedsYouItem {
  id: string;
  pondId: string;
  pondName: string;
  duckId: string;
  duckName: string;
  requestId: string;
  title: string;
  at: number;
}

/** The question a Duck is waiting on now: the newest `question` event no later `resolved` event closed. */
export function openQuestion(events: readonly DuckEvent[]): Extract<DuckEvent, { type: "question" }> | null {
  const resolved = new Set(events.flatMap((e) => (e.type === "resolved" ? [e.requestId] : [])));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "question" && !resolved.has(e.requestId)) return e;
  }
  return null;
}

/** Questions waiting on this person in a Pond. A Viewer answers nothing, so nothing waits on them. */
export function needsYouOf(pond: Pick<PondSummary, "pondId" | "name" | "role">, data: PondData): NeedsYouItem[] {
  if (canOf(pond.role, "", data.policy).answerQuestion !== true) return [];
  const out: NeedsYouItem[] = [];
  for (const duck of data.ducks) {
    if (duck.state !== "waiting" || duck.waitingFor === "approval") continue;
    const q = openQuestion(data.events.get(duck.id) ?? []);
    if (!q) continue;
    out.push({
      id: `${pond.pondId}:${q.requestId}`,
      pondId: pond.pondId,
      pondName: pond.name,
      duckId: duck.id,
      duckName: duck.title,
      requestId: q.requestId,
      title: oneLine(q.text, 160),
      at: q.at,
    });
  }
  return out.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

// ---- The Pond row ----

export interface PondDerived {
  /** The one line under the Pond's name. */
  line: string;
  working: boolean;
  needsYou: boolean;
  unread: boolean;
  /** Connecting: the Owner's Mac has not sealed the Pond key to this browser yet. */
  connecting: boolean;
}

export function lineOf(pond: PondSummary, data: PondData): string {
  const messages = data.posts.filter((p) => p.kind === "message");
  const last = messages[messages.length - 1];
  const working = data.ducks.filter((d) => d.state === "working").length;
  const base = last
    ? `${firstName(last.author.name)}: ${oneLine(last.text, 80)}`
    : working > 0
      ? `${working} working`
      : "Nothing running";
  return pond.shared ? base : `Not shared · ${base}`;
}

// ---- The Room ----

export type RoomItem =
  | { kind: "message"; id: string; mine: boolean; author: string; text: string; at: number; post: RoomPost }
  | {
      kind: "state";
      id: string;
      duck: string;
      text: string;
      at: number;
      canvases: RoomPost["canvases"];
      more: string | null;
    };

/** The Room in reading order (oldest first, as chat does). A Duck's lines are one collapsed line each. */
export function roomItems(data: PondData, selfId: string, selfName: string): RoomItem[] {
  return data.posts.map((post): RoomItem => {
    if (post.kind === "message" && post.author.kind === "person") {
      const mine = post.author.id !== null ? post.author.id === selfId : post.author.name === selfName;
      return { kind: "message", id: post.id, mine, author: post.author.name, text: post.text, at: post.at, post };
    }
    return {
      kind: "state",
      id: post.id,
      duck: post.author.name,
      text: oneLine(post.text, 160),
      at: post.at,
      canvases: post.canvases,
      more: post.detail ? oneLine(post.detail, 300) : null,
    };
  });
}

export const taskLine = (t: RoomTask): string =>
  t.approver && t.state === "waiting"
    ? `${t.title} · waiting for ${firstName(t.approver)} to approve`
    : `${t.title} · ${t.state}`;

// ---- A Duck's conversation ----

export type ConvItem =
  | { kind: "message"; id: string; mine: boolean; author: string; text: string; at: number }
  | { kind: "reply"; id: string; text: string; at: number }
  | { kind: "tools"; id: string; label: string; labels: string[] }
  | { kind: "changed"; id: string; text: string }
  | { kind: "approval"; id: string; label: string };

export interface Conversation {
  items: ConvItem[];
  /** The decision card, while a question is open. */
  question: { requestId: string; text: string; options: string[] } | null;
  working: boolean;
}

const toolsLabel = (labels: string[]): string =>
  labels.length === 1
    ? labels[0]!
    : labels.every((l) => /^Read\b/i.test(l))
      ? `Read ${labels.length} files`
      : `Used ${labels.length} tools`;

/** The line is drawn as "Changed 4 files · Open on your Mac" (`OpenOnMac` adds the end): code is the Mac's. */
export const changedLine = (files: number): string => `Changed ${files} ${files === 1 ? "file" : "files"}`;

export function conversationOf(duck: Duck, events: readonly DuckEvent[], selfId: string): Conversation {
  const items: ConvItem[] = [];
  let group: { id: string; ids: Map<string, number>; labels: string[] } | null = null;
  const resolved = new Set(events.flatMap((e) => (e.type === "resolved" ? [e.requestId] : [])));
  const open = openQuestion(events);
  let state = duck.state;
  for (const e of events) {
    if (e.type === "tool") {
      if (!group) {
        group = { id: `t${e.seq}`, ids: new Map(), labels: [] };
        items.push({ kind: "tools", id: group.id, label: "", labels: group.labels });
      }
      // The same tool seen again (running, then done) is one line, not two.
      const at = e.id !== null ? group.ids.get(e.id) : undefined;
      if (at !== undefined) group.labels[at] = e.label;
      else {
        if (e.id !== null) group.ids.set(e.id, group.labels.length);
        group.labels.push(e.label);
      }
      continue;
    }
    group = null;
    if (e.type === "user") {
      items.push({
        kind: "message",
        id: `e${e.seq}`,
        mine: e.by === selfId,
        author: e.byName ?? duck.starterName,
        text: e.text,
        at: e.at,
      });
    } else if (e.type === "agent") items.push({ kind: "reply", id: `e${e.seq}`, text: e.text, at: e.at });
    else if (e.type === "changed") items.push({ kind: "changed", id: `e${e.seq}`, text: changedLine(e.files) });
    else if (e.type === "approval" && !resolved.has(e.requestId)) {
      items.push({ kind: "approval", id: `e${e.seq}`, label: e.label });
    } else if (e.type === "state") state = e.state;
  }
  for (const item of items) if (item.kind === "tools") item.label = toolsLabel(item.labels);
  return {
    items,
    question: open ? { requestId: open.requestId, text: open.text, options: open.options } : null,
    working: state === "working",
  };
}

/** Ducks working first, then the rest newest first (the brief's order for the Ducks tab). */
export function duckGroups(ducks: readonly Duck[]): { working: Duck[]; earlier: Duck[] } {
  return {
    working: ducks.filter((d) => d.state === "working"),
    earlier: ducks.filter((d) => d.state !== "working"),
  };
}

/** A decision card's option letter: A, B, C. */
export const letter = (index: number): string => String.fromCharCode(65 + (index % 26));
