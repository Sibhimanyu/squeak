import type { CallScript } from "./dialog.js";

/** The made-up question a test call asks (`squeak voice-test`, and the Test call button in the apps). */
export const TEST_SCRIPT: CallScript = {
  greeting: "Hello, this is Squeak. This is a test call.",
  question: "Pick a colour. Press 1 for blue, or press 2 for green. Press star to hear this again, or hash to hang up.",
  options: [
    { letter: "A", title: "blue" },
    { letter: "B", title: "green" },
  ],
};
