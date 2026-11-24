import { type TitleModelCall } from "./auto-title.js";

/**
 * The decider: when a Task is made, one choice: give it to a Duck, hatch a new Duck, or wait. Score-based, no hard
 * rule about any one input. Similarity and code-area overlap say how well a Duck fits; a full context window counts
 * against it (less for a small, closely related Task); being busy counts only a little; an Off-duty Duck is as eligible
 * as any other, so it can come back for related work. A model is asked only when the score is unsure, and when it is
 * still unsure the answer is a new Duck (a mistake then costs a fresh start, not a polluted context).
 *
 * It runs only when a Task is made. Its reasoning is shown as the Room's routing line and kept out of every Duck's
 * context: nothing here ever reaches a prompt.
 */

/** One Duck as the decider sees it (built by the host from its own records; the decider reads nothing itself). */
export interface DeciderDuck {
  id: string;
  name: string;
  duty: "on" | "off";
  /** Working a turn right now. */
  busy: boolean;
  /** How full its context window is, 0..100; null when unknown (never a fake 0). */
  contextPercent: number | null;
  /** Its Tasks and what it was asked, newest first: the text the new Task is compared with. */
  tasks: string[];
  /** The files it changed (paths or names), from its timeline's edit and write steps. */
  touched: string[];
}

export type Decision =
  | { kind: "duck"; duckId: string; reason: string }
  | { kind: "hatch"; reason: string }
  | { kind: "wait"; reason: string };

/** A Duck's fit for the Task, with the pieces the score was made of (the table tests read these). */
export interface ScoredDuck {
  duckId: string;
  name: string;
  score: number;
  similarity: number;
  overlap: number;
  contextPenalty: number;
  busyPenalty: number;
  /** "related to icon work", "knows Toolbar.swift". */
  reason: string;
}

export type DeciderResult = Decision & { ranked: ScoredDuck[] };

/** How alike the Task is to each text, 0..1 apiece. The on-device embedding adapter replaces the local one. */
export interface SimilarityPort {
  similarities(task: string, texts: string[]): Promise<number[]>;
}

export type ModelChoice = { kind: "duck"; duckId: string } | { kind: "hatch" } | { kind: "wait" };

export interface DeciderModelInput {
  task: string;
  ducks: Array<{ duckId: string; name: string; summary: string }>;
}

/** The adapter seam for the model that settles an unsure score. null = it is not sure either. */
export interface DeciderModelPort {
  choose(input: DeciderModelInput): Promise<ModelChoice | null>;
}

/** Weights and bands. A score at or above GIVE gives the Task to the Duck; below HATCH it hatches; between, a model asks. */
export const DECIDER_WEIGHTS = {
  /** What the code-area overlap adds to the room left over by text similarity. */
  overlapShare: 0.6,
  /** The most a full context costs, at 100%. Below half it costs a little, past half it climbs steeply. */
  contextMax: 0.8,
  contextBelowHalf: 0.1,
  /** How much of that a small, closely related Task is spared. */
  smallRelatedRelief: 0.8,
  /** A big Task counts a full context this much worse. */
  largeTaskExtra: 0.5,
  busy: 0.05,
  give: 0.5,
  hatch: 0.2,
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const STOP = new Set(
  "the and for with that this from into have has not but are was were you your can could would should please just then them they there their what when where which will its our out all any new use using about also more some like need want make let get got one two".split(
    " ",
  ),
);

/** Lowercase words of 3+ letters; camelCase, paths and file names split into their words; no stop words. */
export function words(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const out: string[] = [];
  for (const raw of spaced.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let w = raw;
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (w.length >= 3 && !STOP.has(w)) out.push(w);
  }
  return out;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Short texts that are plainly about the same thing share a few words and score a cosine near 0.3; the bands below read
 * 0.5 as "clearly related", so the local cosine is stretched to that scale (no shared word still scores 0).
 */
const COSINE_STRETCH = 2;

/** The local similarity: TF-IDF cosine over the Task and the Duck's texts (the Task is one document of the corpus). */
export class LocalSimilarity implements SimilarityPort {
  async similarities(task: string, texts: string[]): Promise<number[]> {
    const docs = [task, ...texts].map((t) => words(t));
    const df = new Map<string, number>();
    for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
    const idf = (w: string): number => Math.log(1 + docs.length / (df.get(w) ?? 1));
    const vec = (d: string[]): Map<string, number> => {
      const tf = new Map<string, number>();
      for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
      const v = new Map<string, number>();
      for (const [w, n] of tf) v.set(w, n * idf(w));
      return v;
    };
    const norm = (v: Map<string, number>): number => Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0));
    const t = vec(docs[0]!);
    const tn = norm(t);
    return docs.slice(1).map((d) => {
      const v = vec(d);
      const vn = norm(v);
      if (!tn || !vn) return 0;
      let dot = 0;
      for (const [w, x] of t) dot += x * (v.get(w) ?? 0);
      return clamp01((dot / (tn * vn)) * COSINE_STRETCH);
    });
  }
}

