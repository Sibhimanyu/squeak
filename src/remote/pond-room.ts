import { liveHandle } from "./live-turn.js";

/**
 * A pond's Room for a phone that has it open (`pondroom` in its caps, `room` in its presence).
 *
 * The Room is the host's (`GET /native/projects/<id>/room`) or, for a pond someone else owns, what that Owner's Mac
 * published to its Members (`GET /native/ponds/<id>/room`). The phone gets less than either page and decides nothing:
 * this builds the rows it draws (people's messages, Task cards with their state and routing line, Duck state lines
 * with the detail a tap expands) and the switches it needs (may post, may make or drop a Task). Written sealed into
 * `live`, only while a phone has that Room open, rewritten only when it changes, deleted when it leaves.
 */

export const PHONE_POND_ROOM_CAP = "pondroom";
/** The most rows one document holds (the newest). */
export const POND_ROOM_ITEMS_MAX = 80;
/** The longest message a phone may post into a Room (the host's own limit). */
export const ROOM_MESSAGE_MAX = 500;
const LINE_MAX = 140;
const TEXT_MAX = 2000;
const DETAIL_MAX = 1200;

export type PondRoomTone = "working" | "done" | "needs" | "failed";

export type PondRoomItem =
  | {
      t: "message";
      id: string;
      /** Who said it: a person's name or a Duck's. */
      who: string;
      /** A Duck, not a person. */
      duck?: true;
      /** This phone's person said it (drawn on the right). */
      mine: boolean;
      text: string;
      at: number;
      /** "Make task" may be offered on it (the Owner's, on a person's message with no live Task). */
      canTask?: true;
    }
  | {
      t: "duck";
      id: string;
      who: string;
      tone: PondRoomTone;
      /** The collapsed line. */
      line: string;
      /** What a tap shows beneath it; absent when the line says it all. */
      detail?: string;
      at: number;
    }
  | {
      t: "task";
      id: string;
      taskId: string;
      title: string;
      state: "waiting" | "working" | "blocked" | "done";
      /** "Suggested" for a Task only proposed, else the state's word. */
      stateLabel: string;
      /** The one quiet line: "→ given to Pixel (related to the icon work)". */
      routing?: string;
      /** Done: the Duck's one sentence. */
      result?: string;
      /** The Owner may drop it. */
      canDrop?: true;
      at: number;
    };

export interface PondRoomDoc {
  v: 1;
  pond: string;
  /** This person may post in the Room, and the calm reason when not. */
  canPost: boolean;
  reason?: string;
  /** This person may make and drop Tasks (the Owner on their own Mac). */
  canTask: boolean;
  /** A Member's page only: the sentence shown while the Owner's Mac is not running. */
  offline?: string;
  items: PondRoomItem[];
}

/** The `live` document id of a pond's Room: the pond id hashed like a session key, under its own prefix. */
export function pondRoomDoc(pondId: string): string {
  return `${liveHandle(`room:${pondId}`)}-r`;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((r): r is Rec => r !== null) : []);

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/** What the host's Room page holds, as read (`NativePhone.roomPage`). */
export interface PhoneRoomRead {
  page: Rec;
  /** Someone else's pond, read from what its Owner's Mac published. */
  member: boolean;
  /** A Member's own member id (their posts are "mine"). */
  selfId?: string;
}

const STATE_LABEL: Record<string, string> = {
  waiting: "Waiting",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
};

interface Entry {
  at: number;
  order: number;
  item: PondRoomItem;
}

/**
 * The phone's Room from the host's page. Pure. Plain level only (`agents` talk never leaves), posts and Task cards
 * oldest to newest, the newest `POND_ROOM_ITEMS_MAX` kept.
 */
