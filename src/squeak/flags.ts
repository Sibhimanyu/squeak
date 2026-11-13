import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * One registry for Squeak's on/off switches (docs/flags.md).
 *
 * A flag's value comes from, in order: its environment variable (today's exact parsing), `flags.json` in the
 * support dir (staged rollout, read once at start), then the default. The registry decides nothing new: every
 * flag here parses exactly as its scattered call site did before.
 */
export type FlagStage = "stable" | "beta" | "off-switch";

/**
 * How an environment value is read.
 * - `off-word`: on unless the trimmed, lower-cased value is exactly `off`.
 * - `off-word-extended`: on unless the trimmed value is `off`, `0`, `false` or `no` (any case).
 */
export type FlagParse = "off-word" | "off-word-extended";

export interface FlagDefinition {
  name: string;
  env: string;
  default: boolean;
  description: string;
  stage: FlagStage;
  parse: FlagParse;
}

export const FLAGS = [
  {
    name: "remote.verbose",
    env: "SQUEAK_REMOTE_VERBOSE",
    default: true,
    description:
      "Let a phone that opens a chat see its whole live turn (Show thinking live). Off refuses it on the Mac.",
    stage: "off-switch",
    parse: "off-word",
  },
  {
    name: "remote.local",
    env: "SQUEAK_REMOTE_LOCAL",
    default: true,
    description: "The direct same-Wi-Fi path to a paired phone.",
    stage: "off-switch",
    parse: "off-word",
  },
  {
    name: "caffeinate",
    env: "SQUEAK_CAFFEINATE",
    default: true,
    description: "Keep the Mac awake while an agent works. SQUEAK_CAFFEINATE=working also stops the plugged-in hold.",
    stage: "off-switch",
    parse: "off-word",
  },
  {
    name: "askFormat",
    env: "SQUEAK_ASK_FORMAT",
    default: true,
    description: "Tell agents how to ask, so a closing question becomes buttons (install-hooks).",
    stage: "off-switch",
    parse: "off-word-extended",
  },
  {
    name: "autoTitle",
    env: "SQUEAK_AUTO_TITLE",
    default: true,
    description: "Name a new native chat with one small Claude call; off names it from the first message locally.",
    stage: "off-switch",
    parse: "off-word",
  },
] as const satisfies readonly FlagDefinition[];

export type FlagName = (typeof FLAGS)[number]["name"];
export type FlagSource = "env" | "file" | "default";

export interface FlagView {
  name: FlagName;
  env: string;
  value: boolean;
  source: FlagSource;
  default: boolean;
  stage: FlagStage;
  description: string;
}

export const FLAGS_FILE_NAME = "flags.json";

/** Parse a raw environment value with a flag's own rule. Unset or blank reads as the default (on). */
export function parseFlagEnv(parse: FlagParse, raw: string | undefined): boolean {
  const value = (raw ?? "").trim();
  return parse === "off-word" ? value.toLowerCase() !== "off" : !/^(?:off|0|false|no)$/i.test(value);
}

function definitionOf(name: FlagName): FlagDefinition {
  return FLAGS.find((flag) => flag.name === name)!;
}

/**
 * Read `<supportDir>/flags.json`: a flat `{ "<flag name>": true | false }`. A missing file is empty; an invalid
 * file, and any unknown name or non-boolean value, is logged and ignored.
 */
export function readFlagFile(supportDir: string): Partial<Record<FlagName, boolean>> {
  const file = path.join(supportDir, FLAGS_FILE_NAME);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    logger.warn(`flags: ${file} is not valid JSON; ignoring it`);
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    logger.warn(`flags: ${file} must be an object of flag names to true/false; ignoring it`);
    return {};
  }
  const result: Partial<Record<FlagName, boolean>> = {};
  for (const [key, value] of Object.entries(data)) {
    const known = FLAGS.some((flag) => flag.name === key);
    if (known && typeof value === "boolean") result[key as FlagName] = value;
    else logger.warn(`flags: ignoring "${key}" in ${file} (${known ? "not true or false" : "unknown flag"})`);
  }
  return result;
}

export class FlagRegistry {
  constructor(private readonly overrides: Partial<Record<FlagName, boolean>> = {}) {}

  /** The value and where it came from. The environment is read on every call, so it always wins. */
  resolve(name: FlagName, env: NodeJS.ProcessEnv = process.env): { value: boolean; source: FlagSource } {
    const definition = definitionOf(name);
    const raw = env[definition.env];
    if (raw !== undefined && raw.trim() !== "") return { value: parseFlagEnv(definition.parse, raw), source: "env" };
    const override = this.overrides[name];
    if (override !== undefined) return { value: override, source: "file" };
    return { value: parseFlagEnv(definition.parse, raw), source: "default" };
  }

  flag(name: FlagName, env: NodeJS.ProcessEnv = process.env): boolean {
    return this.resolve(name, env).value;
  }

  list(env: NodeJS.ProcessEnv = process.env): FlagView[] {
    return FLAGS.map((definition) => ({
      name: definition.name,
      env: definition.env,
      ...this.resolve(definition.name, env),
      default: definition.default,
      stage: definition.stage,
      description: definition.description,
    }));
  }
}

let current = new FlagRegistry();

/** Called once at start (config load): reads `flags.json` from the support dir. */
export function initFlags(supportDir: string): FlagRegistry {
  current = new FlagRegistry(readFlagFile(supportDir));
  return current;
}

export function flags(): FlagRegistry {
  return current;
}

/** The flag's value now. Without `initFlags` it is the environment and the default, as before the registry. */
export function flag(name: FlagName, env: NodeJS.ProcessEnv = process.env): boolean {
  return current.flag(name, env);
}
