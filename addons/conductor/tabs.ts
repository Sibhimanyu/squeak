import { handsWords, runHandsMode, type FrontAppHost, type HostPlace } from "../../src/fleet/window-tabs.js";

/**
 * Conductor as a front app (core's window-tabs.ts): when it is in front, the phone's Mac controls page shows its
 * recent workspaces and their open chats, read from its own records. A chat is opened by id alone; the Mac looks
 * its workspace up itself, and Squeak Hands proves the route names it before leaving it on screen.
 */

export const CONDUCTOR_BUNDLE_ID = "com.conductor.app";

const HANDS_WORDS: Record<string, string> = {
  "conductor-not-running": "Conductor isn't running.",
  "no-window": "Conductor has no window open.",
  "workspace-not-in-sidebar": "That workspace isn't in Conductor's sidebar.",
  "chat-not-open": "That chat isn't open as a tab in Conductor.",
};

export interface ConductorTabsDeps {
  handsAppPath: string | null;
  /** Conductor's recent workspaces with their open chats. */
  places(): HostPlace[];
  /** One chat's workspace and title; null when there is no such chat. */
  chat(sessionId: string): { workspaceId: string; title: string | null } | null;
}

export function conductorFrontApp(deps: ConductorTabsDeps): FrontAppHost {
  return {
    bundleId: CONDUCTOR_BUNDLE_ID,
    kind: "conductor",
    label: "Conductor",
    places: deps.places,
    chat: deps.chat,
    async showChat(request) {
      const answer = await runHandsMode(deps.handsAppPath, "show-chat", request);
      if (!answer.ok) return answer.reason;
      if (answer.result.ok === true) return null;
      return handsWords(String(answer.result.error ?? ""), HANDS_WORDS) ?? "Squeak Hands couldn't open that chat.";
    },
  };
}
