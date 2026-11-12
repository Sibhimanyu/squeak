#!/usr/bin/env node
/* global process, setTimeout, AbortController */
// A fake `claude` CLI for the host's end-to-end tests (src/native/e2e.test.ts). It speaks what CLI 2.1.322 speaks
// through the Agent SDK: stream-json on stdin/stdout, `control_request`s (initialize, interrupt, set_*), `system`
// init, assistant blocks (one entry per block, one message id), user tool results, `command_lifecycle`
// (queued/started/completed with `command_uuid`), `task_started`/`task_updated`/`task_notification`, `result`.
// Frame shapes are the ones in claude-real-stream.json and the SDK's types; nothing here is a guess the host
// parser does not already read.
//
// What the fake does is scripted by `@@name` words in the message text (see SCRIPTS). It never touches the network.
// FAKE_CLAUDE_DIR (required): `log.jsonl` (what the fake saw), `waiting-<gate>` (it reached a gate), and the test
// releases a gate by creating `release-<gate>`.
//   FAKE_CLAUDE_STOP_REPORTS=0: Stop does not report the helpers it killed (the unreported case in claude-runner.ts).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const DIR = process.env.FAKE_CLAUDE_DIR;
if (!DIR) throw new Error("FAKE_CLAUDE_DIR is required");
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i < 0) return undefined;
  return argv[i].includes("=") ? argv[i].slice(name.length + 1) : argv[i + 1];
};
const sessionId = argOf("--resume") ?? randomUUID();
const model = argOf("--model") ?? "claude-opus-5-5";
const record = (event, data = {}) =>
  fs.appendFileSync(path.join(DIR, "log.jsonl"), JSON.stringify({ event, ...data }) + "\n");
record("spawn", { argv, sessionId, resumed: argOf("--resume") !== undefined });

const out = (obj) => process.stdout.write(JSON.stringify({ uuid: randomUUID(), session_id: sessionId, ...obj }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until the test creates `release-<name>` (and says it is waiting). Rejects when the turn is aborted. */
async function gate(name, signal) {
  fs.writeFileSync(path.join(DIR, `waiting-${name}`), "");
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const release = path.join(DIR, `release-${name}`);
      if (fs.existsSync(release)) {
        fs.unlinkSync(release);
        return;
      }
      await sleep(10);
    }
  } finally {
    fs.rmSync(path.join(DIR, `waiting-${name}`), { force: true });
  }
}

let seq = 0;
const newId = (p) => `${p}_${(++seq).toString().padStart(4, "0")}${randomUUID().slice(0, 6)}`;

/** Hook callbacks the SDK registered (the host's PreToolUse gate): the CLI calls them before every tool. */
let hookIds = [];
const pendingControl = new Map();
function control(request) {
  const request_id = randomUUID();
  return new Promise((resolve) => {
    pendingControl.set(request_id, resolve);
    process.stdout.write(JSON.stringify({ type: "control_request", request_id, request }) + "\n");
  });
}

// ---- the turn machine ----------------------------------------------------------------------------------------
/** Messages that arrived while a turn runs: folded in at the next step boundary (a steer). */
let midQueue = [];
let cur = null; // { uuids, texts, abort, last }
/** Async helpers still alive: task_id -> { toolUseId }. They outlive the turn that started them. */
const bg = new Map();
let askedQuestion = false;

const lifecycle = (state, command_uuid) => out({ type: "command_lifecycle", state, command_uuid });

