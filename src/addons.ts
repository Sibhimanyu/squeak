import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { SqueakAgentAdapter } from "./core/adapter.js";
import type { FleetObservation } from "./core/adapters/fleet-ports.js";
import type { Answerer } from "./fleet/answer-command.js";
import type { AnswerHost } from "./fleet/answer.js";
import type { BackgroundTask } from "./fleet/background-work.js";
import type { WatchSpec } from "./fleet/change-watcher.js";
import type { FleetSnapshot } from "./fleet/fleet-monitor.js";
import type { ChatModel } from "./fleet/chat-models.js";
import type { NewChatHost } from "./fleet/new-chat.js";
import type { ReplyFailureHandler, ReplyOptions, ReplyOutcome, QueueAction, QueueItem } from "./fleet/reply-types.js";
import type { TranscriptResult } from "./fleet/transcript.js";
import type { FleetSession, ObservedSession } from "./fleet/types.js";
import type { FrontAppHost } from "./fleet/window-tabs.js";
import type { WorkSteps } from "./fleet/work-steps.js";
import type { SqueakConfig } from "./squeak/config.js";
import { logger } from "./utils/logger.js";

/**
 * Add-ons: code that is not part of core, found at run time and never imported statically, so a core without one
 * (its folder deleted) is whole. Core knows only this interface; nothing under `src/` may import `addons/`.
 *
 *  - An add-on lives in `addons/<name>/` with an `addon.json` manifest ({@link AddonManifest}) and an `index`
 *    whose default export is an {@link Addon}. It is built to `dist/addons/<name>/index.js` (`scripts/addons.sh`,
 *    one self-contained bundle) beside the daemon, or run from source with tsx.
 *  - A `distributed` add-on ships in every build and is loaded at every start, inert until the owner enables it
 *    (`addons.json` in the support dir, `GET/POST /control/addons`). Any other add-on is for development: it loads
 *    only when `SQUEAK_ADDONS=name,name` names it (`SQUEAK_CONDUCTOR_RELAY=on` is an alias for `conductor-relay`).
 *  - A manifest's `requires` names add-ons that must be loaded and enabled for it to activate this run.
 *  - A missing, unreadable or throwing add-on is logged and skipped; startup never fails for one.
 */

export interface AddonManifest {
  id: string;
  /** What Settings › Add-ons calls it. */
  name: string;
  /** One sentence: what adding it does. */
  blurb: string;
  /** Ships in every build and loads without being asked; false (or absent) is a development add-on. */
  distributed?: boolean;
  /** Add-ons that must be loaded and enabled before this one activates (it loads only at start). */
  requires?: string[];
}

/** What core hands an add-on from its own configuration. */
export type AddonConfig = Pick<
  SqueakConfig,
  | "dbPath"
  | "supportDir"
  | "workspacesRoot"
  | "defaultFallbackModel"
  | "defaultPermissionMode"
  | "claudeBin"
  | "codexBin"
  | "handsAppPath"
  | "activeWindowMs"
> & {
  /** Squeak's own session host's database; an add-on that imports chats reads it. */
  nativeDbPath: string;
};

/** Named values add-ons pass to each other (the relay add-on gives the Conductor add-on its route this way). */
export interface AddonServices {
  provide<T>(name: string, value: T): void;
  get<T>(name: string): T | undefined;
}

export interface AddonContext {
  id: string;
  supportDir: string;
  config: AddonConfig;
  env: NodeJS.ProcessEnv;
  logger: typeof logger;
  /** The fleet's current view; empty until the monitor has run. */
  snapshot(): FleetSnapshot;
  /** Ask the monitor for a refresh now (an enable, a pick, a write the fleet should see). */
  refresh(): void;
  /** Whether the owner has enabled this add-on, now (it can change while the daemon runs). */
  isEnabled(): boolean;
  /** Enables or disables this add-on itself (the same as `POST /control/addons`). */
  setEnabled(enabled: boolean): { ok: true } | { ok: false; reason: string };
  services: AddonServices;
}

/** A source of sessions, as the monitor reads it. Observers never know about each other (merge.ts reconciles). */
export interface FleetObserver {
  readonly source: string;
  /** The host this observer's sessions belong to (`hostId` of the rows it returns); needed to `resolve` them. */
  readonly hostId?: string;
  observe(): ObservedSession[];
  /** Files whose change should refresh the fleet right away. */
  watch?: WatchSpec[];
  /**
   * Settles a session of this host after merging, with what the monitor can read for it (a chat the host calls
   * `waiting` whose only background work is an old shell is finished). Absent: nothing to settle.
   */
  resolve?(session: FleetSession, context: ResolveContext): FleetSession;
}

export interface ResolveContext {
  nowMs: number;
  /** The session's background work, read on demand from its transcript. */
  backgroundTasks(session: FleetSession): BackgroundTask[];
}

