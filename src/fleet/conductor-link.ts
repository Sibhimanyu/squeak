import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Conductor is something the owner links later, in Settings; it is not part of setup and is off for a new install.
 * The choice is `conductor-link.json` in the support dir (`{ linked, linkedAt? }`), read at start and changed at run
 * time. Everything that touches Conductor (the observer, replies, Squeak Hands' Conductor routes, the relay add-on)
 * asks `ConductorLink.linked` first.
 */

export const CONDUCTOR_NOT_LINKED = "Conductor isn't linked. Link it in Squeak › Settings › Add-ons.";

export interface ConductorLinkFile {
  linked: boolean;
  linkedAt?: string;
}

export interface MigrationProbe {
  /** conductor.db exists. */
  dbExists(): boolean;
  /** The Conductor `sessions` table has at least one row (opened read-only, one cheap query). */
  hasSessions(): boolean;
  /** The reply-target table (Telegram/Cliq cards) holds a row naming a Conductor chat (an id with no `:`). */
  referencesConductorChats(): boolean;
  /** `SQUEAK_CONDUCTOR_RELAY=on`, or `conductor-relay` in `SQUEAK_ADDONS`. */
  relayEnabled(): boolean;
}

/**
 * Whether an install that has no `conductor-link.json` already used Conductor. Decided once, then written.
 * Signals (cheap, any one with the database present): the sessions table is not empty; the reply-target store
 * holds a `fleet_reply_target` row naming a Conductor chat (a key with no `:`); the relay add-on is switched on
 * in the environment. A fresh install has no database, or an empty one, and none of the others.
 */
export function usedConductorBefore(probe: MigrationProbe): boolean {
  if (probe.relayEnabled()) return true;
  if (!probe.dbExists()) return false;
  return probe.hasSessions() || probe.referencesConductorChats();
}

export function relayEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.SQUEAK_CONDUCTOR_RELAY?.trim().toLowerCase() === "on") return true;
  return (env.SQUEAK_ADDONS ?? "").split(",").some((name) => name.trim().toLowerCase() === "conductor-relay");
}

export function realProbe(options: {
  conductorDbPath: string;
  stateDbPath: string;
  env?: NodeJS.ProcessEnv;
}): MigrationProbe {
  const scalar = (file: string, sql: string): boolean => {
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      return db.prepare(sql).get() !== undefined;
    } catch {
      return false;
    } finally {
      try {
        db?.close();
      } catch {
        // nothing to close
      }
    }
  };
  return {
    dbExists: () => fs.existsSync(options.conductorDbPath),
    hasSessions: () => scalar(options.conductorDbPath, "SELECT 1 FROM sessions LIMIT 1"),
    referencesConductorChats: () =>
      scalar(
        options.stateDbPath,
        "SELECT 1 FROM fleet_reply_target WHERE instr(conductor_session_id, ':') = 0 LIMIT 1",
      ),
    relayEnabled: () => relayEnvEnabled(options.env ?? process.env),
  };
}

type Listener = (linked: boolean) => void;

export class ConductorLink {
  private state: ConductorLinkFile;
  private readonly listeners = new Set<Listener>();

  private constructor(
    private readonly file: string,
    state: ConductorLinkFile,
  ) {
    this.state = state;
  }

  /** Reads the file; when absent (or unreadable) decides once with `probe` and writes the answer. */
  static load(file: string, probe: MigrationProbe, now: () => Date = () => new Date()): ConductorLink {
    const existing = readFile(file);
    if (existing) return new ConductorLink(file, existing);
    let linked: boolean;
    try {
      linked = usedConductorBefore(probe);
    } catch {
      linked = false;
    }
    const state: ConductorLinkFile = linked ? { linked, linkedAt: now().toISOString() } : { linked };
    const link = new ConductorLink(file, state);
    link.persist();
    return link;
  }

  /** A link with a fixed answer and no file, for tests and callers that predate the setting. */
  static fixed(linked: boolean): ConductorLink {
    const link = new ConductorLink("", { linked });
    return link;
  }

  get linked(): boolean {
    return this.state.linked;
  }

  set(linked: boolean, now: () => Date = () => new Date()): void {
    if (linked === this.state.linked) return;
    this.state = linked ? { linked, linkedAt: now().toISOString() } : { linked };
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener(linked);
      } catch {
        // a listener must never break the switch
      }
    }
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // the choice still holds for this run
    }
  }
}

function readFile(file: string): ConductorLinkFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ConductorLinkFile>;
    if (typeof parsed.linked !== "boolean") return null;
    return {
      linked: parsed.linked,
      ...(typeof parsed.linkedAt === "string" ? { linkedAt: parsed.linkedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** `{ linked }` strictly: exactly that one key, a boolean. */
export function parseLinkRequest(body: unknown): { ok: true; linked: boolean } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "Send { linked: true | false }." };
  }
  const keys = Object.keys(body);
  const linked = (body as { linked?: unknown }).linked;
  if (keys.length !== 1 || keys[0] !== "linked" || typeof linked !== "boolean") {
    return { ok: false, reason: "Send { linked: true | false }." };
  }
  return { ok: true, linked };
}
