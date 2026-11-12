import fs from "node:fs";
import path from "node:path";
import {
  loadAddons,
  type AddonCommandHandler,
  type AddonConfig,
  type AddonContext,
  type AddonHandle,
  type AddonLoadOptions,
  type AddonManifest,
  type AddonPhoneCall,
  type AddonReplier,
  type AddonResponse,
  type AddonRoute,
  type FleetObserver,
  type LoadedAddon,
} from "./addons.js";
import type { ChatModel } from "./fleet/chat-models.js";
import type { FleetSnapshot } from "./fleet/fleet-monitor.js";
import type { FleetSession } from "./fleet/types.js";
import type { FrontAppHost } from "./fleet/window-tabs.js";
import type { WatchSpec } from "./fleet/change-watcher.js";
import { CORE_COMMAND_KINDS } from "./remote/command-kinds.js";
import type { RemoteAddonPhone } from "./remote/remote-bridge.js";
import { builtinChatModels } from "./native/model-catalog.js";
import { logger } from "./utils/logger.js";

/** `addons.json` in the support dir: which add-ons the owner enabled, and when. Absent = none (a fresh install). */
export interface AddonsFile {
  enabled: Record<string, { enabledAt: string }>;
}

export interface AddonStatus {
  id: string;
  name: string;
  blurb: string;
  /** The code is here and loaded (an add-on can be listed yet unavailable: its requirement is off, or it failed). */
  available: boolean;
  enabled: boolean;
}

const EMPTY_SNAPSHOT: FleetSnapshot = {
  sessions: [],
  active: [],
  attention: [],
  generatedAt: new Date(0).toISOString(),
  codexUsage: null,
};

function readFile(file: string): AddonsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { enabled?: unknown };
    const enabled: AddonsFile["enabled"] = {};
    if (parsed.enabled && typeof parsed.enabled === "object" && !Array.isArray(parsed.enabled)) {
      for (const [id, value] of Object.entries(parsed.enabled as Record<string, unknown>)) {
        const at = (value as { enabledAt?: unknown } | null)?.enabledAt;
        if (/^[a-z][a-z0-9-]*$/.test(id)) enabled[id] = { enabledAt: typeof at === "string" ? at : "" };
      }
    }
    return { enabled };
  } catch {
    return { enabled: {} };
  }
}

