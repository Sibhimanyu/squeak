import type { CallResult } from "./baresip-line.js";
import type { CallDialog, DialogAction } from "./dialog.js";

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
   * keeping: they cannot confirm it).
   */
  record(options: { maxMs: number }): Promise<{ file: string; durationMs: number; ended: "key" | "limit" } | null>;
  hangup(): Promise<void>;
}

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
export async function runDialog(call: PhoneCall, dialog: CallDialog): Promise<CallResult> {
  let letter: string | null = null;
  let actions: DialogAction[] = dialog.start();
  while (call.open) {
    for (const action of actions) {
      if (action.type === "answer") {
        letter = action.letter;
      } else if (action.type === "play") {
        await call.say(action.text);
      } else {
        if (action.text) await call.say(action.text);
        await call.hangup();
        return { status: "answered", letter };
      }
    }
    const key = await call.key(KEY_TIMEOUT_MS);
    if (key === null) break;
    actions = dialog.key(key);
  }
  await call.hangup();
  return { status: "answered", letter };
}