/** How many of the Task's words name something in the files the Duck changed, 0..1 (two shared words is full overlap). */
export function fileOverlap(task: string, touched: string[]): { overlap: number; file?: string } {
  const want = new Set(words(task));
  if (want.size === 0 || touched.length === 0) return { overlap: 0 };
  const shared = new Set<string>();
  let best: { file: string; n: number } | undefined;
  for (const file of touched) {
    const hit = words(file).filter((w) => want.has(w));
    for (const w of hit) shared.add(w);
    if (hit.length && (!best || hit.length > best.n)) best = { file, n: hit.length };
  }
  return { overlap: clamp01(shared.size / 2), ...(best ? { file: best.file } : {}) };
}

/** 0 (large) .. 1 (tiny): from the Task's words. */
export function smallness(text: string): number {
  return clamp01((60 - wordCount(text)) / 60);
}

function basename(p: string): string {
  return p.split("/").pop() || p;
}

export interface DeciderOptions {
  similarity?: SimilarityPort;
  /** Asked only when the score is unsure; absent = never asked (unsure hatches). */
  model?: DeciderModelPort | null;
  /** Called when the model fails, with why (the decision is then a new Duck). */
  onModelError?: (error: unknown) => void;
}

export class Decider {
  private readonly similarity: SimilarityPort;
  private readonly model: DeciderModelPort | null;

  constructor(private readonly o: DeciderOptions = {}) {
    this.similarity = o.similarity ?? new LocalSimilarity();
    this.model = o.model ?? null;
  }

  /** Every Duck's fit for the task, best first (ties by id so the order is stable). */
  async rank(task: string, ducks: DeciderDuck[]): Promise<ScoredDuck[]> {
    const W = DECIDER_WEIGHTS;
    // One call for all of the Ducks' texts: an embedding adapter pays its start-up once.
    const flat = ducks.flatMap((d) => d.tasks.map((t) => ({ duck: d.id, text: t })));
    const sims = flat.length
      ? await this.similarity.similarities(
          task,
          flat.map((f) => f.text),
        )
      : [];
    const best = new Map<string, { sim: number; text: string }>();
    flat.forEach((f, i) => {
      const sim = clamp01(sims[i] ?? 0);
      const cur = best.get(f.duck);
      if (!cur || sim > cur.sim) best.set(f.duck, { sim, text: f.text });
    });
    const small = smallness(task);
    const out: ScoredDuck[] = ducks.map((d) => {
      const similarity = best.get(d.id)?.sim ?? 0;
      const { overlap, file } = fileOverlap(task, d.touched);
      const fit = clamp01(similarity + (1 - similarity) * W.overlapShare * overlap);
      let contextPenalty = 0;
      if (d.contextPercent !== null) {
        const f = clamp01(d.contextPercent / 100);
        const over = Math.max(0, f - 0.5) / 0.5;
        contextPenalty = W.contextBelowHalf * (Math.min(f, 0.5) / 0.5) + W.contextMax * over * over;
        // A small Task that is closely related is spared most of it; a large one pays more.
        contextPenalty *= 1 - W.smallRelatedRelief * small * fit;
        contextPenalty *= 1 + W.largeTaskExtra * (1 - small) * over;
      }
      const busyPenalty = d.busy ? W.busy : 0;
      const score = fit - contextPenalty - busyPenalty;
      return {
        duckId: d.id,
        name: d.name,
        score,
        similarity,
        overlap,
        contextPenalty,
        busyPenalty,
        reason: reasonFor(task, best.get(d.id)?.text, similarity, overlap, file),
      };
    });
    return out.sort((a, b) => b.score - a.score || a.duckId.localeCompare(b.duckId));
  }

