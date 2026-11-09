import fs from "node:fs";
import type { ChatStarter } from "./fleet/new-chat.js";
import type { RelayRequest } from "./fleet/answer-relay.js";
import type { ConductorRelaySender } from "./fleet/session-reply.js";
import { logger } from "./utils/logger.js";

/**
 * Add-ons: optional code that is not part of what Squeak distributes, found at run time and never imported
 * statically, so a build without one (its folder deleted) is whole. Core knows only this interface.
 *
 *  - An add-on lives in `addons/<name>/` in the checkout and is built to `dist/addons/<name>/index.js` beside
 *    the daemon (`scripts/addons.sh build`). Its `index.js` default-exports an `Addon`.
 *  - `SQUEAK_ADDONS=name,name` enables it (`SQUEAK_CONDUCTOR_RELAY=on` is an alias for `conductor-relay`).
 *  - A missing, unreadable or throwing add-on is logged and skipped; startup never fails for one.
 */

export interface AddonContext {
  conductorDbPath: string;
  supportDir: string;
}

/** A way into a Conductor chat besides typing into its window and the background CLI; tried first when ready. */
export interface ConductorRoute extends ConductorRelaySender, ChatStarter {
  isReady(): boolean;
  lastHostAt(): number | null;
  requestFn(): RelayRequest | null;
  start(): void;
  stop(): Promise<void>;
}

export interface AddonResponse {
  status: number;
  body: unknown;
}

/** A token-gated control route an add-on serves (`/control/...`); `body` is the parsed JSON object (`{}` for a GET). */
export interface AddonRoute {
  method: "GET" | "POST";
  path: string;
  handle(body: Record<string, unknown>): Promise<AddonResponse> | AddonResponse;
}

export interface AddonHandle {
  conductorRoute?: ConductorRoute;
  routes?: AddonRoute[];
  stop?(): Promise<void>;
}

export interface Addon {
  activate(context: AddonContext): AddonHandle | Promise<AddonHandle>;
}

export const RELAY_OFF_REASON = "Conductor's relay isn't available in this build.";

/** The route when no add-on supplies one: never connected, so every caller falls through to the other routes. */
export class NoConductorRoute implements ConductorRoute {
  isReady(): boolean {
    return false;
  }
  lastHostAt(): number | null {
    return null;
  }
  requestFn(): RelayRequest | null {
    return null;
  }
  async send(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: RELAY_OFF_REASON };
  }
  startChat: ChatStarter["startChat"] = async () => ({ ok: false, reason: RELAY_OFF_REASON });
  start(): void {}
  async stop(): Promise<void> {}
}

export interface LoadedAddons {
  /** Names that activated. */
  names: string[];
  conductorRoute: ConductorRoute;
  routes: AddonRoute[];
  stop(): Promise<void>;
}

const ADDON_NAME = /^[a-z][a-z0-9-]*$/;

/** Names asked for in `SQUEAK_ADDONS` (comma separated) plus the older `SQUEAK_CONDUCTOR_RELAY=on` alias. */
export function enabledAddons(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = (env.SQUEAK_ADDONS ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => ADDON_NAME.test(name));
  if (env.SQUEAK_CONDUCTOR_RELAY?.trim().toLowerCase() === "on") names.push("conductor-relay");
  return [...new Set(names)];
}

/** Where `name`'s entry point is: built beside the daemon, else (running from source with tsx) in the checkout. */
function entryFor(name: string): string | null {
  const here = import.meta.url;
  const candidates = [
    new URL(`./addons/${name}/index.js`, here),
    new URL(`../addons/${name}/index.ts`, here),
    new URL(`../addons/${name}/index.js`, here),
  ];
  for (const url of candidates) {
    try {
      if (fs.existsSync(url)) return url.href;
    } catch {
      // try the next
    }
  }
  return null;
}

export async function loadAddons(
  context: AddonContext,
  env: NodeJS.ProcessEnv = process.env,
  entry: (name: string) => string | null = entryFor,
): Promise<LoadedAddons> {
  const names: string[] = [];
  const routes: AddonRoute[] = [];
  const stops: Array<() => Promise<void>> = [];
  let conductorRoute: ConductorRoute | null = null;
  for (const name of enabledAddons(env)) {
    try {
      const href = entry(name);
      if (!href) {
        logger.warn("add-on enabled but not present in this build", { addon: name });
        continue;
      }
      const loaded = (await import(href)) as { default?: Addon };
      if (typeof loaded.default?.activate !== "function") throw new Error("no default export with activate()");
      const handle = await loaded.default.activate(context);
      if (handle.conductorRoute && !conductorRoute) conductorRoute = handle.conductorRoute;
      routes.push(...(handle.routes ?? []));
      const stop = handle.stop;
      if (stop) stops.push(() => stop.call(handle));
      names.push(name);
      logger.info("add-on loaded", { addon: name });
    } catch (error) {
      logger.warn("add-on failed to load; continuing without it", {
        addon: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    names,
    conductorRoute: conductorRoute ?? new NoConductorRoute(),
    routes,
    stop: async () => {
      for (const stop of stops) await stop().catch(() => undefined);
    },
  };
}