/** A `:name` path pattern as a matcher; `:name` is one segment of letters, digits, `_`, `:` and `-`. */
export function matchRoute(pattern: string, url: string): Record<string, string> | null {
  const want = pattern.split("/");
  const have = url.split("/");
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const expected = want[i] ?? "";
    const actual = have[i] ?? "";
    if (expected.startsWith(":")) {
      if (!/^[A-Za-z0-9_:-]{1,120}$/.test(actual)) return null;
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/**
 * Everything core knows about add-ons at run time: which are loaded, which the owner enabled (`addons.json`), and the
 * registries (observers, repliers, routes, ...) that core consumes instead of importing any add-on. Enabling or
 * disabling takes effect on the next refresh, without a restart: observers and repliers check `isEnabled`.
 */
export class AddonHost {
  private readonly file: string;
  private state: AddonsFile;
  private loaded: LoadedAddon[] = [];
  private present: AddonManifest[] = [];
  private snapshotFn: () => FleetSnapshot = () => EMPTY_SNAPSHOT;
  private refreshFn: () => void = () => undefined;
  private readonly provided = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly supportDir: string) {
    this.file = path.join(supportDir, "addons.json");
    this.state = readFile(this.file);
  }

  /** Late-binds what only exists once the daemon is built. */
  bind(deps: { snapshot: () => FleetSnapshot; refresh: () => void }): void {
    this.snapshotFn = deps.snapshot;
    this.refreshFn = deps.refresh;
  }

  /** Loads this run's add-ons (see `loadAddons`). Call once, before the app is built. */
  async load(config: AddonConfig, options: AddonLoadOptions = {}): Promise<void> {
    const result = await loadAddons((manifest) => this.contextFor(manifest, config, options.env ?? process.env), {
      ...options,
      enabled: (id) => this.isEnabled(id),
    });
    this.loaded = [];
    for (const entry of result.loaded) {
      const refused = this.claimKinds(entry);
      if (refused) {
        logger.warn("add-on refused: it registers a phone command kind it may not", {
          addon: entry.manifest.id,
          kind: refused,
        });
        continue;
      }
      this.loaded.push(entry);
    }
    this.present = result.present;
    // Maintenance runs enabled or not: an add-on puts back what it once changed so an install stays safe.
    for (const { manifest, handle } of this.loaded) {
      try {
        await handle.maintenance?.();
      } catch (error) {
        logger.warn("add-on maintenance failed", {
          addon: manifest.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Registers an add-on built in code (tests). */
  register(manifest: AddonManifest, handle: AddonHandle): void {
    const refused = this.claimKinds({ manifest, handle });
    if (refused) throw new Error(`add-on ${manifest.id} may not register the phone command kind "${refused}"`);
    this.loaded.push({ manifest, handle });
    if (!this.present.some((entry) => entry.id === manifest.id)) this.present.push(manifest);
  }

  /** The first phone command kind this add-on may not register (core's own, or another add-on's), else null. */
  private claimKinds(entry: LoadedAddon): string | null {
    const taken = new Set(this.loaded.flatMap((other) => Object.keys(other.handle.phoneCommands ?? {})));
    for (const kind of Object.keys(entry.handle.phoneCommands ?? {})) {
      if (CORE_COMMAND_KINDS.has(kind) || taken.has(kind)) return kind;
    }
    return null;
  }

  private contextFor(manifest: AddonManifest, config: AddonConfig, env: NodeJS.ProcessEnv): AddonContext {
    return {
      id: manifest.id,
      supportDir: this.supportDir,
      config,
      env,
      logger,
      snapshot: () => this.snapshotFn(),
      refresh: () => this.refreshFn(),
      isEnabled: () => this.isEnabled(manifest.id),
      setEnabled: (enabled) => this.setEnabled(manifest.id, enabled),
      services: {
        provide: (name, value) => void this.provided.set(name, value),
        get: <T>(name: string) => this.provided.get(name) as T | undefined,
      },
    };
  }

  isEnabled(id: string): boolean {
    return id in this.state.enabled;
  }

  enabledIds(): string[] {
    return Object.keys(this.state.enabled).sort();
  }

  /** Settings › Extensions: what is present, whether its code is here, and whether it is on. */
  catalogue(): AddonStatus[] {
    return this.present.map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      blurb: manifest.blurb,
      available: this.loaded.some((entry) => entry.manifest.id === manifest.id),
      enabled: this.isEnabled(manifest.id),
    }));
  }

  /** Turns an add-on on or off. Refuses one that is not here; persists; asks for a refresh. */
  setEnabled(
    id: string,
    enabled: boolean,
    now: () => Date = () => new Date(),
  ): { ok: true } | { ok: false; reason: string } {
    const entry = this.loaded.find((candidate) => candidate.manifest.id === id);
    if (!entry) return { ok: false, reason: "That add-on isn't part of this build." };
    if (this.isEnabled(id) === enabled) return { ok: true };
    const next = { ...this.state.enabled };
    if (enabled) next[id] = { enabledAt: now().toISOString() };
    else delete next[id];
    this.state = { enabled: next };
    this.persist();
    try {
      entry.handle.onEnabledChange?.(enabled);
    } catch (error) {
      logger.warn("add-on enable hook failed", {
        addon: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // a listener must never break the switch
      }
    }
    this.refreshFn();
    return { ok: true };
  }

  /** Told after any add-on is turned on or off. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      logger.warn("could not save addons.json", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private active(): LoadedAddon[] {
    return this.loaded.filter((entry) => this.isEnabled(entry.manifest.id));
  }

  /** Observers of enabled add-ons only, asked at every refresh. */
  observers(): FleetObserver[] {
    return this.loaded.flatMap((entry) =>
      (entry.handle.observers ?? []).map(
        (observer): FleetObserver => ({
          source: observer.source,
          ...(observer.hostId ? { hostId: observer.hostId } : {}),
          observe: () => (this.isEnabled(entry.manifest.id) ? observer.observe() : []),
          ...(observer.watch ? { watch: observer.watch } : {}),
          ...(observer.resolve ? { resolve: (session, context) => observer.resolve!(session, context) } : {}),
        }),
      ),
    );
  }

  /** Files whose change should refresh the fleet, from every loaded add-on's observers. */
  watchSpecs(): WatchSpec[] {
    return this.loaded.flatMap((entry) => (entry.handle.observers ?? []).flatMap((observer) => observer.watch ?? []));
  }

  /** Repliers of enabled add-ons. */
  repliers(): AddonReplier[] {
    return this.active().flatMap((entry) => entry.handle.repliers ?? []);
  }

  replierFor(session: FleetSession): AddonReplier | null {
    return this.repliers().find((replier) => replier.canHandle(session)) ?? null;
  }

  replierForTarget(target: string): AddonReplier | null {
    return this.repliers().find((replier) => replier.ownsTarget(target)) ?? null;
  }

  /** The first enabled add-on's new-chat host, or null. */
  newChat() {
    return this.active().find((entry) => entry.handle.newChat)?.handle.newChat ?? null;
  }

  workspaceActions() {
    return this.active().find((entry) => entry.handle.workspaceActions)?.handle.workspaceActions ?? null;
  }

  /** What a new chat may run: an enabled host's own picker when it has one, else Squeak's built-in catalog. */
  chatModels(): ChatModel[] {
    for (const entry of this.active()) {
      try {
        const models = entry.handle.chatModels?.();
        if (models && models.length > 0) return models;
      } catch {
        // fall through to the next, then the catalog
      }
    }
    return builtinChatModels();
  }

  projectIcons() {
    return this.active().find((entry) => entry.handle.projectIcons)?.handle.projectIcons ?? null;
  }

  frontApps(): FrontAppHost[] {
    return this.active().flatMap((entry) => (entry.handle.frontApp ? [entry.handle.frontApp] : []));
  }

  /** Fields every enabled add-on adds to `/state`, and which are enabled. */
  stateFields(): Record<string, unknown> {
    return this.loaded.reduce<Record<string, unknown>>(
      (fields, entry) => ({ ...fields, ...(entry.handle.stateFields?.() ?? {}) }),
      { addons: this.enabledIds() },
    );
  }

  /** Sessions as every enabled add-on's annotators leave them; one that throws is skipped. */
  annotateSessions(sessions: FleetSession[]): FleetSession[] {
    let result = sessions;
    for (const entry of this.active()) {
      for (const annotate of entry.handle.sessionAnnotators ?? []) {
        try {
          result = annotate(result);
        } catch (error) {
          logger.warn("add-on session annotation failed", {
            addon: entry.manifest.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return result;
  }

  /** Fields enabled add-ons add to the phone's view. */
  phoneViewFields(snapshot: FleetSnapshot, caps: readonly string[]): Record<string, unknown> {
    return this.active().reduce<Record<string, unknown>>((fields, entry) => {
      try {
        return { ...fields, ...(entry.handle.phoneViewFields?.(snapshot, caps) ?? {}) };
      } catch (error) {
        logger.debug("could not read an add-on's phone fields", {
          addon: entry.manifest.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return fields;
      }
    }, {});
  }

  /** Fields enabled add-ons add to one session's row in the phone's view. */
  phoneSessionFields(session: FleetSession): Record<string, unknown> {
    return this.active().reduce<Record<string, unknown>>((fields, entry) => {
      try {
        return { ...fields, ...(entry.handle.phoneSessionFields?.(session) ?? {}) };
      } catch (error) {
        logger.debug("could not read an add-on's session fields", {
          addon: entry.manifest.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return fields;
      }
    }, {});
  }

  /**
   * The handler for a phone command kind: `{ handler }` when an enabled add-on has it, `{ disabled: true }` when one
   * is loaded but off (the caller refuses), null when no add-on knows the kind.
   */
  phoneCommand(kind: string): { handler: AddonCommandHandler } | { disabled: true } | null {
    for (const entry of this.loaded) {
      const handler = entry.handle.phoneCommands?.[kind];
      if (!handler) continue;
      return this.isEnabled(entry.manifest.id) ? { handler } : { disabled: true };
    }
    return null;
  }

  /** The add-on whose `image` fields the command carries: its resolution, a refusal, or null (not an add-on's). */
  phoneImage(
    command: Record<string, unknown>,
    call: AddonPhoneCall,
  ): { projectDir: string } | { refuse: string } | null {
    for (const entry of this.loaded) {
      const images = entry.handle.phoneImages;
      if (!images || !images.fields.some((field) => command[field] !== undefined)) continue;
      if (!this.isEnabled(entry.manifest.id)) return { refuse: "This Mac can't send images to a phone." };
      return images.resolve(command, call);
    }
    return null;
  }

  /** The same for `media`, with the add-on's `prepare` for the file. */
  phoneMedia(
    command: Record<string, unknown>,
    call: AddonPhoneCall,
  ):
    | (
        | { source: string; projectDir: string; prepare: NonNullable<AddonHandle["phoneMedia"]>["prepare"] }
        | { refuse: string }
      )
    | null {
    for (const entry of this.loaded) {
      const media = entry.handle.phoneMedia;
      if (!media || !media.fields.some((field) => command[field] !== undefined)) continue;
      if (!this.isEnabled(entry.manifest.id)) return { refuse: "This Mac can't send films to a phone." };
      const resolved = media.resolve(command, call);
      return "refuse" in resolved ? resolved : { ...resolved, prepare: (source, dir) => media.prepare(source, dir) };
    }
    return null;
  }

  /** What the phone channel asks of add-ons (RemoteBridgeDependencies.addonPhone). */
  remotePhone(): RemoteAddonPhone {
    return {
      viewFields: (snapshot, caps) => this.phoneViewFields(snapshot, caps),
      sessionFields: (session) => this.phoneSessionFields(session),
      command: (kind) => this.phoneCommand(kind),
      image: (command, call) => this.phoneImage(command, call),
      media: (command, call) => this.phoneMedia(command, call),
    };
  }

  /** What Settings and cards call a host (`hostId` -> label). */
  hostLabel(hostId: string | undefined): string | null {
    if (!hostId) return null;
    return (
      this.loaded.find((entry) => entry.handle.presentation?.hostId === hostId)?.handle.presentation?.label ?? null
    );
  }

  /** Every add-on's routes, always served (a route decides for itself what a disabled add-on answers). */
  routes(): AddonRoute[] {
    return this.loaded.flatMap((entry) => entry.handle.routes ?? []);
  }

  handles(): AddonHandle[] {
    return this.loaded.map((entry) => entry.handle);
  }

  names(): string[] {
    return this.loaded.map((entry) => entry.manifest.id);
  }

  /** Tells every loaded add-on the daemon is up. */
  async start(): Promise<void> {
    for (const { manifest, handle } of this.loaded) {
      try {
        await handle.start?.();
      } catch (error) {
        logger.warn("add-on failed to start", {
          addon: manifest.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async stop(): Promise<void> {
    for (const { handle } of this.loaded) await handle.stop?.().catch(() => undefined);
  }

  /** The generic `/control/addons` routes core serves itself. */
  coreRoutes(): AddonRoute[] {
    const reply = (status: number, body: unknown): AddonResponse => ({ status, body });
    return [
      { method: "GET", path: "/control/addons", handle: () => reply(200, { addons: this.catalogue() }) },
      {
        method: "POST",
        path: "/control/addons",
        handle: (body) => {
          const keys = Object.keys(body);
          const { id, enabled } = body as { id?: unknown; enabled?: unknown };
          if (keys.length !== 2 || typeof id !== "string" || typeof enabled !== "boolean") {
            return reply(400, { error: "Send { id: string, enabled: true | false }." });
          }
          const outcome = this.setEnabled(id, enabled);
          return outcome.ok
            ? reply(200, { ok: true, addons: this.catalogue() })
            : reply(404, { error: outcome.reason });
        },
      },
    ];
  }
}
