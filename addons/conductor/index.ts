import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";
import { CodexAppServerAdapter } from "../../src/adapters/codex-app-server.js";
import type { Addon, AddonContext, AddonHandle, AddonReplier, AddonRoute } from "../../src/addons.js";
import { resolveSetup } from "../../src/fleet/chat-setup.js";
import { readPendingAsk } from "../../src/fleet/question.js";
import type { FleetSession } from "../../src/fleet/types.js";
import { AnswerService } from "./answer.js";
import { answerRelayFrom } from "./answer-relay.js";
import { listChatModels } from "./chat-models.js";
import { closeChat } from "./close-chat.js";
import { conductorCliCommands } from "./cli.js";
import { ConductorAdapter } from "./core-adapter.js";
import { ConductorObserver } from "./observer.js";
import { CONDUCTOR_NOT_ENABLED, WorkspacePicks, parseLinkRequest, parseWorkspaceRequest } from "./picks.js";
import { ProjectIcons, readRepositoryIcons, shrinkWithSips } from "./project-icons.js";
import { ConductorRegistryAdapter } from "./registry.js";
import { conductorNewChatHost, listNewChatWorkspaces } from "./new-chat.js";
import { ConductorReplier } from "./replier.js";
import { CONDUCTOR_ROUTE_SERVICE, CONDUCTOR_SERVICE, LateConductorRoute, type ConductorRoute } from "./route.js";
import { conductorFrontApp } from "./tabs.js";
import { SqueakHandsSender } from "./ui.js";
import { resolveWaiting } from "./waiting-resolve.js";
import { conductorMaintenance, conductorUninstallStep } from "./relay-maintenance.js";
import {
  archiveWorkspace,
  createPrPrompt,
  createWorkspace,
  listWorkspaceRepos,
  readWorkspace,
  workspaceControl,
} from "./workspace-actions.js";

/**
 * The Conductor add-on: everything that knows Conductor (the app by Melty, its `conductor.db`, Squeak Hands typing
 * into its window) lives here. It ships in every build and is inert until the owner enables it in Settings ›
 * Add-ons (core's `addons.json`): disabled, nothing reads conductor.db, no observer, replier or route answers.
 * Core knows only `src/addons.ts`; this folder may import core, never the other way round.
 */

/** `CONDUCTOR_DB_PATH`, else Conductor's own location, `~` expanded. */
export function conductorDbPathFor(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CONDUCTOR_DB_PATH?.trim() || "~/Library/Application Support/com.conductor.app/conductor.db";
  return raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : path.resolve(raw);
}

const CONDUCTOR_APP = "/Applications/Conductor.app";

