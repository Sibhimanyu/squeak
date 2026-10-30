import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";
import type { ChatModel } from "./chat-models.js";
import { SPLIT_WORKERS } from "./work-split.js";

/**
 * New chat presets: one shared setting on the daemon, edited from the Mac app, the phone and the web
 * (`chat-presets.json`). A surface draws; it does not compute the built-in defaults against the stored
 * ones. What is stored is only what a person changed: absent means "the built-in rule", so a Mac that has
 * never been edited behaves exactly as before.
 *
 * Semantics mirror the Mac app's old local store: a preset's NAME is shared by both agents, a SETUP is per
 * agent and replaces the built-in one whole, and "restore defaults" for an agent's preset removes its setup
 * and the name.
 */
export const PRESET_IDS = ["best", "balanced", "save"] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const PRESET_AGENTS = ["claude", "codex"] as const;
export type PresetAgent = (typeof PRESET_AGENTS)[number];

export const PRESET_TITLES: Record<PresetId, string> = { best: "Best", balanced: "Balanced", save: "Save usage" };
export const MAX_PRESET_NAME = 32;
const MAX_ID = 80;
const LEVEL = /^[a-z][a-z0-9_-]{0,19}$/;

/** What a new chat starts with. A null / absent field is "the model's own default" or "the chat's own model". */
export interface PresetSetup {
  modelId: string;
  level: string | null;
  code: string | null;
  run: string | null;
  planFirst: boolean;
}

export interface ChatPresetsDoc {
  /** Custom names by preset id (shared by both agents). Absent: the built-in title. */
  names: Partial<Record<PresetId, string>>;
  /** Overrides per agent per preset. Absent: the built-in rule. */
  setups: Partial<Record<PresetAgent, Partial<Record<PresetId, PresetSetup>>>>;
}

export type PresetChange =
  | { agent: PresetAgent; preset: PresetId; change: { setup: unknown } }
  | { preset: PresetId; change: { name: string | null } }
  | { agent: PresetAgent; preset: PresetId; change: { reset: true } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPreset = (value: unknown): value is PresetId => PRESET_IDS.includes(value as PresetId);
const isAgent = (value: unknown): value is PresetAgent => PRESET_AGENTS.includes(value as PresetAgent);
const exactly = (record: Record<string, unknown>, allowed: string[], required: string[] = []) =>
  Object.keys(record).every((key) => allowed.includes(key)) && required.every((key) => key in record);

const BAD = { ok: false as const, reason: "Not a preset change this Mac understands." };

function cleanName(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.length > MAX_PRESET_NAME ? name.slice(0, MAX_PRESET_NAME).trim() : name;
}

/** A stored or sent setup, strictly read; undefined when it is not one. */
export function readPresetSetup(agent: PresetAgent, raw: unknown): PresetSetup | undefined {
  if (!isRecord(raw) || !exactly(raw, ["modelId", "level", "code", "run", "planFirst"], ["modelId"])) return undefined;
  const { modelId, level, code, run, planFirst } = raw;
  if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > MAX_ID) return undefined;
  if (level !== undefined && level !== null && !(typeof level === "string" && LEVEL.test(level))) return undefined;
  const worker = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null) return null;
    return typeof value === "string" && SPLIT_WORKERS.some((w) => w.id === value) ? value : undefined;
  };
  const codeId = worker(code);
  const runId = worker(run);
  if (codeId === undefined || runId === undefined) return undefined;
  if (planFirst !== undefined && typeof planFirst !== "boolean") return undefined;
  // Only Claude hands work to others; a Codex chat has nothing to split.
  if (agent !== "claude" && (codeId !== null || runId !== null || planFirst === true)) return undefined;
  return {
    modelId,
    level: (level as string | null | undefined) ?? null,
    code: codeId,
    run: runId,
    // Plan first holds delegated work; with none there is nothing to hold.
    planFirst: planFirst === true && (codeId !== null || runId !== null),
  };
}

export class ChatPresetsStore {
  private doc: ChatPresetsDoc = { names: {}, setups: {} };

