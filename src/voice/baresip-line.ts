import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { logger } from "../utils/logger.js";
import type { CallDialog, DialogAction } from "./script.js";
import type { Speaker } from "./tts.js";

/**
 * Squeak's phone line: a SIP extension on your PBX (3CX's free edition is enough), run by `baresip`
 * as a child process and driven over its `ctrl_tcp` module. A process per call keeps the line clean:
 * nothing stays registered, listening or holding a socket between calls, and a stuck call dies with
 * its process.
 *
 * Audio never touches the Mac's speakers or microphone: `aufile` plays a WAV into the call and writes
 * what the other side says to a WAV (for dictation later).
 */

export interface LineConfig {
  /** The PBX: `host` or `host:port`. */
  host: string;
  /** The extension Squeak registers as (3CX: its extension number). */
  user: string;
  /** 3CX's separate "Authentication ID"; defaults to `user`. */
  authUser: string | null;
  secret: string;
  transport: "udp" | "tcp" | "tls";
  /** 3CX behind an SBC: the SBC's `host:port`, which every SIP message goes through; null when not used. */
  proxy: string | null;
  baresipPath: string;
  /** Where baresip's modules live; null for its compiled-in default. */
  modulePath: string | null;
  /** `<support dir>/voice`: per-call config (holding the secret, 0600) is written under it. */
  dir: string;
}

export type CallResult =
  | { status: "answered"; letter: string | null }
  | { status: "unanswered" }
  | { status: "failed"; reason: string };

const REGISTER_TIMEOUT_MS = 12_000;
/** Ringing this long without a pickup ends the call. */
const RING_TIMEOUT_MS = 40_000;
/** After a prompt ends, how long to wait for a key. */
const KEY_TIMEOUT_MS = 25_000;
/** Hard ceiling on one call, baresip's own `-t` included. */
const MAX_CALL_MS = 4 * 60_000;
const GOODBYE_PAD_MS = 400;

