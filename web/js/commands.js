// A thin, typed API over the signed commands (everything but a chat reply,
// stop, rename and queue change, which sends.js owns because a reply has a
// message on screen). `commands.start({...})`, `commands.controls({ change: { volume: 40 } })`:
// each builds and checks the command (command-shapes.js), sends it through
// `Sync.deliver` and waits for the Mac's answer in the results document.
//
// What every method returns, and never throws:
//   { ok, status, result, reason, retrySafe, unconfirmed }
//   ok          the Mac did it ("sent" or "answered");
//   status      the Mac's own word, or "invalid" (checked here, nothing sent), "failed" (the write failed and
//               the command was proven taken back), "withdrawn" (the Mac stayed silent, so the command was
//               taken back and can never run), "unconfirmed" (nothing can be proven: it may have run);
//   result      the Mac's whole answer, for fields like `sessionId`, `ref`, `stats`, `image`, `doc`;
//   reason      a sentence for the person when not ok;
//   retrySafe   true only when the command provably did not run. An ambiguous command is NEVER sent again by
//               this module, and a screen must not offer "Send again" unless retrySafe.

import { CommandInputError } from "./command-shapes.js";
import { COMMAND_KINDS } from "./command-shapes.js";
import { COULDNT_CONFIRM, sentence } from "./send-state.js";

/**
 * What the Mac enforces per kind, so a screen can pace itself. `limit` per `perMs` per device is a hard
 * refusal on the Mac (attach: 40 chunks a minute); `minGapMs` is a minimum gap between two (a new chat and an
 * answer: 15 s; the Telegram photo: 30 s). Absent: no limit beyond the Mac's own busy checks.
 */
export const RATE_HINTS = Object.freeze({
  attach: { limit: 40, perMs: 60_000 },
  start: { minGapMs: 15_000 },
  answer: { minGapMs: 15_000 },
  telegramAvatar: { minGapMs: 30_000 },
  history: { note: "one page at a time per chat" },
  media: { note: "one at a time" },
  usage: { minGapMs: 60_000, note: "the Mac refreshes at most once a minute whoever asks" },
});

const NOT_ANSWERED = "Your Mac didn't answer. Is Squeak running?";

/** How an answer reads, whatever the Mac wrote (garbage included). */
export function outcomeOf(result) {
  const status =
    result && typeof result === "object" && typeof result.status === "string" ? result.status : "unconfirmed";
  const ok = status === "sent" || status === "answered";
  if (ok) return { ok: true, status, result, reason: null, retrySafe: false, unconfirmed: false };
  if (status === "refused") {
    const reason = sentence(result.reason) || "Your Mac refused that.";
    return { ok: false, status, result, reason, retrySafe: true, unconfirmed: false };
  }
  if (status === "withdrawn") {
    return {
      ok: false,
      status,
      result: null,
      reason: `${NOT_ANSWERED} Nothing was done.`,
      retrySafe: true,
      unconfirmed: false,
    };
  }
  return {
    ok: false,
    status: "unconfirmed",
    result: null,
    reason: COULDNT_CONFIRM,
    retrySafe: false,
    unconfirmed: true,
  };
}

export class Commands {
  /** @param sync a Sync (its `deliver`, `channel` and `signingKey`); @param now a clock, for the local pacing */
  constructor({ sync, now = () => Date.now() }) {
    this.sync = sync;
    this.now = now;
    /** kind -> epoch ms of this browser's recent sends of it (only for kinds with a hint) */
    this.sent = new Map();
  }

  /** The Mac's limits for a kind (`RATE_HINTS`), or null. */
  hint(kind) {
    return RATE_HINTS[kind] ?? null;
  }

  /** Milliseconds until this browser may send `kind` without the Mac refusing it for rate; 0 when now. */
  waitMs(kind) {
    const hint = RATE_HINTS[kind];
    const times = this.sent.get(kind) ?? [];
    if (!hint || times.length === 0) return 0;
    const now = this.now();
    let wait = 0;
    if (hint.minGapMs) wait = Math.max(wait, times[times.length - 1] + hint.minGapMs - now);
    if (hint.limit) {
      const recent = times.filter((at) => now - at < hint.perMs);
      if (recent.length >= hint.limit) wait = Math.max(wait, recent[recent.length - hint.limit] + hint.perMs - now);
    }
    return Math.max(0, Math.ceil(wait));
  }

  /** Resolves when `kind` may be sent (used between photo chunks). */
  async throttle(kind, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    for (let wait = this.waitMs(kind); wait > 0; wait = this.waitMs(kind)) await sleep(wait);
  }

  #note(kind) {
    if (!RATE_HINTS[kind]) return;
    const now = this.now();
    const keep = (this.sent.get(kind) ?? []).filter((at) => now - at < 60_000);
    this.sent.set(kind, [...keep, now]);
  }

  /** Builds, sends and waits. See the file's header for the result. */
  async run(kind, input) {
    let id = null;
    try {
      const result = await this.sync.deliver(
        async () => {
          // Checked before anything is sealed: a bad input never reaches the channel.
          const made = await this.sync.channel.commandDocument(kind, input, this.sync.signingKey);
          this.#note(kind);
          return made;
        },
        { onId: (value) => (id = value) },
      );
      return outcomeOf(result);
    } catch (error) {
      if (error instanceof CommandInputError) {
        return {
          ok: false,
          status: "invalid",
          result: null,
          reason: error.message,
          retrySafe: true,
          unconfirmed: false,
        };
      }
      // Only reached when the write failed and the command was proven taken back (or never made).
      return {
        ok: false,
        status: "failed",
        result: null,
        reason: id ? "Couldn't reach your Mac's server. Nothing was done." : "Couldn't reach your Mac.",
        retrySafe: true,
        unconfirmed: false,
      };
    }
  }
}

/** `commands.start(input)`: one method per kind, named as the kind. */
export function createCommands(options) {
  const commands = new Commands(options);
  for (const kind of COMMAND_KINDS) {
    commands[kind] = (input = {}) => commands.run(kind, input);
  }
  return commands;
}
