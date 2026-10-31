import { describe, expect, it } from "vitest";

import { CallDialog } from "./dialog.js";
import { ASK_FAILED, inboundPrompts, readBackSentence } from "./inbound-flow.js";
import { fixedPhrases } from "./natural-voice.js";
import { composeCallbackScript, composeScript } from "./script.js";
import { moodFor, moodOf } from "./voice-mood.js";

describe("moodOf", () => {
  it("reads the mood of Squeak's own lines", () => {
    const cases: Array<[string, string]> = [
      ["Blume is waiting for your approval.", "urgent"],
      ["Hello, this is Squeak. Fix the parser needs an answer. Which way should we go?", "urgent"],
      ["Fix the parser has a question for you.", "urgent"],
      ["Fix the parser is done, as you asked. All the tests pass.", "cheerful"],
      ["Sent A. Goodbye.", "cheerful"],
      ["Done. Your message was sent to Fix the parser. Goodbye.", "cheerful"],
      ["That PIN is not right. Try again, then press hash.", "apologetic"],
      ["That PIN is not right. Goodbye.", "apologetic"],
      ["Sorry, I did not get that.", "apologetic"],
      ["Blume stopped on an error.", "sympathetic"],
      ["I could not reach your Mac. Goodbye.", "sympathetic"],
      ["Something went wrong.", "sympathetic"],
      [ASK_FAILED, "sympathetic"],
      ["Goodbye.", "warm"],
      ["Okay, I'll call you back when it is done.", "warm"],
      ["It's taking a while, so I'll let you go.", "warm"],
      ["Still working on it.", "warm"],
      ["Cancelled. Goodbye.", "warm"],
      ["Options. 1, Merge now, recommended. 2, Open a PR first.", "neutral"],
      ["Press star to hear this again", "neutral"],
      ["Please enter your PIN, then press hash. Press star to start over.", "neutral"],
      ["Press 1 to send it to Blume, 2 to record again, star to hear it again, or hash to cancel.", "neutral"],
    ];
    for (const [text, mood] of cases) expect(moodOf(text), text).toBe(mood);
  });

  it("gives every real call line a mood, and every mood is reached", () => {
    const script = {
      greeting: "Hello, this is Squeak. Blume needs an answer.",
      question: "Which way? Options. 1, Merge. 2, Open a PR. Press star to hear this again, or hash to hang up.",
      options: [{ letter: "A", title: "Merge" }],
    };
    const lines = [
      ...fixedPhrases(),
      ...inboundPrompts({ items: [{ n: 1, label: "Blume" }] } as never, true),
      ...new CallDialog(script, "1234", true).prompts(),
      readBackSentence("go ahead", "Blume"),
      composeCallbackScript({ state: "finished" } as never, "All done.", true).greeting,
      composeCallbackScript({ state: "error" } as never, "It broke.", false).greeting,
      composeScript({ kind: "blocked_approval", session: { title: "Blume" } } as never, null, false).greeting,
    ];
    const seen = new Set<string>();
    for (const line of lines) {
      const mood = moodOf(line);
      expect(["urgent", "cheerful", "apologetic", "sympathetic", "warm", "neutral"]).toContain(mood);
      seen.add(mood);
    }
    expect([...seen].sort()).toEqual(["apologetic", "cheerful", "neutral", "sympathetic", "urgent", "warm"]);
  });

  it("turns emotion off into neutral for every line", () => {
    expect(moodFor("Blume needs an answer.", "off")).toEqual({ mood: "neutral", level: "off" });
    expect(moodFor("Blume needs an answer.", "strong")).toEqual({ mood: "urgent", level: "strong" });
  });
});
