import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CloudLocation } from "../cloud/location.js";
import { databaseUrl as remoteDatabaseUrl } from "../squeak/config.js";
import { logger } from "../utils/logger.js";
import { readEnvValues } from "../squeak/channels-setup.js";
import { cliqHandlerBlocks, setEnvValues, writeCliqRelay } from "./setup.js";

/**
 * The Mac app's in-app Cliq setup (Extensions > Zoho Cliq): the three handlers to paste, built from the same
 * generator `squeak cliq-relay --rotate` uses, and the moment the first signed tap arrived. The code holds the
 * signing secret, so it only ever travels on the token-gated control routes and is never logged.
 */
export interface HandlerBlock {
  id: "message" | "squeakbutton" | "squeakreply";
  title: string;
  where: string;
  code: string;
}

export interface HandlersView {
  blocks: HandlerBlock[];
  relayReady: boolean;
  lastTapAt?: string;
  inbox: "catalyst" | "firebase" | "both";
  /** Hosted Macs: Squeak's cloud refused or could not be reached while registering this Mac's Cliq key (a fixed sentence). */
  registerError?: string;
  /** True on a hosted Mac: Squeak's cloud is given this Mac's key by the daemon itself, so the page has nothing to ask for. */
  automatic?: true;
}

export type RegenerateOutcome =
  | { ok: true; needsRelayDeploy: boolean; relayKey?: string; restart: boolean }
  | { ok: false; reason: string };

const STATE_FILE = "cliq-state.json";
/** `.env`: the relay id the Cliq key in `SQUEAK_CLIQ_KEY` was registered for with Squeak's cloud (hosted Macs). */
const KEY_FOR = "SQUEAK_CLIQ_KEY_FOR";
const REGISTER_FAILED = "Squeak's cloud could not set up Cliq. Try again in a moment.";
/** After a failed registration a poll waits this long before trying again by itself; a Retry press does not wait. */
const RETRY_AFTER_MS = 15_000;

export class CliqHandlers {
  constructor(
    private readonly options: {
      envPath: string;
      supportDir: string;
      cloud: () => CloudLocation | null;
      /** Called after a regenerate: the daemon reads `.env` only at start, so it restarts to verify with the new secret. */
      restart?: () => void;
      now?: () => number;
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    },
  ) {}

  private registerError: string | undefined;
  private failedAt = 0;
  private inflight: Promise<void> | undefined;

  private hostedCloud() {
    const cloud = this.options.cloud();
    return cloud?.provider === "catalyst" && cloud.hosted ? cloud : null;
  }

