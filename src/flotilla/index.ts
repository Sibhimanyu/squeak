import { execFile } from "node:child_process";

import { logger } from "../utils/logger.js";
import { CatalystStore } from "../cloud/catalyst-store.js";
import { activeLocation, createCloudStore, guestInviteBase, readCloudConfig } from "../cloud/config.js";
import type { CloudLocation } from "../cloud/location.js";
import type { HostEvent } from "../native/host.js";
import type { SessionHost } from "../native/host.js";
import type { AgentTools } from "../native/agent-tools.js";
import type { NativeStore } from "../native/store.js";
import type { WorkspaceSources } from "../native/workspace-sources.js";
import type { WorkspaceManager } from "../native/workspaces.js";
import { MainRepoFinder } from "../fleet/repo-identity.js";
import { FlotillaBridge, type HostPort } from "./bridge.js";
import { FlotillaRoutes, type RouteContext, type StartSpec } from "./mount.js";
import { computerName, oldDefaults, personName } from "./person.js";
import { HttpPondRelay, RelayRefused } from "./relay.js";
import { FlotillaService, type AccountPort } from "./service.js";
import { FlotillaError, type ChangedFiles } from "./types.js";

export { FlotillaService } from "./service.js";
export { FlotillaBridge, type HostPort } from "./bridge.js";
export { FlotillaRoutes, type RouteContext } from "./mount.js";

/** On for everyone; `SQUEAK_FLOTILLA=off` is the off switch (nothing in this folder is then constructed). */
export const flotillaEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SQUEAK_FLOTILLA !== "off";

export interface Flotilla {
  service: FlotillaService | null;
  bridge: FlotillaBridge | null;
  /** Handles `/native/ponds/*`. */
  handle(ctx: RouteContext): Promise<boolean>;
  /**
   * "Remove from Squeak" of a project: a plain sentence when its pond is shared (removing the project would leave the pond,
   * its people and its invites with nothing to open it from), else null.
   */
  projectRemovalBlock?(projectId: string): string | null;
  /** The project is gone: its pond, if it never left this Mac, goes with it. */
  projectRemoved?(projectId: string): void;
  /** The pond records the directory is built from. */
  records?(): Promise<import("./directory.js").DirRecord[]>;
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
/**
 * Starts a chat in a project this Mac holds: a new workspace when it is a git repository, the folder itself when it is
 * not (a pond can be any folder). Null when the project is not here.
 */
export async function startInProject(
  deps: Pick<FlotillaDeps, "store" | "workspaces" | "host">,
  projectId: string,
  spec: StartSpec,
): Promise<{ sessionId: string } | null> {
  const project = deps.store.getProject(projectId);
  if (!project) return null;
  if (spec.workspaceId) {
    // An existing stream: it must be one of this project's, still there.
    const existing = deps.store.getWorkspace(spec.workspaceId);
    if (!existing || existing.projectId !== project.id) {
      throw new FlotillaError("That stream is not in this pond's project.", 404);
    }
    if (existing.state === "archived") throw new FlotillaError("That stream is archived.", 400);
    const session = await deps.host.create({
      cwd: existing.path,
      agent: spec.agent,
      model: spec.model,
      permissionMode: spec.permissionMode ?? "default",
      ...(spec.effort ? { effort: spec.effort } : {}),
      workspaceId: existing.id,
      text: spec.text,
      ...(spec.agentPrefix ? { agentPrefix: spec.agentPrefix } : {}),
    });
    return { sessionId: session.id };
  }
  // The project's own kind decides (a plain folder inside some other repository is still a plain folder), and a
  // `git` project whose repository vanished still runs in its folder.
  let isRepo = project.kind === "git";
  if (isRepo) {
    try {
      await git(project.rootPath, ["rev-parse", "--git-dir"]);
    } catch {
      isRepo = false;
    }
  }
  // Main: the pond's own folder, whatever it is; no stream is made.
  const ws = isRepo && !spec.main ? deps.workspaces.createWorkspace(project.id) : null;
  const session = await deps.host.create({
    cwd: ws ? ws.path : project.rootPath,
    agent: spec.agent,
    model: spec.model,
    permissionMode: spec.permissionMode ?? "default",
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(ws ? { workspaceId: ws.id } : {}),
    text: spec.text,
    ...(spec.agentPrefix ? { agentPrefix: spec.agentPrefix } : {}),
  });
  return { sessionId: session.id };
}

export function hostPortFor(deps: Pick<FlotillaDeps, "host" | "store" | "tools">): HostPort {
  const { host, store, tools } = deps;
  return {
    onEvent(listener) {
      host.on("event", listener);
      return () => host.off("event", listener as (e: HostEvent) => void);
    },
    getSession: (id) => store.getSession(id),
    workspace: (id) => {
      const w = store.getWorkspace(id);
      return w ? { name: w.name, branch: w.branch } : null;
    },
    messagesAfter: (id, seq, limit) => store.messagesAfter(id, seq, limit),
    openRequests: (id) => store.openRequests(id),
    send: (id, text, options) => host.send(id, text, options),
    respond: (requestId, resolution) => void host.respond(requestId, resolution),
    note: (id, text, by) => host.post(id, "system/pond-sender", { text, by }),
    setGuestTurn: (id, on) => host.setGuestTurn(id, on),
    async diff(id, file) {
      try {
        return await tools.call(id, "stream_changes", { path: file });
      } catch {
        return null;
      }
    },
    async changes(id): Promise<ChangedFiles | null> {
      try {
        const stat = await tools.call(id, "stream_changes", { summaryOnly: true });
        const rows = [...stat.matchAll(/^\s*(\S.*?)\s+\|\s+(\d+)/gm)];
        const paths = rows.map((m) => m[1]!);
        const summary = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat);
        if (!summary) return null;
        return {
          files: Number(summary[1]),
          added: Number(summary[2] ?? 0),
          removed: Number(summary[3] ?? 0),
          paths: paths.slice(0, 200),
          fileStats: rows.slice(0, 200).map((m) => ({ path: m[1]!, changes: Number(m[2]) })),
        };
      } catch {
        return null;
      }
    },
  };
}

