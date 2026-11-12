import os from "node:os";
import path from "node:path";
import type { AddonCommand, AddonConfig } from "../../src/addons.js";
import { formatImportReport, importConductor } from "./import-conductor.js";
import { MoveRefused, formatMoveReport, moveFromConductor } from "./move-from-conductor.js";

/** `squeak import-conductor` and `squeak move-from-conductor`: read-only on Conductor, written into Squeak's own store. */
export function conductorCliCommands(deps: () => { dbPath: string; config: AddonConfig }): AddonCommand[] {
  return [
    {
      name: "import-conductor",
      usage:
        "Copy Conductor's chats into Squeak's own store: [--dry-run] [--repo <name>] (read-only on Conductor; --repo repeats or takes a,b)",
      async run(args) {
        const { dbPath, config } = deps();
        const repos: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!;
          const v = a === "--repo" ? args[++i] : a.startsWith("--repo=") ? a.slice(7) : undefined;
          if (v)
            repos.push(
              ...v
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean),
            );
        }
        console.log(
          formatImportReport(
            importConductor({
              conductorDbPath: dbPath,
              nativeDbPath: config.nativeDbPath,
              workspacesRoot: config.workspacesRoot,
              dryRun: args.includes("--dry-run"),
              repos,
            }),
          ),
        );
      },
    },
    {
      name: "move-from-conductor",
      usage:
        "Move one Conductor repo and its worktrees into ~/squeak and repoint Squeak: --repo <name> [--dry-run] (exactly one repo; refuses if anything is open or a chat is running)",
      async run(args) {
        const { dbPath, config } = deps();
        const repos: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!;
          const v = a === "--repo" ? args[++i] : a.startsWith("--repo=") ? a.slice(7) : undefined;
          if (v) repos.push(v.trim());
        }
        if (repos.length !== 1 || !repos[0]) {
          console.error("Usage: squeak move-from-conductor --repo <name> [--dry-run] (exactly one --repo)");
          return 2;
        }
        try {
          console.log(
            formatMoveReport(
              await moveFromConductor({
                repo: repos[0],
                conductorDbPath: dbPath,
                nativeDbPath: config.nativeDbPath,
                conductorWorkspacesRoot: config.workspacesRoot,
                squeakReposRoot: path.join(os.homedir(), "squeak", "repos"),
                squeakWorkspacesRoot: path.join(os.homedir(), "squeak", "workspaces"),
                claudeProjectsDir: path.join(os.homedir(), ".claude", "projects"),
                dryRun: args.includes("--dry-run"),
              }),
            ),
          );
        } catch (e) {
          if (!(e instanceof MoveRefused)) throw e;
          console.error(`Refused: ${e.message}`);
          return 1;
        }
        return 0;
      },
    },
  ];
}
