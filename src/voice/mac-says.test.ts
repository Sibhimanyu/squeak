import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { inboundPrompts, SAYS, uploadPrompts } from "./inbound-flow.js";
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

describe("what the Mac says is not uploaded; what the add-on says is", () => {
  const prompts = new Set(inboundPrompts(directory, true));
  const uploaded = new Set(uploadPrompts(directory));

  it("covers the add-on's own lines (the keypad flows and the talk flow)", () => {
    for (const text of [...Object.values(SAYS), ...Object.values(TALK_SAYS)]) expect(prompts, text).toContain(text);
  });

  it("leaves every line that comes from the Mac out of the prompt set: its clip rides in the message", () => {
    for (const text of macFixedSays()) {
      // A few are also the add-on's own words ("Goodbye."); those stay.
      if (Object.values(SAYS).includes(text) || Object.values(TALK_SAYS).includes(text)) continue;
      expect(prompts, text).not.toContain(text);
      expect(uploaded, text).not.toContain(text);
    }
    for (const text of macLabelSays("squeak · voice")) expect(uploaded, text).not.toContain(text);
    expect(uploaded).not.toContain("That list is out of date. Call again. Goodbye.");
  });

  it("leaves no refusal as a literal at the point of use", () => {
    const source = fs.readFileSync(path.join(__dirname, "memo-inbox.ts"), "utf8");
    expect(source).not.toMatch(/refuse\(\s*message\.id,\s*["`]/);
    expect(source).not.toMatch(/reply\(\s*"[^"]/);
  });
});
