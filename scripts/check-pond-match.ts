// Real-data check: run the phone's pond matching over the live daemon's sessions and the host's projects.
// Usage: npx tsx scripts/check-pond-match.ts   (prints names and counts, never tokens)
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import type { PhonePond } from "../src/fleet/native-phone.js";
import { MainRepoFinder, matchPond } from "../src/remote/pond-match.js";

const state = (await (await fetch("http://127.0.0.1:8477/state")).json()) as {
  active: Array<Record<string, unknown>>;
  others?: Array<Record<string, unknown>>;
};
const sessions = [...state.active, ...(state.others ?? [])] as Array<{
  origin?: string;
  repoName?: string | null;
  projectId?: string;
  cwd?: string | null;
  workspaceRoot?: string | null;
}>;
const db = new Database(path.join(os.homedir(), "Library/Application Support/squeak/native.db"), { readonly: true });
const projects = db.prepare("SELECT id, name, root_path FROM projects").all() as Array<{
  id: string;
  name: string;
  root_path: string;
}>;
const ponds: PhonePond[] = projects.map((p) => ({
  id: p.id,
  name: p.name,
  shared: false,
  members: [],
  match: p.name.toLowerCase(),
  projectId: p.id,
  folder: p.root_path,
  projectOnly: true,
}));
const finder = new MainRepoFinder();
const base = path.join(os.homedir(), "squeak", "workspaces") + path.sep;
let under = 0;
let unmatched = 0;
let withPond = 0;
for (const s of sessions) {
  const pond = matchPond(ponds, s, finder);
  if (pond) withPond += 1;
  if (s.cwd?.startsWith(base)) {
    under += 1;
    if (!pond) {
      unmatched += 1;
      console.log("NO POND:", s.repoName, s.cwd);
    }
  }
}
console.log(
  `sessions ${sessions.length}, with a pond ${withPond}, without ${sessions.length - withPond}; ` +
    `under ~/squeak/workspaces: ${under}, left without a pond: ${unmatched}`,
);
for (const s of sessions) {
  if (!matchPond(ponds, s, finder))
    console.log("stray:", s.origin, s.repoName ?? "-", s.cwd?.replace(os.homedir(), "~") ?? "-");
}
process.exit(unmatched === 0 ? 0 : 1);
