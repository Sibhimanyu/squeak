import fs from "node:fs";
import path from "node:path";

import type { CloudLocation } from "../cloud/location.js";
import { databaseUrl as remoteDatabaseUrl } from "../squeak/config.js";
import { readEnvValues } from "../squeak/channels-setup.js";
import { cliqHandlerBlocks, writeCliqRelay } from "./setup.js";

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
}

export type RegenerateOutcome =
  | { ok: true; needsRelayDeploy: boolean; relayKey?: string; restart: boolean }
  | { ok: false; reason: string };

const STATE_FILE = "cliq-state.json";

export class CliqHandlers {
  constructor(
    private readonly options: {
      envPath: string;
      supportDir: string;
      cloud: () => CloudLocation | null;
      /** Called after a regenerate: the daemon reads `.env` only at start, so it restarts to verify with the new secret. */
      restart?: () => void;
      now?: () => number;
    },
  ) {}

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
    if (!relayId || !secret || (catalyst && !cliqKey)) {
      return { blocks: [], relayReady: false, inbox, ...(lastTapAt ? { lastTapAt } : {}) };
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
      ...(lastTapAt ? { lastTapAt } : {}),
    };
  }

  /**
   * What `--rotate` does, without the Catalyst deploy: a new relay id and secret. The Cliq key is kept when there is
   * one (write-only, one per relay), so `needsRelayDeploy` is true only when this run had to make it.
   */
  regenerate(): RegenerateOutcome {
    try {
      const env = readEnvValues(this.options.envPath);
      const written = writeCliqRelay(this.options.envPath, env, this.options.cloud(), {
        rotate: true,
        rotateKey: false,
      });
      try {
        fs.rmSync(path.join(this.options.supportDir, STATE_FILE), { force: true });
      } catch {
        // Best effort.
      }
      this.options.restart?.();
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
}
