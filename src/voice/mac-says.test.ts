import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { inboundPrompts, SAYS } from "./inbound-flow.js";
import { macFixedSays, macLabelSays } from "./mac-says.js";
import type { DirectoryDoc } from "./memo-protocol.js";
import { TALK_SAYS } from "./talk-flow.js";

const directory = {
  v: 1,
  at: 0,
  version: "v1",
  caller: "35210",
  ask: true,
  talk: true,
  items: [{ n: 1, label: "squeak · voice" }],
  workspaces: [
    { n: 1, label: "squeak", newChat: true, chats: [{ n: 1, label: "squeak · voice" }] },
    { n: 2, label: "blume", newChat: true, chats: [] },
  ],
} as unknown as DirectoryDoc;

describe("every fixed sentence of a call is recorded by the Mac", () => {
  const prompts = new Set(inboundPrompts(directory, true));

  it("covers the add-on's own lines (the keypad flows and the talk flow)", () => {
    for (const text of [...Object.values(SAYS), ...Object.values(TALK_SAYS)]) expect(prompts, text).toContain(text);
  });

  it("covers every fixed sentence the Mac sends down without audio", () => {
    for (const text of macFixedSays()) expect(prompts, text).toContain(text);
  });

  it("covers the sentences that name a chat, for each chat of the list", () => {
    for (const label of ["squeak · voice"])
      for (const text of macLabelSays(label)) expect(prompts, text).toContain(text);
  });

  it("covers a refusal said before Goodbye in the new-chat flow", () => {
    expect(prompts).toContain("That list is out of date. Call again. Goodbye.");
  });

  it("keeps the fixed lines ahead of the per-chat ones, which a long list can push past the audio documents", () => {
    const list = inboundPrompts(directory, true);
    expect(list.indexOf(SAYS.wait)).toBeLessThan(
      list.indexOf("Done. Your message was sent to squeak · voice. Goodbye."),
    );
  });

  it("leaves no refusal as a literal at the point of use", () => {
    const source = fs.readFileSync(path.join(__dirname, "memo-inbox.ts"), "utf8");
    expect(source).not.toMatch(/refuse\(\s*message\.id,\s*["`]/);
    expect(source).not.toMatch(/reply\(\s*"[^"]/);
  });
});
