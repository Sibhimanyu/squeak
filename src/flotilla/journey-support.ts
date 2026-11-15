import { EventEmitter } from "node:events";

import type { HostEvent } from "../native/host.js";
import type { MessageRow, RequestRow, Resolution, SessionRow } from "../native/types.js";
import type { HostPort } from "./bridge.js";

/** A host double and a session row shared by the multiplayer journeys (fake RTDB and the real relay). */
export class FakeHost extends EventEmitter implements HostPort {
  sessions = new Map<string, SessionRow>();
  messages: MessageRow[] = [];
  requests: RequestRow[] = [];
  sent: Array<{ id: string; text: string; mode: string; author?: { id: string; name: string } }> = [];
  responded: Array<{ requestId: string; resolution: Resolution }> = [];
  notes: string[] = [];
  guest = new Set<string>();
  onEvent(l: (e: HostEvent) => void) {
    this.on("event", l);
    return () => void this.off("event", l);
  }
  getSession = (id: string) => this.sessions.get(id) ?? null;
  messagesAfter = (id: string, seq: number) => this.messages.filter((m) => m.sessionId === id && m.seq > seq);
  openRequests = (id: string) => this.requests.filter((r) => r.sessionId === id && !r.resolvedAt);
  workspace = (id: string) => (id === "w1" ? { name: "ushuaia", branch: "feat/x" } : null);
  async send(id: string, text: string, o: { mode: "queue" | "steer"; author?: { id: string; name: string } }) {
    this.sent.push({ id, text, mode: o.mode, ...(o.author ? { author: o.author } : {}) });
    return { queued: false };
  }
  respond(requestId: string, resolution: Resolution) {
    this.responded.push({ requestId, resolution });
    const r = this.requests.find((x) => x.id === requestId)!;
    r.resolvedAt = "now";
    this.emit("event", { type: "request-resolved", sessionId: r.sessionId, requestId } satisfies HostEvent);
  }
  note(_id: string, text: string) {
    this.notes.push(text);
  }
  setGuestTurn(id: string, on: boolean) {
    if (on) this.guest.add(id);
    else this.guest.delete(id);
  }
  say(sessionId: string, kind: string, payload: unknown, role: "agent" | "user" = "agent") {
    const seq = this.messages.length + 1;
    const createdAt = new Date().toISOString();
    this.messages.push({ seq, sessionId, role, kind, payload, createdAt });
    this.emit("event", { type: "message", sessionId, seq, role, kind, payload, createdAt } satisfies HostEvent);
  }
  ask(sessionId: string, id: string) {
    const row: RequestRow = {
      id,
      sessionId,
      kind: "question",
      payload: {
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which port?", options: [{ label: "3000" }, { label: "4000" }] }] },
      },
      createdAt: "now",
      resolvedAt: null,
      resolution: null,
    };
    this.requests.push(row);
    this.emit("event", { type: "request", sessionId, request: row } satisfies HostEvent);
  }
}

export const session = (id: string, over: Partial<SessionRow> = {}): SessionRow => ({
  id,
  workspaceId: null,
  cwd: "/w",
  agent: "claude",
  agentSessionId: null,
  title: "Fix login",
  model: "m",
  effort: null,
  permissionMode: "default",
  status: "idle",
  createdAt: "",
  updatedAt: "",
  lastTurnEndedAt: null,
  prunedThrough: 0,
  archivedAt: null,
  ...over,
});
