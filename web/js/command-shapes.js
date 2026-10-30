// The body of every signed command the Mac accepts, checked the way the Mac
// (src/remote/remote-bridge.ts and the readers it calls) and the iPhone
// (SqueakCore Channel.swift / Models.swift) check them: strict types, exactly
// the keys the Mac knows, nothing the phone cannot prove. `shape(kind, input)`
// returns the command's own fields (no `v`, `kind`, `nonce` or `expiresAt`:
// Channel adds the envelope) or throws a CommandInputError whose message is
// a sentence for the person. Pure, so tests need no channel.

export class CommandInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandInputError";
  }
}

const bad = (what) => {
  throw new CommandInputError(what);
};

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === "string";
const isInt = (value) => typeof value === "number" && Number.isInteger(value);
const text = (value, name, max) => {
  if (!isString(value) || value.trim() === "") bad(`${name} is required.`);
  if (max !== undefined && value.length > max) bad(`${name} is too long (at most ${max} characters).`);
  return value;
};
const optionalString = (value, name, max) =>
  value === undefined || value === null ? undefined : text(value, name, max);
const optionalBool = (value, name) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") bad(`${name} must be true or false.`);
  return value;
};
const only = (input, allowed, what) => {
  if (!isObject(input)) bad(`${what} needs its fields.`);
  for (const key of Object.keys(input)) if (!allowed.includes(key)) bad(`${what} has no "${key}".`);
  return input;
};
const defined = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

/* Limits the Mac enforces; kept in one place so a screen can show them. */
export const NEW_CHAT_MAX_TEXT = 20_000;
export const HISTORY_PAGE_MAX = 12;
export const ATTACH_MAX_CHUNKS = 4;
export const ATTACH_CHUNK_BYTES = 300_000;
export const SOURCE_MAX = 2_000;
export const FILM_ID = /^film:[0-9a-f]{16}$/;
export const AGENTS = ["claude", "codex"];
export const STATS_RANGES = ["7d", "30d", "all"];
export const FAN_MODES = ["auto", "40", "60", "80", "max"];
export const POWER_CHOICES = ["auto", "low", "high"];
export const LID_CLOSED_KEYS = ["displayOff", "mute", "lowPower", "freezeApps"];
export const LID_OPEN_KEYS = ["screenOn", "mute", "lowPower", "freezeApps"];
export const NOTIFY_CHANNELS = ["telegram", "cliq"];
export const FINISHED_MODES = ["conductor", "all", "off"];
export const PAUSE_CHOICES = ["1h", "4h", "tomorrow", "forever", "resume"];
export const PIN_POLICIES = ["ask", "skip"];
export const FAVORITES_MAX = 9;
export const PRESET_IDS = ["best", "balanced", "save"];
export const PRESET_NAME_MAX = 32;
export const WORKER_IDS = ["sonnet", "haiku", "opus", "fable"];
export const FILM_OPS = ["answer", "chat", "resume", "stop", "installTool"];

