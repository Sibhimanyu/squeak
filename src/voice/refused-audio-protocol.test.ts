import { describe, expect, it } from "vitest";

import { generateChannel } from "../remote/remote-crypto.js";
import { readDown, sealDown } from "./memo-protocol.js";

const { key } = generateChannel();
const clip = (text: string) => ({ text, mulaw: Buffer.alloc(10, 0xff).toString("base64") });
const at = 1_800_000_000_000;

describe("a refusal with the Mac's clip", () => {
  it("round-trips a clip that says exactly the reason", () => {
    const sealed = sealDown(key, { v: 1, id: "a", at, status: "refused", reason: "No.", audio: clip("No.") });
    expect(readDown(key, "a", sealed)).toMatchObject({ status: "refused", reason: "No.", audio: { text: "No." } });
  });

  it("drops a clip of other words, and still reads the refusal", () => {
    const sealed = sealDown(key, { v: 1, id: "a", at, status: "refused", reason: "No.", audio: clip("Yes.") });
    const read = readDown(key, "a", sealed);
    expect(read).toMatchObject({ status: "refused", reason: "No." });
    expect(read && "audio" in read).toBe(false);
  });

  it("reads an old refusal with no clip", () => {
    const sealed = sealDown(key, { v: 1, id: "a", at, status: "refused", reason: "No." });
    expect(readDown(key, "a", sealed)).toEqual({ v: 1, id: "a", at, status: "refused", reason: "No." });
  });
});
