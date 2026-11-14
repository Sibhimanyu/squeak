import os from "node:os";
import path from "node:path";
import type { Addon, AddonContext, AddonHandle } from "../../src/addons.js";
import { reconcileExternalHooks } from "../../src/fleet/external-hooks.js";
import { ClaudeCoworkObserver } from "../../src/fleet/observers/claude-cowork.js";
import { ClaudeTranscriptObserver } from "../../src/fleet/observers/claude-transcript.js";
import { ProcessLivenessObserver } from "../../src/fleet/observers/process-liveness.js";
import { readClaudeSessionFiles } from "../../src/fleet/terminal-process.js";
import { logger } from "../../src/utils/logger.js";

/**
 * Claude Code (external): the Claude sessions Squeak did not start (Terminal `claude`, the Claude desktop app's Code
 * tab, Cowork). Off until the owner enables it in Settings › Extensions; while off, core reads only the Claude
 * transcripts that Squeak's own chats and a host's chats name (claimed mode), never the rest of the folder, and no
 * hook of ours is in Claude Code's settings. Enabling installs the hooks (the only source of "blocked on an
 * approval"); disabling removes them. `maintenance` reconciles both ways at every start.
 */
const addon: Addon = {
  activate(context: AddonContext): AddonHandle {
    const window = {
      activeWithinMs: context.config.activeWindowMs,
      idleAfterMs: context.config.idleAfterMs,
    };
    const transcripts = new ClaudeTranscriptObserver(window);
    const cowork = new ClaudeCoworkObserver(window);
    const liveness = new ProcessLivenessObserver({ claudeSessions: () => readClaudeSessionFiles() });
    const reconcile = (): Promise<void> =>
      reconcileExternalHooks({ supportDir: context.supportDir, port: context.config.hookPort }).then(
        (outcome) => {
          if (outcome && !outcome.ok) logger.warn("agent hooks not reconciled", { reason: outcome.reason });
        },
        () => undefined,
      );
    return {
      // Same sources as core's claimed pass: merge keys on the agent's session id, and core skips ids read here.
      observers: [
        {
          source: "claude-transcript",
          observe: () => transcripts.observe(),
          watch: [{ dir: path.join(os.homedir(), ".claude", "projects"), recursive: true }],
        },
        { source: "claude-cowork", observe: () => cowork.observe() },
      ],
      liveness: { observe: async () => (await liveness.observe()).filter((live) => live.agent === "claude") },
      maintenance: reconcile,
      onEnabledChange: () => void reconcile(),
    };
  },
};

export default addon;
