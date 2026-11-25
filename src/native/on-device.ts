import { spawn } from "node:child_process";
import fs from "node:fs";

import type { DeciderModelSetting } from "./agent-settings.js";
import { logger } from "../utils/logger.js";
import {
  DECIDER_SYSTEM,
  Decider,
  LocalSimilarity,
  deciderPrompt,
  parseModelChoice,
  type DeciderModelInput,
  type DeciderModelPort,
  type ModelChoice,
  type SimilarityPort,
} from "./decider.js";
import { FINISH_SYSTEM, finishPrompt, type FinishInput, type FinishWriterPort } from "./room-finish.js";

/**
 * The on-device decider: the Mac app bundles `squeak-decider` (helpers/squeak-decider), which embeds text with Apple's
 * NaturalLanguage and settles an unsure routing with the on-device Apple model. It is one process per request: a JSON
 * request on stdin, one JSON reply on stdout. Nothing here ever blocks or fails the host: a missing helper, Apple
 * Intelligence being off, a hang or garbage all fall back (similarity to the local TF-IDF, the model to Haiku).
 */

export type { DeciderModelSetting };

export type HelperReply =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

const EMBED_TIMEOUT_MS = 4000;
const DECIDE_TIMEOUT_MS = 8000;
/** After the helper says it is unavailable (Apple Intelligence off), it is not asked again for this long. */
const UNAVAILABLE_FOR_MS = 5 * 60_000;
const MAX_REPLY_BYTES = 1_000_000;

/** Where the helper may be: SQUEAK_DECIDER_BIN, the Mac app's bundle, the support folder. */
export function deciderHelperDirs(supportDir: string): string[] {
  return ["/Applications/Squeak.app/Contents/Helpers/squeak-decider", `${supportDir}/squeak-decider`];
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The first executable helper; `dirs` are full file paths in order of preference. undefined = no helper installed. */
export function resolveDeciderHelper(options: { env?: NodeJS.ProcessEnv; dirs: string[] }): string | undefined {
  const override = (options.env ?? process.env).SQUEAK_DECIDER_BIN?.trim();
  if (override && isExecutable(override)) return override;
  return options.dirs.find(isExecutable);
}

/** Runs the helper once. Never throws and never outlives `timeoutMs`. */
export function runHelper(bin: string, request: unknown, timeoutMs: number): Promise<HelperReply> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: HelperReply): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      resolve({ kind: "failed", reason: String(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "failed", reason: "timed out" });
    }, timeoutMs);
    timer.unref?.();
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_REPLY_BYTES) {
        child.kill("SIGKILL");
        finish({ kind: "failed", reason: "reply too large" });
      } else chunks.push(c);
    });
    child.on("error", (error) => finish({ kind: "failed", reason: error.message }));
    child.on("close", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (body.ok === true) return finish({ kind: "ok", body });
        if (body.unavailable === true) {
          return finish({ kind: "unavailable", reason: typeof body.reason === "string" ? body.reason : "unavailable" });
        }
        finish({ kind: "failed", reason: typeof body.reason === "string" ? body.reason : "helper refused" });
      } catch {
        finish({ kind: "failed", reason: "no JSON reply" });
      }
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(request));
  });
}

interface AdapterOptions {
  /** The helper's path now; undefined = not installed. Read on every call so an install is picked up. */
  helper: () => string | undefined;
  /** False = the setting is off: the fallback answers without spawning anything. */
  enabled?: () => boolean;
  timeoutMs?: number;
  now?: () => number;
}

/** The shared "should we even ask" state: setting, installed helper, and a pause after "unavailable". */
class HelperGate {
  private pausedUntil = 0;
  constructor(private readonly o: AdapterOptions) {}

  async call(request: unknown, timeoutMs: number): Promise<HelperReply | null> {
    if (this.o.enabled && !this.o.enabled()) return null;
    const now = (this.o.now ?? Date.now)();
    if (now < this.pausedUntil) return null;
    const bin = this.o.helper();
    if (!bin) return null;
    const reply = await runHelper(bin, request, this.o.timeoutMs ?? timeoutMs);
    if (reply.kind === "unavailable") {
      this.pausedUntil = now + UNAVAILABLE_FOR_MS;
      logger.info("on-device decider unavailable", { reason: reply.reason });
    } else if (reply.kind === "failed") logger.warn("on-device decider helper failed", { reason: reply.reason });
    return reply;
  }
}

