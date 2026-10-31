import { describe, expect, it } from "vitest";

import { item, QUESTION } from "./fixtures.js";
import { CallDialog, clipOption, clipQuestion, composeScript, FULL_TEXT_NOTE, shouldCall } from "./script.js";

describe("shouldCall", () => {
  it("rings only for what waits on you", () => {
    expect(shouldCall(item("blocked_approval"))).toBe(true);
    expect(shouldCall(item("blocked_question"))).toBe(true);
    expect(shouldCall(item("asked_question"))).toBe(true);
    expect(shouldCall(item("finished_unreviewed"))).toBe(false);
    expect(shouldCall(item("stalled"))).toBe(false);
    expect(shouldCall(item("errored"))).toBe(false);
  });
});

describe("composeScript", () => {
  it("reads the question and one key per lettered option", () => {
    const script = composeScript(item(), QUESTION, true);
    expect(script.greeting).toContain("squeak has a question");
    expect(script.question).toContain("Which one?");
    expect(script.question).toContain("Options. 1, Merge now, recommended. 2, Open a PR first.");
    expect(script.question).not.toContain(FULL_TEXT_NOTE);
    expect(script.options.map((o) => o.letter)).toEqual(["A", "B"]);
  });

  it("offers a message (9) and the status (0) only when asked to and keys may answer", () => {
    const script = composeScript(item(), QUESTION, true, true);
    expect(script.question).toContain(
      "Press 9 to send a message or ask a question about it, or 0 to hear where it stands.",
    );
    expect(script.followUp).toEqual({ label: expect.stringContaining("squeak") });
    expect(composeScript(item(), QUESTION, true).followUp).toBeUndefined();
    expect(composeScript(item(), QUESTION, false, true).followUp).toBeUndefined();
    expect(composeScript(item(), QUESTION, false, true).question).not.toContain("Press 9");
  });

  it("offers no keys when a reply cannot go back, and says where to answer", () => {
    const script = composeScript(item(), QUESTION, false);
    expect(script.options).toEqual([]);
    expect(script.question).toContain("Open Squeak to answer.");
    expect(script.question).not.toContain("Press 1");
  });

  it("tells an approval to be given elsewhere", () => {
    const script = composeScript(item("blocked_approval"), null, false);
    expect(script.greeting).toContain("waiting for your approval");
    expect(script.question).toContain("Approve it from the Mac or the phone app.");
  });
});

describe("a shorter call", () => {
  const LONG = [
    "Okay, so I'm not releasing without your word, because it would go out together with whatever the other chat has committed by the time the build finishes and that may include unrelated work. The daemon and the uninstaller both changed. Let me know what you think.",
    "Release both?",
    "",
    "A) Yes, both: ship the daemon and the uninstaller together (recommended)",
    "B) Only the daemon",
    "C) Only the uninstaller — leave the rest",
  ].join("\n");

  it("speaks the question and the options tersely", () => {
    const script = composeScript(item(), LONG, true);
    expect(script.question).toContain("Release both?");
    expect(script.question).toContain(
      "Options. 1, Yes, both, recommended. 2, Only the daemon. 3, Only the uninstaller.",
    );
    expect(script.question).toContain("Press star to hear this again, or hash to hang up.");
    expect(script.question.split(/\s+/).length).toBeLessThan(60);
  });

  it("with no options, keeps the closing question of a long message and says the full text is on the phone", () => {
    const script = composeScript(item(), LONG.split("\n")[0] + " Release both?", false);
    expect(script.question).toContain("Release both?");
    expect(script.question).toContain(FULL_TEXT_NOTE);
    expect(script.question).not.toContain("Let me know");
    expect(script.question).toContain("Open Squeak to answer.");
    expect(script.question.split(/\s+/).length).toBeLessThan(70);
  });

  it("cuts a long question at a sentence boundary, never mid-word", () => {
    const text = "First point here. Second point goes on for a while with several more words in it. ".repeat(6);
    const { text: out, cut } = clipQuestion(text);
    expect(cut).toBe(true);
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(35);
    expect(out).toMatch(/[.!?]$/);
    expect(text.startsWith(out)).toBe(true);
  });

  it("cuts one endless sentence at a clause or a word", () => {
    const sentence = `${"alpha bravo charlie delta, ".repeat(5)}${"echo ".repeat(40)}`;
    const { text, cut } = clipQuestion(sentence);
    expect(cut).toBe(true);
    expect(words(text)).toBeLessThanOrEqual(35);
    expect(text).toMatch(/\w\.$/);
    expect(words(clipQuestion("x".repeat(500)).text)).toBe(1);
  });

  it("leaves a short question whole, minus filler and links", () => {
    expect(clipQuestion("Sure, should I merge https://example.com/pr/1 now?")).toEqual({
      text: "should I merge a link now?",
      cut: false,
    });
    expect(clipQuestion("").text).toBe("");
  });

  it("clips options to a few words and drops the explanation", () => {
    expect(clipOption("Only the uninstaller — leave the rest of it")).toBe("Only the uninstaller");
    expect(clipOption("Rebuild everything from scratch with a clean cache and retry later")).toBe(
      "Rebuild everything from scratch with a",
    );
    expect(clipOption("Yes!")).toBe("Yes");
  });
});

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

