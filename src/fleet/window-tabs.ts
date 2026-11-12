import { runHands } from "./hands.js";

/**
 * The front app's tabs, for the phone's Mac controls page: in a host app an add-on supplies (Conductor) its recent
 * workspaces and their open chats from its own records, anywhere else the tabs of its front window (Safari,
 * Chrome, Terminal, Finder),
 * read and pressed by Squeak Hands' `tabs` mode through the Accessibility grant it already holds. Never a
 * page's content, never typing.
 *
 * A tab is chosen by its index *and* the title the phone saw: a tab that moved or closed in between is
 * refused, not some other tab pressed. A Conductor chat is chosen by its id alone; the Mac looks its
 * workspace up itself, and Squeak Hands proves the route names it before leaving it on screen.
 */

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export interface WindowTab {
  index: number;
  title: string;
  selected: boolean;
}

export interface HostPlace {
  id: string;
  /** "repo · branch". */
  name: string;
  /** The repo alone: the phone draws its project icon from it. */
  repo?: string;
  /** On screen in Conductor now (read from its window's route, so only when that window is on this desktop). */
  current?: boolean;
  chats: Array<{ id: string; title: string; working: boolean; current?: boolean }>;
}

export interface FrontTabs {
  app: { id: string; name: string } | null;
  /** `tabs` for an ordinary app, `none`, or a host's own kind ("conductor"): then `workspaces` is set. */
  kind: string;
  /** What the person calls the host app ("Conductor") when `kind` is a host's own; the phone's heading. */
  title?: string;
  tabs?: WindowTab[];
  workspaces?: HostPlace[];
  /** Why there is nothing to show, in words; absent when there is. */
  note?: string;
}

/** An app an add-on knows: its bundle id, and its own workspaces and chats from its records. */
export interface FrontAppHost {
  bundleId: string;
  /** The kind `FrontTabs` carries for it. */
  kind: string;
  /** What the person calls it ("Conductor"), for sentences. */
  label: string;
  /** Its recent workspaces with their open chats. */
  places(): HostPlace[];
  /** One chat's workspace and title; null when there is no such chat. */
  chat(sessionId: string): { workspaceId: string; title: string | null } | null;
  /** Opens a chat in the app's window. A reason when it could not. */
  showChat(request: { workspaceId: string; sessionId: string; sessionTitle: string | null }): Promise<string | null>;
}

export interface TabsSystem {
  /** The app in front, from squeak-apps. */
  front(): Promise<{ id: string; name: string } | null>;
  /** Squeak Hands' `tabs` mode: list, or select then list. A reason when it could not. */
  hands(request: {
    bundleId: string;
    action: "list" | "select";
    index?: number;
    title?: string;
  }): Promise<
    | { ok: true; tabs: WindowTab[]; shown?: { workspaceId?: string; sessionId?: string } }
    | { ok: false; reason: string }
  >;
  /** The host apps add-ons contribute, read at call time (an add-on can be enabled while the daemon runs). */
  hosts(): FrontAppHost[];
}

/** A selectTab change's payload, strictly; null for anything else. */
export function readSelectTab(value: unknown): { index: number; title: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "index" && key !== "title")) return null;
  const { index, title } = record;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 59) return null;
  if (typeof title !== "string" || title.length > 200) return null;
  return { index, title };
}

/** A showChat change's payload: a Conductor chat id; null for anything else. */
export function readShowChat(value: unknown): { sessionId: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId)) {
    return null;
  }
  return { sessionId: record.sessionId };
}

export class WindowTabs {
  constructor(private readonly system: TabsSystem) {}

  async list(): Promise<FrontTabs> {
    const app = await this.system.front().catch(() => null);
    if (!app) return { app: null, kind: "none", note: "No app is in front on your Mac." };
    const host = this.system.hosts().find((candidate) => candidate.bundleId === app.id);
    if (host) {
      const shown = await this.system.hands({ bundleId: app.id, action: "list" }).catch(() => null);
      const on = shown?.ok ? shown.shown : undefined;
      const workspaces = host.places().map((w) => ({
        ...w,
        ...(on?.workspaceId === w.id ? { current: true } : {}),
        chats: w.chats.map((chat) => (on?.sessionId === chat.id ? { ...chat, current: true } : chat)),
      }));
      // The one on screen first: it is where you are, and what you most likely switch within.
      workspaces.sort((a, b) => Number(b.current === true) - Number(a.current === true));
      return { app, kind: host.kind, title: host.label, workspaces };
    }
    const answer = await this.system.hands({ bundleId: app.id, action: "list" });
    if (!answer.ok) return { app, kind: "none", note: answer.reason };
    return answer.tabs.length
      ? { app, kind: "tabs", tabs: answer.tabs }
      : { app, kind: "none", note: `${app.name} has no tabs open in its front window.` };
  }

