import { describe, expect, it } from "vitest";

import { joinOptions, matchPick, pickMiss, pickQuestion, words, type PickMenu } from "./voice-pick.js";

const workspaces: PickMenu = {
  options: [
    { n: 1, label: "squeak" },
    { n: 2, label: "motion graphics skill" },
    { n: 3, label: "release notes" },
  ],
  extras: ["other"],
};
const chats: PickMenu = {
  options: [
    { n: 1, label: "Telegram Cliq content difference" },
    { n: 2, label: "UI planning" },
    { n: 3, label: "Telegram bot setup" },
    { n: 4, label: "Fix 2 bugs in the importer" },
  ],
  extras: ["new", "back"],
};

describe("numbers and ordinals", () => {
  it.each([
    ["one", 1],
    ["Two.", 2],
    ["3", 3],
    ["the first one", 1],
    ["number three", 3],
    ["the second one", 2],
    ["option 2, please", 2],
    ["I'll take the third", 3],
  ])("%s picks %s", (said, n) => {
    expect(matchPick(said, workspaces)).toEqual({ choice: n });
  });

  it("picks nothing for a number that is not on the menu, or two different ones", () => {
    expect(matchPick("five", workspaces)).toEqual({});
    expect(matchPick("zero", workspaces)).toEqual({});
    expect(matchPick("one or two", workspaces)).toEqual({});
  });
});

describe("names", () => {
  it.each([
    ["squeak", 1],
    ["Squeak.", 1],
    ["the squeak one", 1],
    ["motion graphics", 2],
    ["motion", 2],
    ["the release one", 3],
    ["release notes please", 3],
    ["squik", undefined],
    ["skwueak", undefined],
    ["graphiks", 2],
  ])("%s on the workspaces picks %s", (said, n) => {
    expect(matchPick(said, workspaces)).toEqual(n === undefined ? {} : { choice: n });
  });

  it("takes a partial name that only one chat has, and the longer name when two share a word", () => {
    expect(matchPick("the cliq one", chats)).toEqual({ choice: 1 });
    expect(matchPick("planning", chats)).toEqual({ choice: 2 });
    expect(matchPick("ui", chats)).toEqual({ choice: 2 });
    expect(matchPick("telegram bot", chats)).toEqual({ choice: 3 });
    expect(matchPick("importer", chats)).toEqual({ choice: 4 });
  });

  it("is no choice when two chats are equally good", () => {
    expect(matchPick("telegram", chats)).toEqual({});
  });

  it("is no choice when it names two things", () => {
    expect(matchPick("squeak or motion graphics", workspaces)).toEqual({});
  });

  it("does not take a digit in a label for the number said", () => {
    expect(matchPick("two", chats)).toEqual({ choice: 2 });
    expect(matchPick("fix the bugs", chats)).toEqual({ choice: 4 });
  });

  it("is a number and a name that agree: one answer; that disagree: none", () => {
    expect(matchPick("two, ui planning", chats)).toEqual({ choice: 2 });
    expect(matchPick("three, ui planning", chats)).toEqual({});
  });
});

describe("the menu's extras", () => {
  it.each([
    ["new chat", { action: "new" }],
    ["a new one", { action: "new" }],
    ["start a new chat", { action: "new" }],
    ["go back", { action: "back" }],
    ["back", { action: "back" }],
    ["repeat", { action: "repeat" }],
    ["say that again", { action: "repeat" }],
    ["hang up", { action: "hangup" }],
    ["bye", { action: "hangup" }],
    ["nothing", { action: "hangup" }],
    ["never mind", { action: "hangup" }],
  ])("%s on a chat menu is %j", (said, result) => {
    expect(matchPick(said, chats)).toEqual(result);
  });

  it("takes 'another chat' or 'something else' on a menu that offers other chats, and only there", () => {
    expect(matchPick("something else", workspaces)).toEqual({ action: "other" });
    expect(matchPick("another chat", workspaces)).toEqual({ action: "other" });
    expect(matchPick("something else", chats)).toEqual({});
  });

  it("offers new and back only where the menu has them", () => {
    expect(matchPick("new chat", workspaces)).toEqual({});
    expect(matchPick("go back", workspaces)).toEqual({});
    expect(matchPick("new chat", { options: chats.options, extras: [] })).toEqual({});
    // Repeat and hang up are always there.
    expect(matchPick("repeat", { options: [], extras: [] })).toEqual({ action: "repeat" });
  });

  it("is none when an extra and a number disagree", () => {
    expect(matchPick("two or hang up", workspaces)).toEqual({});
  });
});

describe("garbage", () => {
  it.each(["", "   ", "hmm", "the quick brown fox", "thank you for watching", "banana", "..."])(
    "%j picks nothing",
    (said) => {
      expect(matchPick(said, workspaces)).toEqual({});
      expect(matchPick(said, chats)).toEqual({});
    },
  );

  it("picks nothing from a long ramble that happens to contain a name", () => {
    const ramble =
      "so yesterday I was thinking about how the squeak thing works and whether it makes sense at all really";
    expect(matchPick(ramble, workspaces)).toEqual({});
  });
});

describe("how a menu is spoken", () => {
  it("joins names the way a person lists them", () => {
    expect(joinOptions(["a"])).toBe("a");
    expect(joinOptions(["a", "b"])).toBe("a or b");
    expect(joinOptions(["a", "b", "c"])).toBe("a, b, or c");
  });

  it("asks as a question, with the options last", () => {
    expect(pickQuestion("Which workspace?", ["squeak", "motion graphics skill", "release notes"])).toBe(
      "Which workspace? squeak, motion graphics skill, or release notes?",
    );
    expect(pickMiss(["squeak", "release notes"])).toBe("Sorry, which one? squeak or release notes?");
  });

  it("reads words as said", () => {
    expect(words("Don't — stop!")).toEqual(["dont", "stop"]);
  });
});
