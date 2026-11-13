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
import type { DiffCommentRow, NativeStore } from "./store.js";
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
    title: string;
    text: string;
  }): Promise<SessionRow>;
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

export const TOOLS: ToolDef[] = [
  {
    name: "workspace_diff",
    description:
      "Everything this stream changed against the branch it merges into: commits on its branch plus uncommitted and untracked files. Use it to review your own work or when the person mentions 'the diff' or 'all changes'. stat: true gives a file summary only; file narrows it to one path.",
    inputSchema: obj({ file: { type: "string" }, stat: { type: "boolean" } }),
    readOnly: true,
  },
  {
    name: "review_comments",
    description:
      "The open review comments the person (or an agent) left on this stream's diff in Squeak. Read them when asked to address review feedback. Optional file narrows to one path.",
    inputSchema: obj({ file: { type: "string" } }),
    readOnly: true,
  },
  {
    name: "add_review_comment",
    description:
      "Leave a review comment on one line of this stream's diff; it shows in Squeak's Changes view. Use it for review findings instead of posting to GitHub unless asked. Plain text.",
    inputSchema: obj({ file: { type: "string" }, line: { type: "integer", minimum: 1 }, comment: { type: "string" } }, [
      "file",
      "line",
      "comment",
    ]),
    readOnly: false,
  },
  {
    name: "resolve_review_comment",
    description: "Mark a review comment (by id from review_comments) as addressed.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    readOnly: false,
  },
  {
    name: "notify_user",
    description:
      "Page the person on their Mac and phone. Squeak already tells them when a turn ends, so use this only when you stop and need them for something specific: a PR or plan to look at, or a decision, credential or input only they can give. At most once per turn, just before ending it.",
    inputSchema: obj({ message: { type: "string" }, title: { type: "string" } }, ["message"]),
    readOnly: false,
  },
  {
    name: "update_progress",
    description:
      "Show a progress tracker above this chat's composer for long multi-step work. Send the whole current state each time (it replaces the last one): steps (short labels) with the index of the current one, an optional percent, and an optional one-line status. Send steps: [] when the work is done or abandoned.",
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
    name: "set_target_branch",
    description:
      "Change the branch this stream merges into (used for its diff and new pull requests). Pass the branch name on origin without 'origin/'; fetch it first. This does not rebase anything.",
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
    name: "terminal_output",
    description:
      "What this stream's own scripts printed: the run script (dev server or other action started from Squeak's Run button; running or last run) and the setup script's log. It does NOT cover Squeak's interactive terminal panel or anything you ran yourself; use your own Bash output for those. source: run_script, setup or auto (default: the run script, else setup). maxLines defaults to 1000 (the newest lines).",
    inputSchema: obj({
      source: { type: "string", enum: ["run_script", "setup", "auto"] },
      maxLines: { type: "integer", minimum: 1, maximum: 5000 },
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

const READ_ONLY = new Set(TOOLS.filter((t) => t.readOnly).map((t) => t.name));

/** Tools any chat may call without asking the person: they read, or only write into Squeak itself. */
export function isSqueakTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX) && TOOLS.some((t) => MCP_TOOL_PREFIX + t.name === toolName);
}
export function isReadOnlySqueakTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX) && READ_ONLY.has(toolName.slice(MCP_TOOL_PREFIX.length));
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
};

export const SHOW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg", ".pdf"]);
export const MAX_SHOW_IMAGE_BYTES = 25 * 1024 * 1024;

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

  async call(sessionId: string, name: string, args: Record<string, unknown>): Promise<string> {
    const s = this.session(sessionId);
    const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    switch (name) {
      case "workspace_diff":
        return this.diff(s, str("file"), args.stat === true);
      case "review_comments": {
        const rows = this.deps.store.diffComments(this.workspaceKey(s), str("file"));
        if (rows.length === 0) return "No open review comments.";
        return rows.map((c: DiffCommentRow) => `[${c.id}] ${c.file}:${c.line} (${c.author})\n${c.body}`).join("\n\n");
      }
      case "add_review_comment": {
        const file = str("file");
        const line = args.line;
        const body = str("comment");
        if (!file || !body || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
          throw new ToolError("file, a line number from 1 and comment are required.");
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
        return `Comment ${row.id} added on ${file}:${line}.`;
      }
      case "resolve_review_comment": {
        const id = str("id");
        if (!id || !this.deps.store.resolveDiffComment(this.workspaceKey(s), id)) {
          throw new ToolError("No open comment with that id in this stream.");
        }
        return "Resolved.";
      }
      case "notify_user": {
        const message = str("message");
        if (!message) throw new ToolError("message is required.");
        this.deps.post(s.id, "squeak/notify", {
          title: str("title")?.slice(0, 120) ?? null,
          text: message.slice(0, 1000),
        });
        return "The person was notified.";
      }
      case "update_progress": {
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
        return steps.length ? "Progress updated." : "Progress cleared.";
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
      case "set_target_branch": {
        const branch = str("branch")?.replace(/^origin\//, "");
        if (!branch || !/^[\w./-]+$/.test(branch) || branch.includes("..")) throw new ToolError("Not a branch name.");
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
      case "terminal_output":
        return this.terminalOutput(s, str("source"), args.maxLines);
      case "pond_appearance":
      case "set_pond_icon":
      case "set_pond_colour":
      case "set_pond_labels":
        return this.pondTool(s, name, args);
      default:
        throw new ToolError(`Unknown tool ${name}.`);
    }
  }

  private async diff(s: SessionRow, file: string | undefined, stat: boolean): Promise<string> {
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
      ? `${out.slice(0, MAX_DIFF)}\n… (cut at ${MAX_DIFF} characters; ask for one file or stat: true)`
      : out;
  }

  private terminalOutput(s: SessionRow, source: string | undefined, maxLinesArg: unknown): string {
    const ws = this.deps.workspaces;
    if (!ws || !s.workspaceId)
      throw new ToolError("This chat is not in a Squeak stream, so it has no scripts' output.");
    if (source !== undefined && source !== "run_script" && source !== "setup" && source !== "auto") {
      throw new ToolError("source is run_script, setup or auto.");
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
    const chosen = source === "setup" ? setup() : source === "run_script" ? run() : run() || setup();
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
    const { store } = this.deps;
    const viaWorkspace = this.projectOf(s);
    const project =
      (viaWorkspace ? store.getProject(viaWorkspace) : null) ??
      store.listProjects().find((p) => path.resolve(p.rootPath) === path.resolve(s.cwd)) ??
      null;
    return project ? { id: project.id, name: project.name } : null;
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

  private async sendToChat(s: SessionRow, chatId: string | undefined, message: string | undefined): Promise<string> {
    if (!chatId || !message?.trim()) throw new ToolError("chatId and message are required.");
    if (chatId === s.id) throw new ToolError("That is this chat.");
    const target = this.deps.store.getSession(chatId);
    if (!target) throw new ToolError("No chat with that id.");
    if (message.length > LIMITS.maxMessage) throw new ToolError(`Keep it under ${LIMITS.maxMessage} characters.`);
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
    this.deps.post(s.id, "squeak/agent-message", {
      text: `Sent to "${target.title ?? "Untitled"}"`,
      to: chatId,
      message: message.slice(0, 4000),
      queued,
    });
    return queued ? "Queued: that chat is busy and will get it next." : "Sent; that chat is working on it.";
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
          "Squeak runs this chat. Use these tools to see the stream's diff and review comments, page the person, show progress, and work with the other Squeak chats on this Mac.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.map((t) => ({
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
