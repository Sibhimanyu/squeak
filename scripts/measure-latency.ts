// How long after Conductor's database says a chat changed does Squeak's /state
// say so too? Purely observational: it opens conductor.db read-only, polls the
// daemon's /state, and sends nothing to any chat.
//
//   npx tsx scripts/measure-latency.ts [--seconds 180] [--poll-ms 100] [--port 8477] [--db <path>]
//
// A transition is a chat whose status moves between "working" (working,
// cancelling, waiting) and "not working". Latency runs from the poll that first
// saw the database change to the poll that first saw /state agree, so it is
// accurate to about one --poll-ms.
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const seconds = Number(arg("seconds", "180"));
const pollMs = Number(arg("poll-ms", "100"));
const port = Number(arg("port", "8477"));
const dbPath = arg("db", path.join(os.homedir(), "Library/Application Support/com.conductor.app/conductor.db"));

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 200");
const statuses = db.prepare("select id, status from sessions where status is not null");

const isWorking = (status: string): boolean => ["working", "cancelling", "waiting"].includes(status);

interface Pending {
  id: string;
  to: boolean; // working?
  from: number;
  /** DB status that triggered it, for the report. */
  status: string;
}

const lastDb = new Map<string, boolean>();
const pending = new Map<string, Pending>();
const results: Array<{ id: string; to: string; ms: number }> = [];

async function readState(): Promise<Map<string, boolean> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as {
      active?: Array<{ conductorSessionId: string | null; state: string }>;
      others?: Array<{ conductorSessionId: string | null; state: string }>;
    };
    const map = new Map<string, boolean>();
    for (const row of [...(body.active ?? []), ...(body.others ?? [])]) {
      if (row.conductorSessionId) {
        map.set(row.conductorSessionId, row.state === "working");
      }
    }
    return map;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  for (const row of statuses.all() as Array<{ id: string; status: string }>) {
    lastDb.set(row.id, isWorking(row.status));
  }
  console.log(`watching ${lastDb.size} chats for ${seconds}s (poll ${pollMs} ms)...`);
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const t = Date.now();
    for (const row of statuses.all() as Array<{ id: string; status: string }>) {
      const working = isWorking(row.status);
      const before = lastDb.get(row.id);
      if (before !== undefined && before !== working) {
        // A newer transition supersedes an unmatched one.
        pending.set(row.id, { id: row.id, to: working, from: t, status: row.status });
      }
      lastDb.set(row.id, working);
    }
    if (pending.size > 0) {
      const state = await readState();
      const seen = Date.now();
      if (state) {
        for (const [id, p] of [...pending]) {
          if (state.get(id) === p.to) {
            pending.delete(id);
            results.push({ id, to: p.status, ms: seen - p.from });
            console.log(`  ${id.slice(0, 8)} -> ${p.status}: /state agreed after ${seen - p.from} ms`);
          }
        }
      }
    }
    await sleep(Math.max(0, pollMs - (Date.now() - t)));
  }

  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${times.length} transitions observed, ${pending.size} never reflected in /state`);
  if (times.length > 0) {
    const median = times[Math.floor((times.length - 1) / 2)]!;
    console.log(`median ${median} ms, max ${times[times.length - 1]} ms, min ${times[0]} ms`);
  }
  db.close();
}

void main();
