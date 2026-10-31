import type { CallResult } from "./baresip-line.js";
import type { CallDialog, DialogAction } from "./dialog.js";
import type { Clip } from "./clips.js";

/**
 * A phone call as a program sees it: say something, wait for a key, record the other side. The SIP details
 * live in `sip-phone.ts`; the two things that talk on the phone (the outbound dialog and the call-in flow) only
 * use this, so they are tested with a fake.
 */
export interface PhoneCall {
  /** The other party's user part: an extension like "35210". */
  readonly peer: string;
  readonly open: boolean;
  /** Settles when the call ends, whoever ends it. */
  readonly closed: Promise<void>;
  /** Speaks; resolves when done, or at once when a key is pressed (the key stays queued) or the call ends. */
  say(text: string): Promise<void>;
  /** The next key, queued ones first; null on timeout or when the call ends. */
  key(timeoutMs: number): Promise<string | null>;
  beep(): Promise<void>;
  /**
   * Records what the other side says until `#`, the limit, or hang-up. Null if they hung up (nothing worth
   * keeping: they cannot confirm it). With `endOnSilence` it also ends on end-of-speech (`silence`: speech was heard,
   * then a quiet spell) or when nothing at all was heard after the beep (`no-speech`).
   */
  record(options: {
    maxMs: number;
    beep?: boolean;
    endOnSilence?: boolean;
  }): Promise<{ file: string; durationMs: number; ended: RecordEnd } | null>;
  /** Where the call writes a line for the call log (set by the flow that owns the call); absent: nothing is logged. */
  trace?: ((line: string) => void) | null;
  /**
   * True while the other side is typing something secret (a PIN): a digit is then logged as "digit" rather than
   * itself. `#` and `*` are always named.
   */
  redactKeys?: boolean;
  hangup(): Promise<void>;
}

/** Why a recording stopped: a hash, a quiet spell after speech, the cap, or nothing was said at all. */
export type RecordEnd = "key" | "limit" | "silence" | "no-speech";

/** What the add-on and the Mac both say when the line is busy, so the Mac knows to wait rather than give up. */
export const LINE_BUSY_REASON = "The line is busy with another call.";

export interface IncomingCall {
  /** The caller's user part (an extension), as the PBX names it. */
  readonly peer: string;
  /** The raw peer URI, for the log when a caller is refused. */
  readonly uri: string;
  answer(): Promise<PhoneCall>;
  reject(): Promise<void>;
}

export type DialOutcome =
  | { status: "connected"; call: PhoneCall }
  | { status: "unanswered" }
  | { status: "failed"; reason: string };

export interface Phone {
  start(): void;
  stop(): void;
  dial(callee: string): Promise<DialOutcome>;
  onIncoming(handler: (incoming: IncomingCall) => void): void;
  /** Makes these prompts ahead of time so they are ready the moment a call connects. */
  prewarm?(texts: readonly string[]): void;
  /** The Mac's own recordings of a call's words, played in place of making them here. */
  seed?(clips: readonly Clip[]): void;
}

/** After a prompt ends, how long to wait for a key. */
export const KEY_TIMEOUT_MS = 25_000;

/**
 * Digits up to `#`: a PIN. `*` clears what was typed. Null on a pause longer than the timeout or a hang-up;
 * the `#` itself is not part of the answer.
 */
export async function readDigits(
  call: PhoneCall,
  options: { maxLength: number; timeoutMs: number },
): Promise<string | null> {
  let typed = "";
  for (;;) {
    const key = await call.key(options.timeoutMs);
    if (key === null) return null;
    if (key === "#") return typed;
    if (key === "*") typed = "";
    else if (/^\d$/.test(key) && typed.length < options.maxLength) typed += key;
  }
}

/** The outbound dialog (script.ts / dialog.ts) on a connected call: what `BaresipLine` does, on the shared phone. */
export async function runDialog(
  call: PhoneCall,
  dialog: CallDialog,
  trace?: (line: string) => void,
  /**
   * Runs a follow-up the person asked for (a message for the chat, or its status). "back": the question is asked
   * again; "ended": the follow-up finished the call (a message sent says goodbye). Absent: the keys do nothing.
   */
  followUp?: (kind: "message" | "status") => Promise<"back" | "ended">,
): Promise<CallResult> {
  let letter: string | null = null;
  call.trace = trace ?? null;
  // The outbound dialog may be taking a PIN: digits are not written down, only that keys arrived and where.
  call.redactKeys = true;
  let actions: DialogAction[] = dialog.start();
  while (call.open) {
    // A follow-up that came back swaps in the question again, said at once rather than after waiting for a key.
    let again = false;
    for (const action of actions) {
      if (action.type === "answer") {
        letter = action.letter;
        trace?.(`key: ${action.letter} chosen`);
      } else if (action.type === "play") {
        trace?.(`said: ${action.text}`);
        await call.say(action.text);
      } else if (action.type === "follow") {
        trace?.(`key: ${action.kind === "message" ? "9 (your own message)" : "0 (status)"}`);
        const outcome = followUp ? await followUp(action.kind) : "back";
        if (outcome === "ended") {
          await call.hangup();
          return { status: "answered", letter };
        }
        actions = dialog.replay();
        again = true;
        break;
      } else {
        if (action.text) {
          trace?.(`said: ${action.text}`);
          await call.say(action.text);
        }
        await call.hangup();
        return { status: "answered", letter };
      }
    }
    if (again) continue;
    const key = await call.key(KEY_TIMEOUT_MS);
    if (key === null) break;
    actions = dialog.key(key);
  }
  await call.hangup();
  return { status: "answered", letter };
}
