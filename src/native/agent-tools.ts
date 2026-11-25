import type { ShowAck, ShowRequest } from "./show-relay.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";
import {
  MAX_ICON_BYTES,
  POND_COLOUR_NAMES,
  PrefsError,
  readColour,
  readLabels,
  type ProjectPrefs,
} from "./project-prefs.js";
import { addArtboard, CanvasError, createCanvas, readCanvas, resolveCanvasDir, updateArtboard } from "./canvases.js";
import { NOTEBOOK_PER_TASK, NotebookError, PondNotebook } from "./pond-notebook.js";
import { TaskError, type RoomTasks } from "./room-tasks.js";
import { ducksOwnBranch, Placement, PlacementError } from "./placement.js";
import { agentName, projectOfSession, Room, RoomError, ROOM_MAX_TEXT } from "./room.js";
import type { DiffCommentRow, NativeStore } from "./store.js";
import { NO_CHANGES, NO_STREAMS } from "./version-history.js";
import type { AgentKind, SessionRow } from "./types.js";

const run = promisify(execFile);

/**
 * Squeak's own tools for the agents it runs, served as an MCP server (streamable HTTP, JSON responses only) at
 * `/mcp/<session id>` on the host. Each chat gets a token derived from the host's secret and its own id, so an
 * agent can only act as itself; it never sees the control token. Tools are named and worded by Squeak.
 */

export const MCP_SERVER_NAME = "squeak";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const PROTOCOL_VERSION = "2025-06-18";
const MAX_DIFF = 200_000;

export function mcpTokenFor(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(`squeak-mcp-v1:${sessionId}`).digest("base64url");
}