export function buildPondRoom(pondId: string, read: PhoneRoomRead): PondRoomDoc {
  const { page, member } = read;
  const threads = new Map<string, Rec>();
  for (const thread of list(page.threads)) threads.set(str(thread.sessionId), thread);
  const duckName = (sessionId: string, fallback: string): string => {
    const thread = threads.get(sessionId);
    return clip(str(thread?.name) || str(thread?.title) || fallback || "Duck", 60) || "Duck";
  };
  const tasks = list(page.tasks).filter((task) => task.state !== "dropped");
  const taskByMessage = new Map<string, Rec>();
  for (const task of list(page.tasks)) taskByMessage.set(str(task.messageId), task);
  const entries: Entry[] = [];
  const postAt = new Map<string, number>();

  for (const post of list(page.posts)) {
    const level = str(post.level) || "room";
    if (level !== "room") continue;
    const author = rec(post.author) ?? {};
    const kind = str(author.kind);
    const id = str(post.id);
    const at = num(post.at);
    const text = str(post.text);
    if (!id) continue;
    postAt.set(id, at);
    if (kind === "person") {
      if (!text.trim()) continue;
      const authorId = str(author.id);
      const mine = member ? read.selfId !== undefined && authorId === read.selfId : authorId === "owner";
      const live = taskByMessage.get(id);
      entries.push({
        at,
        order: 0,
        item: {
          t: "message",
          id,
          who: mine ? "You" : clip(str(author.name) || "Someone", 60),
          mine,
          text: clip(text, TEXT_MAX),
          at,
          ...(!member && (!live || live.state === "dropped" || live.proposed === true)
            ? { canTask: true as const }
            : {}),
        },
      });
    } else if (kind === "agent") {
      const who = duckName(str(post.sessionId), str(author.name));
      const postKind = str(post.kind);
      if (postKind === "message" || postKind === "") {
        if (!text.trim()) continue;
        entries.push({
          at,
          order: 1,
          item: { t: "message", id, who, duck: true, mine: false, text: clip(text, TEXT_MAX), at },
        });
      } else {
        const line = clip(firstLine(text), LINE_MAX);
        if (!line) continue;
        // The host's own `detail` (a status line's expansion, a plan card's spec and plan) wins; else the rest of the text.
        const whole = [text.trim(), str(post.detail).trim()]
          .filter((part, i, all) => part && (i === 0 || part !== all[0]))
          .join("\n");
        const tone: PondRoomTone = postKind === "done" ? "done" : postKind === "needs" ? "needs" : "working";
        entries.push({
          at,
          order: 1,
          item: {
            t: "duck",
            id,
            who,
            tone,
            line,
            ...(whole !== line ? { detail: clip(whole, DETAIL_MAX) } : {}),
            at,
          },
        });
      }
    }
  }

  // A turn a Task started has its words in the Task; every other turn sent from the Room is a Duck's state line.
  const taskTurns = new Set(
    tasks.map((task) => {
      const handed = rec(task.handedTo);
      const turn = str(handed?.turnId);
      return turn.includes(":") || !turn ? turn : `${str(handed?.sessionId)}:${turn}`;
    }),
  );
  for (const turn of list(page.turns)) {
    const id = str(turn.id);
    const startedAt = num(turn.startedAt);
    if (!id || !startedAt) continue;
    const who = duckName(str(turn.sessionId), str(turn.threadTitle));
    const author = rec(turn.author) ?? {};
    const prompt = clip(str(turn.prompt), 200);
    if (prompt && !taskTurns.has(id)) {
      const mine = author.me === true;
      entries.push({
        at: startedAt,
        order: 0,
        item: {
          t: "message",
          id: `t:${id}:q`,
          who: mine ? "You" : clip(str(author.name) || "Someone", 60),
          mine,
          text: prompt,
          at: startedAt,
        },
      });
    }
    const outcome = str(turn.outcome);
    const outcomeText = clip(str(turn.outcomeText), LINE_MAX);
    const intent = clip(str(turn.intent), LINE_MAX);
    const tone: PondRoomTone = outcome === "error" ? "failed" : outcome ? "done" : "working";
    const line =
      outcome === "error"
        ? outcomeText || "Hit an error"
        : outcome === "stopped"
          ? outcomeText || "Stopped"
          : outcome
            ? outcomeText || "Finished"
            : intent || "Working";
    const bits: string[] = [];
    if (prompt) bits.push(`Asked: ${prompt}`);
    const ended = num(turn.endedAt);
    const durationMs = num(turn.durationMs) || (ended ? ended - startedAt : 0);
    if (durationMs > 0) bits.push(duration(durationMs));
    const files = num(turn.filesChanged);
    if (files > 0) bits.push(files === 1 ? "1 file" : `${files} files`);
    entries.push({
      at: ended || startedAt,
      order: 1,
      item: {
        t: "duck",
        id: `t:${id}`,
        who,
        tone,
        line,
        ...(bits.length > 0 ? { detail: bits.join("\n") } : {}),
        at: ended || startedAt,
      },
    });
  }

  for (const task of tasks) {
    const state = str(task.state);
    if (!(state in STATE_LABEL)) continue;
    const id = str(task.id);
    const at = Math.max(num(task.createdAt), postAt.get(str(task.messageId)) ?? 0);
    const proposed = task.proposed === true && state === "waiting";
    const result = state === "done" ? clip(str(task.result), LINE_MAX) : "";
    const routing = routingLine(task);
    entries.push({
      at,
      order: 2,
      item: {
        t: "task",
        id: `task:${id}`,
        taskId: id,
        title: clip(str(task.title) || str(task.text) || "New task", 120),
        state: state as "waiting" | "working" | "blocked" | "done",
        stateLabel: proposed ? "Suggested" : (STATE_LABEL[state] ?? state),
        ...(routing ? { routing } : {}),
        ...(result ? { result } : {}),
        ...(!member && state !== "done" ? { canDrop: true as const } : {}),
        at,
      },
    });
  }

  entries.sort((a, b) => a.at - b.at || a.order - b.order || idOf(a.item).localeCompare(idOf(b.item)));
  const items = entries.slice(-POND_ROOM_ITEMS_MAX).map((entry) => entry.item);
  const offline = clip(str(rec(page.ownerOffline)?.line) || str(page.ownerOffline), 200);
  const canPost = member ? page.canPost !== false : true;
  return {
    v: 1,
    pond: pondId,
    canPost,
    ...(!canPost ? { reason: "The Owner has turned off messaging for you in this pond." } : {}),
    canTask: !member,
    ...(member && offline ? { offline } : {}),
    items,
  };
}

function idOf(item: PondRoomItem): string {
  return item.id;
}

/** "→ given to Pixel (related to the icon work)": the host's own line when it has one, else made from what it routed. */
function routingLine(task: Rec): string | undefined {
  const own = clip(str(task.routing), LINE_MAX);
  if (own) return own;
  const state = str(task.state);
  const handed = rec(task.handedTo);
  const suggestion = rec(task.suggestion);
  if (handed && (state === "working" || state === "done" || state === "blocked")) {
    const title = clip(str(handed.title), 60) || "a duck";
    const reason =
      suggestion && str(suggestion.sessionId) === str(handed.sessionId) ? clip(str(suggestion.reason), 80) : "";
    return reason ? `→ given to ${title} (${reason})` : `→ given to ${title}`;
  }
  if (state === "waiting") {
    if (suggestion) {
      const title = clip(str(suggestion.title), 60) || "a duck";
      const reason = clip(str(suggestion.reason), 80);
      return reason ? `→ suggested ${title} (${reason})` : `→ suggested ${title}`;
    }
    return "→ a new duck";
  }
  return undefined;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
