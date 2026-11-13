import fs from "node:fs";

import Database from "better-sqlite3";

import { NATIVE_HOST_DOWN, NativeHostError, tokenFromFile } from "../native/client.js";
import type { ChatModel } from "./chat-models.js";
import { shrinkWithSips, type Shrink } from "./icon-shrink.js";
import type { NativeRequestSummary } from "./types.js";

/**
 * What the phone can do with Squeak's own (native) chats: see the open approval, plan or question in full, answer
 * it, and start a chat. Reads native.db (read-only, like the fleet observer) for what the phone draws, and asks the
 * session host, the only authority, for what is open when something is acted on. Nothing here trusts the phone.
 */

export const PHONE_NATIVE_CAP = "native";
/** A phone that names this in its presence `caps` reads a chat's `ducklings` (background helpers). */
export const PHONE_DUCKLINGS_CAP = "ducklings";
const PLAN_MAX = 2_000;
const TEXT_MAX = 400;
const OPTION_MAX = 8;
const QUESTION_MAX = 4;
const PROJECTS_MAX = 24;
const WORKSPACES_MAX = 12;
/** Native project icons sent to the phone: at most this many projects, each at most this many base64 characters. */
export const PROJECT_ICONS_MAX = 40;
export const PROJECT_ICON_MAX_CHARS = 24_000;

export interface PhoneNativeQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** The open request as the phone draws it. Every field is a clipped display string, never a whole tool input. */
export interface PhoneNativeRequest {
  id: string;
  kind: NativeRequestSummary["kind"];
  summary: string;
  tool?: string;
  command?: string;
  path?: string;
  plan?: string;
  questions?: PhoneNativeQuestion[];
  /** An allow rule for this chat can be kept ("Allow for this chat"): tool, command and file requests only. */
  chatRule: boolean;
}

export interface NativeWorkspaceChoice {
  id: string;
  name: string;
  /** What the stream is called on screen; a phone that predates titles shows `name`. */
  title?: string;
  branch: string;
}

export interface NativeProjectChoice {
  id: string;
  name: string;
  workspaces: NativeWorkspaceChoice[];
}

/** A project as the Mac knows it, with the folders the phone never sees. */
interface NativeProjectFull extends NativeProjectChoice {
  rootPath: string;
  paths: Map<string, string>;
}

export interface NativeOpenRequest {
  id: string;
  kind: NativeRequestSummary["kind"];
  payload: unknown;
}

export interface NativeRespondBody {
  decision: "allow" | "deny";
  scope?: "session";
  message?: string;
  answers?: Record<string, string>;
}

/** A pond as the phone draws it: names and an online flag only (never keys, invite codes, member ids or emails). */
export interface PhonePond {
  id: string;
  name: string;
  /** A published pond with more than one member; a local pond, or one only its owner is in, is not. */
  shared: boolean;
  /** Only for a shared pond; empty for a local one (the owner is the only one, and the phone knows who that is). */
  members: Array<{ name: string; online: boolean }>;
  /** Sidebar prefs from the host (`project-prefs.json`); only for a pond that follows a native project. */
  hidden?: boolean;
  colour?: string;
  labels?: string[];
  /** The project's streams (workspaces), newest first, `archivedStreams` counted. */
  streams?: PhonePondStream[];
  archivedStreams?: number;
  /** The lower-cased project name chats are matched on (the project's current name, else the pond's). Never sent. */
  match: string;
  /** The native project the pond follows, when it has one: chats match on it before the name. Never sent. */
  projectId?: string;
}

/** A stream (a workspace) of a pond's project, as the phone draws it. `createdAt` is never sent. */
export interface PhonePondStream {
  id: string;
  name: string;
  branch?: string;
  pinned?: true;
  createdAt?: string;
}

/** The sidebar's pond order as the phone reads it: the host's `recent` is the phone's `newest`. */
export interface PhonePondOrder {
  mode: "newest" | "manual";
  ids: string[];
}

