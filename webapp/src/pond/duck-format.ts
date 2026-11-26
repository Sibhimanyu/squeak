// A Duck's cloud documents as the browser reads them (twins of `readThread`, `readThreadEvent` and `CommandDoc` in
// src/flotilla/types.ts): the thread (`threads`), its batches of events (`tevents`, `{events: [...]}` under the id
// `<thread>-<first seq>`) and the signed commands a person sends the Owner's Mac (`tcmds`). The web draws the plain events
// (user, agent, tool, question, resolved, changed, approval, state); the host's richer `timeline` events are the Mac's.

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type DuckState = "idle" | "working" | "waiting" | "error";
const STATES: readonly string[] = ["idle", "working", "waiting", "error"];

export interface Duck {
  id: string;
  title: string;
  /** The starter's member id and first name. */
  starter: string;
  starterName: string;
  agent: string;
  state: DuckState;
  private: boolean;
  waitingFor: "approval" | "question" | null;
  /** The request id a Member's browser made this Duck under (a Duck the Owner's Mac started for them). */
  requestId: string | null;
  updatedAt: number;
}

export function readDuck(value: unknown): Duck | null {
  if (!rec(value) || !str(value["id"], 80) || !value["id"] || !str(value["title"], 300)) return null;
  if (!str(value["starter"], 64) || !str(value["starterName"], 100) || !str(value["agent"], 40)) return null;
  if (typeof value["state"] !== "string" || !STATES.includes(value["state"]) || !num(value["updatedAt"])) return null;
  const waiting = value["waitingFor"];
  return {
    id: value["id"],
    title: value["title"],
    starter: value["starter"],
    starterName: value["starterName"],
    agent: value["agent"],
    state: value["state"] as DuckState,
    private: value["private"] === true,
    waitingFor: waiting === "approval" || waiting === "question" ? waiting : null,
    requestId:
      rec(value["requester"]) && str(value["requester"]["requestId"], 80) ? value["requester"]["requestId"] : null,
    updatedAt: value["updatedAt"],
  };
}

export type DuckEvent =
  | { seq: number; at: number; type: "user"; by: string; byName: string | null; text: string }
  | { seq: number; at: number; type: "agent"; text: string }
  | { seq: number; at: number; type: "tool"; label: string; id: string | null; state: "running" | "done" | "error" }
  | { seq: number; at: number; type: "question"; requestId: string; text: string; options: string[] }
  | { seq: number; at: number; type: "approval"; requestId: string; label: string }
  | { seq: number; at: number; type: "resolved"; requestId: string }
  | { seq: number; at: number; type: "changed"; files: number; added: number; removed: number }
  | { seq: number; at: number; type: "state"; state: DuckState };

export function readDuckEvent(v: unknown): DuckEvent | null {
  if (!rec(v) || !num(v["seq"]) || !num(v["at"]) || typeof v["type"] !== "string") return null;
  const base = { seq: v["seq"], at: v["at"] };
  switch (v["type"]) {
    case "user":
      return str(v["by"], 64) && str(v["text"], 20_000)
        ? { ...base, type: "user", by: v["by"], byName: str(v["byName"], 100) ? v["byName"] : null, text: v["text"] }
        : null;
    case "agent":
      return str(v["text"], 20_000) ? { ...base, type: "agent", text: v["text"] } : null;
    case "tool":
      return str(v["label"], 300) && (v["state"] === "running" || v["state"] === "done" || v["state"] === "error")
        ? { ...base, type: "tool", label: v["label"], id: str(v["id"], 100) ? v["id"] : null, state: v["state"] }
        : null;
    case "question":
      return str(v["requestId"], 80) &&
        str(v["text"], 20_000) &&
        Array.isArray(v["options"]) &&
        v["options"].every((o) => str(o, 300))
        ? { ...base, type: "question", requestId: v["requestId"], text: v["text"], options: v["options"] as string[] }
        : null;
    case "approval":
      return str(v["requestId"], 80) && str(v["label"], 300)
        ? { ...base, type: "approval", requestId: v["requestId"], label: v["label"] }
        : null;
    case "resolved":
      return str(v["requestId"], 80) ? { ...base, type: "resolved", requestId: v["requestId"] } : null;
    case "changed":
      return num(v["files"]) && num(v["added"]) && num(v["removed"])
        ? { ...base, type: "changed", files: v["files"], added: v["added"], removed: v["removed"] }
        : null;
    case "state":
      return typeof v["state"] === "string" && STATES.includes(v["state"])
        ? { ...base, type: "state", state: v["state"] as DuckState }
        : null;
    default:
      return null;
  }
}

/** A `tevents` document: `{events: [...]}`. Answers to commands (`{result}`, `{artifacts}`, `{chunk}`) have no `events` and read as none. */
export function readDuckEvents(value: unknown): DuckEvent[] {
  if (!rec(value) || !Array.isArray(value["events"])) return [];
  return value["events"].flatMap((e) => readDuckEvent(e) ?? []);
}

/** The thread a `tevents` document id belongs to: `<thread>-<first seq>`. */
export function threadOfEventDoc(docId: string): string | null {
  const m = /^(.+)-(\d+)$/.exec(docId);
  return m ? m[1]! : null;
}

// ---- Commands a person may send (`COMMAND_KINDS` in types.ts, plus `stop`, which only the Owner sends) ----

export type CommandInput =
  | { kind: "message"; threadId: string; text: string }
  | { kind: "answer"; threadId: string; requestId: string; answer: string }
  | { kind: "stop"; threadId: string };

export const COMMAND_LIFE_MS = 5 * 60_000;

/** The `CommandDoc` the receiving Mac reads: it checks the signature, the role, the expiry and a fresh nonce. */
export function commandDoc(input: CommandInput, id: string, nonce: string, now: number): Record<string, unknown> {
  const base = { id, kind: input.kind, issuedAt: now, expiresAt: now + COMMAND_LIFE_MS, nonce };
  switch (input.kind) {
    case "message":
      return { ...base, threadId: input.threadId, text: input.text };
    case "answer":
      return { ...base, threadId: input.threadId, requestId: input.requestId, answer: input.answer };
    case "stop":
      return { ...base, threadId: input.threadId };
  }
}