describe("CallDialog", () => {
  const script = composeScript(item(), QUESTION, true);

  it("asks for the PIN first and reveals the options only after it", () => {
    const dialog = new CallDialog(script, "1234");
    const [first] = dialog.start();
    expect(first).toMatchObject({ type: "play" });
    expect((first as { text: string }).text).not.toContain("Press 1");
    // A key before the PIN is just PIN input, never an answer.
    expect(dialog.key("1")).toEqual([]);
    expect(dialog.key("#")).toEqual([{ type: "play", text: "That PIN is not right. Try again, then press hash." }]);
    for (const digit of "1234") dialog.key(digit);
    expect(dialog.key("#")).toEqual([{ type: "play", text: script.question }]);
  });

  it("answers with the letter for the key and hangs up", () => {
    const dialog = new CallDialog(script, "1234");
    dialog.start();
    for (const digit of "1234") dialog.key(digit);
    dialog.key("#");
    expect(dialog.key("2")).toEqual([
      { type: "answer", letter: "B" },
      { type: "hangup", text: "Sent B. Goodbye." },
    ]);
    // Nothing more is taken after an answer.
    expect(dialog.key("1")).toEqual([]);
  });

  it("hangs up after two wrong PINs", () => {
    const dialog = new CallDialog(script, "1234");
    dialog.start();
    dialog.key("9");
    dialog.key("#");
    dialog.key("9");
    expect(dialog.key("#")).toEqual([{ type: "hangup", text: "That PIN is not right. Goodbye." }]);
    expect(dialog.key("1")).toEqual([]);
  });

  it("with no PIN set reads the question and takes no answer", () => {
    const dialog = new CallDialog(script, null);
    const [first] = dialog.start();
    expect((first as { text: string }).text).toContain("Which one?");
    expect(dialog.key("1")).toEqual([]);
    expect(dialog.key("*")).toEqual([{ type: "play", text: script.question }]);
    expect(dialog.key("#")).toEqual([{ type: "hangup" }]);
  });

  it("ignores a key with no option behind it", () => {
    const dialog = new CallDialog(script, "1234");
    dialog.start();
    for (const digit of "1234") dialog.key(digit);
    dialog.key("#");
    expect(dialog.key("7")).toEqual([]);
    expect(dialog.key("0")).toEqual([]);
  });
});

describe("a voice-first call", () => {
  it("is one short opening with no options or keys, and keeps the keypad's wording for a fallback", () => {
    const script = composeScript(item(), QUESTION, true, true, true);
    expect(script.voice).toBe(true);
    expect(script.question).toContain("Which one?");
    expect(script.question.endsWith("Just tell me what to do, or ask me anything about it.")).toBe(true);
    expect(script.question).not.toContain("Options");
    expect(script.question).not.toContain("Merge now");
    expect(script.question).not.toMatch(/press/i);
    expect(script.followUp).toEqual({ label: expect.stringContaining("squeak") });
    expect(script.options.map((o) => o.letter)).toEqual(["A", "B"]);
    expect(script.keypad).toContain("Options. 1, Merge now, recommended. 2, Open a PR first.");
    expect(script.keypad).toContain("Press star to hear this again, or hash to hang up.");
  });

  it("is the keypad call as always when keys cannot answer, or voice is not asked for", () => {
    for (const script of [
      composeScript(item(), QUESTION, false, true, true),
      composeScript(item(), QUESTION, true, true),
    ]) {
      expect(script.voice).toBeUndefined();
      expect(script.keypad).toBeUndefined();
      expect(script.question).toContain("Press star");
    }
    expect(composeScript(item(), QUESTION, true, true).question).toContain("Options. 1,");
  });
});