/** Values land inside a `"..."` in baresip's accounts file: no quote or newline can get through. */
export function isSafeAccountValue(value: string): boolean {
  return value.length > 0 && !/["\\\r\n;<>]/.test(value);
}

export function accountsFile(config: LineConfig): string {
  const params = [
    `auth_user="${config.authUser ?? config.user}"`,
    `auth_pass="${config.secret}"`,
    `transport=${config.transport}`,
    "regint=300",
    "answermode=manual",
    ...(config.proxy ? [`outbound="sip:${config.proxy};transport=${config.transport}"`] : []),
  ];
  return `<sip:${config.user}@${config.host}>;${params.join(";")}\n`;
}

export function configFile(config: LineConfig, port: number, firstPrompt: string, recordTo: string): string {
  const lines = [
    "call_local_timeout 40",
    "call_max_calls 1",
    // Both directions are files: nothing is played on, or recorded from, this Mac.
    `audio_source aufile,${firstPrompt}`,
    `audio_player aufile,${recordTo}`,
    `audio_alert aufile,${recordTo}.alert`,
    ...(config.modulePath ? [`module_path ${config.modulePath}`] : []),
    "module g711.so",
    "module aufile.so",
    "module account.so",
    "module menu.so",
    "module ctrl_tcp.so",
    `ctrl_tcp_listen 127.0.0.1:${port}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** One baresip ctrl_tcp message: a netstring (`<length>:<json>,`). */
export function encodeNetstring(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([Buffer.from(`${body.length}:`), body, Buffer.from(",")]);
}

/** Splits a stream into netstring payloads; keeps a trailing partial one for the next chunk. */
export class NetstringReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: string[] = [];
    for (;;) {
      const colon = this.buffer.indexOf(":");
      if (colon < 0) break;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (!Number.isInteger(length) || length < 0 || length > 1_000_000) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      const end = colon + 1 + length;
      if (this.buffer.length < end + 1) break;
      out.push(this.buffer.subarray(colon + 1, end).toString("utf8"));
      this.buffer = this.buffer.subarray(end + 1);
    }
    return out;
  }
}

export interface BaresipEvent {
  type: string;
  param: string;
  direction: string;
}

export function parseEvent(payload: string): BaresipEvent | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (value.event !== true || typeof value.type !== "string") return null;
    return {
      type: value.type,
      param: typeof value.param === "string" ? value.param : "",
      direction: typeof value.direction === "string" ? value.direction : "",
    };
  } catch {
    return null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(port: number, child: ChildProcess): Promise<net.Socket> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error("baresip exited before it was ready");
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch {
      await delay(150);
    }
  }
  throw new Error("baresip's control port never opened");
}

export class BaresipLine {
  constructor(
    private readonly config: LineConfig,
    private readonly speaker: Speaker,
  ) {}

  /** Rings `callee` and runs the dialog on the keypad until it ends. Never throws. */
  async call(callee: string, dialog: CallDialog): Promise<CallResult> {
    if (!isSafeAccountValue(callee) || !/^[\w.+*#-]+$/.test(callee)) {
      return { status: "failed", reason: "The number to call is not one Squeak will dial." };
    }
    const runDir = path.join(this.config.dir, `call-${Date.now()}`);
    let child: ChildProcess | null = null;
    try {
      const first = dialog.start().find((a): a is Extract<DialogAction, { type: "play" }> => a.type === "play");
      const prompt = first ? await this.speaker.speak(first.text) : null;
      if (!prompt) return { status: "failed", reason: "There was nothing to say." };

      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const port = await freePort();
      fs.writeFileSync(path.join(runDir, "accounts"), accountsFile(this.config), { mode: 0o600 });
      fs.writeFileSync(
        path.join(runDir, "config"),
        configFile(this.config, port, prompt.file, path.join(runDir, "heard.wav")),
        { mode: 0o600 },
      );
      child = spawn(this.config.baresipPath, ["-f", runDir, "-c", "-t", String(Math.ceil(MAX_CALL_MS / 1000))], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      const keep = (chunk: Buffer): void => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      };
      child.stderr?.on("data", keep);
      child.stdout?.on("data", keep);
      const socket = await connectWithRetry(port, child);
      return await this.drive(socket, child, callee, dialog, prompt.durationMs, () => stderr);
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      child?.kill("SIGTERM");
      const stuck = child;
      setTimeout(() => stuck?.kill("SIGKILL"), 3000).unref();
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  }

  private drive(
    socket: net.Socket,
    child: ChildProcess,
    callee: string,
    dialog: CallDialog,
    firstMs: number,
    stderr: () => string,
  ): Promise<CallResult> {
    return new Promise<CallResult>((resolve) => {
      const reader = new NetstringReader();
      let registered = false;
      let established = false;
      let letter: string | null = null;
      let hangingUp = false;
      let keyTimer: NodeJS.Timeout | null = null;
      let chain: Promise<void> = Promise.resolve();

      const send = (command: string, params?: string): void => {
        socket.write(encodeNetstring({ command, ...(params ? { params } : {}) }));
      };
      const done = (result: CallResult): void => {
        if (keyTimer) clearTimeout(keyTimer);
        clearTimeout(registerTimer);
        clearTimeout(ringTimer);
        clearTimeout(hardTimer);
        socket.destroy();
        resolve(result);
      };
      const armKeyTimer = (afterMs: number): void => {
        if (keyTimer) clearTimeout(keyTimer);
        keyTimer = setTimeout(() => send("hangup"), afterMs + KEY_TIMEOUT_MS);
      };
      const registerTimer = setTimeout(
        () =>
          done({
            status: "failed",
            reason:
              `The PBX did not accept Squeak's extension in time. ${stderr().trim().split("\n").slice(-2).join(" ")}`.trim(),
          }),
        REGISTER_TIMEOUT_MS,
      );
      let ringTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
      const hardTimer = setTimeout(
        () => done(established ? { status: "answered", letter } : { status: "unanswered" }),
        MAX_CALL_MS,
      );

      const play = async (text: string): Promise<number> => {
        const speech = await this.speaker.speak(text);
        send("ausrc", `aufile,${speech.file}`);
        return speech.durationMs;
      };
      const perform = async (action: DialogAction): Promise<void> => {
        if (action.type === "answer") {
          letter = action.letter;
          return;
        }
        if (action.type === "play") {
          armKeyTimer(await play(action.text));
          return;
        }
        hangingUp = true;
        if (action.text) await delay((await play(action.text)) + GOODBYE_PAD_MS);
        send("hangup");
      };

      socket.on("data", (chunk: Buffer) => {
        for (const payload of reader.push(chunk)) {
          const event = parseEvent(payload);
          if (!event) continue;
          switch (event.type) {
            case "REGISTER_OK":
              if (!registered) {
                registered = true;
                clearTimeout(registerTimer);
                ringTimer = setTimeout(() => send("hangup"), RING_TIMEOUT_MS);
                send("dial", `sip:${callee}@${this.config.host}`);
              }
              break;
            case "REGISTER_FAIL":
              done({
                status: "failed",
                reason: `The PBX refused Squeak's extension (${event.param || "no reason"}). Check the extension, authentication ID and password.`,
              });
              break;
            case "CALL_ESTABLISHED":
              established = true;
              clearTimeout(ringTimer);
              armKeyTimer(firstMs);
              break;
            case "CALL_DTMF_START":
              if (established && !hangingUp && event.param) {
                const digit = event.param.trim().slice(0, 1);
                chain = chain
                  .then(async () => {
                    for (const action of dialog.key(digit)) await perform(action);
                  })
                  .catch((error: unknown) => {
                    logger.warn("voice dialog step failed", {
                      error: error instanceof Error ? error.message : String(error),
                    });
                  });
              }
              break;
            case "CALL_CLOSED":
              done(established ? { status: "answered", letter } : { status: "unanswered" });
              break;
            default:
              break;
          }
        }
      });
      socket.on("error", () => done({ status: "failed", reason: "Lost baresip's control connection." }));
      child.on("exit", () =>
        done(
          established
            ? { status: "answered", letter }
            : {
                status: "failed",
                reason: `baresip stopped. ${stderr().trim().split("\n").slice(-2).join(" ")}`.trim(),
              },
        ),
      );
    });
  }
}
