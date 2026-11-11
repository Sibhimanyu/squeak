import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";
import type { ChatModel } from "./chat-models.js";
import { SPLIT_WORKERS } from "./work-split.js";

/**
 * New chat presets: three SHARED presets (best / balanced / save) for Claude threads, one setting on the daemon,
 * edited from the Mac app, the phone and the web (`chat-presets.json`). Each mixes models by role: the thread's
 * own model plans and talks, `code` and `run` name the Claude models its coding and command subagents use
 * (`work-split.ts`), `planFirst` holds changes until go. Codex threads have no presets (a plain model picker).
 *
 * What is stored is only what a person changed; `snapshot()` answers the RESOLVED presets (the built-in defaults,
 * worked out from the models this Mac lists, with stored ones laid over them), so a surface draws and never
 * computes a default. `setups.claude` repeats them for older phones and Macs, which read the per-agent shape.
 */
export const PRESET_IDS = ["best", "balanced", "save"] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const PRESET_AGENTS = ["claude", "codex"] as const;
export type PresetAgent = (typeof PRESET_AGENTS)[number];

export const PRESET_TITLES: Record<PresetId, string> = { best: "Best", balanced: "Balanced", save: "Save usage" };
export const MAX_PRESET_NAME = 32;
const MAX_ID = 80;
const LEVEL = /^[a-z][a-z0-9_-]{0,19}$/;

/** What a new Claude thread starts with. A null / absent field is "the model's own default" or "the thread's own model". */
export interface PresetSetup {
  modelId: string;
  level: string | null;
  code: string | null;
  run: string | null;
  planFirst: boolean;
}

export interface ChatPresetsDoc {
  /** Custom names by preset id. Absent: the built-in title. */
  names: Partial<Record<PresetId, string>>;
  /** The three presets as a new thread starts with them (defaults and edits resolved); empty with no Claude model listed. */
  presets: Partial<Record<PresetId, PresetSetup>>;
  /** The same presets under the old per-agent shape, for an older phone or Mac. Claude only. */
  setups: Partial<Record<PresetAgent, Partial<Record<PresetId, PresetSetup>>>>;
}

/** What is saved: only what a person changed. */
interface StoredPresets {
  version: 2;
  names: Partial<Record<PresetId, string>>;
  presets: Partial<Record<PresetId, PresetSetup>>;
}

export type PresetChange =
  | { agent?: "claude"; preset: PresetId; change: { setup: unknown } }
  | { preset: PresetId; change: { name: string | null } }
  | { agent?: "claude"; preset: PresetId; change: { reset: true } };

const WANT_LEVEL: Record<PresetId, string> = { best: "high", balanced: "medium", save: "low" };
const WANT_WORKERS: Record<PresetId, { code: string; run: string }> = {
  best: { code: "opus", run: "sonnet" },
  balanced: { code: "sonnet", run: "haiku" },
  save: { code: "haiku", run: "haiku" },
};

const family = (model: ChatModel, name: string) => `${model.id} ${model.label}`.toLowerCase().includes(name);
const longContext = (model: ChatModel) => /1m/i.test(`${model.id} ${model.label}`);

function pick(list: ChatModel[], families: string[], preferLong: boolean): ChatModel {
  for (const name of families) {
    const found = list.filter((model) => family(model, name));
    if (found.length === 0) continue;
    return found.find((model) => longContext(model) === preferLong) ?? found[0]!;
  }
  return list[0]!;
}

function levelFor(model: ChatModel, want: string): string | null {
  if (model.levels.length === 0) return null;
  return model.levels.includes(want) ? want : (model.defaultLevel ?? model.levels[0]!);
}

/**
 * The built-in presets, only from the Claude models this Mac lists: Best = Opus (1M when offered) plans, Opus
 * codes, Sonnet runs commands, high; Balanced = Opus plans, Sonnet codes, Haiku runs, medium; Save usage =
 * Sonnet plans, Haiku codes and runs, low. A family not listed falls to the nearest one that is. None listed: none.
 */
