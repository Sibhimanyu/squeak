import fs from "node:fs";
import path from "node:path";

/**
 * Which Conductor workspaces the owner added to Squeak: `workspaces.json` in the support dir's `conductor/` folder
 * (`{ workspaces: string[] }`, absent = none). Whether the add-on is on at all is core's `addons.json`; nothing is
 * carried over from the old `conductor-link.json`, so every Mac starts with no Conductor chat visible.
 */

export const CONDUCTOR_NOT_ENABLED = "Conductor isn't added to Squeak. Add it in Squeak › Settings › Add-ons.";

export const CONDUCTOR_WORKSPACE_NOT_PICKED =
  "That Conductor workspace isn't added to Squeak. Add it in Squeak › Settings › Conductor.";

type Listener = () => void;

export class WorkspacePicks {
  private picked: string[];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly file: string | null) {
    this.picked = file ? readPicks(file) : [];
  }

  /** The picks for `supportDir`, kept in `<supportDir>/conductor/workspaces.json`. */
  static in(supportDir: string): WorkspacePicks {
    return new WorkspacePicks(path.join(supportDir, "conductor", "workspaces.json"));
  }

  get workspaces(): string[] {
    return [...this.picked];
  }

  isPicked(workspaceId: string | null | undefined): boolean {
    return !!workspaceId && this.picked.includes(workspaceId);
  }

  /** Adds or removes one workspace; listeners run (a refresh) only when the set changed. */
  setPicked(workspaceId: string, picked: boolean): void {
    if (this.picked.includes(workspaceId) === picked) return;
    this.picked = picked ? [...this.picked, workspaceId] : this.picked.filter((id) => id !== workspaceId);
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // a listener must never break the change
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
      fs.writeFileSync(tmp, `${JSON.stringify({ workspaces: this.picked })}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // the pick still holds for this run
    }
  }
}

function readPicks(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces)
      ? parsed.workspaces.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
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

/** `{ id, picked }` strictly: exactly those keys, a non-empty string and a boolean. */
export function parseWorkspaceRequest(
  body: unknown,
): { ok: true; id: string; picked: boolean } | { ok: false; reason: string } {
  const bad = { ok: false as const, reason: "Send { id: string, picked: true | false }." };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad;
  const keys = Object.keys(body).sort();
  const { id, picked } = body as { id?: unknown; picked?: unknown };
  if (keys.length !== 2 || keys[0] !== "id" || keys[1] !== "picked") return bad;
  if (typeof id !== "string" || id.length === 0 || id.length > 200 || typeof picked !== "boolean") return bad;
  return { ok: true, id, picked };
}
