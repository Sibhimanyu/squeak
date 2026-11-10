import { execFile } from "node:child_process";
import os from "node:os";

import { activeLocation, createCloudStore, readCloudConfig } from "../cloud/config.js";
import type { CloudLocation } from "../cloud/location.js";
import type { HostEvent } from "../native/host.js";
import type { SessionHost } from "../native/host.js";
import type { AgentTools } from "../native/agent-tools.js";
import type { NativeStore } from "../native/store.js";
import type { WorkspaceSources } from "../native/workspace-sources.js";
import type { WorkspaceManager } from "../native/workspaces.js";
import { FlotillaBridge, type HostPort } from "./bridge.js";
import { FlotillaRoutes, type RouteContext } from "./mount.js";
import { FlotillaService } from "./service.js";
import type { ChangedFiles } from "./types.js";

export { FlotillaService } from "./service.js";
export { FlotillaBridge, type HostPort } from "./bridge.js";
export { FlotillaRoutes, type RouteContext } from "./mount.js";

/** Off unless `SQUEAK_FLOTILLA=on`: with it off nothing in this folder is constructed. */
export const flotillaEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SQUEAK_FLOTILLA === "on";

export interface Flotilla {
  service: FlotillaService | null;
  bridge: FlotillaBridge | null;
  /** Handles `/native/ponds/*`; answers 503 sentences when no cloud store is set up. */
  handle(ctx: RouteContext): Promise<boolean>;
  stop(): void;
}

export interface FlotillaDeps {
  host: SessionHost;
  store: NativeStore;
  workspaces: WorkspaceManager;
  sources: WorkspaceSources;
  tools: AgentTools;
  supportDir: string;
}

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile("git", args, { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (e, out) =>
      e ? reject(e) : resolve(String(out)),
    ),
  );

const normalizeRemote = (url: string): string =>
  url
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

/** The adapter from the real host to the port the bridge uses. */
export function hostPortFor(deps: Pick<FlotillaDeps, "host" | "store" | "tools">): HostPort {
  const { host, store, tools } = deps;
  return {
    onEvent(listener) {
      host.on("event", listener);
      return () => host.off("event", listener as (e: HostEvent) => void);
    },
    getSession: (id) => store.getSession(id),
    messagesAfter: (id, seq, limit) => store.messagesAfter(id, seq, limit),
    openRequests: (id) => store.openRequests(id),
    send: (id, text, options) => host.send(id, text, options),
    respond: (requestId, resolution) => void host.respond(requestId, resolution),
    note: (id, text, by) => host.post(id, "system/pond-sender", { text, by }),
    setGuestTurn: (id, on) => host.setGuestTurn(id, on),
    async diff(id, file) {
      try {
        return await tools.call(id, "workspace_diff", { file });
      } catch {
        return null;
      }
    },
    async changes(id): Promise<ChangedFiles | null> {
      try {
        const stat = await tools.call(id, "workspace_diff", { stat: true });
        const paths = [...stat.matchAll(/^\s*(\S.*?)\s+\|\s+\d+/gm)].map((m) => m[1]!);
        const summary = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat);
        if (!summary) return null;
        return {
          files: Number(summary[1]),
          added: Number(summary[2] ?? 0),
          removed: Number(summary[3] ?? 0),
          paths: paths.slice(0, 200),
        };
      } catch {
        return null;
      }
    },
  };
}

/** Builds Flotilla for the host process; call only when `flotillaEnabled()`. */
export function createFlotilla(deps: FlotillaDeps, location?: CloudLocation | null): Flotilla {
  const config = readCloudConfig(deps.supportDir);
  const where =
    location === undefined ? activeLocation(config, process.env.SQUEAK_REMOTE_DATABASE_URL ?? null) : location;
  if (!where) {
    const none = async (ctx: RouteContext): Promise<boolean> => {
      if (ctx.parts[0] !== "ponds") return false;
      ctx.json(503, { error: "Set up a cloud store (Firebase or Catalyst) before using ponds." });
      return true;
    };
    return { service: null, bridge: null, handle: none, stop: () => undefined };
  }
  const service = new FlotillaService({
    store: createCloudStore(where),
    supportDir: deps.supportDir,
    displayName: os.userInfo().username,
    nest: os.hostname().replace(/\.local$/, ""),
    location: where,
    storeFor: (loc) => createCloudStore(loc as CloudLocation),
  });
  const bridge = new FlotillaBridge(service, hostPortFor(deps));
  const routes = new FlotillaRoutes({
    service,
    bridge,
    remoteOf: async (projectId, rootPath) => {
      const root = (projectId ? deps.store.getProject(projectId)?.rootPath : null) ?? rootPath;
      if (!root) return null;
      try {
        return (await git(root, ["remote", "get-url", "origin"])).trim() || null;
      } catch {
        return null;
      }
    },
    startOwn: async (remote, spec) => {
      const want = normalizeRemote(remote);
      let project = null as ReturnType<NativeStore["listProjects"]>[number] | null;
      for (const p of deps.store.listProjects()) {
        try {
          if (normalizeRemote(await git(p.rootPath, ["remote", "get-url", "origin"])) === want) {
            project = p;
            break;
          }
        } catch {
          // not a repository with an origin
        }
      }
      project ??= await deps.sources.clone(remote);
      const ws = deps.workspaces.createWorkspace(project.id);
      const session = await deps.host.create({
        cwd: ws.path,
        agent: spec.agent,
        model: spec.model,
        permissionMode: "default",
        workspaceId: ws.id,
        text: spec.text,
      });
      return { sessionId: session.id };
    },
  });
  service.start();
  bridge.start();
  return {
    service,
    bridge,
    handle: (ctx) => routes.handle(ctx),
    stop: () => {
      bridge.stop();
      service.stop();
    },
  };
}