  async decide(task: string, ducks: DeciderDuck[], opts: { useModel?: boolean } = {}): Promise<DeciderResult> {
    const W = DECIDER_WEIGHTS;
    if (words(task).length === 0 && !task.trim()) {
      return { kind: "wait", reason: "the task has no words yet", ranked: [] };
    }
    const ranked = await this.rank(task, ducks);
    const top = ranked[0];
    if (!top) return { kind: "hatch", reason: "no Duck here yet", ranked };
    if (top.score >= W.give) return { kind: "duck", duckId: top.duckId, reason: top.reason, ranked };
    if (top.score < W.hatch) return { kind: "hatch", reason: "nothing here is related", ranked };
    // Unsure: the nearest few go to the model, which may still say it is not sure.
    if (!this.model || opts.useModel === false)
      return { kind: "hatch", reason: "not sure who fits, so a fresh Duck", ranked };
    const near = ranked.filter((r) => r.score >= W.hatch).slice(0, 3);
    const byId = new Map(ducks.map((d) => [d.id, d]));
    let choice: ModelChoice | null = null;
    try {
      choice = await this.model.choose({
        task,
        ducks: near.map((r) => ({
          duckId: r.duckId,
          name: r.name,
          summary: summaryOf(byId.get(r.duckId)),
        })),
      });
    } catch (error) {
      this.o.onModelError?.(error);
    }
    if (choice?.kind === "duck") {
      const hit = near.find((r) => r.duckId === choice.duckId);
      if (hit) return { kind: "duck", duckId: hit.duckId, reason: hit.reason, ranked };
    }
    if (choice?.kind === "wait") return { kind: "wait", reason: "better to wait a moment", ranked };
    return { kind: "hatch", reason: "not sure who fits, so a fresh Duck", ranked };
  }
}

function reasonFor(task: string, text: string | undefined, similarity: number, overlap: number, file?: string): string {
  if (file && overlap > 0 && overlap * 0.6 >= similarity) return `knows ${basename(file)}`;
  if (text && similarity > 0) {
    const want = new Set(words(task));
    const shared = [...new Set(words(text).filter((w) => want.has(w)))].slice(0, 3);
    if (shared.length) return `related to ${shared.join(" ")} work`;
  }
  return file ? `knows ${basename(file)}` : "related work";
}

function summaryOf(d: DeciderDuck | undefined): string {
  if (!d) return "";
  const tasks = d.tasks
    .slice(0, 3)
    .map((t) => t.replace(/\s+/g, " ").trim().slice(0, 120))
    .join("; ");
  const files = [...new Set(d.touched.map(basename))].slice(0, 6).join(", ");
  return [tasks && `Did: ${tasks}`, files && `Files: ${files}`].filter(Boolean).join(". ");
}

// ---- the Haiku adapter ----

export const DECIDER_SYSTEM =
  'You route one new task to one of a few AI agents ("ducks") or to a fresh one. Prefer the duck whose past work and files clearly relate to the task. If none clearly fits, or you are unsure, answer hatch. Reply with only JSON: {"choice":"1"} (a duck\'s number), {"choice":"hatch"}, or {"choice":"wait"}.';

const MODEL_TIMEOUT_MS = 8000;

/** The model port over a small-model call (Haiku, the same transport the job check and titles use). */
export function haikuDecider(call: () => TitleModelCall, timeoutMs = MODEL_TIMEOUT_MS): DeciderModelPort {
  return {
    async choose(input) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const timedOut = new Promise<never>((_, reject) =>
          abort.signal.addEventListener("abort", () => reject(new Error("decider timed out")), { once: true }),
        );
        const ducks = input.ducks.map((d, i) => `${i + 1}. ${d.name}${d.summary ? ` - ${d.summary}` : ""}`).join("\n");
        const raw = await Promise.race([
          call()({
            prompt: `Task:\n${input.task.slice(0, 600)}\n\nDucks:\n${ducks}\n\nJSON:`,
            system: DECIDER_SYSTEM,
            signal: abort.signal,
          }),
          timedOut,
        ]);
        return parseModelChoice(raw, input);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The model's answer as a choice; null for anything that is not strictly one of the offered answers. */
export function parseModelChoice(raw: string, input: DeciderModelInput): ModelChoice | null {
  const m = raw.match(/\{[^{}]*\}/);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const c = (o as { choice?: unknown } | null)?.choice;
  if (c === "hatch") return { kind: "hatch" };
  if (c === "wait") return { kind: "wait" };
  const n = typeof c === "number" ? c : typeof c === "string" && /^\d+$/.test(c) ? Number(c) : NaN;
  const duck = Number.isInteger(n) ? input.ducks[n - 1] : undefined;
  return duck ? { kind: "duck", duckId: duck.duckId } : null;
}