/** The part of a chat's host that answers messages, reads its history and acts on it. */
export interface AddonReplier {
  readonly hostId: string;
  /** Whether `session` (a fleet session) is this host's. */
  canHandle(session: FleetSession): boolean;
  /** Whether a bare (not a fleet key) reply target is this host's chat id. */
  ownsTarget(target: string): boolean;
  lastTurnText(id: string): string | null;
  lastTurnId?(id: string): string | null;
  lastTurnError?(id: string): string | null;
  transcript?(id: string, limit: number, before?: number | null): TranscriptResult;
  workBetween?(id: string, messageId: string): WorkSteps | null;
  send(id: string, text: string, onFailed: ReplyFailureHandler, options?: ReplyOptions): Promise<ReplyOutcome>;
  isCompacting?(id: string): boolean;
  setOnQueueChange?(listener: ((sessionId: string) => void) | null): void;
  queue?(id: string): Promise<QueueItem[] | null>;
  queueAction?(
    id: string,
    messageId: string,
    action: QueueAction,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  stopTurn?(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  setSetup?(
    id: string,
    setup: { model: string; thinkingLevel?: string; fastMode: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** A chat action from the Mac app (`stop`, `setup`, `pr`); the models it may pick from are the host's. */
  action?(id: string, action: "stop" | "setup" | "pr", body: Record<string, unknown>): Promise<unknown>;
  /** The chat's new title; false when there is no such chat. */
  rename?(id: string, title: string): boolean;
  /** Closes the chat's tab in the host's own window. */
  close?(id: string): Promise<"closed" | "busy" | "missing"> | "closed" | "busy" | "missing";
  /** Answers the chat's pending question or plan. */
  answers?: AnswerHost & Answerer;
  stop?(): Promise<void>;
}

/** Workspace actions a host offers: archive one, make one, and the prompt that asks a chat for a pull request. */
export interface AddonWorkspaceActions {
  repos(): Array<{ id: string; name: string }>;
  archive(workspaceId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  create(repoId: string): Promise<{ ok: true; workspaceId?: string } | { ok: false; reason: string }>;
  prPrompt(workspaceId: string): string | null;
  /** The Mac app's `GET /control/workspaces/repos` and `POST /control/workspaces/action`. */
  control: {
    workspaceRepos(): unknown;
    workspaceAction(body: Record<string, unknown>): Promise<unknown>;
  };
}

export interface AddonResponse {
  status: number;
  body: unknown;
}

/**
 * A token-gated control route an add-on serves (`/control/...`). `path` may carry `:name` segments (one segment each,
 * `[A-Za-z0-9_:-]{1,120}`), handed to `handle` in `params`; `body` is the parsed JSON object (`{}` for a GET).
 */
export interface AddonRoute {
  method: "GET" | "POST";
  path: string;
  handle(body: Record<string, unknown>, params: Record<string, string>): Promise<AddonResponse> | AddonResponse;
}

export interface AddonCommand {
  name: string;
  /** One line for `squeak help`. */
  usage: string;
  run(args: string[]): Promise<number | void>;
}

/** One step of `squeak uninstall` an add-on owns (the conductor add-on hands Conductor's relay settings back). */
export interface AddonUninstallStep {
  /** `StepId`-like identifier shown in the plan. */
  id: string;
  title: string;
  detail: string;
  /** What would be undone, in words, without doing it; empty when there is nothing to undo. */
  plan(): Promise<string[]> | string[];
  /** Does it; the note is shown to the person. `restart` names an app the person must restart afterwards. */
  run(): Promise<{ status: "done" | "skipped" | "failed"; note: string; acted?: string[]; restart?: string }>;
}

export interface AddonHandle {
  /** Runs at every start, enabled or not (it puts back what the add-on once changed, so an install stays safe). */
  maintenance?(): Promise<void> | void;
  observers?: FleetObserver[];
  repliers?: AddonReplier[];
  /** New chats: the host's workspaces, its models and the way to start one. */
  newChat?: NewChatHost;
  workspaceActions?: AddonWorkspaceActions;
  /** The models the host offers; core falls back to Squeak's own catalog when none does. */
  chatModels?(): ChatModel[];
  /** Repository icons by name, shrunk for the phone, and the refresh that reads them again. */
  projectIcons?: { current(): Record<string, string>; refresh(): Promise<boolean> };
  routes?: AddonRoute[];
  /** Fields merged into `/state` (while enabled). */
  stateFields?(): Record<string, unknown>;
  /** An app the phone's Mac controls page can show the tabs of. */
  frontApp?: FrontAppHost;
  /** Core adapters (src/core) for the sessions this add-on's host runs. */
  coreAdapters?(deps: {
    observe: FleetObservation;
    send: (target: string, text: string, onFailed: ReplyFailureHandler) => Promise<ReplyOutcome>;
  }): SqueakAgentAdapter[];
  cli?: AddonCommand[];
  uninstall?: AddonUninstallStep;
  /** Called once the daemon is up (after every add-on is loaded and the app is built). */
  start?(): Promise<void> | void;
  /** Told when the owner enables or disables the add-on. */
  onEnabledChange?(enabled: boolean): void;
  /** Core's own labels for what this add-on's host calls things. */
  presentation?: { hostId: string; label: string };
  stop?(): Promise<void>;
}

export interface Addon {
  activate(context: AddonContext): AddonHandle | Promise<AddonHandle>;
}

const ADDON_NAME = /^[a-z][a-z0-9-]*$/;

/** Names asked for in `SQUEAK_ADDONS` (comma separated) plus the older `SQUEAK_CONDUCTOR_RELAY=on` alias. */
export function requestedAddons(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = (env.SQUEAK_ADDONS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => ADDON_NAME.test(name));
  if (env.SQUEAK_CONDUCTOR_RELAY?.trim().toLowerCase() === "on") names.push("conductor-relay");
  return [...new Set(names)];
}

/** An add-on found on disk: its manifest and its entry point. */
export interface FoundAddon {
  manifest: AddonManifest;
  entry: string;
}

function readManifest(file: URL, id: string): AddonManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AddonManifest>;
    if (parsed.id !== id || typeof parsed.name !== "string" || typeof parsed.blurb !== "string") return null;
    return {
      id,
      name: parsed.name,
      blurb: parsed.blurb,
      ...(parsed.distributed === true ? { distributed: true } : {}),
      ...(Array.isArray(parsed.requires)
        ? { requires: parsed.requires.filter((name): name is string => typeof name === "string") }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Every add-on present in this layout, first root winning: built beside the daemon (`dist/addons/<name>/`, which
 * is `../addons` from the bundle at `dist/squeak/` and `./addons` from the tsc build), else the checkout's
 * `addons/` when running from source with tsx.
 */
export function discoverAddons(
  roots: URL[] = [new URL("./addons/", import.meta.url), new URL("../addons/", import.meta.url)],
): FoundAddon[] {
  const found = new Map<string, FoundAddon>();
  for (const root of roots) {
    let names: string[];
    try {
      names = fs.readdirSync(fileURLToPath(root));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!ADDON_NAME.test(name) || found.has(name)) continue;
      const manifest = readManifest(new URL(`${name}/addon.json`, root), name);
      if (!manifest) continue;
      const entry = ["index.js", "index.ts"]
        .map((file) => new URL(`${name}/${file}`, root))
        .find((url) => fs.existsSync(url));
      if (entry) found.set(name, { manifest, entry: entry.href });
    }
  }
  return [...found.values()];
}

/** The order to activate in: required add-ons first. A cycle or a missing requirement drops the add-on. */
export function activationOrder(wanted: FoundAddon[]): FoundAddon[] {
  const byId = new Map(wanted.map((addon) => [addon.manifest.id, addon]));
  const ordered: FoundAddon[] = [];
  const visiting = new Set<string>();
  const visit = (addon: FoundAddon): void => {
    const id = addon.manifest.id;
    if (ordered.includes(addon) || visiting.has(id)) return;
    visiting.add(id);
    for (const required of addon.manifest.requires ?? []) {
      const next = byId.get(required);
      if (next) visit(next);
    }
    visiting.delete(id);
    ordered.push(addon);
  };
  for (const addon of wanted) visit(addon);
  return ordered;
}

export interface AddonLoadOptions {
  env?: NodeJS.ProcessEnv;
  found?: FoundAddon[];
  /** Whether an add-on is enabled now (addons.json); a `requires` add-on activates only when its requirements are. */
  enabled?: (id: string) => boolean;
}

export interface LoadedAddon {
  manifest: AddonManifest;
  handle: AddonHandle;
}

/**
 * Loads what this run asks for: every `distributed` add-on, and any other named in `SQUEAK_ADDONS`. Returns the
 * ones that activated, plus the manifests of those present but not activated (still listed in Settings).
 */
export async function loadAddons(
  makeContext: (manifest: AddonManifest) => AddonContext,
  options: AddonLoadOptions = {},
): Promise<{ loaded: LoadedAddon[]; present: AddonManifest[] }> {
  const env = options.env ?? process.env;
  const found = options.found ?? discoverAddons();
  const requested = new Set(requestedAddons(env));
  const enabled = options.enabled ?? (() => true);
  const loaded: LoadedAddon[] = [];
  const active = new Set<string>();
  for (const addon of activationOrder(found)) {
    const { manifest } = addon;
    if (!manifest.distributed && !requested.has(manifest.id)) continue;
    const missing = (manifest.requires ?? []).find((id) => !active.has(id) || !enabled(id));
    if (missing) {
      logger.info("add-on not activated: a requirement is not enabled", { addon: manifest.id, requires: missing });
      continue;
    }
    try {
      const module = (await import(addon.entry)) as { default?: Addon };
      if (typeof module.default?.activate !== "function") throw new Error("no default export with activate()");
      const handle = await module.default.activate(makeContext(manifest));
      loaded.push({ manifest, handle });
      active.add(manifest.id);
      logger.info("add-on loaded", { addon: manifest.id });
    } catch (error) {
      logger.warn("add-on failed to load; continuing without it", {
        addon: manifest.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { loaded, present: found.map((addon) => addon.manifest) };
}
