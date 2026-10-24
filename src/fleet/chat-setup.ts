import type { ChatModel } from "./chat-models.js";

/**
 * A change to what a Conductor chat runs, checked against the models this Mac offers for the chat's own agent
 * (so never another provider's). Shared by the phone's signed `setup` command and the Mac app's control route.
 * An absent level keeps the chat's own when the new model takes it, else the model's default; an absent fast
 * mode keeps the chat's.
 */
export function resolveSetup(
  models: ChatModel[],
  chat: { agent: string; effortId?: string; fast?: boolean },
  ask: { model: unknown; thinking?: unknown; fast?: unknown },
):
  | { ok: true; model: string; label: string; thinkingLevel?: string; fastMode: boolean }
  | { ok: false; reason: string } {
  if (
    typeof ask.model !== "string" ||
    (ask.thinking !== undefined && typeof ask.thinking !== "string") ||
    (ask.fast !== undefined && typeof ask.fast !== "boolean")
  ) {
    return { ok: false, reason: "Not a request this Mac understands." };
  }
  if (chat.agent !== "claude" && chat.agent !== "codex") {
    return { ok: false, reason: "This chat's agent has no models to pick from." };
  }
  const offered = models.find((candidate) => candidate.id === ask.model && candidate.agent === chat.agent);
  if (!offered)
    return { ok: false, reason: "That model isn't one this Mac offers for this chat's agent. Pick another." };
  let thinking: string | undefined;
  if (ask.thinking !== undefined) {
    if (!offered.levels.includes(ask.thinking as string)) {
      return { ok: false, reason: "That thinking level isn't available for that model." };
    }
    thinking = ask.thinking as string;
  } else if (chat.effortId && offered.levels.includes(chat.effortId)) {
    thinking = chat.effortId;
  } else if (offered.defaultLevel && offered.levels.includes(offered.defaultLevel)) {
    thinking = offered.defaultLevel;
  } else {
    thinking = offered.levels.at(-1);
  }
  return {
    ok: true,
    model: offered.id,
    label: offered.label,
    ...(thinking ? { thinkingLevel: thinking } : {}),
    fastMode: (ask.fast as boolean | undefined) ?? chat.fast === true,
  };
}
