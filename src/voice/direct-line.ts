import type { BaresipLine, CallResult } from "./baresip-line.js";
import { CallDialog, type CallScript } from "./dialog.js";
import type { VoiceLine } from "./relay-line.js";

/** The Mac places the call itself, which needs a route to the PBX (at home, or over a VPN). */
export class DirectLine implements VoiceLine {
  constructor(
    private readonly line: Pick<BaresipLine, "call">,
    private readonly callee: () => string,
    private readonly pin: string | null,
  ) {}

  call(script: CallScript, answerable: boolean): Promise<CallResult> {
    return this.line.call(this.callee(), new CallDialog(script, answerable ? this.pin : null));
  }
}