function think(text) {
  out({
    type: "assistant",
    parent_tool_use_id: null,
    message: block({ type: "thinking", thinking: text, signature: "sig" }),
  });
}
let msgId = newId("msg");
function block(content, stop = null) {
  return {
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content: [content],
    stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
  };
}
function say(text) {
  cur.last = text;
  out({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });
  out({ type: "assistant", parent_tool_use_id: null, message: block({ type: "text", text }, "end_turn") });
  msgId = newId("msg");
}
async function toolUse(name, input, parent = null) {
  const id = newId("toolu");
  // the CLI asks the SDK's PreToolUse callback before it runs a tool
  if (hookIds.length > 0 && parent === null) {
    await control({
      subtype: "hook_callback",
      callback_id: hookIds[0],
      input: { hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id },
    });
  }
  out({
    type: "assistant",
    parent_tool_use_id: parent,
    message: block({ type: "tool_use", id, name, input }, "tool_use"),
  });
  msgId = newId("msg");
  return id;
}
function toolResult(id, content, parent = null) {
  out({
    type: "user",
    parent_tool_use_id: parent,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
}
/** After a tool result the CLI reads its queue: every message waiting is folded into this turn. */
function boundary() {
  for (const m of midQueue) {
    lifecycle("started", m.uuid);
    cur.uuids.push(m.uuid);
    cur.texts.push(m.text);
  }
  midQueue = [];
}
const helperInput = (background) => ({
  description: "scan the repo",
  subagent_type: "general-purpose",
  prompt: "look around",
  ...(background ? { run_in_background: true } : {}),
});

/** A helper (subagent) started by an Agent call: the CLI says `task_started` for foreground and background alike. */
function taskStarted(toolUseId, isBackground) {
  const task_id = newId("a");
  out({
    type: "system",
    subtype: "task_started",
    task_id,
    run_id: `run-${task_id}`,
    tool_use_id: toolUseId,
    description: "scan the repo",
    subagent_type: "general-purpose",
    is_backgrounded: isBackground,
    task_type: "local_agent",
  });
  return task_id;
}
function taskEnds(task_id, toolUseId, status) {
  out({
    type: "system",
    subtype: "task_updated",
    task_id,
    run_id: `run-${task_id}`,
    patch: { status: status === "stopped" ? "killed" : status, end_time: Date.now() },
  });
  out({
    type: "system",
    subtype: "task_notification",
    task_id,
    run_id: `run-${task_id}`,
    tool_use_id: toolUseId,
    status,
    output_file: "/tmp/fake/tasks/out",
    summary: `Agent "scan the repo" ${status}`,
  });
}

const SCRIPTS = {
  async plain() {
    think("The person said hi; answer briefly.");
    say("hello there");
  },
  /** A long Bash: no step boundary until it is released. */
  async bash(signal) {
    think("Run the long command.");
    const id = await toolUse("Bash", { command: "sleep 100", description: "wait" });
    await gate("bash", signal);
    toolResult(id, "ok");
    boundary();
    say(cur.texts.length > 1 ? `bash done; also: ${cur.texts.slice(1).join(" | ")}` : "bash done");
  },
  /** A FOREGROUND Agent helper: the tool call blocks on it, so no boundary until it ends. */
  async agent(signal) {
    think("Hand the scan to a helper.");
    const id = await toolUse("Agent", helperInput(false));
    const task = taskStarted(id, false);
    const inner = await toolUse("Bash", { command: "ls" }, id);
    toolResult(inner, "a.txt", id);
    await gate("helper", signal);
    taskEnds(task, id, "completed");
    toolResult(id, "The helper found a.txt");
    boundary();
    say(cur.texts.length > 1 ? `helper done; also: ${cur.texts.slice(1).join(" | ")}` : "helper done");
  },
  /** An ASYNC helper: the call returns at once, the turn ends, the helper lives on until `helperdone`. */
  async asyncagent() {
    think("Start a helper in the background.");
    const id = await toolUse("Agent", helperInput(true));
    const task = taskStarted(id, true);
    toolResult(id, "Async agent launched successfully. agentId: " + task);
    boundary();
    say("launched a helper");
    bg.set(task, { toolUseId: id });
    void (async () => {
      try {
        await gate("helperdone", processAbort.signal);
      } catch {
        return;
      }
      if (!bg.delete(task)) return;
      taskEnds(task, id, "completed");
      void ownTurn();
    })();
  },
  async question() {
    think("This needs a decision.");
    say("Which way should I go?\nA) Fast (recommended)\nB) Careful");
    askedQuestion = true;
  },
  /** What a bare lettered answer does: a new turn with a foreground helper that ends quickly. */
  async answer() {
    think("They chose; delegate it.");
    const id = await toolUse("Agent", helperInput(false));
    const task = taskStarted(id, false);
    await sleep(20);
    taskEnds(task, id, "completed");
    toolResult(id, "done by helper");
    boundary();
    say("went with your pick");
  },
};

const processAbort = new AbortController();

function scriptFor(text) {
  const named = /@@(\w+)/.exec(text)?.[1];
  if (named && SCRIPTS[named]) return named;
  if (askedQuestion && /^[A-Z]$/.test(text.trim())) return "answer";
  return "plain";
}

function result(extra = {}) {
  const first = cur.uuids[0];
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    num_turns: 2,
    api_error_status: null,
    result: cur.last ?? "",
    user_message_uuid: first,
    user_message_uuids: [...cur.uuids],
    queued_turn_count: midQueue.length,
    result_index: 0,
    ...extra,
  });
}

