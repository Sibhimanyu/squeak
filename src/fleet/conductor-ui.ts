import { DEFAULT_HANDS_APP, runHands } from "./hands.js";

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

/** Closing a chat's tab through its own "Close tab", as a person would; Conductor then hides it itself. */
export interface UiCloseRequest {
  workspaceId: string;
  sessionId: string;
  sessionTitle: string | null;
}

export type UiCloseResult = { ok: true } | { ok: false; error: string; detail?: string };

export interface ConductorUiCloser {
  close(request: UiCloseRequest): Promise<UiCloseResult>;
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

export class SqueakHandsSender implements ConductorUiSender, ConductorUiCloser {
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

  close(request: UiCloseRequest): Promise<UiCloseResult> {
    const run = this.queue.then(() => this.runClose(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runClose(request: UiCloseRequest): Promise<UiCloseResult> {
    const outcome = await runHands(this.appPath, "close", request);
    if (outcome.status === "missing") return { ok: false, error: "helper-missing" };
    if (outcome.status === "no-result") return { ok: false, error: "helper-failed", detail: outcome.detail };
    const parsed = outcome.result as { ok?: boolean; error?: string; detail?: string };
    if (parsed.ok) return { ok: true };
    return { ok: false, error: parsed.error ?? "helper-failed", ...(parsed.detail ? { detail: parsed.detail } : {}) };
  }

  private async run(request: UiSendRequest): Promise<UiSendResult> {
    const outcome = await runHands(this.appPath, "send", request);
    if (outcome.status === "missing") {
      return { ok: false, error: "helper-missing" };
    }
    if (outcome.status === "no-result") {
      // No verdict: it may have died halfway through typing.
      return { ok: false, error: "helper-failed", detail: outcome.detail };
    }
    const parsed = outcome.result as { ok?: boolean; error?: UiSendError; detail?: string };
    if (parsed.ok) {
      return { ok: true };
    }
    return { ok: false, error: parsed.error ?? "helper-failed", ...(parsed.detail ? { detail: parsed.detail } : {}) };
  }
}
