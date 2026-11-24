import fs from "node:fs";
import path from "node:path";

/** Claude Code's artifact tools: they publish to claude.ai, which a Squeak chat must not depend on (use `show`). */
export const ARTIFACT_TOOLS = ["Artifact", "ArtifactComments", "ArtifactData", "ArtifactCheck"] as const;

export type DeciderModelSetting = "on-device" | "haiku";

export interface AgentSettingsView {
  /** "Use my claude.ai connectors in Squeak chats": off by default. */
  claudeAiConnectors: boolean;
  /** Who settles an unsure Task routing: this Mac's own models (default; falls back to Haiku when it cannot) or Haiku. */
  deciderModel: DeciderModelSetting;
}

/** Host-wide settings for the agents Squeak runs, in `agent-settings.json` (support dir). A bad file reads as the defaults. */
export class AgentSettings {
  private readonly file: string;
  constructor(supportDir: string) {
    this.file = path.join(supportDir, "agent-settings.json");
  }

  get(): AgentSettingsView {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return {
        claudeAiConnectors: raw.claudeAiConnectors === true,
        deciderModel: raw.deciderModel === "haiku" ? "haiku" : "on-device",
      };
    } catch {
      return { claudeAiConnectors: false, deciderModel: "on-device" };
    }
  }

  /** Strict: only known keys with booleans. Throws an Error with a plain message otherwise. */
  set(body: unknown): AgentSettingsView {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("expected an object");
    const next = { ...this.get() };
    for (const [k, v] of Object.entries(body)) {
      if (k === "deciderModel") {
        if (v !== "on-device" && v !== "haiku") throw new Error('deciderModel is "on-device" or "haiku"');
        next.deciderModel = v;
      } else if (k === "claudeAiConnectors") {
        if (typeof v !== "boolean") throw new Error("claudeAiConnectors is true or false");
        next.claudeAiConnectors = v;
      } else throw new Error(`unknown setting ${k}`);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next), { mode: 0o600 });
    return next;
  }
}