/** Similarity by Apple's sentence embeddings; the local TF-IDF whenever the helper cannot answer. */
export class OnDeviceSimilarity implements SimilarityPort {
  private readonly gate: HelperGate;
  private readonly fallback: SimilarityPort;
  constructor(o: AdapterOptions & { fallback?: SimilarityPort }) {
    this.gate = new HelperGate(o);
    this.fallback = o.fallback ?? new LocalSimilarity();
  }

  async similarities(task: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];
    const reply = await this.gate.call({ op: "embed", task, texts }, EMBED_TIMEOUT_MS);
    const sims = reply?.kind === "ok" ? reply.body.similarities : undefined;
    if (
      Array.isArray(sims) &&
      sims.length === texts.length &&
      sims.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return sims as number[];
    }
    return this.fallback.similarities(task, texts);
  }
}

/** The unsure-routing model on the Mac's own Apple model; the fallback (Haiku) when the helper cannot answer. */
export class OnDeviceDecider implements DeciderModelPort {
  private readonly gate: HelperGate;
  private readonly fallback: DeciderModelPort | null;
  constructor(o: AdapterOptions & { fallback?: DeciderModelPort | null }) {
    this.gate = new HelperGate(o);
    this.fallback = o.fallback ?? null;
  }

  async choose(input: DeciderModelInput): Promise<ModelChoice | null> {
    const allowed = [...input.ducks.map((_, i) => String(i + 1)), "hatch", "wait"];
    const reply = await this.gate.call(
      { op: "decide", system: DECIDER_SYSTEM, prompt: deciderPrompt(input), allowed },
      DECIDE_TIMEOUT_MS,
    );
    if (reply?.kind === "ok") {
      // The model answered (or had no answer: unsure, which hatches); either way Haiku is not asked.
      const choice = reply.body.choice;
      return typeof choice === "string" ? parseModelChoice(JSON.stringify({ choice }), input) : null;
    }
    return this.fallback ? this.fallback.choose(input) : null;
  }
}

export interface CreateDeciderOptions {
  /** The owner's setting now ("on-device" is the default). */
  setting: () => DeciderModelSetting;
  helper: () => string | undefined;
  /** The Haiku adapter: the model when the setting is "haiku" and the fallback when the helper cannot answer. */
  haiku: DeciderModelPort;
  onModelError?: (error: unknown) => void;
}

/** The host's decider: on-device by default, Haiku as the setting or as the automatic fallback. */
export function createDecider(o: CreateDeciderOptions): Decider {
  const enabled = (): boolean => o.setting() === "on-device";
  return new Decider({
    similarity: new OnDeviceSimilarity({ helper: o.helper, enabled }),
    model: new OnDeviceDecider({ helper: o.helper, enabled, fallback: o.haiku }),
    ...(o.onModelError ? { onModelError: o.onModelError } : {}),
  });
}

const WRITE_TIMEOUT_MS = 10_000;

/**
 * The Room message of a finished Task, written on the Mac's own Apple model (`{op:"write", system, prompt}` answers
 * `{ok:true, text}`). A null answer (helper missing, off, or too old to know the op) leaves it to the Haiku port.
 */
export class OnDeviceFinishWriter implements FinishWriterPort {
  private readonly gate: HelperGate;
  constructor(o: AdapterOptions) {
    this.gate = new HelperGate(o);
  }

  async write(input: FinishInput): Promise<string | null> {
    const reply = await this.gate.call(
      { op: "write", system: FINISH_SYSTEM, prompt: finishPrompt(input) },
      WRITE_TIMEOUT_MS,
    );
    const text = reply?.kind === "ok" ? reply.body.text : undefined;
    return typeof text === "string" && text.trim() ? text : null;
  }
}

/** The finish-message writers in order: on-device when the setting allows it, then Haiku. */
export function createFinishWriters(o: {
  setting: () => DeciderModelSetting;
  helper: () => string | undefined;
  haiku: FinishWriterPort;
}): FinishWriterPort[] {
  return [new OnDeviceFinishWriter({ helper: o.helper, enabled: () => o.setting() === "on-device" }), o.haiku];
}
