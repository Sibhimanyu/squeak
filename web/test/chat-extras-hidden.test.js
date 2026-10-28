import { describe, expect, it } from "vitest";

import { hiddenChats, hiddenCount, hideChange, isHiddenHere, showHiddenAgainChange } from "../js/hidden-chats.js";
import { readTurn } from "../js/live.js";

describe("chats hidden on this browser", () => {
  it("reads only a clean map, and hides until newer activity", () => {
    expect(hiddenChats(null)).toEqual({});
    expect(hiddenChats([1])).toEqual({});
    expect(hiddenChats({ a: 5, b: "x", c: NaN })).toEqual({ a: 5 });
    const hidden = hiddenChats(hideChange({}, { key: "k" }, 1_000).hiddenChats);
    expect(isHiddenHere(hidden, { key: "k", lastActivityAt: new Date(900).toISOString() })).toBe(true);
    expect(isHiddenHere(hidden, { key: "k", lastActivityAt: new Date(2_000).toISOString() })).toBe(false);
    expect(isHiddenHere(hidden, { key: "other", lastActivityAt: new Date(0).toISOString() })).toBe(false);
    expect(hiddenCount(hidden)).toBe(1);
    expect(showHiddenAgainChange()).toEqual({ hiddenChats: {} });
  });

  it("keeps a history entry's cursor from the live turn", () => {
    const turn = readTurn(
      {
        v: 1,
        key: "k",
        working: false,
        total: 0,
        steps: [],
        history: [{ id: "42", role: "user", text: "hi", at: null }],
      },
      "k",
    );
    expect(turn.history[0].id).toBe("42");
  });
});