export function builtinPresets(models: ChatModel[]): Partial<Record<PresetId, PresetSetup>> {
  const claude = models.filter((model) => model.agent === "claude");
  if (claude.length === 0) return {};
  const out: Partial<Record<PresetId, PresetSetup>> = {};
  for (const id of PRESET_IDS) {
    const planner = pick(claude, id === "save" ? ["sonnet", "haiku"] : ["opus", "fable"], id === "best");
    out[id] = { modelId: planner.id, level: levelFor(planner, WANT_LEVEL[id]), ...WANT_WORKERS[id], planFirst: false };
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPreset = (value: unknown): value is PresetId => PRESET_IDS.includes(value as PresetId);
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

/** A stored or sent setup, strictly read; undefined when it is not one. Presets are Claude's: Codex has none. */
export function readPresetSetup(agent: PresetAgent, raw: unknown): PresetSetup | undefined {
  if (agent !== "claude") return undefined;
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
  private doc: StoredPresets = { version: 2, names: {}, presets: {} };

  /**
   * `models` is the Mac's own list (Conductor's picker, or Squeak's catalog); when it names Claude models, a setup
   * naming one it does not list, or a level the model does not take, is refused, and the built-in presets are
   * worked out from it. Without a list a string is accepted and no default is made.
   */
  constructor(
    private readonly file: string,
    private readonly models: () => ChatModel[] = () => [],
  ) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return; // Nothing saved, or unreadable: the built-in defaults stand.
    }
    if (!isRecord(raw)) return;
    this.doc = this.readDoc(raw);
    // The old file held a setup per agent: its Claude ones become the shared presets, Codex's are dropped. Once.
    if (raw.version !== 2) {
      try {
        this.save(this.doc);
      } catch {
        // Read-only support dir: the migrated copy still serves from memory.
      }
    }
  }

  private readDoc(raw: Record<string, unknown>): StoredPresets {
    const doc: StoredPresets = { version: 2, names: {}, presets: {} };
    if (isRecord(raw.names)) {
      for (const id of PRESET_IDS) {
        const name = cleanName(raw.names[id]);
        if (name) doc.names[id] = name;
      }
    }
    const source = raw.version === 2 ? raw.presets : isRecord(raw.setups) ? raw.setups.claude : undefined;
    if (isRecord(source)) {
      for (const id of PRESET_IDS) {
        const setup = readPresetSetup("claude", source[id]);
        if (setup) doc.presets[id] = setup;
      }
    }
    return doc;
  }

  /** A stored setup this Mac can still start a thread with: its model is listed and takes the level. */
  private usable(setup: PresetSetup, claude: ChatModel[]): boolean {
    if (claude.length === 0) return true;
    const model = claude.find((m) => m.id === setup.modelId);
    return !!model && (setup.level === null || model.levels.includes(setup.level));
  }

  /**
   * The document, as the routes, the phone view and the Mac app carry it: custom names, the three resolved
   * presets, and the same under `setups.claude` for older clients.
   */
  snapshot(): ChatPresetsDoc {
    const models = this.models();
    const claude = models.filter((model) => model.agent === "claude");
    const builtin = builtinPresets(models);
    const presets: Partial<Record<PresetId, PresetSetup>> = {};
    for (const id of PRESET_IDS) {
      const stored = this.doc.presets[id];
      const chosen = stored && this.usable(stored, claude) ? stored : builtin[id];
      if (chosen) presets[id] = { ...chosen };
    }
    const copy = JSON.parse(JSON.stringify({ names: this.doc.names, presets })) as Pick<
      ChatPresetsDoc,
      "names" | "presets"
    >;
    return {
      names: copy.names,
      presets: copy.presets,
      setups: Object.keys(copy.presets).length > 0 ? { claude: JSON.parse(JSON.stringify(copy.presets)) } : {},
    };
  }

  /**
   * One change: `{ preset, change: { setup } }`, `{ preset, change: { name: string | null } }` or
   * `{ preset, change: { reset: true } }`; exactly those keys, plus `agent: "claude"` that older clients still
   * send on a setup or reset (Codex has no presets). A setup replaces the preset whole; a reset drops its setup and name.
   */
  apply(request: unknown): { ok: true; doc: ChatPresetsDoc } | { ok: false; reason: string } {
    if (!isRecord(request) || !isRecord(request.change) || !isPreset(request.preset)) return BAD;
    const { preset, change } = request;
    const next: StoredPresets = JSON.parse(JSON.stringify(this.doc)) as StoredPresets;
    if ("name" in change) {
      if (!exactly(request, ["preset", "change"], ["preset", "change"]) || !exactly(change, ["name"])) return BAD;
      const name = cleanName(change.name);
      if (name === undefined) return { ok: false, reason: "A preset's name is text." };
      if (!name || name === PRESET_TITLES[preset]) delete next.names[preset];
      else next.names[preset] = name;
    } else {
      if (!exactly(request, ["agent", "preset", "change"], ["preset", "change"])) return BAD;
      if ("agent" in request && request.agent !== "claude") {
        if (!PRESET_AGENTS.includes(request.agent as PresetAgent)) return BAD;
        // Codex has no presets: an older client's reset of one is a no-op, anything else is refused.
        if ("reset" in change && exactly(change, ["reset"]) && change.reset === true) {
          return { ok: true, doc: this.snapshot() };
        }
        return { ok: false, reason: "Presets are for Claude threads; Codex keeps its own model picker." };
      }
      if ("reset" in change) {
        if (!exactly(change, ["reset"]) || change.reset !== true) return BAD;
        delete next.names[preset];
        delete next.presets[preset];
      } else if ("setup" in change) {
        if (!exactly(change, ["setup"])) return BAD;
        const setup = readPresetSetup("claude", change.setup);
        if (!setup) return { ok: false, reason: "That is not a setup this Mac can start a chat with." };
        const offered = this.models().filter((model) => model.agent === "claude");
        if (offered.length > 0) {
          const model = offered.find((m) => m.id === setup.modelId);
          if (!model) return { ok: false, reason: "This Mac doesn't offer that model." };
          if (setup.level !== null && !model.levels.includes(setup.level)) {
            return { ok: false, reason: "That model doesn't take that thinking level." };
          }
        }
        next.presets[preset] = setup;
      } else {
        return BAD;
      }
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

  private save(doc: StoredPresets): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