/** Builds Flotilla for the host process; call only when `flotillaEnabled()`. Works with no cloud: local ponds only. */
export function createFlotilla(deps: FlotillaDeps, location?: CloudLocation | null): Flotilla {
  const config = readCloudConfig(deps.supportDir);
  const where =
    location === undefined ? activeLocation(config, process.env.SQUEAK_REMOTE_DATABASE_URL ?? null) : location;
  const catalystRelay =
    where?.provider === "catalyst"
      ? new HttpPondRelay(where.relayUrl, where.relayKey, undefined, where.hosted === true)
      : null;
  // The Squeak account behind this Mac (a hosted Mac's own key says whose Mac it is). A name comes only from here.
  const hostedAccount = () => readCloudConfig(deps.supportDir)?.hosted ?? null;
  const account: AccountPort = {
    name: () => (where?.provider === "catalyst" && where.hosted ? (hostedAccount()?.name ?? null) : null),
    email: () => (where?.provider === "catalyst" && where.hosted ? (hostedAccount()?.email ?? null) : null),
    attest: async () => {
      if (!catalystRelay || where?.provider !== "catalyst" || !where.hosted) throw new RelayRefused(401);
      return (await catalystRelay.attest()).token;
    },
    names: async (ids) => (catalystRelay ? catalystRelay.names(ids) : { names: {} }),
  };
  const service = new FlotillaService({
    account,
    // No cloud set up: the service still works, with local ponds only, and makes no network call.
    store: where ? createCloudStore(where) : null,
    supportDir: deps.supportDir,
    displayName: personName(),
    nest: computerName(),
    ...(where ? { location: where } : {}),
    // A web guest's invite is a link to the guest page on the relay's own domain (the code rides in the fragment).
    ...(where?.provider === "catalyst" &&
    guestInviteBase(where.hosted ? { appUrl: new URL(where.relayUrl).origin } : config?.catalyst)
      ? {
          inviteLinkBase: guestInviteBase(
            where.hosted ? { appUrl: new URL(where.relayUrl).origin } : config?.catalyst,
          )!,
        }
      : {}),
    // Catalyst: an owner holds the relay key and asks the relay for pond tokens; a member who joined by invite holds
    // only a pond token and the relay's URL (docs/ponds.md, "Scoped tokens").
    ...(catalystRelay ? { relay: catalystRelay } : {}),
    storeFor: (loc, pondToken, joinAttest) => {
      const at = loc as CloudLocation | { provider: "catalyst"; relayUrl: string };
      if (at.provider === "catalyst" && pondToken)
        return new CatalystStore({ baseUrl: at.relayUrl, pondToken, ...(joinAttest ? { joinAttest } : {}) });
      if (at.provider === "catalyst" && !("relayKey" in at))
        throw new Error("This pond has no access on this Mac yet.");
      return createCloudStore(at as CloudLocation);
    },
  });
  const bridge = new FlotillaBridge(service, hostPortFor(deps), {
    // A member's thread on this Mac: in the pond's folder (Main for a git pond), always asking first.
    startChat: (projectId, spec) => startInProject(deps, projectId, spec),
  });
  const routes = new FlotillaRoutes({
    service,
    bridge,
    projects: () => deps.store.listProjects(),
    remoteOf: async (projectId, rootPath) => {
      const root = (projectId ? deps.store.getProject(projectId)?.rootPath : null) ?? rootPath;
      if (!root) return null;
      try {
        return (await git(root, ["remote", "get-url", "origin"])).trim() || null;
      } catch {
        return null;
      }
    },
    startInProject: (projectId, spec) => startInProject(deps, projectId, spec),
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
        permissionMode: spec.permissionMode ?? "default",
        ...(spec.effort ? { effort: spec.effort } : {}),
        workspaceId: ws.id,
        text: spec.text,
        ...(spec.agentPrefix ? { agentPrefix: spec.agentPrefix } : {}),
      });
      return { sessionId: session.id };
    },
  });
  service.start();
  // The one-time repair (idempotent: nothing to do after the first run): ponds.json obeys the directory's invariants.
  try {
    const done = service.repairPonds(
      deps.store
        .listProjects()
        .map((p) => ({ id: p.id, name: p.name, remote: new MainRepoFinder().identity(p.rootPath)?.remote ?? null })),
    );
    for (const a of done) logger.info("pond repair", { op: a.op, pond: a.pondId, name: a.name, why: a.why });
  } catch (error) {
    logger.warn("pond repair failed; ponds.json is unchanged", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // An install made before real names kept the login name and hostname: bring them up to date (and republish).
  void service.updateOwnProfile({ name: personName(), nest: computerName() }, oldDefaults()).catch(() => undefined);
  bridge.start();
  return {
    service,
    bridge,
    handle: (ctx) => routes.handle(ctx),
    projectRemovalBlock: (projectId) => service.projectRemovalBlock(projectId),
    projectRemoved: (projectId) => service.projectRemoved(projectId),
    records: () => service.directoryRecords(),
    stop: () => {
      bridge.stop();
      service.stop();
    },
  };
}