/** What a pond's page shows beyond the list: pending invites, people waiting to join, recent activity. */
export interface PhonePondDetail {
  id: string;
  invites?: Array<{ label: string; expiresAt?: string }>;
  waiting?: Array<{ name: string }>;
  ripples?: Array<{ text: string; at: string; who?: string }>;
}

export const PONDS_MAX = 30;
export const POND_STREAMS_MAX = 20;
const POND_RIPPLES_MAX = 20;
const POND_NAME_MAX = 80;
const MEMBER_NAME_MAX = 40;
const MEMBERS_MAX = 12;

export type NativeStartSpec = {
  projectId: string;
  where: "newWorkspace" | "workspace" | "folder";
  workspaceId?: string;
  agent: "claude" | "codex";
  model: string;
  effort?: string;
  permissionMode: string;
  text: string;
};

export const NATIVE_PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;

/** The seam RemoteBridge sees: tests give it fakes, the daemon gives it `NativePhone`. */
export interface RemoteNative {
  /** The open request's display fields for a native session, or null. Sync: read once per phone view. */
  detail(nativeSessionId: string, summary: NativeRequestSummary): PhoneNativeRequest | null;
  /** Projects and their ready workspaces, for the new-chat sheet. Re-read on every command: the phone's copy is never trusted. */
  projects(): NativeProjectFull[];
  models(): ChatModel[];
  /** Whether a phone may start a chat that skips approvals (a Mac-side setting, off by default). */
  allowBypass(): boolean;
  /** The host's own newest open request for the session, or null: the only thing a respond is matched against. */
  currentRequest(nativeSessionId: string): Promise<NativeOpenRequest | null>;
  respond(requestId: string, body: NativeRespondBody): Promise<void>;
  start(spec: NativeStartSpec & { cwd: string }): Promise<{ id: string }>;
  /** The host's ponds for the phone; null when the host is down or Ponds is off. Optional: tests omit it. */
  ponds?(): Promise<PhonePond[] | null>;
  /** Squeak's own project icons, shrunk, by project name and by project id; null when the host cannot say. */
  projectIcons?(): Promise<Record<string, string> | null>;
  /** The sidebar's pond order (`GET /native/pond-order`); null when unknown. Optional: tests omit it. */
  pondOrder?(): Promise<PhonePondOrder | null>;
  /** One pond's page (`GET /native/ponds/<id>`); null when unknown. */
  pondDetail?(pondId: string): Promise<PhonePondDetail | null>;
  /** Hide or show a pond's project in the sidebar (`PATCH /native/projects/<key>/prefs`, what the Mac's Hide does). */
  setPondHidden?(key: string, hidden: boolean): Promise<void>;
  /** `PUT /native/pond-order`: manual with these keys, or back to newest first. */
  setPondOrder?(change: { mode: "newest" } | { ids: string[] }): Promise<void>;
}

export type { NativeProjectFull };

export interface NativePhoneOptions {
  dbPath: string;
  baseUrl: string;
  tokenPath: string;
  models: () => ChatModel[];
  /** `SQUEAK_REMOTE_NATIVE_BYPASS=1` by default. */
  allowBypass?: () => boolean;
  fetch?: typeof fetch;
  /** Shrinks an icon for the phone; `sips` by default. */
  shrink?: Shrink;
}

type Row = Record<string, unknown>;

export class NativePhone implements RemoteNative {
  private readonly token: () => string | null;
  /** Shrunk icons by project id, valid while the host's `iconUpdatedAt` (and size) stay the same. */
  private readonly iconCache = new Map<string, { stamp: string; png: string | null }>();

  constructor(private readonly options: NativePhoneOptions) {
    this.token = tokenFromFile(options.tokenPath);
  }

  allowBypass(): boolean {
    return this.options.allowBypass ? this.options.allowBypass() : process.env.SQUEAK_REMOTE_NATIVE_BYPASS === "1";
  }