export function mcpTokenValid(secret: string, sessionId: string, provided: string): boolean {
  const want = Buffer.from(mcpTokenFor(secret, sessionId));
  const got = Buffer.from(provided);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** How a runner reaches the tools: what goes into Claude's `mcpServers` and Codex's `mcp_servers`. */
export interface McpEndpoint {
  url: string;
  token: string;
}

/** What the tools need from the host; injected so tests run without agents. */
export interface AgentToolDeps {
  store: NativeStore;
  /** Starts or queues a turn in a chat (the host's `send`). */
  send(sessionId: string, text: string): Promise<{ queued: boolean }>;
  /** A new chat (the host's `create`). */
  create(spec: {
    cwd: string;
    agent: AgentKind;
    model: string;
    permissionMode: string;
    workspaceId: string | null;
    title: string | null;
    text: string;
    effort?: string | null;
    duckId?: string;
  }): Promise<SessionRow>;
  /** A duck showed a file in this pond: the Artifacts tab should look again. */
  artifactShown?(projectId: string): void;
  /** Asks a Squeak window to open a shown file as a tab and waits for its answer (absent: the tool does not wait). */
  openShown?(req: ShowRequest): Promise<ShowAck>;
  /** Persists and broadcasts a message in a chat (the host's message path). */
  post(sessionId: string, kind: string, payload: unknown): void;
  /** The workspace's run script and setup output (the host's own; no interactive terminal). */
  workspaces?: {
    runStatus(workspaceId: string): { running: boolean; logTail: string };
    getLog(workspaceId: string): { state: string; log: string };
  };
  /**
   * Pond upkeep (`pond_appearance`, `set_pond_*`): the sidebar prefs, and a hook that records a Ripple in the pond
   * (absent, or throwing, is logged and never fails the change). Absent: the tools say they are unavailable.
   */
  pond?: {
    prefs: ProjectPrefs;
    ripple?: (projectId: string, projectName: string, text: string, by?: string) => Promise<void> | void;
  };
  /** The pond's room (`post_to_room`, `read_room`, and `send_to_chat` mirrored into it). Absent: those tools say so. */
  room?: Room;
  /** The Pond Notebook (`note_to_notebook`); default: one over the store. */
  notebook?: PondNotebook;
  /** The pond's room jobs (`open_jobs`, `claim_job`). Absent: those tools say so. */
  jobs?: RoomTasks;
  /** Placement for `streams`, `open_stream`, `leave_stream` (flag `ducksOwnBranch`). Absent: those tools say so. */
  placement?: Placement;
  /** Returns a chat whose Stream folder is gone to the Pond (`recover_stream`); the host's own recovery. */
  recoverStream?: (sessionId: string) => Promise<string>;
  now?: () => number;
  /** git, injectable for tests. */
  git?: (cwd: string, args: string[]) => Promise<string>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/**
 * Names and input keys this server used before its tools were renamed. They are still answered (chats begun
 * before the update, prompts people saved) but never listed in `tools/list`.
 */
const LEGACY_TOOLS: Record<string, { name: string; keys?: Record<string, string>; values?: Record<string, string> }> = {
  workspace_diff: { name: "stream_changes", keys: { file: "path", stat: "summaryOnly" } },
  review_comments: { name: "list_review_notes", keys: { file: "path" } },
  add_review_comment: { name: "add_review_note", keys: { file: "path", comment: "text" } },
  resolve_review_comment: { name: "resolve_review_note" },
  notify_user: { name: "page_person" },
  update_progress: { name: "set_progress" },
  set_target_branch: { name: "set_merge_branch" },
  terminal_output: {
    name: "script_output",
    keys: { source: "script", maxLines: "lines" },
    values: { run_script: "run" },
  },
};

function currentToolName(name: string): string {
  return Object.hasOwn(LEGACY_TOOLS, name) ? LEGACY_TOOLS[name]!.name : name;
}

function upgradeLegacyCall(
  name: string,
  args: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } {
  const old = Object.hasOwn(LEGACY_TOOLS, name) ? LEGACY_TOOLS[name] : undefined;
  if (!old) return { name, args };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const key = old.keys?.[k] ?? k;
    out[key] = typeof v === "string" && old.values && Object.hasOwn(old.values, v) ? old.values[v] : v;
  }
  return { name: old.name, args: out };
}

export const TOOLS: ToolDef[] = [
  {
    name: "stream_changes",
    description:
      "All the work in this stream so far, compared with the branch it will merge into: its commits, plus files edited but not committed, plus new files. Reach for it when checking your own work or when the person says 'the diff'. summaryOnly: true lists just the files and counts; path limits it to one file.",
    inputSchema: obj({ path: { type: "string" }, summaryOnly: { type: "boolean" } }),
    readOnly: true,
  },
  {
    name: "list_review_notes",
    description:
      "The unresolved notes left on this stream's changes in Squeak, by the person or by an agent. Read them when asked to act on review feedback. path limits the list to one file.",
    inputSchema: obj({ path: { type: "string" } }),
    readOnly: true,
  },
  {
    name: "add_review_note",
    description:
      "Pin a note to one line of this stream's changes; it appears in Squeak's Changes view. Put review findings here rather than on GitHub, unless asked otherwise. Plain text.",
    inputSchema: obj({ path: { type: "string" }, line: { type: "integer", minimum: 1 }, text: { type: "string" } }, [
      "path",
      "line",
      "text",
    ]),
    readOnly: false,
  },
  {
    name: "resolve_review_note",
    description: "Close a review note (use the id that list_review_notes shows) once you have dealt with it.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    readOnly: false,
  },
  {
    name: "page_person",
    description:
      "Send the person an alert on their Mac and phone. Squeak already tells them when a turn finishes, so call this only when you are stopping because you need them: something to review, or a choice, secret or answer only they have. Once per turn at most, right before you stop.",
    inputSchema: obj({ message: { type: "string" }, title: { type: "string" } }, ["message"]),
    readOnly: false,
  },
  {
    name: "set_progress",
    description:
      "Put a progress strip above this chat's composer while you work through many steps. Each call replaces the previous one, so send everything: short step labels, which one you are on (current), optionally a percent and a one-line status. Send steps: [] when finished or dropped.",
    inputSchema: obj(
      {
        steps: { type: "array", items: { type: "string" } },
        current: { type: "integer", minimum: 0 },
        percent: { type: "number", minimum: 0, maximum: 100 },
        status: { type: "string" },
      },
      ["steps"],
    ),
    readOnly: false,
  },
  {
    name: "show_image",
    description:
      "Show the person a picture in this chat: a card with a thumbnail and your caption that opens in an image tab. Use it when they ask to see an image, screenshot, chart or diagram, instead of describing it. path is a PNG, JPEG, GIF, WebP, HEIC, SVG or PDF file (up to 25 MB) in this chat's folder, its project or the system temp folder.",
    inputSchema: obj({ path: { type: "string" }, caption: { type: "string" } }, ["path"]),
    readOnly: false,
  },
  {
    name: "show",
    description:
      "Open a file from this chat's folder in the person's Squeak window as a file tab: a page, diagram, document or preview you wrote. HTML and Markdown show as pages. Write the file in the workspace first, then call show with its path. Never use claude.ai artifacts.",
    inputSchema: obj({ path: { type: "string" }, title: { type: "string" } }, ["path"]),
    readOnly: false,
  },
  {
    name: "canvas_create",
    description:
      "Create a canvas (artboards for slides, a poster, logo sheet or social post) in this chat's folder under canvases/. kind is deck, poster, logo, social or blank; it starts with one artboard (a title slide for a deck). Returns the canvas path. Then add or change artboards with canvas_add_artboard and canvas_update_artboard, and canvas_open to show it.",
    inputSchema: obj(
      { title: { type: "string" }, kind: { type: "string", enum: ["deck", "poster", "logo", "social", "blank"] } },
      ["title"],
    ),
    readOnly: false,
  },
  {
    name: "canvas_add_artboard",
    description:
      "Add an artboard to a canvas. canvas is the path returned by canvas_create or its short name. html is the whole artboard: self-contained HTML/CSS (inline SVG allowed) whose body is exactly width x height pixels (the canvas's last artboard size when you omit them), text kept as real text, images from the canvas's assets/ folder by relative path, no network assets except web fonts.",
    inputSchema: obj(
      {
        canvas: { type: "string" },
        name: { type: "string" },
        width: { type: "integer", minimum: 16, maximum: 8000 },
        height: { type: "integer", minimum: 16, maximum: 8000 },
        html: { type: "string" },
      },
      ["canvas", "name", "html"],
    ),
    readOnly: false,
  },
  {
    name: "canvas_update_artboard",
    description:
      "Change an artboard of a canvas: its html (the whole file again, same rules as canvas_add_artboard) and/or its name and size. id is the artboard id from canvas_add_artboard or the canvas's canvas.json. The open canvas redraws that artboard by itself.",
    inputSchema: obj(
      {
        canvas: { type: "string" },
        id: { type: "string" },
        html: { type: "string" },
        name: { type: "string" },
        width: { type: "integer", minimum: 16, maximum: 8000 },
        height: { type: "integer", minimum: 16, maximum: 8000 },
      },
      ["canvas", "id"],
    ),
    readOnly: false,
  },
  {
    name: "canvas_open",
    description: "Open a canvas in the person's Squeak window as a tab. canvas is its path or short name.",
    inputSchema: obj({ canvas: { type: "string" } }, ["canvas"]),
    readOnly: false,
  },
  {
    name: "set_merge_branch",
    description:
      "Pick a different branch for this stream to merge into; its changes and new pull requests are measured against it. Give the name as it is on origin, without 'origin/', and fetch it first. Nothing is rebased.",
    inputSchema: obj({ branch: { type: "string" } }, ["branch"]),
    readOnly: false,
  },
  {
    name: "list_chats",
    description:
      "The other Squeak chats on this Mac: id, title, folder, agent and whether it is working. Use it to find a chat to ask or hand work to.",
    inputSchema: obj({ sameProject: { type: "boolean" } }),
    readOnly: true,
  },
  {
    name: "read_chat",
    description: "The latest messages of another Squeak chat (by id from list_chats), text only, newest last.",
    inputSchema: obj({ chatId: { type: "string" }, last: { type: "integer", minimum: 1, maximum: 20 } }, ["chatId"]),
    readOnly: true,
  },
  {
    name: "send_to_chat",
    description:
      "Send a message to another Squeak chat, as a new turn there (queued if it is busy). The person sees it, marked as from you. Use it to ask another agent something or hand over work; then read_chat later for its answer. Limited to a few messages per chat per hour.",
    inputSchema: obj({ chatId: { type: "string" }, message: { type: "string" } }, ["chatId", "message"]),
    readOnly: false,
  },
  {
    name: "post_to_room",
    description:
      'Write a message in this pond\'s room, the shared chat the person and the other chats read. Use kind message. Write one when you finish a task from the room, and when someone in the room asked you something: two or three plain sentences saying what you did, what you found, and what you need from the reader (leave that out if nothing). Start with the substance, with no greeting or preamble, and never paste tool output, logs or code; the details are in your chat, which the reader can open from your message. A "took it" or "finished" line is not needed: the room already shows the task moving. Other kinds: needs (you are blocked and need the person; say what you need), handoff (you are passing work on; name the chat in toChatId), plan (a spec and plan card, only for a task that is more than small: text is its title, detail the spec and plan; people comment on it and you get the comments at your next turn). done and working still post, but the room shows only what a person would read, so prefer a message. level: room (default, what the person sees) or agents (coordination the person need not see; shown collapsed). At most 500 characters of text, 4000 of detail; 30 posts per chat per hour. In a pond nobody else reads, status lines are skipped and you are told so.',
    inputSchema: obj(
      {
        text: { type: "string" },
        kind: { type: "string", enum: ["working", "done", "needs", "handoff", "message", "plan"] },
        detail: { type: "string" },
        level: { type: "string", enum: ["room", "agents"] },
        toChatId: { type: "string" },
      },
      ["text", "kind"],
    ),
    readOnly: false,
  },
  {
    name: "hand_off",
    description:
      'Give a piece of work to another duck in this pond, as a sub-task of the one you are on, visible in the room. toDuck: the duck\'s name; Squeak posts "@Name <text>" and gives it straight to that duck (it is woken, nothing decides). Leave toDuck out for a task nobody in particular should take: Squeak decides who does it, and may hatch a new duck. text: what to do, in one self-contained paragraph (at most 500 characters). A plain @mention in post_to_room only nudges a duck; hand_off gives it work.',
    inputSchema: obj({ text: { type: "string" }, toDuck: { type: "string" } }, ["text"]),
    readOnly: false,
  },
  {
    name: "read_room",
    description:
      "The newest posts in this pond's room (what each chat is working on, what the person said) and who is working on what now. Read it before touching an area another chat may be in. last: 1 to 50 posts (20 by default); level: room, agents or all (default).",
    inputSchema: obj({
      last: { type: "integer", minimum: 1, maximum: 50 },
      level: { type: "string", enum: ["room", "agents", "all"] },
    }),
    readOnly: true,
  },
  {
    name: "note_to_notebook",
    description:
      "Add a lesson to the pond's shared Notebook, which every duck reads when it takes a task. Only at the very end of the task you took from the room, and only a lesson that will last (a command that must run, a trap, a convention); never a log of what you did. Pass taskDone true to say the task is finished. Refused when you have no task from the room, mid-task, or past a few lessons per task. One short sentence each, 300 characters at most.",
    inputSchema: obj({ lesson: { type: "string" }, taskDone: { type: "boolean" } }, ["lesson", "taskDone"]),
    readOnly: false,
  },
  {
    name: "open_jobs",
    description:
      "Jobs the person has asked for in this pond's room that nobody has taken and that fit what you work on, with their ids and why. Call it near the end of a turn. Never start a job from it: use claim_job to ask, then wait for the person to allow it.",
    inputSchema: obj({}),
    readOnly: true,
  },
  {
    name: "claim_job",
    description:
      'Ask the person to let you take one open job (from open_jobs), with a rough eta such as "10 min". This only asks; it starts nothing. Do the job only if the person then sends it to you as a message. One chat can hold a job\'s claim at a time.',
    inputSchema: obj({ jobId: { type: "string" }, eta: { type: "string" } }, ["jobId"]),
    readOnly: false,
  },
  {
    name: "start_chat",
    description:
      "Start a new Squeak chat in this same folder with its own agent, for a parallel task the person can watch and steer. Returns its id; use read_chat for progress. Prefer a duckling (your own helper) for short internal work.",
    inputSchema: obj(
      {
        message: { type: "string" },
        title: { type: "string" },
        agent: { type: "string", enum: ["claude", "codex"] },
        model: { type: "string" },
      },
      ["message"],
    ),
    readOnly: false,
  },
  {
    name: "script_output",
    description:
      "What this stream's own scripts have printed: the run script (started from Squeak's Run button, running or last run) and the setup script's log. Squeak's terminal panel and commands you ran yourself are not included; your own Bash output covers those. script: run, setup or auto (default: run if it printed, else setup). lines: how many of the newest lines, 1000 by default.",
    inputSchema: obj({
      script: { type: "string", enum: ["run", "setup", "auto"] },
      lines: { type: "integer", minimum: 1, maximum: 5000 },
    }),
    readOnly: true,
  },
  {
    name: "pond_appearance",
    description:
      "How this chat's pond (project) looks in Squeak's sidebar: its name, colour, the palette of colours it may take, its labels and whether it has an icon. Read it before changing anything. Only for the pond this chat belongs to.",
    inputSchema: obj({}),
    readOnly: true,
  },
  {
    name: "set_pond_icon",
    description:
      "Set this pond's icon from a PNG or JPEG file inside this chat's own folder (at most 512 KB; Squeak shrinks it to 256 px). Use an existing logo from the repository. Only when the person asks.",
    inputSchema: obj({ path: { type: "string" } }, ["path"]),
    readOnly: false,
  },
  {
    name: "set_pond_colour",
    description:
      "Set this pond's colour to a name from pond_appearance's palette, or \"default\" to go back to the automatic colour. Only when the person asks.",
    inputSchema: obj({ colour: { type: "string" } }, ["colour"]),
    readOnly: false,
  },
  {
    name: "set_pond_labels",
    description:
      "Replace this pond's labels (at most 8, 1 to 24 characters each, unique ignoring case; [] clears them). Only when the person asks.",
    inputSchema: obj({ labels: { type: "array", items: { type: "string" } } }, ["labels"]),
    readOnly: false,
  },
];

/**
 * Streams (flag `ducksOwnBranch`, docs/adr/0003): a Duck starts in the project's main folder, which is read-only, and
 * opens or joins branches with their own working copies to edit. Listed (and answered) only while the flag is on. The
 * descriptions use plain words (branch, working copy, other agents): they are read by whatever agent runs here.
 */
export const PLACEMENT_TOOLS: ToolDef[] = [
  {
    name: "streams",
    description:
      "List the branches of this project that have their own working copy, with the folder of each and which agents are working in it, and the ones you are in. Your own folder is the project's main folder and is read-only: to change files, open a branch with open_stream.",
    inputSchema: obj({}),
    readOnly: true,
  },
  {
    name: "open_stream",
    description:
      "Create or join a branch with its own working copy so you can edit files; the main folder is read-only. name: a short name for the work (joins the branch called that if there is one, else creates it). branch: an exact branch name instead (joins it, opens it if it only exists in git, else creates it). from: the branch to branch off when creating (default: the default branch). Returns the folder. Edit files there by their full path, and run commands from that folder. You can be in several branches at once.",
    inputSchema: obj({ name: { type: "string" }, branch: { type: "string" }, from: { type: "string" } }),
    readOnly: false,
  },
  {
    name: "leave_stream",
    description:
      "Leave a branch you opened or joined with open_stream, so other agents can see you are no longer working in it. name: its branch or name (optional when you are in just one). Nothing is deleted; the branch and its changes stay.",
    inputSchema: obj({ name: { type: "string" } }),
    readOnly: false,
  },
  {
    name: "recover_stream",
    description:
      "Carry on when a duck's Stream folder has been removed from disk (it cannot run there): the duck returns to the pond's own folder (read-only), keeping its chat and history; the Stream is made again when it next joins its branch. duck: a duck's name or id in this pond (default: yourself).",
    inputSchema: obj({ duck: { type: "string" } }),
    readOnly: false,
  },
];

const PLACEMENT_NAMES = new Set([...PLACEMENT_TOOLS.map((t) => t.name), "branch_off", "join_branch", "move_to_main"]);

const READ_ONLY = new Set([...TOOLS, ...PLACEMENT_TOOLS].filter((t) => t.readOnly).map((t) => t.name));

/** Tools any chat may call without asking the person: they read, or only write into Squeak itself. */
export function isSqueakTool(toolName: string): boolean {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return false;
  const name = currentToolName(toolName.slice(MCP_TOOL_PREFIX.length));
  return TOOLS.some((t) => t.name === name) || PLACEMENT_NAMES.has(name);
}
export function isReadOnlySqueakTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX) && READ_ONLY.has(currentToolName(toolName.slice(MCP_TOOL_PREFIX.length)));
}

