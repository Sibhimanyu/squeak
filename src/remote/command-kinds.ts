/**
 * The phone command kinds core handles itself (`RemoteBridge.handleCommand`). An add-on may register handlers only for
 * other kinds (`AddonHandle.phoneCommands`); the host refuses one that names any of these, so an add-on can never
 * shadow, say, `reply` or `awake`. `command-kinds.test.ts` fails when `handleCommand` handles a kind missing here.
 */
export const CORE_COMMAND_KINDS: ReadonlySet<string> = new Set([
  "reply",
  "start",
  "native",
  "hotspot",
  "awake",
  "stats",
  "controls",
  "notify",
  "sendDefault",
  "claudeAccount",
  "telegram",
  "cliq",
  "presets",
  "voice",
  "voiceSample",
  "accountLink",
  "accountUnlink",
  "telegramAvatar",
  "lidActions",
  "usage",
  "history",
  "subagent",
  "queue",
  "image",
  "diff",
  "work",
  "stop",
  "attach",
  "workspace",
  "setup",
  "rename",
  "close",
  "archive",
  "media",
  "answer",
  "pond",
]);

/** The largest serialized command an add-on's handler is given: core caps the box before any add-on sees it. */
export const ADDON_COMMAND_MAX_CHARS = 64_000;