  models(): ChatModel[] {
    return this.options.models();
  }

  detail(_nativeSessionId: string, summary: NativeRequestSummary): PhoneNativeRequest | null {
    const row = this.query((db) =>
      db.prepare("SELECT id, kind, payload FROM requests WHERE id = ? AND resolved_at IS NULL").get(summary.id),
    ) as Row | undefined;
    const payload = row ? parsePayload(row.payload) : {};
    return describeRequest(summary, payload);
  }

  projects(): NativeProjectFull[] {
    return (
      this.query((db) => {
        const projects = db
          .prepare("SELECT id, name, root_path FROM projects ORDER BY created_at, id LIMIT ?")
          .all(PROJECTS_MAX) as Row[];
        const workspaces = db.prepare(
          "SELECT * FROM workspaces WHERE project_id = ? AND state = 'ready' ORDER BY created_at DESC, id LIMIT ?",
        );
        return projects.map((project): NativeProjectFull => {
          const rows = workspaces.all(project.id, WORKSPACES_MAX) as Row[];
          return {
            id: project.id as string,
            name: project.name as string,
            rootPath: project.root_path as string,
            workspaces: rows.map((w) => ({
              id: w.id as string,
              name: w.name as string,
              ...(typeof w.title === "string" && w.title.trim() ? { title: w.title.trim() } : {}),
              branch: w.branch as string,
            })),
            paths: new Map(rows.map((w) => [w.id as string, w.path as string])),
          };
        });
      }) ?? []
    );
  }

  async currentRequest(nativeSessionId: string): Promise<NativeOpenRequest | null> {
    const body = await this.call("GET", `/native/sessions/${encodeURIComponent(nativeSessionId)}/requests`);
    const list = Array.isArray(body.requests) ? (body.requests as Array<Record<string, unknown>>) : [];
    const newest = list[list.length - 1];
    if (!newest || typeof newest.id !== "string") return null;
    return { id: newest.id, kind: newest.kind as NativeRequestSummary["kind"], payload: newest.payload };
  }

  async respond(requestId: string, body: NativeRespondBody): Promise<void> {
    await this.call("POST", `/native/requests/${encodeURIComponent(requestId)}`, body);
  }

  async start(spec: NativeStartSpec & { cwd: string }): Promise<{ id: string }> {
    const body = await this.call("POST", "/native/sessions", {
      agent: spec.agent,
      model: spec.model,
      ...(spec.effort ? { effort: spec.effort } : {}),
      permissionMode: spec.permissionMode,
      text: spec.text,
      projectId: spec.projectId,
      ...(spec.where === "newWorkspace"
        ? { newWorkspace: true }
        : { cwd: spec.cwd, ...(spec.workspaceId ? { workspaceId: spec.workspaceId } : {}) }),
    });
    const session = body.session as { id?: unknown } | undefined;
    if (!session || typeof session.id !== "string") throw new NativeHostError("The host did not start a chat.", "http");
    return { id: session.id };
  }

  async projectIcons(): Promise<Record<string, string> | null> {
    let list: Array<Record<string, unknown>>;
    try {
      const body = await this.call("GET", "/native/projects");
      list = Array.isArray(body.projects) ? (body.projects as Array<Record<string, unknown>>) : [];
    } catch {
      return null;
    }
    const shrink = this.options.shrink ?? shrinkWithSips;
    const out: Record<string, string> = {};
    const live = new Set<string>();
    let count = 0;
    for (const project of list) {
      if (count >= PROJECT_ICONS_MAX) break;
      const id = typeof project.id === "string" ? project.id : "";
      if (!id || typeof project.iconUrl !== "string" || typeof project.iconUpdatedAt !== "number") continue;
      live.add(id);
      const stamp = String(project.iconUpdatedAt);
      let entry = this.iconCache.get(id);
      if (entry?.stamp !== stamp) {
        entry = { stamp, png: await this.readIcon(id, shrink) };
        this.iconCache.set(id, entry);
      }
      if (!entry.png) continue;
      count += 1;
      out[id] = entry.png;
      const name = clip(project.name, POND_NAME_MAX);
      if (name) out[name] = entry.png;
    }
    for (const id of [...this.iconCache.keys()]) if (!live.has(id)) this.iconCache.delete(id);
    return out;
  }

