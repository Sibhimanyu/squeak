import type { AddonReplier } from "../addons.js";
import { STEER_UNAVAILABLE_NOTE, type ReplyOutcome, type ReplyOptions } from "./reply-types.js";
import { SqueakHandsTerminal, TerminalReplier } from "./terminal-reply.js";
import type { AgentKind, FleetSession } from "./types.js";

/** One TerminalReplier per Squeak Hands app: there is one keyboard, so sends of every agent queue behind each other. */
const shared = new Map<string, TerminalReplier>();

function terminalFor(handsAppPath: string): TerminalReplier {
  let replier = shared.get(handsAppPath);
  if (!replier) {
    replier = new TerminalReplier({ screen: new SqueakHandsTerminal(handsAppPath) });
    shared.set(handsAppPath, replier);
  }
  return replier;
}

export interface TerminalAddonReplierOptions {
  /** The add-on's id, used as the replier's `hostId`. */
  hostId: string;
  /** Which agent this add-on serves; the other one's terminal sessions are not its to answer. */
  agent: AgentKind;
  /** Squeak Hands' app path; without it terminal agents stay watch-only and no replier exists. */
  handsAppPath: string | null | undefined;
  /** The fleet's current view, to resolve a fleet key back to its session. */
  sessions: () => FleetSession[];
  /** Tests: a replier of their own instead of the shared Hands-backed one. */
  terminal?: TerminalReplier;
}

/**
 * The Terminal replier as an add-on's `AddonReplier` for sessions no host owns (no `hostId`): a `claude` or `codex`
 * running in Terminal.app, answered by typing into its tab. Every proof and refusal lives in `TerminalReplier`
 * (terminal-reply.ts) unchanged; this only adapts its shape. Targets are fleet keys, so `ownsTarget` is never true.
 */
export function createTerminalAddonReplier(options: TerminalAddonReplierOptions): AddonReplier | null {
  if (!options.terminal && !options.handsAppPath) return null;
  const terminal = options.terminal ?? terminalFor(options.handsAppPath as string);
  const resolve = (key: string): FleetSession | null => options.sessions().find((s) => s.key === key) ?? null;
  const mine = (session: FleetSession): boolean =>
    !session.hostId && session.agent === options.agent && terminal.canReply(session);
  return {
    hostId: options.hostId,
    canHandle: mine,
    ownsTarget: () => false,
    lastTurnText(key: string): string | null {
      const session = resolve(key);
      return session && mine(session) ? terminal.lastTurnText(session) : null;
    },
    lastTurnId(key: string): string | null {
      const session = resolve(key);
      return session && mine(session) ? terminal.lastTurnId(session) : null;
    },
    async send(key: string, text: string, _onFailed, replyOptions: ReplyOptions = {}): Promise<ReplyOutcome> {
      const session = resolve(key);
      if (!session || !mine(session)) {
        return { status: "refused", reason: "That session cannot be replied to from here." };
      }
      // A terminal agent is only typed into when idle, so there is nothing to queue or steer; say so if asked.
      const outcome = await terminal.send(session, text);
      if (outcome.status !== "started") return outcome;
      return {
        ...outcome,
        delivery: "sent",
        ...(replyOptions.mode === "steer" ? { note: STEER_UNAVAILABLE_NOTE } : {}),
      };
    },
  };
}