const PRESET_LEVEL = /^[a-z][a-z0-9_-]{0,19}$/;
const KOKORO_VOICE = /^[a-z]{2}_[a-z]+$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,120}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,40}$/;
const TASK_ID = /^[A-Za-z0-9_-]{8,80}$/;
const CURSOR = /^[1-9]\d{0,15}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
const CHAT_ID = /^[A-Za-z0-9-]{8,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EXTENSION = /^\d{2,6}$/;
const PIN = /^\d{4,12}$/;
const WORKFLOW_TYPE = /^[a-z-]{2,20}$/;

/** The longest base64 slice the Mac takes for one attach chunk. */
export const ATTACH_MAX_BASE64 = Math.ceil(ATTACH_CHUNK_BYTES / 3) * 4 + 8;

function splitShape(split, agent) {
  if (split === undefined || split === null) return undefined;
  only(split, ["code", "run", "planFirst"], "The work split");
  const out = {};
  for (const worker of ["code", "run"]) {
    if (split[worker] === undefined) continue;
    if (!isString(split[worker]) || split[worker] === "") bad("A worker model is a name like sonnet.");
    if (agent !== "claude") bad("Only a Claude chat can hand work to other models.");
    out[worker] = split[worker];
  }
  if (split.planFirst !== undefined) {
    if (typeof split.planFirst !== "boolean") bad("Plan first must be true or false.");
    if (split.planFirst) out.planFirst = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function answersShape(answers) {
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 8)
    bad("An answer has one to eight questions.");
  return answers.map((entry) => {
    only(entry, ["question", "picked", "other"], "An answer");
    if (!isInt(entry.question) || entry.question < 0) bad("An answer names its question by number.");
    if (!Array.isArray(entry.picked) || entry.picked.length > 20 || !entry.picked.every(isString)) {
      bad("Picked is a list of option labels.");
    }
    if (entry.other !== undefined && !isString(entry.other)) bad("Other is text.");
    return defined({ question: entry.question, picked: entry.picked, other: entry.other });
  });
}

function planShape(plan) {
  if (!isObject(plan)) bad("A plan answer is approve or send back.");
  if (plan.approve === true && Object.keys(plan).length === 1) return { approve: true };
  if (plan.approve === false && Object.keys(plan).length === 2 && isString(plan.note)) {
    if (plan.note.trim() === "") bad("Say what to change before sending it back.");
    return { approve: false, note: plan.note };
  }
  return bad("A plan answer is approve, or send back with a note.");
}

function controlsChange(change) {
  if (!isObject(change) || Object.keys(change).length !== 1) bad("A control changes one thing at a time.");
  const [key] = Object.keys(change);
  const v = change[key];
  const percent = (x) => isInt(x) && x >= 0 && x <= 100;
  const trueOnly = (x) => x === true;
  const ok = (valid) => (valid ? { [key]: v } : bad(`"${key}" is not a value this Mac accepts.`));
  switch (key) {
    case "volume":
    case "brightness":
      return ok(percent(v));
    case "muted":
    case "screenAwake":
      return ok(typeof v === "boolean");
    case "fans":
      return ok(FAN_MODES.includes(v));
    case "power":
      return ok(POWER_CHOICES.includes(v));
    case "displaySleep":
    case "wakeScreen":
    case "lock":
    case "listApps":
    case "listTabs":
      return ok(trueOnly(v));
    case "open":
    case "quit":
      return ok(isString(v) && BUNDLE_ID.test(v));
    case "space":
      return ok(v === "left" || v === "right");
    case "media":
      return ok(v === "playPause" || v === "next" || v === "previous");
    case "appIcons":
      return ok(
        Array.isArray(v) && v.length > 0 && v.length <= 12 && v.every((id) => isString(id) && BUNDLE_ID.test(id)),
      );
    case "selectTab": {
      if (!isObject(v) || Object.keys(v).some((k) => k !== "index" && k !== "title")) return bad("Not a tab.");
      if (!isInt(v.index) || v.index < 0 || v.index > 59 || !isString(v.title) || v.title.length > 200) {
        return bad("Not a tab.");
      }
      return { selectTab: { index: v.index, title: v.title } };
    }
    case "showChat": {
      if (!isObject(v) || Object.keys(v).length !== 1 || !isString(v.sessionId) || !CHAT_ID.test(v.sessionId)) {
        return bad("Not a chat.");
      }
      return { showChat: { sessionId: v.sessionId } };
    }
    default:
      return bad(`"${key}" is not a control this Mac has.`);
  }
}

function notifyChange(change) {
  if (!isObject(change) || Object.keys(change).length !== 1) bad("A notification setting changes one thing at a time.");
  const [key] = Object.keys(change);
  const v = change[key];
  switch (key) {
    case "muted":
    case "approval":
    case "question":
    case "stalled":
    case "quota":
      if (typeof v !== "boolean") bad(`"${key}" is on or off.`);
      return { [key]: v };
    case "finished":
      if (!FINISHED_MODES.includes(v)) bad('"finished" is conductor, all or off.');
      return { finished: v };
    case "quiet": {
      if (v === null) return { quiet: null };
      if (!isObject(v) || Object.keys(v).length !== 2) return bad("Quiet hours are a from and a to time.");
      if (!isString(v.from) || !isString(v.to) || !CLOCK.test(v.from) || !CLOCK.test(v.to) || v.from === v.to) {
        return bad("Quiet hours are two different times, HH:MM.");
      }
      return { quiet: { from: v.from, to: v.to } };
    }
    default:
      return bad(`"${key}" is not a notification setting.`);
  }
}

/* ---------- Telegram and Cliq setup (the Mac's channels-setup.ts). No message below ever repeats a value. ---------- */

export const BOT_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,80}$/;
export const OWNER_EMAIL = /^[^\s@"'#\\]{1,64}@[^\s@"'#\\]{1,200}$/;
export const OWNER_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const CLIQ_HOSTS = /^cliq\.(zoho\.(com|eu|in|com\.au|jp|sa|uk|com\.cn)|zohocloud\.ca)$/;
const WEBHOOK_HELP = "That should be an https link on zoho.com, like the one in the bot's webhook settings.";

/** The Mac's `parseCliqWebhookUrl`: https, a Cliq host, a `zapikey`, nothing the daemon would trim or refuse. */
export function isCliqWebhook(value) {
  if (!isString(value) || value !== value.trim() || value.length > 2_000) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && CLIQ_HOSTS.test(url.hostname) && Boolean(url.searchParams.get("zapikey"));
}

const chatIdOf = (value) => {
  if (!(typeof value === "number" && Number.isSafeInteger(value) && value !== 0))
    bad("Not a chat this Mac understands.");
  return value;
};

function telegramChange(change) {
  if (!isObject(change) || Object.keys(change).length !== 1) bad("A Telegram change is one thing at a time.");
  const [key] = Object.keys(change);
  const v = change[key];
  switch (key) {
    case "token":
      if (!(isString(v) && BOT_TOKEN.test(v))) {
        bad("That doesn't look like a bot token. It is a number, a colon, then letters and digits.");
      }
      return { token: v };
    case "off":
    case "startLink":
    case "stopLink":
    case "test":
      if (v !== true) bad(`"${key}" is true or nothing.`);
      return { [key]: true };
    case "link":
      return { link: chatIdOf(v) };
    case "unlink":
      return { unlink: chatIdOf(v) };
    default:
      return bad("Not a Telegram setting this Mac understands.");
  }
}

function cliqChange(change) {
  if (!isObject(change) || Object.keys(change).length !== 1) bad("A Cliq change is one thing at a time.");
  const [key] = Object.keys(change);
  const v = change[key];
  switch (key) {
    case "webhook":
      if (!isCliqWebhook(v)) bad(WEBHOOK_HELP);
      return { webhook: v };
    case "removeWebhook":
      if (v !== true) bad('"removeWebhook" is true or nothing.');
      return { removeWebhook: true };
    case "owner": {
      if (!isObject(v) || Object.keys(v).sort().join(",") !== "email,id") bad("The owner is an email and an ID.");
      const { email, id } = v;
      if (email !== null && !(isString(email) && OWNER_EMAIL.test(email)))
        bad("That doesn't look like an email address.");
      if (id !== null && !(isString(id) && OWNER_ID.test(id))) {
        bad("A Cliq user ID is letters, digits, dots, dashes and underscores.");
      }
      return { owner: { email, id } };
    }
    default:
      return bad("Not a Cliq setting this Mac understands.");
  }
}

function voiceChange(change) {
  if (!isObject(change) || Object.keys(change).length !== 1) bad("A phone-call change is one thing at a time.");
  const [key] = Object.keys(change);
  const v = change[key];
  if (key === "callee") {
    if (v !== null && !(isString(v) && EXTENSION.test(v))) bad("An extension is 2 to 6 digits.");
    return { callee: v };
  }
  if (key === "test") {
    if (v !== true) bad("A test is test: true.");
    return { test: true };
  }
  if (key === "pin") {
    if (!isObject(v) || Object.keys(v).sort().join(",") !== "current,next")
      bad("A pin change needs the current and the new pin.");
    if (!isString(v.current) || !isString(v.next) || !PIN.test(v.current) || !PIN.test(v.next)) {
      bad("A pin is 4 to 12 digits.");
    }
    return { pin: { current: v.current, next: v.next } };
  }
  if (key === "pause") {
    if (!PAUSE_CHOICES.includes(v)) bad("Pick 1 hour, 4 hours, tomorrow morning, until turned back on, or resume.");
    return { pause: v };
  }
  if (key === "pinAction") return { pinAction: pinActionShape(v) };
  if (key === "natural") return { natural: naturalShape(v) };
  if (key === "favorites") return { favorites: favoritesShape(v) };
  return bad(`"${key}" is not a phone-call setting.`);
}

/** The Mac's `parsePinAction` (voice/relay-protocol.ts): exactly the keys each action takes; a reset's `next` may be null. */
function pinActionShape(v) {
  if (!isObject(v) || !isString(v.action)) bad("That is not a PIN action.");
  const keys = Object.keys(v).sort().join(",");
  const digits = (x) => isString(x) && PIN.test(x);
  const need = (ok) => {
    if (!ok) bad("A pin is 4 to 12 digits.");
  };
  switch (v.action) {
    case "change":
      need(keys === "action,current,next" && digits(v.current) && digits(v.next));
      return { action: "change", current: v.current, next: v.next };
    case "disable":
      need(keys === "action,current" && digits(v.current));
      return { action: "disable", current: v.current };
    case "enable":
      need(keys === "action,next" && digits(v.next));
      return { action: "enable", next: v.next };
    case "reset":
      need(keys === "action,next" && (v.next === null || digits(v.next)));
      return { action: "reset", next: v.next };
    case "policy":
      if (
        keys !== "action,incoming,outgoing" ||
        !PIN_POLICIES.includes(v.outgoing) ||
        !PIN_POLICIES.includes(v.incoming)
      )
        bad("When the PIN is asked is ask or skip, for each kind of call.");
      return { action: "policy", outgoing: v.outgoing, incoming: v.incoming };
    default:
      return bad("That is not a PIN action.");
  }
}

/** `NaturalSettingsStore`: at least one of `enabled` (boolean) and `voice` (a Kokoro name), nothing else. */
function naturalShape(v) {
  if (!isObject(v) || Object.keys(v).length === 0) bad("That is not a voice setting.");
  for (const key of Object.keys(v)) if (key !== "enabled" && key !== "voice") bad("That is not a voice setting.");
  if ("enabled" in v && typeof v.enabled !== "boolean") bad("Turn the natural voice on or off.");
  if ("voice" in v && !(isString(v.voice) && KOKORO_VOICE.test(v.voice))) bad("That is not a Kokoro voice name.");
  return defined({ enabled: v.enabled, voice: v.voice });
}

/** `VoiceFavoritesStore`: the whole list, at most nine, each exactly `{ n, workspace }`, each digit once. */
function favoritesShape(v) {
  if (!Array.isArray(v)) bad("favorites must be a list.");
  if (v.length > FAVORITES_MAX) bad("At most 9 favourites.");
  const used = new Set();
  return v.map((entry) => {
    if (!isObject(entry) || Object.keys(entry).sort().join(",") !== "n,workspace")
      bad("Each favourite is { n, workspace }.");
    if (!isInt(entry.n) || entry.n < 1 || entry.n > 9) bad("n is a digit from 1 to 9.");
    if (used.has(entry.n)) bad("Each digit can be used once.");
    used.add(entry.n);
    if (!isString(entry.workspace) || entry.workspace === "" || entry.workspace.length > 200)
      bad("workspace is a name of up to 200 characters.");
    return { n: entry.n, workspace: entry.workspace };
  });
}

const SHAPES = {
  start(input) {
    only(input, ["workspaceId", "agent", "text", "model", "thinking", "split"], "A new chat");
    const body = text(input.text, "The first message", NEW_CHAT_MAX_TEXT);
    if (!isString(input.workspaceId) || input.workspaceId === "") bad("Pick a workspace.");
    if (!AGENTS.includes(input.agent)) bad("The agent is claude or codex.");
    return defined({
      workspaceId: input.workspaceId,
      agent: input.agent,
      text: body,
      model: optionalString(input.model, "The model"),
      thinking: optionalString(input.thinking, "The thinking level"),
      split: splitShape(input.split, input.agent),
    });
  },

  answer(input) {
    only(input, ["sessionId", "toolUseId", "answers", "plan"], "An answer");
    if (!isString(input.sessionId) || !SESSION_ID.test(input.sessionId)) bad("Not a chat that can be answered.");
    const toolUseId = text(input.toolUseId, "The question", 200);
    const hasAnswers = input.answers !== undefined && input.answers !== null;
    const hasPlan = input.plan !== undefined && input.plan !== null;
    if (hasAnswers === hasPlan) bad("An answer is either picks or a plan answer, not both and not neither.");
    return defined({
      sessionId: input.sessionId,
      toolUseId,
      answers: hasAnswers ? answersShape(input.answers) : undefined,
      plan: hasPlan ? planShape(input.plan) : undefined,
    });
  },

  attach(input) {
    only(input, ["sessionId", "workspaceId", "uploadId", "index", "total", "data"], "A photo piece");
    const forSession = isString(input.sessionId) && input.sessionId !== "";
    const forWorkspace = isString(input.workspaceId) && input.workspaceId !== "";
    if (forSession === forWorkspace) bad("A photo goes to a chat or to a new chat's workspace, not both.");
    if (!isString(input.uploadId) || !UPLOAD_ID.test(input.uploadId)) bad("Bad upload id.");
    if (!isInt(input.total) || input.total < 1 || input.total > ATTACH_MAX_CHUNKS)
      bad("A photo is one to four pieces.");
    if (!isInt(input.index) || input.index < 0 || input.index >= input.total) bad("Bad piece number.");
    if (
      !isString(input.data) ||
      input.data === "" ||
      input.data.length > ATTACH_MAX_BASE64 ||
      !BASE64.test(input.data)
    ) {
      bad("That piece of the photo is not valid or is too big.");
    }
    return defined({
      ...(forSession ? { sessionId: input.sessionId } : { workspaceId: input.workspaceId }),
      uploadId: input.uploadId,
      index: input.index,
      total: input.total,
      data: input.data,
    });
  },

  history(input) {
    only(input, ["key", "before", "n"], "A history page");
    if (!isString(input.key) || input.key === "" || input.key.length > 200) bad("Not a chat.");
    if (input.before !== undefined && input.before !== null && !(isString(input.before) && CURSOR.test(input.before))) {
      bad("Bad cursor.");
    }
    let n = input.n;
    if (n !== undefined && n !== null) {
      if (typeof n !== "number" || !Number.isFinite(n)) bad("Bad page size.");
      n = Math.min(HISTORY_PAGE_MAX, Math.max(1, Math.floor(n)));
    }
    return defined({ key: input.key, before: input.before ?? undefined, n: n ?? undefined });
  },

  subagent(input) {
    only(input, ["key", "taskId"], "A subagent feed");
    if (!isString(input.key) || input.key === "" || input.key.length > 200) bad("Not a chat.");
    // null stops the feed and goes out as an explicit null: the Mac wants the key present.
    if (input.taskId !== null && !(isString(input.taskId) && TASK_ID.test(input.taskId))) bad("Not a subagent.");
    return { key: input.key, taskId: input.taskId };
  },

  diff(input) {
    only(input, ["sessionId", "file"], "A diff");
    if (!isString(input.sessionId) || input.sessionId === "") bad("Not a chat.");
    if (input.file !== undefined && input.file !== null && !(isInt(input.file) && input.file >= 0))
      bad("Bad file number.");
    return defined({ sessionId: input.sessionId, file: input.file ?? undefined });
  },

  close(input) {
    only(input, ["sessionId"], "Close");
    if (!isString(input.sessionId) || input.sessionId === "") bad("Not a chat that can be closed.");
    return { sessionId: input.sessionId };
  },

  workspace(input) {
    only(input, ["action", "workspaceId", "repoId", "sessionId", "answersTurn"], "A workspace action");
    if (input.action === "archive") {
      if (!isString(input.workspaceId) || input.workspaceId === "") bad("Pick a workspace.");
      return { action: "archive", workspaceId: input.workspaceId };
    }
    if (input.action === "create") {
      if (!isString(input.repoId) || input.repoId === "") bad("Pick a repository.");
      return { action: "create", repoId: input.repoId };
    }
    if (input.action === "createPr") {
      if (!isString(input.sessionId) || input.sessionId === "") bad("Pick a chat.");
      if (input.answersTurn !== undefined && input.answersTurn !== null && !isString(input.answersTurn))
        bad("Bad turn.");
      return defined({ action: "createPr", sessionId: input.sessionId, answersTurn: input.answersTurn ?? undefined });
    }
    return bad("A workspace action is archive, create or createPr.");
  },

  setup(input) {
    only(input, ["sessionId", "model", "thinking", "fast"], "A chat setup");
    if (!isString(input.sessionId) || input.sessionId === "") bad("Not a chat that can be changed.");
    return defined({
      sessionId: input.sessionId,
      model: text(input.model, "The model"),
      thinking: optionalString(input.thinking, "The thinking level"),
      fast: optionalBool(input.fast, "Fast mode"),
    });
  },

  usage(input) {
    only(input ?? {}, [], "A usage refresh");
    return {};
  },

  stats(input) {
    only(input, ["range", "agent"], "A usage range");
    if (!STATS_RANGES.includes(input.range)) bad("The range is 7d, 30d or all.");
    if (input.agent !== undefined && input.agent !== null && !AGENTS.includes(input.agent))
      bad("The agent is claude or codex.");
    return defined({ range: input.range, agent: input.agent ?? undefined });
  },

  awake(input) {
    only(input, ["on", "minutes", "extend", "lid"], "Keep awake");
    if (typeof input.on !== "boolean") bad("On is true or false.");
    const positive = (v, name) => {
      if (v === undefined || v === null) return undefined;
      if (!isInt(v) || v <= 0) bad(`${name} is a whole number of minutes.`);
      return v;
    };
    const minutes = positive(input.minutes, "Minutes");
    const extend = positive(input.extend, "Extend");
    const lid = optionalBool(input.lid, "Lid");
    if (!input.on && (minutes !== undefined || extend !== undefined || lid !== undefined)) {
      bad("Turning keep awake off carries no minutes, extension or lid.");
    }
    if (lid === true && minutes === undefined && extend === undefined) bad("A lid-closed session needs a time.");
    return defined({ on: input.on, minutes, extend, lid });
  },

  lidActions(input) {
    only(input, ["settings", "mode"], "Lid actions");
    if (input.mode !== undefined && input.mode !== "open" && input.mode !== "closed")
      bad("The mode is open or closed.");
    const open = input.mode === "open";
    const allowed = open ? LID_OPEN_KEYS : LID_CLOSED_KEYS;
    if (!isObject(input.settings) || Object.keys(input.settings).length === 0) bad("Change at least one switch.");
    const settings = {};
    for (const [key, value] of Object.entries(input.settings)) {
      if (!allowed.includes(key)) bad(`"${key}" is not a ${open ? "lid-open" : "lid-closed"} switch.`);
      if (typeof value !== "boolean") bad(`"${key}" is on or off.`);
      settings[key] = value;
    }
    // Closed is what an older phone sent: no mode at all.
    return { ...(open ? { mode: "open" } : {}), settings };
  },

  controls(input) {
    only(input, ["change"], "A control");
    return { change: controlsChange(input.change) };
  },

  notify(input) {
    only(input, ["channel", "change"], "A notification setting");
    if (!NOTIFY_CHANNELS.includes(input.channel)) bad("The channel is telegram or cliq.");
    return { channel: input.channel, change: notifyChange(input.change) };
  },

  telegram(input) {
    only(input, ["change"], "A Telegram setting");
    return { change: telegramChange(input.change) };
  },

  cliq(input) {
    only(input, ["change"], "A Cliq setting");
    return { change: cliqChange(input.change) };
  },

  voice(input) {
    only(input, ["change"], "A phone-call setting");
    return { change: voiceChange(input.change) };
  },

  /** The Mac's `readPresetRequest` (fleet/chat-presets.ts): one name, one whole setup or one reset. */
  presets(input) {
    only(input, ["agent", "preset", "change"], "A preset change");
    if (!PRESET_IDS.includes(input.preset)) bad("Not a preset this Mac knows.");
    if (!isObject(input.change)) bad("Not a preset change this Mac understands.");
    const keys = Object.keys(input.change);
    if (keys.length !== 1) bad("Not a preset change this Mac understands.");
    if (keys[0] === "name") {
      if ("agent" in input) bad("A preset's name is shared by both agents.");
      const name = input.change.name;
      if (name !== null && !isString(name)) bad("A preset's name is text.");
      // eslint-disable-next-line no-control-regex
      const flat = name === null ? "" : name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
      const clean = flat.length > PRESET_NAME_MAX ? flat.slice(0, PRESET_NAME_MAX).trim() : flat;
      return { preset: input.preset, change: { name: clean === "" ? null : clean } };
    }
    if (!AGENTS.includes(input.agent)) bad("Not a preset change this Mac understands.");
    if (keys[0] === "reset") {
      if (input.change.reset !== true) bad("Not a preset change this Mac understands.");
      return { agent: input.agent, preset: input.preset, change: { reset: true } };
    }
    if (keys[0] !== "setup") bad("Not a preset change this Mac understands.");
    const setup = only(input.change.setup, ["modelId", "level", "code", "run", "planFirst"], "A setup");
    if (!isString(setup.modelId) || setup.modelId.length < 1 || setup.modelId.length > 80)
      bad("A setup needs a model.");
    const level = setup.level ?? null;
    if (level !== null && !(isString(level) && PRESET_LEVEL.test(level))) bad("That is not a thinking level.");
    const worker = (value, name) => {
      if (value === undefined || value === null) return null;
      if (!WORKER_IDS.includes(value)) bad(`${name} is not a worker this Mac knows.`);
      return value;
    };
    const code = worker(setup.code, "The code worker");
    const run = worker(setup.run, "The run worker");
    if (setup.planFirst !== undefined && typeof setup.planFirst !== "boolean") bad("Ask before changes is on or off.");
    if (input.agent === "codex" && (code !== null || run !== null || setup.planFirst === true))
      bad("Codex chats do their own work.");
    const planFirst = (code !== null || run !== null) && setup.planFirst === true;
    return {
      agent: input.agent,
      preset: input.preset,
      change: { setup: { modelId: setup.modelId, level, code, run, planFirst } },
    };
  },

  voiceSample(input) {
    only(input, ["voice"], "A voice sample");
    if (!(isString(input.voice) && KOKORO_VOICE.test(input.voice))) bad("Not a voice this Mac offers.");
    return { voice: input.voice };
  },

  telegramAvatar(input) {
    only(input ?? {}, [], "The Telegram photo");
    return {};
  },

  hotspot(input) {
    only(input, ["action", "ssid", "password", "enabled"], "The hotspot");
    if (input.action === "join" || input.action === "leave" || input.action === "clear") {
      for (const key of ["ssid", "password", "enabled"])
        if (input[key] !== undefined) bad(`${input.action} carries no ${key}.`);
      return { action: input.action };
    }
    if (input.action !== "configure") bad("The hotspot action is configure, join, leave or clear.");
    if (typeof input.enabled !== "boolean") bad("Enabled is on or off.");
    const ssid = input.ssid;
    const controls = (s) => [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
    if (!isString(ssid) || ssid.trim() === "" || new TextEncoder().encode(ssid).length > 32 || controls(ssid)) {
      bad("A network name is 1 to 32 characters.");
    }
    if (input.password !== undefined && !(isString(input.password) && /^[\x20-\x7e]{8,63}$/.test(input.password))) {
      bad("A hotspot password is 8 to 63 characters.");
    }
    return defined({ action: "configure", ssid, password: input.password, enabled: input.enabled });
  },

  workflow(input) {
    only(input, ["sessionKey", "step", "revision", "type", "value", "note"], "A workflow answer");
    if (!isString(input.sessionKey) || input.sessionKey === "") bad("Not a session.");
    if (!isString(input.step) || !isString(input.revision)) bad("An answer names the call it answers.");
    if (!isString(input.type) || !WORKFLOW_TYPE.test(input.type)) bad("Bad answer type.");
    if (input.note !== undefined && input.note !== null && !isString(input.note)) bad("A note is text.");
    const value = input.value === null ? undefined : input.value;
    if (value !== undefined && JSON.stringify(value).length > 8_000) bad("That answer is too long.");
    return defined({
      sessionKey: input.sessionKey,
      step: input.step,
      revision: input.revision,
      type: input.type,
      value,
      note: input.note ?? undefined,
    });
  },

  film(input) {
    only(
      input,
      ["filmId", "op", "step", "revision", "type", "value", "note", "text", "askId", "tool"],
      "A film command",
    );
    if (!isString(input.filmId) || !FILM_ID.test(input.filmId)) bad("Not a film.");
    if (!FILM_OPS.includes(input.op)) bad("A film op is answer, chat, resume, stop or installTool.");
    const limits = { step: 200, revision: 300, type: 20, note: 8_000, askId: 200, tool: 40 };
    for (const [key, max] of Object.entries(limits)) {
      const v = input[key];
      if (v !== undefined && v !== null && !(isString(v) && v.length <= max)) bad(`"${key}" is too long.`);
    }
    if (input.type !== undefined && input.type !== null && !WORKFLOW_TYPE.test(input.type)) bad("Bad answer type.");
    const value = input.value === null ? undefined : input.value;
    if (value !== undefined && JSON.stringify(value).length > 24_000) bad("That answer is too long.");
    const present = (key) => isString(input[key]) && input[key] !== "";
    if (input.op === "answer" && !(present("step") && present("revision") && present("type"))) {
      bad("An answer names the call it answers.");
    }
    if (input.op === "installTool" && !(present("askId") && present("tool"))) bad("Name the tool to install.");
    if (input.op === "chat") {
      if (!isString(input.text) || input.text.trim() === "") bad("Write a message first.");
      if (input.text.length > 2_000) bad("That message is too long.");
    } else if (input.text !== undefined && input.text !== null) bad("Only a chat carries text.");
    return defined({
      filmId: input.filmId,
      op: input.op,
      step: input.step ?? undefined,
      revision: input.revision ?? undefined,
      type: input.type ?? undefined,
      value,
      note: input.note ?? undefined,
      text: input.text ?? undefined,
      askId: input.askId ?? undefined,
      tool: input.tool ?? undefined,
    });
  },

  media(input) {
    only(input, ["sessionKey", "filmId", "source"], "A media request");
    const byFilm = input.filmId !== undefined && input.filmId !== null;
    const bySession = input.sessionKey !== undefined && input.sessionKey !== null;
    if (byFilm === bySession) bad("Name a film or a session, not both.");
    if (byFilm && !(isString(input.filmId) && FILM_ID.test(input.filmId))) bad("Not a film.");
    if (bySession && !(isString(input.sessionKey) && input.sessionKey !== "")) bad("Not a session.");
    return {
      ...(byFilm ? { filmId: input.filmId } : { sessionKey: input.sessionKey }),
      source: text(input.source, "The source", SOURCE_MAX),
    };
  },

  image(input) {
    only(input, ["sessionId", "sessionKey", "filmId", "source"], "An image request");
    const source = text(input.source, "The source", SOURCE_MAX);
    if (input.filmId !== undefined && input.filmId !== null) {
      if (!(isString(input.filmId) && FILM_ID.test(input.filmId))) bad("Not a film.");
      // The Mac ignores a session for a film's picture; the iPhone sends none.
      return { sessionId: "", filmId: input.filmId, source };
    }
    if (input.sessionKey !== undefined && input.sessionKey !== null) {
      if (!(isString(input.sessionKey) && input.sessionKey !== "")) bad("Not a session.");
      // A workflow card's picture: the Mac wants a session id present, and ignores it.
      return { sessionId: input.sessionId ?? "", sessionKey: input.sessionKey, source };
    }
    if (!isString(input.sessionId) || input.sessionId === "") bad("Not a chat.");
    return { sessionId: input.sessionId, source };
  },
};

/** The command kinds a browser can send through `shape`. */
export const COMMAND_KINDS = Object.freeze(Object.keys(SHAPES));

/** The command's own fields, checked; throws CommandInputError. */
export function shape(kind, input) {
  const make = Object.hasOwn(SHAPES, kind) ? SHAPES[kind] : null;
  if (!make) throw new CommandInputError(`"${kind}" is not a command this browser knows.`);
  return make(input);
}
