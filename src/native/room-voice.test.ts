import { describe, expect, it } from "vitest";

import { check, duckName, needsYouLine, personName, refusal, RULE, statusLine, waitingLine } from "./room-voice.js";

// The two real posts a Duck made in the owner's Room, and a plain rewrite of each.
const POST_ONE =
  "main moved to 831a4d9 with source-of-truth, small-fixes-mute-zoom-remove and meeting-audio-probe merged in; 1,859 tests pass. In CoordinatorController, the meeting-setup rewrite replaced resetPresenceBubbleToLayoutDefault with noteSetupMoment, and the R49.13 video flags now clear there. If your branch touches that code, rebase onto origin/main. Nothing has been released or tried in a live meeting yet.";
const POST_TWO =
  "main is now at a5027cf with two refactors that shouldn't change behaviour. CameraLook (App/Stage/CameraLook.swift) is now the one owner of background, picture, removal and mirror. 1,890 tests pass.";
const PLAIN_ONE =
  "The shared version now has the new meeting setup, the audio check and the small fixes (mute, zoom, remove). It is not released and nobody has tried it in a live meeting yet. If you were changing the meeting setup, tell me and I will help you catch up.";
const PLAIN_TWO =
  "I tidied up how the camera look is handled (background, picture, removal and mirror) so it lives in one place. It should work exactly as before, and everything we check automatically still passes.";

describe("RoomVoice.check", () => {
  it("refuses the two real posts, with a reason", () => {
    for (const post of [POST_ONE, POST_TWO]) {
      const v = check(post);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.rewrite.length).toBeGreaterThan(5);
    }
  });

  it("passes their plain rewrites", () => {
    expect(check(PLAIN_ONE)).toEqual({ ok: true });
    expect(check(PLAIN_TWO)).toEqual({ ok: true });
  });

  it("names the shape it found", () => {
    const why = (t: string): string => {
      const v = check(t);
      return v.ok ? "" : v.rewrite;
    };
    expect(why("Fixed in 831a4d9.")).toMatch(/commit code/);
    expect(why("Look in src/native/room.ts.")).toMatch(/file/);
    expect(why("Changed App/Stage/CameraLook.swift.")).toMatch(/file/);
    expect(why("Open ~/Documents/plan")).toMatch(/file/);
    expect(why("Run `npm test` first.")).toMatch(/code/);
    expect(why("It renamed resetBubble.")).toMatch(/code/);
    expect(why("It renamed reset_bubble.")).toMatch(/code/);
    expect(why("The CoordinatorController changed.")).toMatch(/code/);
    expect(why("Merged small-fixes-mute-zoom-remove today.")).toMatch(/branch/);
    expect(why("Rebase onto origin/main.")).toMatch(/file or branch|rebase/);
    expect(why("1,859 tests pass.")).toMatch(/test/);
    expect(why("All the tests pass now.")).toMatch(/test/);
    expect(why("Two ducklings are working.")).toMatch(/duckling/);
    expect(why("It joined the stream.")).toMatch(/stream/);
    expect(why("CI is red.")).toMatch(/CI/);
    expect(why("I rebased it.")).toMatch(/rebase/);
  });

  it("never refuses ordinary plain sentences", () => {
    const fine = [
      "Zoom setup is ready to try; open the meeting and tell me what you see.",
      "Version 1.10.8 of the app is out, with the new login screen.",
      "The release note for 1.10.8 is ready for you to read.",
      "I found 3 problems with the 12 pictures you sent, and fixed 2 of them.",
      "We have 24/7 cover and yes/no answers are fine.",
      "Please check it on your iPhone, your iPad and your Mac (macOS 15).",
      "It works with YouTube, GitHub, LinkedIn, WhatsApp and PowerPoint files.",
      "Node.js and Next.js are what the site is made with.",
      "The live stream and the video stream both play now.",
      "This is state-of-the-art, up-to-date and easy-to-use.",
      "Ask JoAnn or McDonald or DeShawn to try it. Order 4821 has shipped.",
      "See https://example.com/docs/guide.html or write to me@example.com.",
      "I ran the checks twice and they all passed, so it is ready to try.",
      "The meeting is at 3:30 and the budget is $1,859.",
      "Does the deadline (July 4) still work? Tell me what you need.",
      "It cost 1859 dollars, which was 4% less than the quote.",
    ];
    for (const t of fine) expect(check(t), t).toEqual({ ok: true });
  });

  it("refusal text tells the Duck what to do", () => {
    expect(refusal("it names a file")).toMatch(
      /^Not posted: rewrite this for a non-technical reader \(it names a file\)/,
    );
  });
});