  /**
   * Hosted Macs: registers the per-Mac Cliq ingest token with Squeak's cloud (`POST /account/macs/cliq-token`, the Mac's
   * own key). The relay keeps only a hash of it. Never logs the token or the response body.
   */
  private async register(relayId: string, token: string): Promise<boolean> {
    const cloud = this.hostedCloud();
    if (!cloud) return false;
    try {
      const response = await (this.options.fetch ?? fetch)(`${cloud.relayUrl}/account/macs/cliq-token`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-squeak-mac-key": cloud.relayKey },
        body: JSON.stringify({ channel: relayId, token }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) logger.warn(`cliq token registration refused (${response.status})`);
      return response.ok;
    } catch {
      logger.warn("cliq token registration failed (network)");
      return false;
    }
  }

  /**
   * Hosted Macs: makes sure the handlers carry a Cliq key Squeak's cloud knows (registering a fresh one on first use or
   * when the saved one was never registered for this relay id), and makes the relay when there is none. Nothing to do
   * for own-Catalyst and Firebase Macs. `force` is the Retry press: it skips the wait after a failure.
   */
  ensure(force = false): Promise<void> {
    if (!this.hostedCloud()) return Promise.resolve();
    if (!force && this.failedAt && (this.options.now ?? Date.now)() - this.failedAt < RETRY_AFTER_MS)
      return Promise.resolve();
    this.inflight ??= this.ensureHosted().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async ensureHosted(): Promise<void> {
    const env = readEnvValues(this.options.envPath);
    const relayId = env.SQUEAK_CLIQ_RELAY_ID?.trim();
    if (!relayId || !env.SQUEAK_CLIQ_RELAY_SECRET?.trim()) {
      await this.regenerateHosted();
      return;
    }
    if (env.SQUEAK_CLIQ_KEY?.trim() && env[KEY_FOR]?.trim() === relayId) {
      this.registerError = undefined;
      return;
    }
    const token = randomBytes(32).toString("base64url");
    if (!(await this.register(relayId, token))) {
      this.registerError = REGISTER_FAILED;
      this.failedAt = (this.options.now ?? Date.now)();
      return;
    }
    // Same relay id and secret, new key: the pasted handlers' relay id is unchanged, so no restart.
    writeCliqRelay(this.options.envPath, env, this.options.cloud(), { rotate: false, cliqKey: token });
    setEnvValues(this.options.envPath, { [KEY_FOR]: relayId });
    this.registerError = undefined;
    this.failedAt = 0;
  }

  /** A verified Cliq record from the owner arrived. */
  recordTap(): void {
    try {
      const at = new Date((this.options.now ?? Date.now)()).toISOString();
      fs.writeFileSync(path.join(this.options.supportDir, STATE_FILE), JSON.stringify({ lastTapAt: at }), {
        mode: 0o600,
      });
    } catch {
      // A missing timestamp must never stop an answer.
    }
  }

  private lastTapAt(): string | undefined {
    try {
      const value = (
        JSON.parse(fs.readFileSync(path.join(this.options.supportDir, STATE_FILE), "utf8")) as {
          lastTapAt?: unknown;
        }
      ).lastTapAt;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  view(): HandlersView {
    const env = readEnvValues(this.options.envPath);
    const cloud = this.options.cloud();
    const relayId = env.SQUEAK_CLIQ_RELAY_ID?.trim();
    const secret = env.SQUEAK_CLIQ_RELAY_SECRET?.trim();
    const catalyst = cloud?.provider === "catalyst";
    const cliqKey = env.SQUEAK_CLIQ_KEY?.trim();
    const projectId = env.SQUEAK_REMOTE_PROJECT?.trim() ?? "";
    const inbox: HandlersView["inbox"] = catalyst ? (projectId ? "both" : "catalyst") : "firebase";
    const lastTapAt = this.lastTapAt();
    // A hosted Mac's key counts only once Squeak's cloud knows it for this relay id.
    const unregistered = Boolean(cloud?.provider === "catalyst" && cloud.hosted) && env[KEY_FOR]?.trim() !== relayId;
    const automatic = this.hostedCloud() ? ({ automatic: true } as const) : {};
    if (!relayId || !secret || (catalyst && !cliqKey) || unregistered) {
      return {
        blocks: [],
        relayReady: false,
        inbox,
        ...automatic,
        ...(this.registerError && this.hostedCloud() ? { registerError: this.registerError } : {}),
        ...(lastTapAt ? { lastTapAt } : {}),
      };
    }
    const code = cliqHandlerBlocks({
      projectId,
      relayId,
      secret,
      databaseUrl: remoteDatabaseUrl(env.SQUEAK_REMOTE_DATABASE_URL),
      catalyst: catalyst && cliqKey ? { relayUrl: cloud.relayUrl, cliqKey } : null,
    });
    return {
      blocks: [
        {
          id: "message",
          title: "Message handler",
          where: "Bots › Squeak › Edit Handlers › Message handler (replace everything)",
          code: code.message,
        },
        {
          id: "squeakbutton",
          title: "Button function",
          where: "Integrations › Functions › Create: new function named squeakbutton (type: Button)",
          code: code.squeakbutton,
        },
        {
          id: "squeakreply",
          title: "Reply form function",
          where: "Integrations › Functions › Create: new function named squeakreply (type: Form)",
          code: code.squeakreply,
        },
      ],
      relayReady: true,
      inbox,
      ...automatic,
      ...(lastTapAt ? { lastTapAt } : {}),
    };
  }

  /**
   * What `--rotate` does, without the Catalyst deploy: a new relay id and secret. The Cliq key is kept when there is
   * one (write-only, one per relay), so `needsRelayDeploy` is true only when this run had to make it. A hosted Mac
   * registers a fresh key of its own with Squeak's cloud first, so it never needs the cloud changed by hand.
   */
  async regenerate(): Promise<RegenerateOutcome> {
    try {
      if (this.hostedCloud()) return await this.regenerateHosted();
      const env = readEnvValues(this.options.envPath);
      const written = writeCliqRelay(this.options.envPath, env, this.options.cloud(), {
        rotate: true,
        rotateKey: false,
      });
      this.afterRegenerate();
      const needsRelayDeploy = Boolean(written.catalyst) && written.newCliqKey;
      return {
        ok: true,
        needsRelayDeploy,
        ...(needsRelayDeploy ? { relayKey: written.cliqKey } : {}),
        restart: Boolean(this.options.restart),
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Could not make the handlers." };
    }
  }

  private afterRegenerate(): void {
    try {
      fs.rmSync(path.join(this.options.supportDir, STATE_FILE), { force: true });
    } catch {
      // Best effort.
    }
    this.options.restart?.();
  }

  private async regenerateHosted(): Promise<RegenerateOutcome> {
    const relayId = randomBytes(32).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    if (!(await this.register(relayId, token))) {
      this.registerError = REGISTER_FAILED;
      this.failedAt = (this.options.now ?? Date.now)();
      return { ok: false, reason: REGISTER_FAILED };
    }
    const env = readEnvValues(this.options.envPath);
    writeCliqRelay(this.options.envPath, env, this.options.cloud(), { rotate: true, relayId, cliqKey: token });
    setEnvValues(this.options.envPath, { [KEY_FOR]: relayId });
    this.registerError = undefined;
    this.failedAt = 0;
    this.afterRegenerate();
    return { ok: true, needsRelayDeploy: false, restart: Boolean(this.options.restart) };
  }
}
