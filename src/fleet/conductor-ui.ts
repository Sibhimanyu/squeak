import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * Typing a reply into Conductor's own composer, through Squeak Hands.
 *
 * Conductor has no local "send a message" API (its API is cloud-only) and
 * does not live-reload rows written behind its back, so a reply that should
 * appear and stream in the Conductor window has to go in the way a person's
 * would. Squeak Hands (helpers/squeak-hands) is a separate signed app that
 * holds the Accessibility grant, so that nothing broader — node, or
 * Conductor with every agent inside it — has to.
 *
 * It only types after proving from Conductor's own route which chat is on
 * screen, and every failure except "unconfirmed" guarantees nothing was typed.
 */

export type UiSendError =
  | "locked"
  | "conductor-not-running"
  | "no-window"
  | "workspace-not-in-sidebar"
  | "chat-not-open"
  | "no-composer"
  | "draft-present"
  | "paste-failed"
  | "unconfirmed"
  | "not-trusted"
  | "helper-missing"
  | "helper-failed";

export type UiSendResult = { ok: true } | { ok: false; error: UiSendError; detail?: string };

export interface UiSendRequest {
  workspaceId: string;
  sessionId: string;
  sessionTitle: string | null;
  text: string;
}

export interface ConductorUiSender {
  send(request: UiSendRequest): Promise<UiSendResult>;
}

/** True when the failure means the text may be in the chat already. */
export function mayHaveSent(result: UiSendResult): boolean {
  return !result.ok && (result.error === "unconfirmed" || result.error === "helper-failed");
}

/** Short human reason for a card, when a reply could not go through the window. */
export function describeUiFailure(error: UiSendError): string {
  switch (error) {
    case "locked":
      return "the Mac is locked";
    case "conductor-not-running":
      return "Conductor is not open";
    case "workspace-not-in-sidebar":
      return "the workspace is not in Conductor's sidebar";
    case "chat-not-open":
      return "the chat is not open as a tab in Conductor";
    case "draft-present":
      return "there is an unsent draft in that chat";
    case "not-trusted":
      return "Squeak Hands has no Accessibility permission";
    case "helper-missing":
      return "Squeak Hands is not installed";
    default:
      return "Conductor's window could not be driven";
  }
}

export const DEFAULT_HANDS_APP = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "squeak",
  "Squeak Hands.app",
);

const HELPER_TIMEOUT_MS = 30_000;

export class SqueakHandsSender implements ConductorUiSender {
  private readonly appPath: string;
  /** One window, one pair of hands: sends never overlap. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(appPath = DEFAULT_HANDS_APP) {
    this.appPath = appPath;
  }

  send(request: UiSendRequest): Promise<UiSendResult> {
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(request: UiSendRequest): Promise<UiSendResult> {
    if (!fs.existsSync(this.appPath)) {
      return { ok: false, error: "helper-missing" };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-hands-"));
    const requestPath = path.join(dir, "request.json");
    const resultPath = path.join(dir, "result.json");
    try {
      fs.writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
      // Launched through LaunchServices so macOS attributes it to Squeak
      // Hands' own grant, not to whoever spawned it.
      const launched = await new Promise<boolean>((resolve) => {
        execFile(
          "/usr/bin/open",
          ["-W", "-n", this.appPath, "--args", "send", requestPath, resultPath],
          { timeout: HELPER_TIMEOUT_MS },
          (error) => resolve(!error),
        );
      });
      const raw = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, "utf8") : null;
      if (!raw) {
        // No verdict: it may have died halfway through typing.
        return { ok: false, error: "helper-failed", detail: launched ? "no result" : "launch failed or timed out" };
      }
      const parsed = JSON.parse(raw) as { ok?: boolean; error?: UiSendError; detail?: string };
      if (parsed.ok) {
        return { ok: true };
      }
      return { ok: false, error: parsed.error ?? "helper-failed", ...(parsed.detail ? { detail: parsed.detail } : {}) };
    } catch (error) {
      logger.warn("squeak hands failed", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, error: "helper-failed" };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