  private async readIcon(id: string, shrink: Shrink): Promise<string | null> {
    const token = this.token();
    if (!token) return null;
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.baseUrl}/native/projects/${encodeURIComponent(id)}/icon`,
        { headers: { "x-squeak-token": token }, signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) return null;
      const small = await shrink(Buffer.from(await response.arrayBuffer()));
      if (!small || small.length === 0) return null;
      const png = small.toString("base64");
      return png.length <= PROJECT_ICON_MAX_CHARS ? png : null;
    } catch {
      return null;
    }
  }

  async ponds(): Promise<PhonePond[] | null> {
    let list: Array<Record<string, unknown>>;
    try {
      const body = await this.call("GET", "/native/ponds");
      list = Array.isArray(body.ponds) ? (body.ponds as Array<Record<string, unknown>>) : [];
    } catch {
      return null;
    }
    const names = new Map(this.projects().map((p) => [p.id, p.name]));
    const prefs = await this.projectPrefs();
    const out: PhonePond[] = [];
    for (const pond of list.slice(0, PONDS_MAX)) {
      const id = typeof pond.id === "string" ? pond.id : null;
      const name = clip(pond.name, POND_NAME_MAX);
      if (!id || !name) continue;
      const shared = pond.local !== true && typeof pond.memberCount === "number" && pond.memberCount > 1;
      let members: PhonePond["members"] = [];
      if (shared) {
        try {
          const view = await this.call("GET", `/native/ponds/${encodeURIComponent(id)}`);
          const raw = Array.isArray(view.members) ? (view.members as Array<Record<string, unknown>>) : [];
          members = raw
            .slice(0, MEMBERS_MAX)
            .map((m) => ({ name: clip(m.name, MEMBER_NAME_MAX) ?? "", online: m.online === true }))
            .filter((m) => m.name);
        } catch {
          // Members unknown: the pond is still shared.
        }
      }
      const project = typeof pond.projectId === "string" ? names.get(pond.projectId) : undefined;
      const extras =
        typeof pond.projectId === "string" && pond.projectId
          ? await this.pondExtras(pond.projectId, prefs.get(pond.projectId))
          : {};
      out.push({
        ...extras,
        id,
        name,
        shared,
        members,
        match: (project ?? name).trim().toLowerCase(),
        ...(typeof pond.projectId === "string" && pond.projectId ? { projectId: pond.projectId } : {}),
      });
    }
    return out;
  }

  /** The host's per-project prefs (hidden, colour, labels), by project id; empty when unknown. */
  private async projectPrefs(): Promise<Map<string, Record<string, unknown>>> {
    try {
      const body = await this.call("GET", "/native/projects");
      const list = Array.isArray(body.projects) ? (body.projects as Array<Record<string, unknown>>) : [];
      return new Map(list.flatMap((p) => (typeof p.id === "string" ? [[p.id, p] as const] : [])));
    } catch {
      return new Map();
    }
  }

  /** A project pond's prefs and streams; each part absent when the host cannot say. */
  private async pondExtras(projectId: string, pref: Record<string, unknown> | undefined): Promise<Partial<PhonePond>> {
    const out: Partial<PhonePond> = {};
    if (pref) {
      out.hidden = pref.hidden === true;
      if (typeof pref.colour === "string" && pref.colour) out.colour = pref.colour;
      if (Array.isArray(pref.labels)) {
        const labels = pref.labels.filter((l): l is string => typeof l === "string").slice(0, 8);
        if (labels.length > 0) out.labels = labels;
      }
    }
    try {
      const body = await this.call("GET", `/native/projects/${encodeURIComponent(projectId)}/workspaces`);
      const rows = Array.isArray(body.workspaces) ? (body.workspaces as Array<Record<string, unknown>>) : [];
      const streams: PhonePondStream[] = [];
      let archived = 0;
      // The host lists oldest first; the newest are what a phone opens.
      for (const w of [...rows].reverse()) {
        if (w.state === "archived") {
          archived += 1;
          continue;
        }
        if (w.state !== "ready" || typeof w.id !== "string") continue;
        const name = clip(w.title, POND_NAME_MAX) ?? clip(w.name, POND_NAME_MAX);
        if (!name) continue;
        const branch = clip(w.branch, 120);
        streams.push({
          id: w.id,
          name,
          ...(branch ? { branch } : {}),
          ...(typeof w.createdAt === "string" ? { createdAt: w.createdAt } : {}),
        });
      }
      out.streams = streams.slice(0, POND_STREAMS_MAX);
      out.archivedStreams = archived;
    } catch {
      // Streams unknown: the pond still lists.
    }
    return out;
  }

  async pondOrder(): Promise<PhonePondOrder | null> {
    try {
      const body = await this.call("GET", "/native/pond-order");
      const ids = Array.isArray(body.order) ? body.order.filter((k): k is string => typeof k === "string") : [];
      return { mode: body.mode === "manual" ? "manual" : "newest", ids };
    } catch {
      return null;
    }
  }

  async pondDetail(pondId: string): Promise<PhonePondDetail | null> {
    let view: Record<string, unknown>;
    try {
      view = await this.call("GET", `/native/ponds/${encodeURIComponent(pondId)}`);
    } catch {
      return null;
    }
    const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as never[]) : []);
    const iso = (ms: unknown): string | undefined =>
      typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
    const out: PhonePondDetail = { id: pondId };
    if (Array.isArray(view.invites)) {
      out.invites = list(view.invites)
        .filter((i) => i.state === "pending")
        .map((i) => {
          const expiresAt = iso(i.expiresAt);
          return { label: `${clip(i.role, 20) ?? "member"} invite`, ...(expiresAt ? { expiresAt } : {}) };
        });
    }
    if (Array.isArray(view.joins)) {
      out.waiting = list(view.joins).flatMap((j) => {
        const name = clip(j.name, MEMBER_NAME_MAX);
        return name ? [{ name }] : [];
      });
    }
    if (Array.isArray(view.ripples)) {
      out.ripples = list(view.ripples)
        .flatMap((r) => {
          const text = clip(r.text, 200);
          const at = iso(r.at);
          if (!text || !at) return [];
          const who = clip(r.actorName, MEMBER_NAME_MAX);
          return [{ text, at, ...(who ? { who } : {}) }];
        })
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, POND_RIPPLES_MAX);
    }
    return out;
  }

  async setPondHidden(key: string, hidden: boolean): Promise<void> {
    await this.call("PATCH", `/native/projects/${encodeURIComponent(key)}/prefs`, { hidden });
  }

  async setPondOrder(change: { mode: "newest" } | { ids: string[] }): Promise<void> {
    await this.call(
      "PUT",
      "/native/pond-order",
      "ids" in change ? { mode: "manual", order: change.ids } : { mode: "recent" },
    );
  }

  private query<T>(read: (db: InstanceType<typeof Database>) => T): T | null {
    if (!fs.existsSync(this.options.dbPath)) return null;
    let db: InstanceType<typeof Database>;
    try {
      db = new Database(this.options.dbPath, { readonly: true, fileMustExist: true });
    } catch {
      return null;
    }
    try {
      return read(db);
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = this.token();
    if (!token) throw new NativeHostError(NATIVE_HOST_DOWN, "down");
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}${path}`, {
        method,
        headers: { "x-squeak-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw timedOut
        ? new NativeHostError("Squeak's session host did not answer in time.", "timeout")
        : new NativeHostError(NATIVE_HOST_DOWN, "down");
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      // only the status matters
    }
    if (!response.ok) {
      throw new NativeHostError(
        typeof parsed.error === "string" ? parsed.error : `host answered ${response.status}`,
        "http",
        response.status,
      );
    }
    return parsed;
  }
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The questions an AskUserQuestion carries (`input.questions`), clipped; the shape the phone draws and a respond is checked against. */
export function readQuestions(payload: unknown): PhoneNativeQuestion[] {
  const input = parsePayload(parsePayload(payload).input);
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  const out: PhoneNativeQuestion[] = [];
  for (const item of raw.slice(0, QUESTION_MAX)) {
    const q = parsePayload(item);
    const question = clip(q.question, TEXT_MAX);
    if (!question) continue;
    const options: PhoneNativeQuestion["options"] = [];
    for (const option of (Array.isArray(q.options) ? (q.options as unknown[]) : []).slice(0, OPTION_MAX)) {
      const o = typeof option === "string" ? { label: option } : parsePayload(option);
      const label = clip(o.label, 120);
      if (!label) continue;
      const description = clip(o.description, 200);
      options.push({ label, ...(description ? { description } : {}) });
    }
    const header = clip(q.header, 40);
    out.push({
      question,
      ...(header ? { header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}

export function describeRequest(summary: NativeRequestSummary, payload: Record<string, unknown>): PhoneNativeRequest {
  const input = parsePayload(payload.input);
  const base: PhoneNativeRequest = {
    id: summary.id,
    kind: summary.kind,
    summary: summary.summary,
    chatRule: summary.kind === "tool" || summary.kind === "command" || summary.kind === "file_change",
  };
  if (summary.kind === "plan") {
    const plan = clip(input.plan ?? payload.plan, PLAN_MAX);
    return plan ? { ...base, plan } : base;
  }
  if (summary.kind === "question") {
    return { ...base, questions: readQuestions(payload) };
  }
  if (summary.kind === "command") {
    const command = clip(payload.command ?? payload.cmd, TEXT_MAX);
    return command ? { ...base, command } : base;
  }
  if (summary.kind === "file_change") {
    const path = clip(payload.grantRoot ?? payload.reason, TEXT_MAX);
    return path ? { ...base, path } : base;
  }
  const tool = clip(payload.toolName, 80);
  const command = clip(input.command, TEXT_MAX);
  const path = clip(input.file_path ?? input.path ?? input.url, TEXT_MAX);
  return {
    ...base,
    ...(tool ? { tool } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
  };
}

/**
 * Checks a question answer, given as `[{question: index, picked: label}]`, against the options the host's own
 * request carries, and builds the record the agent reads (`{<question text>: <label>}`). The index must name a
 * question, the label must be one of its options (a multi-select may join labels with ", "), and a question is
 * answered once. The keys are the request's own words, never text from the phone.
 */
export function checkAnswers(
  payload: unknown,
  answers: unknown,
): { ok: true; answers: Record<string, string> } | { ok: false } {
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > QUESTION_MAX) return { ok: false };
  const input = parsePayload(parsePayload(payload).input);
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  const out: Record<string, string> = {};
  for (const item of answers) {
    const a = parsePayload(item);
    if (typeof a.question !== "number" || !Number.isInteger(a.question) || typeof a.picked !== "string") {
      return { ok: false };
    }
    const q = parsePayload(raw[a.question]);
    if (typeof q.question !== "string" || q.question in out) return { ok: false };
    const labels = (Array.isArray(q.options) ? (q.options as unknown[]) : []).map((option) =>
      typeof option === "string" ? option : parsePayload(option).label,
    );
    const fine =
      labels.includes(a.picked) || (q.multiSelect === true && a.picked.split(", ").every((v) => labels.includes(v)));
    if (!fine) return { ok: false };
    out[q.question] = a.picked;
  }
  return { ok: true, answers: out };
}