const addon: Addon = {
  activate(context: AddonContext): AddonHandle {
    const { config, supportDir } = context;
    const dbPath = conductorDbPathFor(context.env);
    const enabled = () => context.isEnabled();
    const picks = WorkspacePicks.in(supportDir);
    picks.onChange(() => context.refresh());
    context.services.provide(CONDUCTOR_SERVICE, { dbPath });

    // Conductor's database is opened only once it is first needed while enabled: a disabled add-on never touches it.
    let opened: ConductorRegistryAdapter | null = null;
    const registry = (): ConductorRegistryAdapter =>
      (opened ??= new ConductorRegistryAdapter(dbPath, {
        workspacesRoot: config.workspacesRoot,
        defaultFallbackModel: config.defaultFallbackModel,
        defaultPermissionMode: config.defaultPermissionMode,
      }));
    const lazyRegistry = new Proxy({} as ConductorRegistryAdapter, {
      get: (_target, property) => {
        const value = (registry() as unknown as Record<string | symbol, unknown>)[property];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(registry()) : value;
      },
    });

    const hands = config.handsAppPath ? new SqueakHandsSender(config.handsAppPath) : null;
    const route: ConductorRoute = new LateConductorRoute(
      () => context.services.get<ConductorRoute>(CONDUCTOR_ROUTE_SERVICE),
      enabled,
      CONDUCTOR_NOT_ENABLED,
    );

    const replier = new ConductorReplier({
      registry: lazyRegistry,
      claude: new ClaudeCodeAdapter(config.claudeBin),
      codex: new CodexAppServerAdapter(config.codexBin),
      relay: route,
      ui: hands,
      linked: enabled,
      workspacePicked: (id) => picks.isPicked(id),
    });

    const answers = new AnswerService({
      registry: lazyRegistry,
      relay: answerRelayFrom({
        isReady: () => route.isReady(),
        send: (args) => route.send(args),
        request: () => route.requestFn(),
      }),
      readAsk: (conductorSessionId) => {
        const session = context
          .snapshot()
          .sessions.find((candidate) => candidate.conductorSessionId === conductorSessionId);
        return session?.agent === "claude" && session.transcriptPath ? readPendingAsk(session.transcriptPath) : null;
      },
    });

    const workspaceDeps = { conductorDbPath: dbPath, relay: route };
    const chatAction = async (
      sessionId: string,
      action: "stop" | "setup" | "pr",
      body: Record<string, unknown>,
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const session = context.snapshot().sessions.find((candidate) => candidate.conductorSessionId === sessionId);
      if (!session) return { ok: false, reason: "That chat isn't in Conductor any more." };
      if (action === "stop") return replier.stopTurn(sessionId);
      if (action === "setup") {
        const setup = resolveSetup(listChatModels(dbPath), session, {
          model: body.model,
          thinking: body.thinking,
          fast: body.fast,
        });
        if (!setup.ok) return setup;
        return replier.setSetup(sessionId, {
          model: setup.model,
          ...(setup.thinkingLevel ? { thinkingLevel: setup.thinkingLevel } : {}),
          fastMode: setup.fastMode,
        });
      }
      if (["working", "awaiting_approval", "awaiting_input"].includes(session.state)) {
        return { ok: false, reason: "The agent is mid-turn. Ask for the PR once it has finished." };
      }
      const workspace = session.conductorWorkspaceId ? readWorkspace(dbPath, session.conductorWorkspaceId) : null;
      if (!workspace) return { ok: false, reason: "That chat's workspace isn't in Conductor any more." };
      const outcome = await replier.send(sessionId, createPrPrompt(workspace), (message) => {
        context.logger.warn("PR request from the Mac app failed", { sessionId, message });
      });
      return outcome.status === "refused" || outcome.status === "unconfirmed"
        ? { ok: false, reason: outcome.reason }
        : { ok: true };
    };

    const hostReplier: AddonReplier = {
      hostId: "conductor",
      canHandle: (session: FleetSession) => session.hostId === "conductor",
      // Conductor's chat ids are bare UUIDs; a fleet key always carries `:`.
      ownsTarget: (target) => !target.includes(":"),
      lastTurnText: (id) => replier.lastTurnText(id),
      lastTurnId: (id) => replier.lastTurnId(id),
      lastTurnError: (id) => replier.lastTurnError(id),
      transcript: (id, limit, before) => replier.transcript(id, limit, before),
      workBetween: (id, messageId) => replier.workBetween(id, messageId),
      send: (id, text, onFailed, options) => replier.send(id, text, onFailed, options),
      isCompacting: (id) => replier.isCompacting(id),
      setOnQueueChange: (listener) => replier.setOnQueueChange(listener),
      queue: (id) => replier.queue(id),
      queueAction: (id, messageId, action) => replier.queueAction(id, messageId, action),
      stopTurn: (id) => replier.stopTurn(id),
      setSetup: (id, setup) => replier.setSetup(id, setup),
      action: (id, action, body) => chatAction(id, action, body),
      rename: (id, title) => registry().renameSession(id, title),
      close: (id) =>
        closeChat(
          {
            lookup: (sessionId) => registry().sessionForClose(sessionId),
            hide: (sessionId) => registry().closeSession(sessionId),
            ui: hands,
          },
          id,
        ),
      answers,
      stop: () => replier.stop(),
    };

    const observer = new ConductorObserver(lazyRegistry, {
      finishedWithinMs: config.activeWindowMs,
      enabled,
      workspaces: () => picks.workspaces,
    });
    const dbName = path.basename(dbPath);

    // The repository icons Conductor keeps; read only while enabled, so disabling clears them on the next refresh.
    const icons = new ProjectIcons(() => (enabled() ? readRepositoryIcons(dbPath) : []), shrinkWithSips);

    let repos: { at: number; list: Array<{ id: string; name: string }> } | null = null;
    const workspaceView = () => {
      const on = enabled();
      if (!on) return { linked: false, workspaces: [] as unknown[] };
      let rows: ReturnType<ConductorRegistryAdapter["listWorkspacesForPicker"]>;
      try {
        rows = registry().listWorkspacesForPicker();
      } catch {
        rows = [];
      }
      return { linked: true, workspaces: rows.map((row) => ({ ...row, picked: picks.isPicked(row.id) })) };
    };

    const routes: AddonRoute[] = [
      {
        method: "GET",
        path: "/control/conductor/link",
        handle: () => ({
          status: 200,
          body: {
            linked: enabled(),
            available: fs.existsSync(dbPath),
            appInstalled: fs.existsSync(CONDUCTOR_APP),
          },
        }),
      },
      {
        // The Mac app's Add button before it learned `/control/addons`: `{ linked: true }` is the same as enabling.
        method: "POST",
        path: "/control/conductor/link",
        handle: (body) => {
          const parsed = parseLinkRequest(body);
          if (!parsed.ok) return { status: 400, body: { error: parsed.reason } };
          const outcome = context.setEnabled(parsed.linked);
          if (!outcome.ok) return { status: 400, body: { error: outcome.reason } };
          return { status: 200, body: { ok: true, linked: enabled() } };
        },
      },
      { method: "GET", path: "/control/conductor/workspaces", handle: () => ({ status: 200, body: workspaceView() }) },
      {
        method: "POST",
        path: "/control/conductor/workspaces",
        handle: (body) => {
          const parsed = parseWorkspaceRequest(body);
          if (!parsed.ok) return { status: 400, body: { error: parsed.reason } };
          picks.setPicked(parsed.id, parsed.picked);
          return { status: 200, body: workspaceView() };
        },
      },
    ];

    return {
      maintenance: () => conductorMaintenance(context, dbPath),
      observers: [
        {
          source: observer.source,
          hostId: "conductor",
          observe: () => observer.observe(),
          watch: [{ dir: path.dirname(dbPath), names: [dbName, `${dbName}-wal`] }],
          resolve: (session, resolveContext) =>
            session.conductorWaiting && session.transcriptPath
              ? resolveWaiting(session, resolveContext.backgroundTasks(session), resolveContext.nowMs)
              : session,
        },
      ],
      repliers: [hostReplier],
      newChat: conductorNewChatHost(dbPath, route),
      workspaceActions: {
        repos: () => {
          if (!repos || Date.now() - repos.at > 60_000) {
            repos = { at: Date.now(), list: listWorkspaceRepos(dbPath).map(({ id, name }) => ({ id, name })) };
          }
          return repos.list;
        },
        archive: (workspaceId) => archiveWorkspace(workspaceDeps, workspaceId),
        create: (repoId) => createWorkspace(workspaceDeps, repoId),
        prPrompt: (workspaceId) => {
          const workspace = readWorkspace(dbPath, workspaceId);
          return workspace ? createPrPrompt(workspace) : null;
        },
        control: workspaceControl(workspaceDeps),
      },
      chatModels: () => listChatModels(dbPath),
      projectIcons: { current: () => icons.current(), refresh: () => icons.refresh() },
      routes,
      stateFields: () => ({ conductorLinked: enabled(), conductorWorkspaces: picks.workspaces }),
      frontApp: conductorFrontApp({
        handsAppPath: config.handsAppPath,
        places: () => {
          const workspaces = listNewChatWorkspaces(dbPath, 8);
          const chats = registry().openChatsIn(workspaces.map((w) => w.id));
          return workspaces.map((w) => ({
            id: w.id,
            name: [w.repoName, w.branch].filter(Boolean).join(" · "),
            ...(w.repoName ? { repo: w.repoName } : {}),
            chats: chats
              .filter((chat) => chat.workspaceId === w.id)
              .map((chat) => ({
                id: chat.id,
                title: chat.title && chat.title !== "Untitled" ? chat.title : "Untitled chat",
                working: ["working", "waiting", "cancelling"].includes(chat.status ?? ""),
              })),
          }));
        },
        chat: (id) => {
          const row = registry().sessionForClose(id);
          return row ? { workspaceId: row.workspaceId, title: row.title } : null;
        },
      }),
      coreAdapters: ({ observe, send }) => [new ConductorAdapter({ observe, replier: { send } })],
      cli: conductorCliCommands(() => ({ dbPath, config })),
      uninstall: conductorUninstallStep(supportDir),
      presentation: { hostId: "conductor", label: "Conductor" },
      stop: async () => {
        await replier.stop().catch(() => undefined);
      },
    };
  },
};

export default addon;
