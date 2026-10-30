import { describe, expect, it } from "vitest";

import { judgeTranscript } from "./transcript-quality.js";

describe("judgeTranscript", () => {
  it.each(["", ".", "  ", "you", "You.", "Thank you.", "Thanks for watching!", "[BLANK_AUDIO]", "(silence)", "Bye."])(
    "calls %j nothing heard",
    (text) => {
      expect(judgeTranscript(text, 4000)).toBe("silence");
    },
  );

  it.each(["uh", "um.", "okay", "go on"])("calls %j unclear", (text) => {
    expect(judgeTranscript(text, 4000)).toBe("unclear");
  });

  it("calls a very short recording unclear even with real words", () => {
    expect(judgeTranscript("tell it to go with option B", 1200)).toBe("unclear");
  });

  it("lets a real message through", () => {
    expect(judgeTranscript("tell it to go with option B", 4000)).toBe("ok");
    expect(judgeTranscript("yes, ship it now", 2000)).toBe("ok");
    expect(judgeTranscript("yes please", 2000)).toBe("ok");
  });
});
