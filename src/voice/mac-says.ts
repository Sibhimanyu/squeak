/**
 * Every fixed sentence the Mac sends down in a call without audio of its own (a refusal, a talk reply, a new chat's
 * outcome). The add-on speaks whatever text arrives, so each one is also in `inboundPrompts`: the Mac records it in
 * its own voice and the add-on finds it by its exact words, rather than making it with Piper mid-call. Keep them here,
 * never as a literal at the point of use, so `mac-says.test.ts` can see that none is left out.
 */

/** A new chat's sentences; failures never carry a reason from Conductor or the model. */
export const NEW_CHAT_SAYS = {
  failed: "Your Mac could not start the chat.",
  limit: "Too many new chats by phone this hour.",
  gone: "That new chat is no longer waiting. Call again.",
  stale: "That list is out of date. Call again.",
  unavailable: "Your Mac cannot start chats from a call yet.",
  again: "Say yes to start it, or no to cancel.",
  declined: "Okay, I won't start it. Goodbye.",
  started: "Started. It's working on it.",
  offerHold: "Want me to stay on the line while it works? Say yes to hold, or no to hang up.",
  bye: "Goodbye.",
};

/** What a recording that did not arrive whole says. */
export const PARTS_SAYS = {
  unsupported: "I could not make that out.",
  missing: "The recording did not arrive whole. Try again.",
};

/** The talk flow's replies from the Mac. */
export const TALK_REPLY_SAYS = {
  closed: "That call is no longer open.",
  sorry: "Sorry, I didn't catch that. Tell me what to do, or ask me anything about it.",
  unclear: "Sorry, I didn't get that. Tell me what to do, or ask me anything about it.",
  failed: "I could not work that out. You can try again.",
  again: "Say yes to send it, or no to cancel.",
  giveUp: "I won't send it. Goodbye.",
  declined: "Okay, I won't send it. What would you like to do?",
  gone: "That message is no longer waiting. Tell me what to do again.",
  sent: "Sent. Goodbye.",
  sentCallback: "Sent. I'll call you back when it's done. Goodbye.",
  noCallback: "I can't arrange a call back from here yet.",
  offerHold: "Sent. Want me to stay on the line while it works? Say yes to hold, or no to hang up.",
  holding: "Okay, I'll stay on the line. Press 1 any time to hear what it's thinking, or hash to hang up.",
  sentHolding:
    "Sent. I'll stay on the line while it works. Press 1 any time to hear what it's thinking, or hash to hang up.",
  noHold: "Okay. Goodbye.",
  stillWorking: "Still working. Press 1 to hear what it's thinking.",
  noStart: "I don't see it working yet.",
  longHold: "It's taking a while, so I'll let you go. You'll get a card when it's done. Goodbye.",
  lostChat: "I lost track of that chat. Goodbye.",
  cannotSee: "I can't see what it's doing.",
  bye: "Goodbye.",
  turns: "That is as much as I can do by voice on one call. Goodbye.",
};

/** The `refused` reasons of the keypad flows (and the ones the talk flow shares). */
export const REFUSED_SAYS = {
  noAnswering: "Your Mac cannot answer questions yet.",
  tooManyQuestions: "Too many questions by phone this hour.",
  staleList: "That list is out of date. Call again.",
  recordingGone: "That recording is no longer waiting. Record it again.",
  notMadeOut: "I could not make that out.",
  heardNothing: "I did not hear anything.",
  messageGone: "That message is no longer waiting.",
  noTalking: "Your Mac cannot talk through a call yet.",
  tooManyMessages: "Too many messages by phone this hour.",
  wentWrong: "Something went wrong on the Mac.",
  noCallbackChat: "I can't find that chat any more.",
  tooManyCallbacks: "There are too many call backs waiting already.",
};

/** Fixed sentences that name the chat: the directory's labels are known, so each is recorded per label. */
export const couldNotFind = (label: string): string => `I could not find ${label} any more.`;
export const chatBusy = (label: string): string => `${label} is busy right now. Send it from the app.`;
export const nothingRunning = (label: string): string =>
  `Nothing is running in ${label} right now, so there is nothing to wait for.`;
export const callBackLine = (label: string): string => `Okay, I'll call you back when ${label} is done. Goodbye.`;

/** Every fixed sentence above that does not name a chat. */
export function macFixedSays(): string[] {
  return [
    ...Object.values(REFUSED_SAYS),
    ...Object.values(PARTS_SAYS),
    ...Object.values(TALK_REPLY_SAYS),
    ...Object.values(NEW_CHAT_SAYS),
  ];
}

/** The sentences that name one chat. */
export const macLabelSays = (label: string): string[] => [
  couldNotFind(label),
  chatBusy(label),
  nothingRunning(label),
  callBackLine(label),
];