export class ToolError extends Error {}

/** Agent-to-agent limits: per sender, per target per hour, and how many chats one chat may start. */
export const LIMITS = {
  perTargetPerHour: 6,
  perSenderPerHour: 30,
  startsPerHour: 5,
  maxMessage: 20_000,
  pondChangesPerHour: 10,
  imagesPerHour: 30,
  streamsPerHour: 5,
};

export const SHOW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg", ".pdf"]);
export const MAX_SHOW_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SHOW_IMAGE_BYTES = 25 * 1024 * 1024;

const textOf = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.text === "string") return p.text;
  // Claude SDK assistant message
  const message = p.message as { content?: unknown } | undefined;
  if (Array.isArray(message?.content)) {
    const parts = message.content
      .filter((c): c is { type: string; text: string } => (c as { type?: string }).type === "text")
      .map((c) => c.text);
    return parts.length ? parts.join("\n") : null;
  }
  // Codex agentMessage item
  const item = p.item as { type?: string; text?: string } | undefined;
  if (item?.type === "agentMessage" && typeof item.text === "string") return item.text;
  return null;
};

/** The listed numeric args that were given as numbers. */
function numberArgs<K extends string>(args: Record<string, unknown>, keys: K[]): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const k of keys) if (typeof args[k] === "number") out[k] = args[k] as number;
  return out;
}

export class AgentTools {
  private readonly sent: { from: string; to: string; at: number }[] = [];
  private readonly starts: { from: string; at: number }[] = [];
  private readonly pondChanges: { from: string; at: number }[] = [];
  private readonly shown: { from: string; at: number }[] = [];
  private readonly now: () => number;
  private readonly git: (cwd: string, args: string[]) => Promise<string>;

