import type { ChatModel } from "./chat-models.js";
import type { ChatStarter, NewChatAgent, StartChatOutcome } from "./chat-starter.js";
import { agentMessageFor, checkWorkSplit } from "./work-split.js";

/**
 * Starting a new chat in a host app from a Mac or phone surface: which workspaces can take one, and the
 * validated hand-off to the host's chat starter. The workspaces and models come from the host (an add-on).
 */

export const NEW_CHAT_MAX_TEXT = 20_000;

export interface NewChatWorkspace {
  id: string;
  repoName: string;
  branch: string;
  title?: string;
  lastActivityAt: string;
  defaultAgent: NewChatAgent;
  /** The workspace's own folder, from the host's records. Never sent to a phone. */
  path?: string;
}

/** A phone's model and level, checked against what the host offers; the error is for the person. */
export function checkChatModel(
  models: Array<{ agent: NewChatAgent; id: string; levels: string[] }>,
  agent: NewChatAgent,
  model: unknown,
  thinking: unknown,
): { ok: true; model?: string; thinking?: string } | { ok: false; reason: string } {
  if (model === undefined && thinking === undefined) return { ok: true };
  if (typeof model !== "string") return { ok: false, reason: "Choose a model." };
  const offered = models.find((candidate) => candidate.id === model && candidate.agent === agent);
  if (!offered)
    return { ok: false, reason: "That model isn't one this Mac offers for that agent any more. Pick another." };
  if (thinking === undefined) return { ok: true, model };
  if (typeof thinking !== "string" || !offered.levels.includes(thinking)) {
    return { ok: false, reason: "That thinking level isn't available for that model." };
  }
  return { ok: true, model, thinking };
}

/** What a host supplies for new chats: its workspaces, its models and the way to start one. */
export interface NewChatHost {
  /** Recent workspaces that can take a chat, newest first; throws when unreadable. */
  workspaces(limit?: number): NewChatWorkspace[];
  find(id: string): NewChatWorkspace | null;
  /** The models the host offers; throws when unreadable. */
  models(): ChatModel[];
  starter: ChatStarter;
}

/** The ingress control hooks, built over a host's new-chat pieces. */
export function newChatControl(host: NewChatHost) {
  return {
    workspaces: () => {
      try {
        return { workspaces: host.workspaces() };
      } catch {
        return { workspaces: [] };
      }
    },
    models: () => {
      try {
        return host.models();
      } catch {
        return [];
      }
    },
    startChat: async (body: {
      workspaceId?: unknown;
      agent?: unknown;
      text?: unknown;
      model?: unknown;
      thinking?: unknown;
      /** A `WorkSplit`: which models code and run, and whether to plan first. */
      split?: unknown;
    }): Promise<StartChatOutcome> => {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return { ok: false, reason: "Write a first message." };
      if (text.length > NEW_CHAT_MAX_TEXT) {
        return { ok: false, reason: `That message is too long (limit ${NEW_CHAT_MAX_TEXT} characters).` };
      }
      if (typeof body.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(body.workspaceId)) {
        return { ok: false, reason: "Choose a workspace." };
      }
      if (body.agent !== undefined && body.agent !== "claude" && body.agent !== "codex") {
        return { ok: false, reason: "Agent must be claude or codex." };
      }
      let workspace: NewChatWorkspace | null;
      try {
        workspace = host.find(body.workspaceId);
      } catch {
        return { ok: false, reason: "Couldn't read the workspaces." };
      }
      if (!workspace) return { ok: false, reason: "That workspace doesn't exist or is archived." };
      const agent = body.agent ?? workspace.defaultAgent;
      // Only a start that names a model needs the host's list; a plain one never reads it.
      let models: ChatModel[] = [];
      if (body.model !== undefined || body.thinking !== undefined) {
        try {
          models = host.models();
        } catch {
          return { ok: false, reason: "Couldn't read the models." };
        }
      }
      const chosen = checkChatModel(models, agent, body.model, body.thinking);
      if (!chosen.ok) return chosen;
      const split = checkWorkSplit(agent, body.split);
      if (!split.ok) return split;
      const agentText = agentMessageFor(text, split.split);
      return host.starter.startChat({
        workspaceId: workspace.id,
        agent,
        text,
        ...(chosen.model ? { model: chosen.model } : {}),
        ...(chosen.thinking ? { thinking: chosen.thinking } : {}),
        ...(agentText ? { agentText } : {}),
      });
    },
  };
}