describe("RoomVoice.RULE", () => {
  it("says who reads, what to say, and what never to write", () => {
    expect(RULE).toMatch(/not engineers/);
    expect(RULE).toMatch(/whether it is ready to try/);
    for (const word of [
      "commit hashes",
      "branch",
      "file",
      "test counts",
      "stream",
      "duckling",
      "rebase",
      "merge",
      "CI",
    ]) {
      expect(RULE).toContain(word);
    }
    expect(RULE).toMatch(/Bad:/);
    expect(RULE).toMatch(/Good:/);
  });

  it("its own good example passes the check", () => {
    const good = /Good: "([^"]+)"/.exec(RULE)![1]!;
    expect(check(good)).toEqual({ ok: true });
    const bad = /Bad: "([^"]+)"/.exec(RULE)![1]!;
    expect(check(bad).ok).toBe(false);
  });
});

describe("RoomVoice names", () => {
  it("a Duck uses its own name, else a short label from its title, never Claude or Codex", () => {
    expect(duckName("Upma", "Zoom setup")).toBe("Upma");
    expect(duckName(null, "fix the zoom setup for the new meeting flow")).toBe("Fix the zoom setup");
    expect(duckName(null, "Claude")).toBe("A Duck");
    expect(duckName("Codex", undefined)).toBe("A Duck");
    expect(duckName(undefined, null)).toBe("A Duck");
    expect(duckName(null, "src/native/room.ts cleanup")).toBe("A Duck");
    expect(duckName(null, "someone@example.com")).toBe("A Duck");
    expect(duckName("a@b.com", "Billing")).toBe("Billing");
  });

  it("a person is their name, else the part of the email before the @, never the address", () => {
    expect(personName("Asha Rao", "asha@example.com")).toBe("Asha Rao");
    expect(personName("", "asha.rao@example.com")).toBe("Asha");
    expect(personName(null, "sibhi_m@example.com")).toBe("Sibhi");
    expect(personName("asha@example.com", null)).toBe("Asha");
    expect(personName(undefined, undefined)).toBe("Someone");
    for (const v of [personName("", "x.y@z.com"), personName("a@b.c", "a@b.c")]) {
      expect(v).not.toContain("@");
    }
  });

  it("status words have no duckling counts", () => {
    const now = 10_000_000;
    const min = 60_000;
    expect(statusLine("needsYou", true, undefined, now, now)).toBe("Needs you");
    expect(statusLine("idle", true, undefined, now - 4 * min, now)).toBe("Idle · 4m");
    expect(statusLine("working", true, undefined, now, now)).toBe("Working");
    expect(statusLine("working", true, "the Zoom setup", now, now)).toBe("Working on the Zoom setup");
    expect(statusLine("idle", false, undefined, now - 3 * 24 * 60 * min, now)).toBe("Closed 3d ago");
    expect(statusLine("idle", false, undefined, now, now)).toBe("Closed just now");
  });

  it("fixed lines are plain and pass the check", () => {
    for (const t of [waitingLine("Upma", "Tilly"), needsYouLine("Upma")]) expect(check(t)).toEqual({ ok: true });
    expect(waitingLine("Upma", "Tilly")).not.toMatch(/lock|Stream/i);
  });
});