  async select(choice: {
    index: number;
    title: string;
  }): Promise<{ ok: true; tabs: FrontTabs } | { ok: false; reason: string }> {
    const app = await this.system.front().catch(() => null);
    if (!app || this.system.hosts().some((host) => host.bundleId === app.id)) {
      return { ok: false, reason: "That app isn't in front any more." };
    }
    const answer = await this.system.hands({ bundleId: app.id, action: "select", ...choice });
    if (!answer.ok) return answer;
    return { ok: true, tabs: { app, kind: "tabs", tabs: answer.tabs } };
  }

  async showChat(sessionId: string): Promise<{ ok: true; tabs: FrontTabs } | { ok: false; reason: string }> {
    const hosts = this.system.hosts();
    for (const host of hosts) {
      const chat = host.chat(sessionId);
      if (!chat) continue;
      const problem = await host.showChat({ workspaceId: chat.workspaceId, sessionId, sessionTitle: chat.title });
      if (problem) return { ok: false, reason: problem };
      return { ok: true, tabs: await this.list() };
    }
    return { ok: false, reason: `That chat isn't in ${hosts[0]?.label ?? "an app Squeak reads"} any more.` };
  }
}

const HANDS_WORDS: Record<string, string> = {
  "not-running": "That app isn't running any more.",
  "tab-moved": "That tab moved or closed. The list has been read again.",
  "not-trusted": "Squeak Hands needs Accessibility on your Mac.",
  locked: "Your Mac's screen is locked.",
};

/** Squeak Hands' words for what went wrong, for a host that adds its own. */
export function handsWords(error: string, extra: Record<string, string> = {}): string | undefined {
  return extra[error] ?? HANDS_WORDS[error];
}

/** The real thing, through Squeak Hands at `handsAppPath`. */
export function macTabsSystem(deps: {
  handsAppPath: string | null;
  front: TabsSystem["front"];
  hosts: TabsSystem["hosts"];
}): TabsSystem {
  return {
    front: deps.front,
    hosts: deps.hosts,
    async hands(request) {
      const answer = await runHandsMode(deps.handsAppPath, "tabs", request);
      if (!answer.ok) return answer;
      const { result } = answer;
      if (result.ok !== true) {
        const error = String(result.error ?? "");
        return { ok: false, reason: HANDS_WORDS[error] ?? "Squeak Hands couldn't read that window." };
      }
      const tabs = Array.isArray(result.tabs) ? (result.tabs as WindowTab[]) : [];
      const reported = result.conductor as { workspaceId?: unknown; sessionId?: unknown } | undefined;
      const shown =
        reported && typeof reported === "object"
          ? {
              ...(typeof reported.workspaceId === "string" ? { workspaceId: reported.workspaceId } : {}),
              ...(typeof reported.sessionId === "string" ? { sessionId: reported.sessionId } : {}),
            }
          : undefined;
      return { ok: true, tabs, ...(shown ? { shown } : {}) };
    },
  };
}

/** One Squeak Hands mode, or why it could not run. */
export async function runHandsMode(handsAppPath: string | null, mode: string, request: unknown) {
  if (!handsAppPath) return { ok: false as const, reason: "This Mac has no Squeak Hands." };
  const outcome = await runHands(handsAppPath, mode, request);
  if (outcome.status === "missing") return { ok: false as const, reason: "Squeak Hands isn't installed on this Mac." };
  if (outcome.status !== "result" || outcome.result.error === "unknown-mode") {
    return {
      ok: false as const,
      reason: "Squeak Hands didn't answer. Rebuild it with helpers/squeak-hands/build.sh.",
    };
  }
  return { ok: true as const, result: outcome.result };
}