async function runTurn(msg) {
  const script = scriptFor(msg.text);
  askedQuestion = false;
  cur = { uuids: [msg.uuid], texts: [msg.text], abort: new AbortController(), last: "" };
  lifecycle("started", msg.uuid);
  out({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    model,
    permissionMode: argOf("--permission-mode") ?? "default",
    tools: ["Bash", "Agent"],
    mcp_servers: [],
  });
  const turn = cur;
  try {
    await SCRIPTS[script](turn.abort.signal);
  } catch (error) {
    if (!turn.abort.signal.aborted) throw error;
    return; // the interrupt handler wrote the result
  }
  result();
  for (const u of turn.uuids) lifecycle("completed", u);
  cur = null;
  // anything that arrived after the last boundary is the CLI's next turn
  if (midQueue.length > 0) void runTurn(midQueue.shift());
}

/** The CLI starts a turn by itself when a helper reports in. */
async function ownTurn() {
  if (cur) return;
  cur = { uuids: [], texts: [], abort: new AbortController(), last: "" };
  out({ type: "system", subtype: "init", cwd: process.cwd(), model, tools: [], mcp_servers: [] });
  out({
    type: "user",
    parent_tool_use_id: null,
    isReplay: false,
    message: { role: "user", content: "<task-notification>helper finished</task-notification>" },
  });
  say("the helper reported in");
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "the helper reported in",
    origin: { kind: "task-notification" },
    terminal_reason: "completed",
    permission_denials: [],
  });
  cur = null;
}

function interrupt() {
  record("interrupt", { turn: cur !== null, helpers: bg.size });
  if (cur) {
    const turn = cur;
    turn.abort.abort();
    out({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    });
    result({
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      stop_reason: "tool_use",
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
    });
    for (const u of turn.uuids) lifecycle("completed", u);
    cur = null;
  }
  // Stop stops the helpers too; Claude Code reports the ones it killed
  if (process.env.FAKE_CLAUDE_STOP_REPORTS !== "0") {
    for (const [task, h] of bg) taskEnds(task, h.toolUseId, "stopped");
    bg.clear();
  }
}

// ---- stdin ---------------------------------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "control_response") {
    const done = pendingControl.get(msg.response?.request_id);
    pendingControl.delete(msg.response?.request_id);
    done?.(msg.response);
    return;
  }
  if (msg.type === "control_request") {
    const sub = msg.request?.subtype;
    record("control", { subtype: sub });
    if (sub === "initialize") {
      hookIds = (msg.request.hooks?.PreToolUse ?? []).flatMap((m) => m.hookCallbackIds ?? []);
    }
    if (sub === "interrupt") interrupt();
    process.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response:
            sub === "initialize"
              ? { commands: [], models: [], output_style: "default", available_output_styles: ["default"] }
              : {},
        },
      }) + "\n",
    );
    return;
  }
  if (msg.type === "user") {
    const content = msg.message?.content;
    const text = typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("");
    const uuid = msg.uuid ?? randomUUID();
    record("user", { text, uuid, midTurn: cur !== null });
    lifecycle("queued", uuid);
    if (cur) midQueue.push({ uuid, text });
    else void runTurn({ uuid, text });
  }
});
rl.on("close", () => {
  record("exit");
  processAbort.abort();
  process.exit(0);
});
process.on("SIGTERM", () => {
  record("killed");
  process.exit(0);
});