  /**
   * `models` is the Mac's own list (Conductor's picker); when it names the agent's models, a setup naming one
   * it does not list, or a level the model does not take, is refused. Without a list a string is accepted.
   */
  constructor(
    private readonly file: string,
    private readonly models: () => ChatModel[] = () => [],
  ) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isRecord(raw)) this.doc = this.readDoc(raw);
    } catch {
      // Nothing saved, or unreadable: the built-in defaults stand.
    }
  }

  private readDoc(raw: Record<string, unknown>): ChatPresetsDoc {
    const doc: ChatPresetsDoc = { names: {}, setups: {} };
    if (isRecord(raw.names)) {
      for (const id of PRESET_IDS) {
        const name = cleanName(raw.names[id]);
        if (name) doc.names[id] = name;
      }
    }
    if (isRecord(raw.setups)) {
      for (const agent of PRESET_AGENTS) {
        const forAgent = raw.setups[agent];
        if (!isRecord(forAgent)) continue;
        for (const id of PRESET_IDS) {
          const setup = readPresetSetup(agent, forAgent[id]);
          if (setup) (doc.setups[agent] ??= {})[id] = setup;
        }
      }
    }
    return doc;
  }

  /** The document, as the routes, the phone view and the Mac app carry it. Empty `{names:{},setups:{}}` = all defaults. */
  snapshot(): ChatPresetsDoc {
    return JSON.parse(JSON.stringify(this.doc)) as ChatPresetsDoc;
  }

  /**
   * One change: `{ agent, preset, change: { setup } }`, `{ preset, change: { name: string | null } }` or
   * `{ agent, preset, change: { reset: true } }`; exactly those keys. A setup replaces the agent's preset whole.
   */
  apply(request: unknown): { ok: true; doc: ChatPresetsDoc } | { ok: false; reason: string } {
    if (!isRecord(request) || !isRecord(request.change) || !isPreset(request.preset)) return BAD;
    const { preset, change } = request;
    const next: ChatPresetsDoc = this.snapshot();
    if ("name" in change) {
      if (!exactly(request, ["preset", "change"], ["preset", "change"]) || !exactly(change, ["name"])) return BAD;
      const name = cleanName(change.name);
      if (name === undefined) return { ok: false, reason: "A preset's name is text." };
      if (!name || name === PRESET_TITLES[preset]) delete next.names[preset];
      else next.names[preset] = name;
    } else {
      if (!isAgent(request.agent) || !exactly(request, ["agent", "preset", "change"], ["agent", "preset", "change"])) {
        return BAD;
      }
      const agent = request.agent;
      if ("reset" in change) {
        if (!exactly(change, ["reset"]) || change.reset !== true) return BAD;
        delete next.names[preset];
        if (next.setups[agent]) delete next.setups[agent]![preset];
      } else if ("setup" in change) {
        if (!exactly(change, ["setup"])) return BAD;
        const setup = readPresetSetup(agent, change.setup);
        if (!setup) return { ok: false, reason: "That is not a setup this Mac can start a chat with." };
        const offered = this.models().filter((model) => model.agent === agent);
        if (offered.length > 0) {
          const model = offered.find((m) => m.id === setup.modelId);
          if (!model) return { ok: false, reason: "This Mac doesn't offer that model." };
          if (setup.level !== null && !model.levels.includes(setup.level)) {
            return { ok: false, reason: "That model doesn't take that thinking level." };
          }
        }
        (next.setups[agent] ??= {})[preset] = setup;
      } else {
        return BAD;
      }
    }
    for (const agent of PRESET_AGENTS) {
      if (next.setups[agent] && Object.keys(next.setups[agent]!).length === 0) delete next.setups[agent];
    }
    try {
      this.save(next);
    } catch (error) {
      logger.warn("chat presets could not be saved", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: "This Mac could not save the presets." };
    }
    this.doc = next;
    return { ok: true, doc: this.snapshot() };
  }

  private save(doc: ChatPresetsDoc): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