  constructor(private readonly deps: AgentToolDeps) {
    this.now = deps.now ?? Date.now;
    this.git =
      deps.git ??
      (async (cwd, args) => (await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })).stdout);
  }

  private session(id: string): SessionRow {
    const s = this.deps.store.getSession(id);
    if (!s) throw new ToolError("This chat no longer exists.");
    return s;
  }

  private workspaceKey(s: SessionRow): string {
    return s.workspaceId ?? `cwd:${s.cwd}`;
  }

  /** The branch the chat's work merges into, as a ref git can read. */
  private async baseRef(s: SessionRow): Promise<string> {
    const { store } = this.deps;
    const ws = s.workspaceId ? store.getWorkspace(s.workspaceId) : null;
    // Main (the pond's own folder, no stream): its changes are what is uncommitted there.
    if (!ws && this.inMain(s)) return "HEAD";
    const project = ws ? store.getProject(ws.projectId) : null;
    const branch = (ws && store.getTargetBranch(ws.id)) || project?.defaultBranch || "main";
    for (const ref of [`origin/${branch}`, branch]) {
      try {
        return (await this.git(s.cwd, ["merge-base", "HEAD", ref])).trim();
      } catch {
        // try the next spelling
      }
    }
    throw new ToolError(`Couldn't find the target branch ${branch} in this repository.`);
  }

  async call(sessionId: string, calledName: string, calledArgs: Record<string, unknown>): Promise<string> {
    const s = this.session(sessionId);
    const { name, args } = upgradeLegacyCall(calledName, calledArgs);
    const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    switch (name) {
      case "stream_changes":
        return this.diff(s, str("path"), args.summaryOnly === true);
      case "list_review_notes": {
        const rows = this.deps.store.diffComments(this.workspaceKey(s), str("path"));
        if (rows.length === 0) return "No open review notes.";
        return rows.map((c: DiffCommentRow) => `[${c.id}] ${c.file}:${c.line} (${c.author})\n${c.body}`).join("\n\n");
      }
      case "add_review_note": {
        const file = str("path");
        const line = args.line;
        const body = str("text");
        if (!file || !body || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
          throw new ToolError("path, a line number from 1 and text are required.");
        }
        const row = this.deps.store.addDiffComment({
          workspaceKey: this.workspaceKey(s),
          sessionId: s.id,
          file,
          line,
          body: body.slice(0, 4000),
          author: `agent:${s.id}`,
        });
        this.deps.post(s.id, "squeak/review-comment", { id: row.id, file, line, text: row.body });
        return `Note ${row.id} pinned to ${file}:${line}.`;
      }
      case "resolve_review_note": {
        const id = str("id");
        if (!id || !this.deps.store.resolveDiffComment(this.workspaceKey(s), id)) {
          throw new ToolError("No open note with that id in this stream.");
        }
        return "Resolved.";
      }
      case "page_person": {
        const message = str("message");
        if (!message) throw new ToolError("message is required.");
        this.deps.post(s.id, "squeak/notify", {
          title: str("title")?.slice(0, 120) ?? null,
          text: message.slice(0, 1000),
        });
        return "The person was notified.";
      }
      case "set_progress": {
        const steps = Array.isArray(args.steps) ? args.steps.filter((x): x is string => typeof x === "string") : null;
        if (!steps) throw new ToolError("steps must be a list of short labels ([] to clear).");
        const current = typeof args.current === "number" ? Math.max(0, Math.min(steps.length - 1, args.current)) : 0;
        const percent = typeof args.percent === "number" ? Math.max(0, Math.min(100, args.percent)) : null;
        this.deps.post(s.id, "squeak/progress", {
          steps: steps.slice(0, 12).map((x) => x.slice(0, 40)),
          current: steps.length ? current : null,
          percent,
          status: str("status")?.slice(0, 200) ?? null,
        });
        return steps.length ? `Progress strip set: step ${current + 1} of ${steps.length}.` : "Progress strip removed.";
      }
      case "show_image": {
        const file = str("path");
        if (!file) throw new ToolError("path is required.");
        this.prune();
        if (this.shown.filter((x) => x.from === s.id).length >= LIMITS.imagesPerHour) {
          throw new ToolError("This chat showed enough images this hour.");
        }
        const { real, size } = this.imageToShow(s, file);
        this.shown.push({ from: s.id, at: this.now() });
        this.deps.post(s.id, "squeak/image", {
          path: real,
          name: path.basename(real),
          caption: str("caption")?.trim().slice(0, 300) || null,
          bytes: size,
        });
        return `Showing ${path.basename(real)} to the person.`;
      }
      case "show": {
        const file = str("path");
        if (!file) throw new ToolError("path is required.");
        this.prune();
        if (this.shown.filter((x) => x.from === s.id).length >= LIMITS.imagesPerHour) {
          throw new ToolError("This chat showed enough files this hour.");
        }
        const { real, relative, size } = this.fileToShow(s, file);
        this.shown.push({ from: s.id, at: this.now() });
        const shownPath = path.join(s.cwd, relative);
        const pond = this.pondOf(s);
        if (pond) {
          // The Artifacts tab lists what ducks showed; a failed note must never fail the show itself.
          try {
            const duck = this.deps.store.duckBySession(s.id);
            this.deps.store.recordShownArtifact({
              projectId: pond.id,
              path: shownPath,
              duckId: duck?.id ?? s.duckId ?? null,
              sessionId: s.id,
              branch: s.branch ?? duck?.branch ?? null,
              at: this.now(),
            });
            this.deps.artifactShown?.(pond.id);
          } catch {
            /* best effort */
          }
        }
        const title = str("title")?.trim().slice(0, 200) || null;
        this.deps.post(s.id, "squeak/show", {
          path: shownPath,
          relative,
          name: path.basename(real),
          title,
          bytes: size,
        });
        return this.openedMessage(
          path.basename(real),
          await this.askToOpen(s, pond?.id ?? null, shownPath, relative, title),
        );
      }
      case "canvas_create": {
        const title = str("title")?.trim();
        if (!title) throw new ToolError("title is required.");
        const made = this.canvasOp(() => createCanvas(s.cwd, title, str("kind")));
        this.noteCanvasChanged(s, made.path);
        return `Created canvas "${made.canvas.title}" (${made.canvas.kind}) at ${made.path}. Its artboard ids: ${made.artboards.map((a) => a.id).join(", ")}. Files: artboards/<id>.html. Open it with canvas_open.`;
      }
      case "canvas_add_artboard": {
        const dir = this.canvasDirOf(s, str("canvas"));
        const name = str("name");
        const html = str("html");
        if (!name || html === undefined) throw new ToolError("name and html are required.");
        const board = this.canvasOp(() => addArtboard(dir, { name, html, ...numberArgs(args, ["width", "height"]) }));
        this.noteCanvasChanged(s, dir);
        return `Added artboard ${board.id} (${board.width}x${board.height}) to the canvas.`;
      }
      case "canvas_update_artboard": {
        const dir = this.canvasDirOf(s, str("canvas"));
        const id = str("id");
        if (!id) throw new ToolError("id is required.");
        const html = str("html");
        const name = str("name");
        const board = this.canvasOp(() =>
          updateArtboard(dir, id, {
            ...(html !== undefined ? { html } : {}),
            ...(name !== undefined ? { name } : {}),
            ...numberArgs(args, ["width", "height"]),
          }),
        );
        this.noteCanvasChanged(s, dir);
        return `Updated artboard ${board.id} (${board.width}x${board.height}).`;
      }
      case "canvas_open": {
        const dir = this.canvasDirOf(s, str("canvas"));
        const detail = this.canvasOp(() => readCanvas(dir));
        const relative = path.relative(fs.realpathSync(s.cwd), dir);
        const shownPath = path.join(s.cwd, relative);
        const pond = this.pondOf(s);
        if (pond) {
          try {
            const duck = this.deps.store.duckBySession(s.id);
            this.deps.store.recordShownArtifact({
              projectId: pond.id,
              path: shownPath,
              duckId: duck?.id ?? s.duckId ?? null,
              sessionId: s.id,
              branch: s.branch ?? duck?.branch ?? null,
              at: this.now(),
            });
            this.deps.artifactShown?.(pond.id);
          } catch {
            /* best effort */
          }
        }
        this.deps.post(s.id, "squeak/show", {
          path: shownPath,
          relative,
          name: path.basename(dir),
          title: detail.canvas.title,
          bytes: 0,
        });
        return this.openedMessage(
          `canvas "${detail.canvas.title}"`,
          await this.askToOpen(s, pond?.id ?? null, shownPath, relative, detail.canvas.title),
        );
      }
      case "set_merge_branch": {
        const branch = str("branch")?.replace(/^origin\//, "");
        if (!branch || !/^[\w./-]+$/.test(branch) || branch.includes("..")) throw new ToolError("Not a branch name.");
        if (this.inFolderPond(s)) throw new ToolError(NO_STREAMS);
        if (!s.workspaceId && this.inMain(s)) {
          throw new ToolError("This chat is in Main, the pond's own folder, which has no target branch. Streams do.");
        }
        if (!s.workspaceId) throw new ToolError("This chat is not in a Squeak stream, so it has no target branch.");
        try {
          await this.git(s.cwd, ["rev-parse", "--verify", "--quiet", `origin/${branch}^{commit}`]);
        } catch {
          throw new ToolError(`origin/${branch} doesn't exist here; run git fetch origin ${branch} first.`);
        }
        this.deps.store.setTargetBranch(s.workspaceId, branch);
        this.deps.post(s.id, "squeak/target-branch", { text: `Target branch set to ${branch}`, branch });
        return `This stream now merges into ${branch}.`;
      }
      case "list_chats":
        return this.listChats(s, args.sameProject === true);
      case "read_chat":
        return this.readChat(s, str("chatId"), typeof args.last === "number" ? args.last : 4);
      case "send_to_chat":
        return this.sendToChat(s, str("chatId"), str("message"));
      case "start_chat":
        return this.startChat(s, args);
      case "post_to_room":
        return this.postToRoom(s, args);
      case "hand_off":
        return this.handOff(s, args);
      case "read_room":
        return this.readRoom(s, args);
      case "note_to_notebook":
        return this.noteToNotebook(s, args);
      case "open_jobs":
        return this.openJobs(s);
      case "claim_job":
        return this.claimJob(s, args);
      case "streams":
      case "open_stream":
      case "leave_stream":
      case "branch_off":
      case "join_branch":
      case "move_to_main":
        return this.placeTool(s, name, args);
      case "recover_stream":
        return this.recoverStreamTool(s, args);
      case "script_output":
        return this.terminalOutput(s, str("script"), args.lines);
      case "pond_appearance":
      case "set_pond_icon":
      case "set_pond_colour":
      case "set_pond_labels":
        return this.pondTool(s, name, args);
      default:
        throw new ToolError(`Unknown tool ${name}.`);
    }
  }

  /** A chat in a plain-folder pond's own folder: no workspace, no repository. */
  private inFolderPond(s: SessionRow): boolean {
    return !s.workspaceId && this.deps.store.getProjectByRoot(s.cwd)?.kind === "folder";
  }

  /** A chat in a git pond's own folder: Main. */
  private inMain(s: SessionRow): boolean {
    return !s.workspaceId && this.deps.store.getProjectByRoot(s.cwd)?.kind === "git";
  }

  private async diff(s: SessionRow, file: string | undefined, stat: boolean): Promise<string> {
    if (this.inFolderPond(s)) return NO_CHANGES;
    const base = await this.baseRef(s);
    const paths = file ? ["--", file] : [];
    if (stat) {
      const tracked = await this.git(s.cwd, ["diff", "--stat", base, ...paths]);
      const untracked = (await this.git(s.cwd, ["ls-files", "--others", "--exclude-standard", ...paths])).trim();
      const extra = untracked ? `\nUntracked:\n${untracked}` : "";
      return (tracked.trim() || "No tracked changes.") + extra;
    }
    let out = await this.git(s.cwd, ["diff", base, ...paths]);
    const untracked = (await this.git(s.cwd, ["ls-files", "--others", "--exclude-standard", ...paths]))
      .split("\n")
      .filter(Boolean);
    for (const f of untracked) {
      if (out.length > MAX_DIFF) break;
      try {
        out += await this.git(s.cwd, ["diff", "--no-index", "--", "/dev/null", f]);
      } catch (error) {
        // --no-index exits 1 when the files differ, which for a new file is always; stdout is the answer.
        out += (error as { stdout?: string }).stdout ?? "";
      }
    }
    if (!out.trim()) return "No changes against the target branch.";
    return out.length > MAX_DIFF
      ? `${out.slice(0, MAX_DIFF)}\n… (cut at ${MAX_DIFF} characters; ask for one path or summaryOnly: true)`
      : out;
  }

  private terminalOutput(s: SessionRow, script: string | undefined, maxLinesArg: unknown): string {
    const ws = this.deps.workspaces;
    if (!ws || !s.workspaceId)
      throw new ToolError("This chat is not in a Squeak stream, so it has no scripts' output.");
    if (script !== undefined && script !== "run" && script !== "setup" && script !== "auto") {
      throw new ToolError("script is run, setup or auto.");
    }
    const maxLines =
      typeof maxLinesArg === "number" && Number.isInteger(maxLinesArg) && maxLinesArg > 0
        ? Math.min(maxLinesArg, 5000)
        : 1000;
    const lastLines = (text: string): string => text.trimEnd().split("\n").slice(-maxLines).join("\n");
    const run = (): string => {
      const r = ws.runStatus(s.workspaceId!);
      return r.logTail.trim() ? `Run script (${r.running ? "running" : "last run"}):\n${lastLines(r.logTail)}` : "";
    };
    const setup = (): string => {
      const r = ws.getLog(s.workspaceId!);
      return r.log.trim() ? `Setup script (stream ${r.state}):\n${lastLines(r.log)}` : "";
    };
    const chosen = script === "setup" ? setup() : script === "run" ? run() : run() || setup();
    return (
      chosen ||
      "Nothing printed yet. This covers only the run script and the setup script, not the terminal panel or your own commands."
    );
  }

  private projectOf(s: SessionRow): string | null {
    return s.workspaceId ? (this.deps.store.getWorkspace(s.workspaceId)?.projectId ?? null) : null;
  }

  /** The pond (project) this chat belongs to: its workspace's project, else the project whose folder it runs in. */
  private pondOf(s: SessionRow): { id: string; name: string } | null {
    return projectOfSession(this.deps.store, s);
  }

  private roomOf(): Room {
    if (!this.deps.room) throw new ToolError("The room isn't available here.");
    return this.deps.room;
  }

  private postToRoom(s: SessionRow, args: Record<string, unknown>): string {
    const room = this.roomOf();
    const mine = this.pondOf(s);
    if (!mine) throw new ToolError("This chat isn't in a pond, so it has no room to post to.");
    const kind = args.kind;
    if (
      kind !== "working" &&
      kind !== "done" &&
      kind !== "needs" &&
      kind !== "handoff" &&
      kind !== "message" &&
      kind !== "plan"
    ) {
      throw new ToolError("kind must be working, done, needs, handoff, plan or message.");
    }
    if (args.detail !== undefined && typeof args.detail !== "string") throw new ToolError("detail must be text.");
    const level = args.level === undefined ? "room" : args.level;
    if (level !== "room" && level !== "agents") throw new ToolError("level must be room or agents.");
    let toSessionId: string | undefined;
    if (args.toChatId !== undefined) {
      if (typeof args.toChatId !== "string") throw new ToolError("toChatId must be a chat id.");
      const target = this.deps.store.getSession(args.toChatId);
      const there = target ? this.pondOf(target) : null;
      if (!target || there?.id !== mine.id) throw new ToolError("toChatId must be a chat in this pond.");
      toSessionId = target.id;
    }
    let row: ReturnType<Room["agentPost"]>;
    try {
      row = room.agentPost(s, {
        kind,
        level,
        text: args.text as string,
        ...(typeof args.detail === "string" ? { detail: args.detail } : {}),
        ...(toSessionId ? { toSessionId } : {}),
      });
    } catch (error) {
      if (error instanceof RoomError) throw new ToolError(error.message);
      throw error;
    }
    if (!row) {
      return "Not posted: nobody else reads this pond's room right now (it isn't shared and no other duck is working), so status lines are skipped. Carry on; post when that changes.";
    }
    return level === "agents" ? "Posted to the agents level of the room." : "Posted to the room.";
  }

  private handOff(s: SessionRow, args: Record<string, unknown>): string {
    const { jobs, pond } = this.jobsOf(s);
    const room = this.roomOf();
    if (typeof args.text !== "string" || !args.text.trim()) throw new ToolError("text is required.");
    if (args.toDuck !== undefined && (typeof args.toDuck !== "string" || !args.toDuck.trim())) {
      throw new ToolError("toDuck must be a duck's name.");
    }
    let target: ReturnType<typeof this.deps.store.listDucks>[number] | undefined;
    if (typeof args.toDuck === "string") {
      const want = args.toDuck.trim().replace(/^@/, "").toLowerCase();
      target = this.deps.store.listDucks(pond.id).find((d) => d.name?.toLowerCase() === want);
      if (!target?.name) throw new ToolError(`No duck named ${args.toDuck.trim()} in this pond.`);
      if (target.currentSessionId === s.id) throw new ToolError("That is you: do the work yourself.");
      if (target.duty === "off") throw new ToolError(`${target.name} is off duty; hand the work to someone else.`);
    }
    const body = args.text.trim();
    const parent = jobs.currentFor(s.id);
    let row: ReturnType<Room["agentPost"]>;
    try {
      row = room.agentPost(s, {
        kind: "message",
        text: target ? `@${target.name} ${body}` : body,
        noWake: true,
      });
      if (!row) throw new ToolError("Could not post the hand-off.");
      if (target) {
        jobs.handOff(pond.id, row.id, target.id, {
          text: body,
          ...(parent ? { parentTaskId: parent.id } : {}),
          reason: `${agentName(s)} handed it over`,
        });
      } else {
        jobs.fromMessage(pond.id, row.id, parent?.id);
      }
    } catch (error) {
      if (error instanceof RoomError || error instanceof TaskError) throw new ToolError(error.message);
      throw error;
    }
    return target
      ? `Gave the task to ${target.name}; it is in the room.`
      : "Posted the task to the room; Squeak is choosing who takes it (it may start a new duck).";
  }

  private jobsOf(s: SessionRow): { jobs: RoomTasks; pond: { id: string; name: string } } {
    if (!this.deps.jobs) throw new ToolError("Jobs aren't available here.");
    const pond = projectOfSession(this.deps.store, s);
    if (!pond) throw new ToolError("This chat isn't in a pond, so it has no jobs.");
    return { jobs: this.deps.jobs, pond };
  }

  /**
   * A lesson for the pond's Notebook. The rule, enforced here: only a chat that holds a working Task from the Room,
   * only when it says the Task is done (`taskDone`), and at most NOTEBOOK_PER_TASK lessons per Task.
   */
  private noteToNotebook(s: SessionRow, args: Record<string, unknown>): string {
    const { jobs, pond } = this.jobsOf(s);
    const notebook = this.deps.notebook ?? new PondNotebook(this.deps.store, this.now);
    if (typeof args.lesson !== "string" || !args.lesson.trim()) throw new ToolError("lesson is required.");
    const working = jobs.workingTaskOf(s.id);
    if (!working) {
      throw new ToolError("The Notebook is written only at the end of a task you took from the room; you have none.");
    }
    if (args.taskDone !== true) {
      throw new ToolError("Not yet: add to the Notebook only when you are finishing the task (taskDone true).");
    }
    const { store } = this.deps;
    let slot = 0;
    for (let n = 1; n <= NOTEBOOK_PER_TASK && !slot; n++) {
      if (store.markOnce(`notebook:${working.task.id}:${n}`, this.now())) slot = n;
    }
    if (!slot) throw new ToolError(`This task has already added ${NOTEBOOK_PER_TASK} lessons; that is enough.`);
    const by = store.duckBySession(s.id)?.name ?? s.title ?? null;
    try {
      const r = notebook.add(pond.id, args.lesson, by);
      return r.added ? "Added to the Pond Notebook." : "That lesson was already in the Notebook.";
    } catch (error) {
      if (error instanceof NotebookError) throw new ToolError(error.message);
      throw error;
    }
  }

  private openJobs(s: SessionRow): string {
    const { jobs, pond } = this.jobsOf(s);
    const open = jobs.openFor(pond.id, s);
    if (open.length === 0) return "No open jobs fit this chat.";
    return open.map(({ job, why }) => `${job.id}: ${job.text}${why ? ` (${why})` : ""}`).join("\n");
  }

  private claimJob(s: SessionRow, args: Record<string, unknown>): string {
    const { jobs, pond } = this.jobsOf(s);
    if (typeof args.jobId !== "string" || !args.jobId) throw new ToolError("jobId is required.");
    if (args.eta !== undefined && typeof args.eta !== "string") throw new ToolError("eta must be text.");
    try {
      jobs.claim(s, pond.id, args.jobId, args.eta as string | undefined);
    } catch (error) {
      if (error instanceof TaskError) throw new ToolError(error.message);
      throw error;
    }
    return "Asked the person. Do not start this job unless they send it to you.";
  }

  private readRoom(s: SessionRow, args: Record<string, unknown>): string {
    const room = this.roomOf();
    const mine = this.pondOf(s);
    if (!mine) throw new ToolError("This chat isn't in a pond, so it has no room.");
    const last =
      typeof args.last === "number" && Number.isInteger(args.last) ? Math.min(50, Math.max(1, args.last)) : 20;
    const level = args.level === "room" || args.level === "agents" ? args.level : "all";
    const rows: ReturnType<Room["page"]>["posts"] = [];
    let before: number | undefined;
    for (let page = 0; page < 20 && rows.length < last; page++) {
      const got = room.page(mine.id, { ...(before !== undefined ? { before } : {}), limit: 200, all: true }).posts;
      if (got.length === 0) break;
      for (let i = got.length - 1; i >= 0 && rows.length < last; i--) {
        if (level === "all" || got[i]!.level === level) rows.push(got[i]!);
      }
      before = got[0]!.seq;
    }
    const hhmm = (at: number): string => {
      const d = new Date(at);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const lines = rows.reverse().map((p) => `[${hhmm(p.at)}] ${p.author.name} (${p.kind}): ${p.text}`);
    const working = room
      .threads(mine.id)
      .filter((t) => t.workingOn)
      .map((t) => `- ${t.title}${t.sessionId === s.id ? " (you)" : ""}: ${t.workingOn}`);
    return [
      lines.length ? lines.join("\n") : "The room is quiet.",
      working.length ? `\nWorking now:\n${working.join("\n")}` : "",
    ]
      .join("\n")
      .trim();
  }

  private async pondTool(s: SessionRow, name: string, args: Record<string, unknown>): Promise<string> {
    const pond = this.deps.pond;
    if (!pond) throw new ToolError("Pond upkeep isn't available here.");
    const mine = this.pondOf(s);
    if (!mine) throw new ToolError("This chat isn't in a pond (a Squeak project), so there is nothing to change.");
    const { prefs } = pond;
    if (name === "pond_appearance") {
      const p = prefs.get(mine.id);
      return JSON.stringify({
        name: mine.name,
        colour: p.colour ?? "default",
        colours: POND_COLOUR_NAMES,
        labels: p.labels,
        hasIcon: prefs.iconUpdatedAt(mine.id) !== null,
      });
    }
    this.prune();
    if (this.pondChanges.filter((x) => x.from === s.id).length >= LIMITS.pondChangesPerHour) {
      throw new ToolError("This chat changed the pond enough this hour; ask the person to do more.");
    }
    let done: string;
    let ripple: string;
    try {
      if (name === "set_pond_icon") {
        const file = typeof args.path === "string" ? args.path : "";
        if (!file) throw new ToolError("path is required.");
        const bytes = this.readInside(s.cwd, file);
        this.pondChanges.push({ from: s.id, at: this.now() });
        await prefs.setIcon(mine.id, bytes);
        done = "The pond's icon is set.";
        ripple = "set the pond icon";
      } else if (name === "set_pond_colour") {
        const raw = typeof args.colour === "string" ? args.colour.trim().toLowerCase() : "";
        const colour = raw === "default" ? null : readColour(raw);
        this.pondChanges.push({ from: s.id, at: this.now() });
        prefs.patch(mine.id, { colour });
        done = colour ? `The pond's colour is ${colour}.` : "The pond's colour is back to automatic.";
        ripple = colour ? `set the pond colour to ${colour}` : "reset the pond colour";
      } else {
        const labels = readLabels(args.labels);
        this.pondChanges.push({ from: s.id, at: this.now() });
        prefs.patch(mine.id, { labels });
        done = labels.length ? `The pond's labels are ${labels.join(", ")}.` : "The pond's labels are cleared.";
        ripple = "changed the pond's labels";
      }
    } catch (error) {
      if (error instanceof PrefsError) throw new ToolError(error.message);
      throw error;
    }
    const who = s.agent === "codex" ? "Codex" : "Claude";
    try {
      await pond.ripple?.(mine.id, mine.name, ripple, who);
    } catch (error) {
      logger.warn("pond upkeep ripple failed", { error: String(error) });
    }
    return done;
  }

  /** A PNG/JPEG file's bytes, only when its real path (symlinks resolved) is inside the chat's own folder. */
  private readInside(cwd: string, file: string): Buffer {
    let root: string;
    let real: string;
    try {
      root = fs.realpathSync(cwd);
      real = fs.realpathSync(path.resolve(cwd, file));
    } catch {
      throw new ToolError("No such file in this chat's folder.");
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new ToolError("The icon must be a file inside this chat's own folder.");
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new ToolError("That is not a file.");
    if (stat.size > MAX_ICON_BYTES) throw new ToolError("The icon is over 512 KB.");
    return fs.readFileSync(real);
  }

  private listChats(s: SessionRow, sameProject: boolean): string {
    const mine = this.projectOf(s);
    const rows = this.deps.store
      .listSessions()
      .filter((x) => x.id !== s.id)
      .filter((x) => !x.archivedAt)
      .filter((x) => !x.workspaceId || this.deps.store.getWorkspace(x.workspaceId)?.state !== "archived")
      .filter((x) => !sameProject || (mine !== null && this.projectOf(x) === mine))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 40);
    if (rows.length === 0) return "No other chats.";
    return rows.map((x) => `${x.id}  ${x.title ?? "Untitled"}  [${x.agent}, ${x.status}]  ${x.cwd}`).join("\n");
  }

  private readChat(s: SessionRow, chatId: string | undefined, last: number): string {
    if (!chatId) throw new ToolError("chatId is required.");
    if (chatId === s.id) throw new ToolError("That is this chat.");
    const target = this.deps.store.getSession(chatId);
    if (!target) throw new ToolError("No chat with that id.");
    const out: string[] = [];
    let before: number | null = null;
    for (let page = 0; page < 10 && out.length < last; page++) {
      const rows = this.deps.store.messagesBefore(chatId, before, 200);
      if (rows.length === 0) break;
      for (let i = rows.length - 1; i >= 0 && out.length < last; i--) {
        const m = rows[i]!;
        const text = m.role === "user" || m.role === "agent" ? textOf(m.payload) : null;
        if (text) out.push(`${m.role === "user" ? "Person" : "Agent"}: ${text.slice(0, 4000)}`);
      }
      before = rows[0]!.seq;
    }
    return `${target.title ?? "Untitled"} [${target.status}]\n\n${out.reverse().join("\n\n") || "No messages yet."}`;
  }

  private prune(): void {
    const hour = this.now() - 3_600_000;
    while (this.sent.length && this.sent[0]!.at < hour) this.sent.shift();
    while (this.starts.length && this.starts[0]!.at < hour) this.starts.shift();
    while (this.streamOpens.length && this.streamOpens[0]!.at < hour) this.streamOpens.shift();
    while (this.pondChanges.length && this.pondChanges[0]!.at < hour) this.pondChanges.shift();
    while (this.shown.length && this.shown[0]!.at < hour) this.shown.shift();
  }

  /**
   * An image file the person may be shown: its real path (symlinks resolved) must lie inside the chat's folder, its
   * project's folder or the temp folder (where screenshots land), be an image type and at most 25 MB.
   */
  private imageToShow(s: SessionRow, file: string): { real: string; size: number } {
    const roots = [s.cwd, os.tmpdir(), "/tmp"];
    const project = this.projectOf(s);
    const rootPath = project ? this.deps.store.getProject(project)?.rootPath : undefined;
    if (rootPath) roots.push(rootPath);
    const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(s.cwd, expanded));
    } catch {
      throw new ToolError("No such file.");
    }
    const inside = roots.some((r) => {
      try {
        const base = fs.realpathSync(r);
        return real === base || real.startsWith(base + path.sep);
      } catch {
        return false;
      }
    });
    if (!inside) throw new ToolError("That file is outside this chat's folder, its project and the temp folder.");
    if (!SHOW_IMAGE_EXTENSIONS.has(path.extname(real).toLowerCase())) {
      throw new ToolError("show_image takes a PNG, JPEG, GIF, WebP, HEIC, SVG or PDF file.");
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new ToolError("That is not a file.");
    if (stat.size > MAX_SHOW_IMAGE_BYTES) throw new ToolError("That image is over 25 MB.");
    return { real, size: stat.size };
  }

  /** Waits for the Mac's answer (null: this host has no relay, so nothing to wait for). */
  private async askToOpen(
    s: SessionRow,
    projectId: string | null,
    shownPath: string,
    relative: string,
    title: string | null,
  ): Promise<ShowAck | null> {
    if (!this.deps.openShown) return null;
    try {
      return await this.deps.openShown({ sessionId: s.id, projectId, path: shownPath, relative, title });
    } catch {
      return { ok: false, reason: "timeout", message: "Squeak could not be asked to open it." };
    }
  }

  /** What the duck is told: opened only when the Mac said so; otherwise why not, and that the file is still listed. */
  private openedMessage(what: string, ack: ShowAck | null): string {
    if (!ack || ack.ok) return `Opened ${what} in the person's Squeak window.`;
    return `Did not open ${what} as a tab: ${ack.message} It is listed in the pond's Artifacts tab; do not tell the person it is open.`;
  }

  private canvasOp<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof CanvasError) throw new ToolError(err.message);
      throw err;
    }
  }

  private noteCanvasChanged(s: SessionRow, dir: string): void {
    const pond = this.pondOf(s);
    // The Task's done line will carry a card for it (the host attaches it, the Duck says nothing).
    this.deps.room?.noteCanvasTouched(s.id, dir);
    if (pond) this.deps.artifactShown?.(pond.id);
  }

  /** The canvas folder a duck named: a path inside this chat's folder, or a short name under canvases/. */
  canvasDirOf(s: SessionRow, name: string | undefined): string {
    if (!name?.trim()) throw new ToolError("canvas is required.");
    const given = name.trim();
    const plain = !/[\\/]/.test(given);
    const candidate = plain
      ? path.join(s.cwd, "canvases", given.endsWith(".canvas") ? given : `${given}.canvas`)
      : path.resolve(s.cwd, given.startsWith("~/") ? path.join(os.homedir(), given.slice(2)) : given);
    try {
      return resolveCanvasDir(candidate, [s.cwd]);
    } catch (err) {
      if (err instanceof CanvasError) throw new ToolError(err.message);
      throw err;
    }
  }

  /** A file to open in the Mac app: only inside the chat's own folder, after symlinks are resolved. */
  fileToShow(s: SessionRow, file: string): { real: string; relative: string; size: number } {
    const expanded = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
    let real: string, base: string;
    try {
      base = fs.realpathSync(s.cwd);
      real = fs.realpathSync(path.resolve(s.cwd, expanded));
    } catch {
      throw new ToolError("No such file.");
    }
    if (real === base || !real.startsWith(base + path.sep)) {
      throw new ToolError("That file is outside this chat's folder. Write it in the folder first.");
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new ToolError("That is not a file.");
    if (stat.size > MAX_SHOW_FILE_BYTES) throw new ToolError("That file is over 10 MB.");
    return { real, relative: path.relative(base, real), size: stat.size };
  }

  private async sendToChat(s: SessionRow, chatId: string | undefined, message: string | undefined): Promise<string> {
    if (!chatId || !message?.trim()) throw new ToolError("chatId and message are required.");
    if (chatId === s.id) throw new ToolError("That is this chat.");
    const target = this.deps.store.getSession(chatId);
    if (!target) throw new ToolError("No chat with that id.");
    if (message.length > LIMITS.maxMessage) throw new ToolError(`Keep it under ${LIMITS.maxMessage} characters.`);
    if (this.deps.store.duckOf(chatId).duty === "off") {
      throw new ToolError("That chat is off duty; the person has to put it back on duty or message it themselves.");
    }
    this.prune();
    if (this.sent.filter((x) => x.from === s.id && x.to === chatId).length >= LIMITS.perTargetPerHour) {
      throw new ToolError("Too many messages to that chat this hour; wait for its answer or ask the person.");
    }
    if (this.sent.filter((x) => x.from === s.id).length >= LIMITS.perSenderPerHour) {
      throw new ToolError("Too many messages to other chats this hour.");
    }
    this.sent.push({ from: s.id, to: chatId, at: this.now() });
    const header = `[Message from the Squeak chat "${s.title ?? "Untitled"}" (${s.id}). Reply in this chat; it can read your answer with read_chat.]`;
    const { queued } = await this.deps.send(chatId, `${header}\n\n${message}`);
    this.mirrorToRoom(s, chatId, message);
    this.deps.post(s.id, "squeak/agent-message", {
      text: `Sent to "${target.title ?? "Untitled"}"`,
      to: chatId,
      message: message.slice(0, 4000),
      queued,
    });
    return queued ? "Queued: that chat is busy and will get it next." : "Sent; that chat is working on it.";
  }

  /** A sent message also lands in the room's agents level, from the sender; never fails the send. */
  private mirrorToRoom(s: SessionRow, toChatId: string, message: string): void {
    try {
      const pond = this.pondOf(s);
      if (!this.deps.room || !pond) return;
      this.deps.room.post({
        projectId: pond.id,
        author: { kind: "agent", id: s.id, name: agentName(s) },
        sessionId: s.id,
        kind: "message",
        level: "agents",
        text: message.trim().slice(0, ROOM_MAX_TEXT),
        toSessionId: toChatId,
      });
    } catch (error) {
      logger.warn("room mirror failed", { error: String(error) });
    }
  }

  /**
   * The model a new chat gets when the caller names none: its own when the agent is the same, otherwise the one
   * the newest chat of that agent runs (a model that chat's runner accepted). Squeak's host has no model list of
   * its own, so with no such chat the caller must name one, from the ones Squeak has seen.
   */
  private defaultModel(s: SessionRow, agent: AgentKind): string {
    if (agent === s.agent) return s.model;
    const sessions = this.deps.store
      .listSessions()
      .filter((x) => x.agent === agent && x.model && x.model !== "default")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (sessions[0]) return sessions[0].model;
    throw new ToolError(
      `Squeak has no ${agent} chat to take a default model from, so pass model: a ${agent} model id as listed in Squeak's model picker.`,
    );
  }

  private async recoverStreamTool(s: SessionRow, args: Record<string, unknown>): Promise<string> {
    if (!ducksOwnBranch()) throw new ToolError("Branches are not managed by ducks in this Squeak yet.");
    const { store, recoverStream } = this.deps;
    if (!recoverStream) throw new ToolError("Recovery is unavailable here.");
    const wanted = typeof args.duck === "string" ? args.duck.trim() : "";
    let target = s;
    if (wanted) {
      const project = projectOfSession(store, s);
      const duck =
        store.duckRow(wanted) ??
        (project ? store.listDucks(project.id) : []).find((d) => d.name?.toLowerCase() === wanted.toLowerCase());
      if (!duck || (project && duck.projectId !== project.id))
        throw new ToolError(`No duck called ${wanted} in this pond.`);
      const current = duck.currentSessionId ? store.getSession(duck.currentSessionId) : null;
      if (!current) throw new ToolError(`${wanted} has no chat to move yet.`);
      target = current;
    }
    try {
      return await recoverStream(target.id);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
  }

  private async placeTool(s: SessionRow, name: string, args: Record<string, unknown>): Promise<string> {
    if (!ducksOwnBranch()) throw new ToolError("Branches are not managed by agents in this Squeak yet.");
    const { placement, store } = this.deps;
    if (!placement) throw new ToolError("Placement is unavailable here.");
    const text = (k: string): string | undefined =>
      typeof args[k] === "string" && (args[k] as string).trim() ? (args[k] as string).trim() : undefined;
    const pondRef = projectOfSession(store, s);
    const project = pondRef ? store.getProject(pondRef.id) : null;
    const noBranches =
      "This project is a plain folder with no git history, so it has no branches. Edit its files directly; a file is locked while another agent is editing it.";
    try {
      if (project?.kind === "folder") {
        if (name === "streams") return noBranches;
        throw new ToolError(noBranches);
      }
      if (name === "streams") return this.streamsText(s, placement);
      if (name === "leave_stream" || name === "move_to_main") {
        const left = placement.leaveStream(s.id, text("name"));
        this.streamLine(s, `left Stream ${left.stream.title || left.stream.branch}`);
        const rest = left.streams.length
          ? `You are still in: ${left.streams.map((w) => w.branch).join(", ")}.`
          : "You are in no branch now; your folder is the read-only main folder.";
        return `Left ${left.stream.branch}. ${rest}`;
      }
      // open_stream, and the older branch_off and join_branch that chats begun before this update may still call.
      let req: { name?: string; branch?: string; from?: string };
      if (name === "join_branch") {
        const wanted = text("duck");
        const duck = wanted
          ? (store.duckRow(wanted) ??
            (project ? store.listDucks(project.id) : []).find((d) => d.name?.toLowerCase() === wanted.toLowerCase()))
          : null;
        if (wanted && !duck) throw new ToolError(`No agent called ${wanted} in this project.`);
        const branch =
          text("branch") ?? (duck ? (store.duckStreams(duck.id)[0]?.branch ?? duck.branch ?? undefined) : undefined);
        if (!branch) throw new ToolError("Give a branch to join.");
        req = { branch };
      } else {
        const asked = { name: text("name"), branch: text("branch"), from: text("from") };
        req = {
          ...(asked.name ? { name: asked.name } : {}),
          ...(asked.branch ? { branch: asked.branch } : {}),
          ...(asked.from ? { from: asked.from } : {}),
        };
      }
      this.prune();
      if (this.streamOpens.filter((x) => x.from === s.id).length >= LIMITS.streamsPerHour) {
        throw new ToolError("You created enough branches this hour; join one that exists with open_stream.");
      }
      const opened = await placement.openStream(s.id, req);
      if (opened.created) this.streamOpens.push({ from: s.id, at: this.now() });
      const label = opened.stream.title || opened.stream.branch;
      if (opened.created) this.streamLine(s, `created Stream ${label}`);
      else if (opened.joined) this.streamLine(s, `joined Stream ${label}`);
      const folder = opened.stream.path;
      const lead = opened.created
        ? `Created branch ${opened.stream.branch}`
        : opened.joined
          ? `Joined branch ${opened.stream.branch}`
          : `You are already in branch ${opened.stream.branch}`;
      return [
        `${lead}. Its working copy is ${folder}.`,
        `Edit files there by their full path (for example ${folder}/<file>) and run commands from that folder. Your own folder is read-only. You are in: ${opened.streams.map((w) => w.branch).join(", ")}.`,
      ].join(" ");
    } catch (error) {
      if (error instanceof PlacementError) throw new ToolError(error.message);
      throw error;
    }
  }

  private readonly streamOpens: { from: string; at: number }[] = [];

  /** `streams`: every branch with a working copy, who is in it, and which ones are yours. */
  private streamsText(s: SessionRow, placement: Placement): string {
    const { main, mine, active, project } = placement.streamsFor(s.id);
    const mineIds = new Set(mine.map((w) => w.id));
    const lines = [`Your folder: ${main} (the project's main folder, read-only for you).`];
    lines.push(
      mine.length
        ? `You are in: ${mine.map((w) => w.branch).join(", ")}.`
        : "You are in no branch yet; open one with open_stream to edit.",
    );
    if (active.length === 0) {
      lines.push("No branches have a working copy yet.");
    } else {
      lines.push(`Branches with a working copy (default branch ${project.defaultBranch}):`);
      for (const b of active) {
        const ws = this.deps.store.getWorkspace(b.workspaceId);
        const who = b.ducks.length ? b.ducks.map((d) => d.name).join(", ") : "nobody now";
        const title = b.title && b.title !== b.branch ? ` (${b.title})` : "";
        lines.push(
          `- ${b.branch}${title}: ${ws?.path ?? ""}; ${who}${mineIds.has(b.workspaceId) ? "; you are in it" : ""}`,
        );
      }
    }
    return lines.join("\n");
  }

  /** One status line in the Room: a Duck joined, left or created a Stream. Never fails the tool. */
  private streamLine(s: SessionRow, text: string): void {
    const { room, store } = this.deps;
    const project = projectOfSession(store, s);
    if (!room || !project) return;
    try {
      const duck = store.duckBySession(s.id);
      room.post({
        projectId: project.id,
        author: { kind: "squeak", name: duck?.name?.trim() || agentName(s) },
        sessionId: s.id,
        kind: "message",
        level: "room",
        text,
      });
      if (duck) room.emitDuck(duck.id);
    } catch (error) {
      logger.warn("stream line failed", { error: String(error) });
    }
  }

  private async startChat(s: SessionRow, args: Record<string, unknown>): Promise<string> {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!message) throw new ToolError("message is required.");
    if (message.length > LIMITS.maxMessage) throw new ToolError(`Keep it under ${LIMITS.maxMessage} characters.`);
    this.prune();
    if (this.starts.filter((x) => x.from === s.id).length >= LIMITS.startsPerHour) {
      throw new ToolError("This chat started enough chats this hour.");
    }
    const agent: AgentKind = args.agent === "codex" ? "codex" : args.agent === "claude" ? "claude" : s.agent;
    const model = typeof args.model === "string" && args.model ? args.model : this.defaultModel(s, agent);
    const title = (typeof args.title === "string" && args.title.trim()) || message.split("\n")[0]!.slice(0, 60);
    this.starts.push({ from: s.id, at: this.now() });
    const child = await this.deps.create({
      cwd: s.cwd,
      agent,
      model,
      // Never wider than the chat that started it.
      permissionMode: agent === s.agent ? s.permissionMode : "default",
      workspaceId: s.workspaceId,
      title,
      text: `[Started by the Squeak chat "${s.title ?? "Untitled"}" (${s.id}).]\n\n${message}`,
    });
    this.deps.post(s.id, "squeak/agent-started", { text: `Started "${title}"`, chatId: child.id, agent });
    return `Started chat ${child.id} ("${title}").`;
  }
}

