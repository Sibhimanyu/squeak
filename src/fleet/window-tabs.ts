import { runHands } from "./conductor-ui.js";

/**
 * The front app's tabs, for the phone's Mac controls page: in Conductor its recent workspaces and their open
 * chats (from its own records), anywhere else the tabs of its front window (Safari, Chrome, Terminal, Finder),
 * read and pressed by Squeak Hands' `tabs` mode through the Accessibility grant it already holds. Never a
 * page's content, never typing.
 *
 * A tab is chosen by its index *and* the title the phone saw: a tab that moved or closed in between is
 * refused, not some other tab pressed. A Conductor chat is chosen by its id alone; the Mac looks its
 * workspace up itself, and Squeak Hands proves the route names it before leaving it on screen.
 */

export const CONDUCTOR_BUNDLE_ID = "com.conductor.app";
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export interface WindowTab {
  index: number;
  title: string;
  selected: boolean;
}

export interface ConductorPlace {
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
  kind: "conductor" | "tabs" | "none";
  tabs?: WindowTab[];
  workspaces?: ConductorPlace[];
  /** Why there is nothing to show, in words; absent when there is. */
  note?: string;
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
    | { ok: true; tabs: WindowTab[]; conductor?: { workspaceId?: string; sessionId?: string } }
    | { ok: false; reason: string }
  >;
  /** Squeak Hands' `show-chat` mode. A reason when it could not. */
  showChat(request: { workspaceId: string; sessionId: string; sessionTitle: string | null }): Promise<string | null>;
  /** Conductor's recent workspaces with their open chats. */
  conductor(): ConductorPlace[];
  /** One chat's workspace and title; null when there is no such chat. */
  chat(sessionId: string): { workspaceId: string; title: string | null } | null;
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
    if (app.id === CONDUCTOR_BUNDLE_ID) {
      const shown = await this.system.hands({ bundleId: app.id, action: "list" }).catch(() => null);
      const on = shown?.ok ? shown.conductor : undefined;
      const workspaces = this.system.conductor().map((w) => ({
        ...w,
        ...(on?.workspaceId === w.id ? { current: true } : {}),
        chats: w.chats.map((chat) => (on?.sessionId === chat.id ? { ...chat, current: true } : chat)),
      }));
      // The one on screen first: it is where you are, and what you most likely switch within.
      workspaces.sort((a, b) => Number(b.current === true) - Number(a.current === true));
      return { app, kind: "conductor", workspaces };
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
    if (!app || app.id === CONDUCTOR_BUNDLE_ID) return { ok: false, reason: "That app isn't in front any more." };
    const answer = await this.system.hands({ bundleId: app.id, action: "select", ...choice });
    if (!answer.ok) return answer;
    return { ok: true, tabs: { app, kind: "tabs", tabs: answer.tabs } };
  }

  async showChat(sessionId: string): Promise<{ ok: true; tabs: FrontTabs } | { ok: false; reason: string }> {
    const chat = this.system.chat(sessionId);
    if (!chat) return { ok: false, reason: "That chat isn't in Conductor any more." };
    const problem = await this.system.showChat({ workspaceId: chat.workspaceId, sessionId, sessionTitle: chat.title });
    if (problem) return { ok: false, reason: problem };
    return { ok: true, tabs: await this.list() };
  }
}

const HANDS_WORDS: Record<string, string> = {
  "not-running": "That app isn't running any more.",
  "tab-moved": "That tab moved or closed. The list has been read again.",
  "not-trusted": "Squeak Hands needs Accessibility on your Mac.",
  locked: "Your Mac's screen is locked.",
  "conductor-not-running": "Conductor isn't running.",
  "no-window": "Conductor has no window open.",
  "workspace-not-in-sidebar": "That workspace isn't in Conductor's sidebar.",
  "chat-not-open": "That chat isn't open as a tab in Conductor.",
};

/** The real thing, through Squeak Hands at `handsAppPath`. */
export function macTabsSystem(deps: {
  handsAppPath: string | null;
  front: TabsSystem["front"];
  conductor: TabsSystem["conductor"];
  chat: TabsSystem["chat"];
}): TabsSystem {
  const hands = async (mode: string, request: unknown) => {
    if (!deps.handsAppPath) return { ok: false as const, reason: "This Mac has no Squeak Hands." };
    const outcome = await runHands(deps.handsAppPath, mode, request);
    if (outcome.status === "missing")
      return { ok: false as const, reason: "Squeak Hands isn't installed on this Mac." };
    if (outcome.status !== "result" || outcome.result.error === "unknown-mode") {
      return {
        ok: false as const,
        reason: "Squeak Hands didn't answer. Rebuild it with helpers/squeak-hands/build.sh.",
      };
    }
    return { ok: true as const, result: outcome.result };
  };
  return {
    front: deps.front,
    conductor: deps.conductor,
    chat: deps.chat,
    async hands(request) {
      const answer = await hands("tabs", request);
      if (!answer.ok) return answer;
      const { result } = answer;
      if (result.ok !== true) {
        const error = String(result.error ?? "");
        return { ok: false, reason: HANDS_WORDS[error] ?? "Squeak Hands couldn't read that window." };
      }
      const tabs = Array.isArray(result.tabs) ? (result.tabs as WindowTab[]) : [];
      const shown = result.conductor as { workspaceId?: unknown; sessionId?: unknown } | undefined;
      const conductor =
        shown && typeof shown === "object"
          ? {
              ...(typeof shown.workspaceId === "string" ? { workspaceId: shown.workspaceId } : {}),
              ...(typeof shown.sessionId === "string" ? { sessionId: shown.sessionId } : {}),
            }
          : undefined;
      return { ok: true, tabs, ...(conductor ? { conductor } : {}) };
    },
    async showChat(request) {
      const answer = await hands("show-chat", request);
      if (!answer.ok) return answer.reason;
      if (answer.result.ok === true) return null;
      return HANDS_WORDS[String(answer.result.error ?? "")] ?? "Squeak Hands couldn't open that chat.";
    },
  };
}
