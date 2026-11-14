import os from "node:os";
import path from "node:path";
import type { Addon, AddonContext, AddonHandle } from "../../src/addons.js";
import { reconcileExternalHooks } from "../../src/fleet/external-hooks.js";
import { CodexRolloutObserver } from "../../src/fleet/observers/codex-rollout.js";
import { ProcessLivenessObserver } from "../../src/fleet/observers/process-liveness.js";
import { logger } from "../../src/utils/logger.js";

/**
 * Codex (external): the Codex threads Squeak did not start (Terminal `codex`, the Codex desktop app). Off until the
 * owner enables it in Settings › Extensions; while off, core reads only the rollouts that Squeak's own chats and a
 * host's chats name (claimed mode) and no hook of ours is in Codex's settings. Enabling installs the hooks (and the
 * ask format in `AGENTS.md`); disabling removes them. `maintenance` reconciles both ways at every start.
 */
const addon: Addon = {
  activate(context: AddonContext): AddonHandle {
    const rollouts = new CodexRolloutObserver({
      activeWithinMs: context.config.activeWindowMs,
      idleAfterMs: context.config.idleAfterMs,
    });
    const liveness = new ProcessLivenessObserver();
    const reconcile = (): Promise<void> =>
      reconcileExternalHooks({ supportDir: context.supportDir, port: context.config.hookPort }).then(
        (outcome) => {
          if (outcome && !outcome.ok) logger.warn("agent hooks not reconciled", { reason: outcome.reason });
        },
        () => undefined,
      );
    return {
      observers: [
        {
          source: "codex-rollout",
          observe: () => rollouts.observe(),
          watch: [{ dir: path.join(os.homedir(), ".codex", "sessions"), recursive: true }],
        },
      ],
      liveness: { observe: async () => (await liveness.observe()).filter((live) => live.agent === "codex") },
      maintenance: reconcile,
      onEnabledChange: () => void reconcile(),
    };
  },
};

export default addon;