// MCP over HTTP: JSON-RPC 2.0 requests in, one JSON response out (no SSE needed for tools-only servers).

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleMcpMessage(
  tools: AgentTools,
  sessionId: string,
  message: unknown,
): Promise<Record<string, unknown> | null> {
  const req = (typeof message === "object" && message !== null ? message : {}) as RpcRequest;
  const id = req.id ?? null;
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, msg: string): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: msg },
  });
  if (typeof req.method !== "string") return fail(-32600, "Invalid request");
  // Notifications get no response.
  if (req.id === undefined) return null;
  switch (req.method) {
    case "initialize":
      return ok({
        protocolVersion:
          typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: "1" },
        instructions:
          "Squeak runs this chat. Use these tools to see the stream's diff and review comments, page the person, show progress, and work with the other Squeak chats on this Mac. This pond has a room: post to it (post_to_room) only when your state changes (took a task, blocked, handing off, done), one short line each and never once per turn; read_room before touching an area another chat may be in, and use level `agents` for coordination the person doesn't need to see.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: [...TOOLS, ...(ducksOwnBranch() ? PLACEMENT_TOOLS : [])].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly },
        })),
      });
    case "tools/call": {
      const name = req.params?.name;
      const args = req.params?.arguments;
      if (typeof name !== "string") return fail(-32602, "name is required");
      try {
        const text = await tools.call(
          sessionId,
          name,
          typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
        );
        return ok({ content: [{ type: "text", text }] });
      } catch (error) {
        const text = error instanceof ToolError ? error.message : "Squeak couldn't run that tool.";
        return ok({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(-32601, "Method not found");
  }
}
