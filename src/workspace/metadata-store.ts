import fs from "node:fs";
import path from "node:path";

import type { WorkspaceId } from "../core/types.js";
import type { ProcessRecord, WorkspaceMetadata } from "./types.js";

export const WORKSPACE_STORE_VERSION = 1;

interface FileShape {
  version: number;
  workspaces: Record<string, WorkspaceMetadata>;
  processes: Record<string, ProcessRecord>;
}

/** One versioned JSON file, written atomically; independent of git and of core.db. */
export class WorkspaceMetadataStore {
  private data: FileShape;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): FileShape {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<FileShape>;
      if (typeof parsed.version === "number" && parsed.version > WORKSPACE_STORE_VERSION) {
        throw new Error(
          `workspaces.json is version ${parsed.version}; this Squeak understands ${WORKSPACE_STORE_VERSION}`,
        );
      }
      return {
        version: WORKSPACE_STORE_VERSION,
        workspaces: parsed.workspaces ?? {},
        processes: parsed.processes ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: WORKSPACE_STORE_VERSION, workspaces: {}, processes: {} };
      if (error instanceof SyntaxError) {
        // Keep the unreadable file for a human, start clean.
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          // best effort
        }
        return { version: WORKSPACE_STORE_VERSION, workspaces: {}, processes: {} };
      }
      throw error;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(id: WorkspaceId): WorkspaceMetadata | undefined {
    const w = this.data.workspaces[id];
    return w ? structuredClone(w) : undefined;
  }

  list(): WorkspaceMetadata[] {
    return Object.values(this.data.workspaces).map((w) => structuredClone(w));
  }

  put(meta: WorkspaceMetadata): void {
    this.data.workspaces[meta.workspaceId] = structuredClone(meta);
    this.save();
  }

  delete(id: WorkspaceId): void {
    delete this.data.workspaces[id];
    this.save();
  }

  getProcess(id: string): ProcessRecord | undefined {
    const p = this.data.processes[id];
    return p ? structuredClone(p) : undefined;
  }

  listProcesses(): ProcessRecord[] {
    return Object.values(this.data.processes).map((p) => structuredClone(p));
  }

  putProcess(record: ProcessRecord): void {
    this.data.processes[record.id] = structuredClone(record);
    this.save();
  }
}
