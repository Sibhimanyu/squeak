// The state and actions behind the chat's extras (WP3): answering a plan or a
// question in place, background tasks and a subagent's feed, photos in the
// composer and pictures in the timeline, earlier history, the chat menu, the
// model and thinking picker and the diff. One long-lived object for the page
// (`createExtras`); the views (chat-extras-view.js, plan-question-card.js,
// subagent-sheet.js, diff-view.js) read it and call it, and nothing here
// builds DOM. The page is redrawn from scratch on every `touch()`, so every
// bit of state a screen needs between draws (an open dialog, a half-made
// answer, photos waiting) lives here, per chat key.
//
// What the page lends (`app`):
//   commands()          the typed commands (commands.js), or null before pairing
//   channel()           the Sync's channel (to read a `live` document the Mac wrote)
//   prefs               { get(name), save(change) }
//   touch()             draw once, soon
//   send(session, text, mode)   the outbox send (sends.js): every message goes through it
//   history(key)        the held history of a chat (the live turn's, else the cached), oldest first
//   selected()          the open chat's key
//   select(key)         opens a chat (null closes)
//   view()              the Mac's view
//   verbose()           "Show thinking live" is on
//
// Rules that hold throughout: a command that came back unconfirmed is never
// sent again (the card locks and says so); "Send again" shows only when the
// command provably did not run; nothing from the Mac is parsed as HTML.

import { open } from "./channel-crypto.js";
import { MAX_REPLY_CHARS } from "./channel.js";
import { toBase64 } from "./encoding.js";
import {
  addPhotos,
  answerInput,
  answerLine,
  answerSummary,
  buildAnswers,
  closeResult,
  earlierCursor,
  earlierRow,
  earlierRows,
  emptyEarlier,
  emptyForm,
  imageFiles,
  isComplete,
  mergeEarlier,
  menuItems,
  openOther,
  patchLines,
  pendingSetupLine,
  planAnswer,
  readDiff,
  readFeed,
  readPage,
  readPatch,
  readQuestion,
  setOther,
  setupInput,
  setupModels,
  shouldFetchEarlier,
  togglePick,
  workspaceResult,
  midTurn,
} from "./chat-extras-logic.js";
import { hiddenChats, hideChange } from "./hidden-chats.js";
import { composeMessage, fetchImage, MAX_PHOTOS, prepareImage, uploadPhoto } from "./images.js";
import { liveHandle } from "./live.js";
import { chatModels, repos } from "./view-model.js";

export const PAGE_SIZE = 12;
export const FEED_POLL_MS = 2_000;
const SETUP_PENDING_MS = 20_000;
const MAX_LOADED_IMAGES = 12;

const frame = (fn) =>
  typeof globalThis.requestAnimationFrame === "function" ? globalThis.requestAnimationFrame(fn) : setTimeout(fn, 0);

let counter = 0;
const nextId = () => `x${++counter}`;

export class ChatExtras {
  /**
   * @param app  what the page lends (see the file's header)
   * @param deps replaceable for tests: `prepareImage`, `uploadPhoto`, `fetchImage`, `timers`, `now`
   */
  constructor(app, deps = {}) {
    this.app = app;
    this.deps = { prepareImage, uploadPhoto, fetchImage, timers: globalThis, now: () => Date.now(), ...deps };
    /** chat key -> { toolUseId, form, revising, note, sending, result, locked } */
    this.asks = new Map();
    /** chat key -> true/false: the background strip opened or folded by a tap */
    this.strips = new Map();
    /** chat key -> { list, busy, problem } */
    this.photos = new Map();
    /** `${key}\n${source}` -> { phase, uri, reason } */
    this.images = new Map();
    /** chat key -> { state, load } */
    this.earlier = new Map();
    /** The one dialog at a time: viewer, confirm, subagent or diff, each tied to a chat key. */
    this.viewer = null;
    this.confirm = null;
    this.sub = null;
    this.diff = null;
    /** The chat's open menu / setup panel (a chat key), or null. */
    this.menuOpen = null;
    this.setupOpen = null;
    /** chat key -> { line, bad } for what a menu action said. */
    this.notices = new Map();
    /** chat key -> { line, at }: the setup the Mac was asked for, shown until its view catches up. */
    this.setupPending = new Map();
    this.setupBusy = new Set();
    if (typeof document !== "undefined") {
      // Esc closes a dialog first; the page's own Esc (which closes the chat) must not also run.
      document.addEventListener("keydown", (event) => this.#onKey(event), true);
    }
  }

  touch() {
    this.app.touch();
  }

  /** Forget this browser: nothing of any chat (a picture, a half-made answer, a photo) stays in memory. */
  reset() {
    this.#dropSub();
    for (const map of [
      this.asks,
      this.strips,
      this.photos,
      this.images,
      this.earlier,
      this.notices,
      this.setupPending,
    ]) {
      map.clear();
    }
    this.setupBusy.clear();
    this.viewer = this.confirm = this.diff = null;
    this.menuOpen = this.setupOpen = null;
  }

  get commands() {
    return this.app.commands();
  }

  /* ---------- what the extras know about the Mac ---------- */

  workspaceActions() {
    return repos(this.app.view()) !== null;
  }

  menu(session) {
    return menuItems(session, { workspaceActions: this.workspaceActions(), hasDiff: this.commands !== null });
  }

  /* ---------- plan and question cards ---------- */

  #ask(session) {
    const question = readQuestion(session);
    const id = question?.toolUseId ?? `${session.key}:read`;
    let st = this.asks.get(session.key);
    if (!st || st.toolUseId !== id) {
      st = { toolUseId: id, form: emptyForm(), revising: false, note: "", sending: false, result: null, locked: false };
      this.asks.set(session.key, st);
    }
    return st;
  }

  /** What a plan or question card draws from. */
  askState(session) {
    return this.#ask(session);
  }

  pick(session, index, label, multi) {
    const st = this.#ask(session);
    if (st.sending || st.locked || st.result?.delivered) return;
    st.form = togglePick(st.form, index, label, multi);
    this.touch();
  }

  showOther(session, index) {
    const st = this.#ask(session);
    st.form = openOther(st.form, index);
    this.touch();
  }

  typeOther(session, index, text, multi) {
    const st = this.#ask(session);
    // No redraw while typing: the field keeps its caret; Send's state is updated by the card.
    st.form = setOther(st.form, index, text, multi);
  }

  startRevising(session) {
    const st = this.#ask(session);
    st.revising = true;
    this.touch();
  }

  cancelRevising(session) {
    const st = this.#ask(session);
    st.revising = false;
    st.note = "";
    this.touch();
  }

  typeNote(session, text) {
    this.#ask(session).note = text;
  }

  /** Sends the question's picks. Resolves when the Mac has answered (or the send could not be made). */
  async submitAnswers(session) {
    const q = readQuestion(session);
    const st = this.#ask(session);
    if (!q || st.sending || st.locked || !isComplete(q.prompts, st.form)) return;
    st.summary = answerSummary(q.prompts, st.form);
    await this.#deliverAnswer(session, st, { answers: buildAnswers(q.prompts, st.form) }, "");
  }

  async approvePlan(session) {
    const st = this.#ask(session);
    if (st.sending || st.locked) return;
    await this.#deliverAnswer(session, st, { plan: planAnswer(true) }, "Approved");
  }

  async sendPlanChanges(session) {
    const st = this.#ask(session);
    const plan = planAnswer(false, st.note);
    if (st.sending || st.locked || !plan) return;
    await this.#deliverAnswer(session, st, { plan }, "Sent back with your changes");
  }

  async #deliverAnswer(session, st, body, okLine) {
    const input = answerInput(session, body);
    const commands = this.commands;
    if (!input || !commands) {
      st.result = {
        delivered: false,
        line: "Your Mac can't take answers from this browser yet. Update Squeak on your Mac.",
      };
      return this.touch();
    }
    const wait = commands.waitMs("answer");
    if (wait > 0) {
      st.result = { delivered: false, line: `You just answered. Wait ${Math.ceil(wait / 1000)} s and try again.` };
      return this.touch();
    }
    st.sending = true;
    st.result = null;
    this.touch();
    const out = await commands.answer(input);
    st.sending = false;
    if (out.ok) {
      st.result = {
        delivered: true,
        line: okLine && out.result?.via !== "stopped-and-sent" ? okLine : answerLine(out),
      };
    } else {
      st.result = { delivered: false, line: answerLine(out), unconfirmed: out.unconfirmed };
      // Possibly delivered: never sent again from here; the chat says what happened next.
      if (out.unconfirmed) st.locked = true;
    }
    this.touch();
  }

  /* ---------- background tasks and a subagent's feed ---------- */

  stripChosen(key) {
    return this.strips.get(key);
  }

  toggleStrip(key, currentlyOpen) {
    this.strips.set(key, !currentlyOpen);
    this.touch();
  }

  async openSubagent(session, task) {
    this.#dropSub();
    const commands = this.commands;
    if (!commands || !task.canOpenSteps) return;
    const watch = { key: session.key, task, phase: "asking", feed: null, reason: null, timer: null };
    this.sub = watch;
    this.touch();
    this.#focusDialog();
    const out = await commands.subagent({ key: session.key, taskId: task.id });
    if (this.sub !== watch) {
      // Closed while asking: the Mac may be following it now, so tell it to stop.
      if (out.ok) void commands.subagent({ key: session.key, taskId: null });
      return;
    }
    if (!out.ok) {
      watch.phase = "refused";
      watch.reason = out.reason;
      return this.touch();
    }
    watch.phase = "following";
    this.touch();
    this.#pollFeed(watch);
  }

  #pollFeed(watch) {
    const tick = async () => {
      if (this.sub !== watch) return;
      if (this.app.selected() !== watch.key) return this.closeSubagent();
      try {
        const doc = `${await liveHandle(watch.key)}-s`;
        const feed = readFeed(await this.#readLive(doc), watch.key);
        if (this.sub !== watch) return;
        if (feed && feed.taskId === watch.task.id) {
          const changed = JSON.stringify(feed) !== JSON.stringify(watch.feed);
          watch.feed = feed;
          if (changed) this.touch();
          if (feed.status !== "running" && feed.available) return;
        }
      } catch {
        // A failed read is just a quiet moment; the next poll tries again.
      }
      if (this.sub === watch) watch.timer = this.deps.timers.setTimeout(tick, FEED_POLL_MS);
    };
    void tick();
  }

  #dropSub() {
    const watch = this.sub;
    if (!watch) return;
    this.sub = null;
    this.deps.timers.clearTimeout(watch.timer);
    // Following: the Mac stops writing the feed when told (an explicit null).
    if (watch.phase === "following" && this.commands) void this.commands.subagent({ key: watch.key, taskId: null });
  }

  closeSubagent() {
    if (!this.sub) return;
    this.#dropSub();
    this.touch();
  }

  async #readLive(doc) {
    const channel = this.app.channel();
    if (!channel) return null;
    const stored = await channel.db.get(channel.path("live", doc));
    return stored ? open(channel.key, stored.box) : null;
  }

  /* ---------- photos in the composer ---------- */

  photoState(key) {
    let st = this.photos.get(key);
    if (!st) {
      st = { list: [], busy: false, problem: null };
      this.photos.set(key, st);
    }
    return st;
  }

  /** Whether this chat can take photos at all: a Conductor chat this browser can reply to. */
  canAttach(session) {
    return (
      Boolean(this.commands) && typeof session.conductorSessionId === "string" && session.conductorSessionId !== ""
    );
  }

  /** Files from the picker, a paste or a drop: images only, at most four, each shrunk to fit before it can be sent. */
  async addFiles(session, files) {
    const st = this.photoState(session.key);
    const images = imageFiles(files);
    if (images.length === 0) {
      if (Array.from(files ?? []).length > 0) st.problem = "Only photos can be attached.";
      return this.touch();
    }
    const { list, dropped } = addPhotos(st.list, images, MAX_PHOTOS);
    const added = list.slice(st.list.length).map((file) => ({
      id: nextId(),
      name: file.name || "photo",
      state: "preparing",
      bytes: null,
      uri: null,
      error: null,
      ref: null,
      file,
    }));
    st.list = [...st.list, ...added];
    st.problem = dropped > 0 ? `At most ${MAX_PHOTOS} photos go with one message.` : null;
    this.touch();
    await Promise.all(
      added.map(async (photo) => {
        const out = await this.deps.prepareImage(photo.file);
        photo.file = null;
        if (out.error) {
          photo.state = "error";
          photo.error = out.error;
        } else {
          photo.state = "ready";
          photo.bytes = out.bytes;
          photo.uri = `data:image/jpeg;base64,${toBase64(out.bytes)}`;
        }
        this.touch();
      }),
    );
  }

  removePhoto(session, id) {
    const st = this.photoState(session.key);
    if (st.busy) return;
    st.list = st.list.filter((photo) => photo.id !== id);
    st.problem = null;
    this.touch();
  }

  /**
   * The composer's send: with photos, each is saved on the Mac first and the message names where (exactly as the
   * iPhone and the Mac app do); the message then goes through the outbox like any other. Resolves `true` when the
   * words were handed on (so the composer may clear), `false` when they must be given back.
   */
  async sendWithPhotos(session, words, mode) {
    const st = this.photoState(session.key);
    if (st.busy) return false;
    if (st.list.some((photo) => photo.state === "preparing")) {
      st.problem = "The photos are still being prepared.";
      this.touch();
      return false;
    }
    const ready = st.list.filter((photo) => photo.state === "ready");
    if (ready.length === 0) return (await this.app.send(session, words, mode)) !== false;
    const commands = this.commands;
    if (!commands) return false;
    st.busy = true;
    st.problem = null;
    this.touch();
    for (const photo of ready) {
      if (photo.ref) continue;
      const out = await this.deps.uploadPhoto(commands, { sessionId: session.conductorSessionId }, photo.bytes);
      if (out.ok) {
        photo.ref = out.ref;
        continue;
      }
      st.busy = false;
      if (out.unconfirmed) {
        // It may have landed: never sent again. The photo goes; attach it again if it is still wanted.
        st.list = st.list.filter((p) => p !== photo);
        st.problem = `${out.reason} That photo was not sent again; attach it once more if it didn't arrive.`;
      } else {
        st.problem = out.reason || "The photo could not be sent.";
      }
      this.touch();
      return false;
    }
    const message = composeMessage(
      words,
      ready.map((photo) => photo.ref),
    );
    if (message.length > MAX_REPLY_CHARS) {
      st.busy = false;
      st.problem = "That message is too long to send.";
      this.touch();
      return false;
    }
    st.list = [];
    st.busy = false;
    this.touch();
    return (await this.app.send(session, message, mode)) !== false;
  }

  /* ---------- pictures in the timeline ---------- */

  #imageKey(session, image) {
    return `${session.key}\n${image.source}`;
  }

  imageState(session, image) {
    return this.images.get(this.#imageKey(session, image)) ?? { phase: "idle", uri: null, reason: null };
  }

  /** Loads a picture on a tap, never by itself: nothing leaves the Mac until the person asks. */
  async loadImage(session, image, { thenView = false } = {}) {
    const key = this.#imageKey(session, image);
    const now = this.images.get(key);
    if (now?.phase === "loading") return;
    if (now?.phase === "loaded") return this.viewImage(session, image);
    this.images.set(key, { phase: "loading", uri: null, reason: null });
    this.touch();
    const commands = this.commands;
    const out =
      commands && session.conductorSessionId
        ? await this.deps.fetchImage(commands, { sessionId: session.conductorSessionId, source: image.source })
        : {
            ok: false,
            reason: commands ? "Only a Conductor chat's pictures can be shown here." : "Not connected to your Mac.",
          };
    if (out.ok) {
      this.images.set(key, { phase: "loaded", uri: out.uri, reason: null });
      for (const old of [...this.images.keys()].slice(0, Math.max(0, this.images.size - MAX_LOADED_IMAGES)))
        this.images.delete(old);
    } else {
      this.images.set(key, { phase: "failed", uri: null, reason: out.reason });
    }
    this.touch();
    if (out.ok && thenView) this.viewImage(session, image);
  }

  viewImage(session, image) {
    const state = this.imageState(session, image);
    if (state.phase !== "loaded") return;
    this.#closeAll();
    this.viewer = { key: session.key, uri: state.uri, name: image.alt || image.source.split("/").pop() || "Image" };
    this.touch();
    this.#focusDialog();
  }

  /* ---------- earlier history ---------- */

  #earlier(key) {
    let e = this.earlier.get(key);
    if (!e) {
      e = { state: emptyEarlier(), load: "idle" };
      this.earlier.set(key, e);
    }
    return e;
  }

  canPage(session) {
    return (
      Boolean(this.commands) && typeof session.conductorSessionId === "string" && session.conductorSessionId !== ""
    );
  }

  /** The row above the first message: `none`, `sentinel`, `loading`, `failed` or `start`. */
  earlierRowKind(session) {
    const e = this.#earlier(session.key);
    const held = this.app.history(session.key) ?? [];
    return earlierRow({ available: this.canPage(session), hasHeld: held.length > 0, state: e.state, load: e.load });
  }

  /** Timeline rows for the older messages fetched so far. */
  earlierRows(session) {
    const e = this.#earlier(session.key);
    return earlierRows(e.state.entries, this.app.history(session.key) ?? []);
  }

  async loadEarlier(session, manual = false) {
    const key = session.key;
    const e = this.#earlier(key);
    const held = this.app.history(key) ?? [];
    const args = { available: this.canPage(session), hasHeld: held.length > 0, state: e.state, load: e.load, manual };
    if (!shouldFetchEarlier(args)) return;
    e.load = "loading";
    this.touch();
    const before = earlierCursor(e.state, held);
    const scroller = typeof document !== "undefined" ? document.querySelector(".timeline") : null;
    const keepPlace = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 48;
    const heightBefore = scroller?.scrollHeight ?? 0;
    const topBefore = scroller?.scrollTop ?? 0;
    try {
      const out = await this.commands.history({ key, before: before ?? undefined, n: PAGE_SIZE });
      const expected = `${await liveHandle(key)}-h${before ?? "latest"}`;
      if (!out.ok || out.result?.doc !== expected) throw new Error("no page");
      const page = readPage(await this.#readLive(expected), key, before);
      if (!page) throw new Error("not this page");
      e.state = mergeEarlier(e.state, page, held);
      e.load = "idle";
      this.touch();
      // The reader keeps their place: what was first stays where it was.
      if (keepPlace) {
        frame(() => {
          const now = document.querySelector(".timeline");
          if (now?.dataset.key === key) now.scrollTop = topBefore + (now.scrollHeight - heightBefore);
        });
      }
    } catch {
      e.load = "failed";
      this.touch();
    }
  }

  /* ---------- the chat menu ---------- */

  toggleMenu(key) {
    this.menuOpen = this.menuOpen === key ? null : key;
    this.setupOpen = null;
    this.touch();
  }

  closeMenu() {
    if (this.menuOpen === null) return;
    this.menuOpen = null;
    this.touch();
  }

  notice(key) {
    return this.notices.get(key) ?? null;
  }

  dismissNotice(key) {
    this.notices.delete(key);
    this.touch();
  }

  async runMenu(session, id) {
    this.menuOpen = null;
    switch (id) {
      case "diff":
        return this.openDiff(session);
      case "close":
      case "archive":
        this.#closeAll();
        this.confirm = { kind: id, key: session.key, busy: false };
        this.touch();
        return this.#focusDialog();
      case "hide":
        return this.hide(session);
      case "createPr":
        return this.#workspace(session, "createPr");
      default:
        return this.touch();
    }
  }

  /** Puts the chat away on this browser only; it returns when it has newer activity. */
  async hide(session) {
    this.closeConfirm();
    await this.app.prefs.save(hideChange(hiddenChats(this.app.prefs.get("hiddenChats")), session, this.deps.now()));
    if (this.app.selected() === session.key) this.app.select(null);
    else this.touch();
  }

  closeConfirm() {
    if (!this.confirm || this.confirm.busy) return;
    this.confirm = null;
    this.touch();
  }

  async confirmAction(session) {
    const c = this.confirm;
    if (!c || c.busy) return;
    c.busy = true;
    this.touch();
    if (c.kind === "close") {
      const out = await this.commands.close({ sessionId: session.conductorSessionId });
      const result = closeResult(out);
      this.confirm = null;
      this.notices.set(session.key, { line: result.line, bad: !result.ok, title: result.ok ? null : "Couldn't close" });
      return this.touch();
    }
    this.confirm = null;
    await this.#workspace(session, "archive");
  }

  async #workspace(session, action) {
    const commands = this.commands;
    if (!commands) return;
    const input =
      action === "archive"
        ? { action, workspaceId: session.workspaceId }
        : { action, sessionId: session.conductorSessionId, answersTurn: session.turnId ?? null };
    this.notices.set(session.key, {
      line: action === "archive" ? "Archiving…" : "Asking for a pull request…",
      bad: false,
      busy: true,
    });
    this.touch();
    const out = await commands.workspace(input);
    const result = workspaceResult(action, out);
    this.notices.set(session.key, {
      line: result.line,
      bad: !result.ok,
      title: result.ok ? null : action === "archive" ? "Couldn't archive" : "Couldn't ask for a pull request",
    });
    this.touch();
  }

  /* ---------- model and thinking ---------- */

  setupChoices(session) {
    return setupModels(session, chatModels(this.app.view()));
  }

  toggleSetup(key) {
    this.setupOpen = this.setupOpen === key ? null : key;
    this.menuOpen = null;
    this.touch();
  }

  /** The line to show for what the chat runs: the one just asked for until the Mac's view catches up. */
  pendingSetup(key) {
    const p = this.setupPending.get(key);
    if (!p) return null;
    if (this.deps.now() - p.at > SETUP_PENDING_MS) {
      this.setupPending.delete(key);
      return null;
    }
    return p.line;
  }

  async changeSetup(session, chosen, pick) {
    if (this.setupBusy.has(session.key) || midTurn(session) || !this.commands) return;
    this.setupBusy.add(session.key);
    this.touch();
    const out = await this.commands.setup(setupInput(session, { model: chosen.id, ...pick }));
    this.setupBusy.delete(session.key);
    if (out.ok) {
      this.setupPending.set(session.key, { line: pendingSetupLine(session, chosen, pick), at: this.deps.now() });
      this.setupOpen = null;
      this.notices.delete(session.key);
    } else {
      this.notices.set(session.key, { line: out.reason, bad: true, title: "Couldn't change it" });
    }
    this.touch();
  }

  /* ---------- the diff ---------- */

  async openDiff(session) {
    this.#closeAll();
    const d = {
      key: session.key,
      sessionId: session.conductorSessionId,
      phase: "loading",
      diff: null,
      problem: null,
      file: null,
      patch: null,
      pages: 1,
    };
    this.diff = d;
    this.touch();
    this.#focusDialog();
    await this.#loadDiff(d);
  }

  async #loadDiff(d) {
    d.phase = "loading";
    d.problem = null;
    this.touch();
    const out = await this.commands.diff({ sessionId: d.sessionId });
    if (this.diff !== d) return;
    const diff = out.ok ? readDiff(out.result?.diff) : null;
    if (diff) {
      d.diff = diff;
      d.phase = "list";
    } else {
      d.phase = "problem";
      d.problem = out.ok ? "Your Mac sent something that isn't a list of changes." : out.reason;
    }
    this.touch();
  }

  retryDiff() {
    if (this.diff) void this.#loadDiff(this.diff);
  }

  async openFile(index) {
    const d = this.diff;
    if (!d?.diff?.files[index]) return;
    d.file = index;
    d.patch = { phase: "loading", lines: [], problem: null };
    d.pages = 1;
    this.touch();
    const out = await this.commands.diff({ sessionId: d.sessionId, file: index });
    if (this.diff !== d || d.file !== index) return;
    const patch = out.ok ? readPatch(out.result?.patch) : null;
    if (patch && patch.path === d.diff.files[index].path) {
      d.patch = { phase: "ready", lines: patchLines(patch.text), problem: null, empty: patch.text.trim() === "" };
    } else {
      d.patch = {
        phase: "problem",
        lines: [],
        problem: out.ok ? "The changes moved on since the list was read. Go back and open it again." : out.reason,
      };
    }
    this.touch();
  }

  backToFiles() {
    if (!this.diff) return;
    this.diff.file = null;
    this.diff.patch = null;
    this.touch();
  }

  morePatch() {
    if (this.diff) {
      this.diff.pages += 1;
      this.touch();
    }
  }

  closeDiff() {
    if (!this.diff) return;
    this.diff = null;
    this.touch();
  }

  /* ---------- dialogs ---------- */

  /** Which dialog is up for this chat, if any: `viewer`, `confirm`, `subagent` or `diff`. */
  dialogFor(key) {
    this.#sync(key);
    if (this.confirm?.key === key) return "confirm";
    if (this.viewer?.key === key) return "viewer";
    if (this.sub?.key === key) return "subagent";
    if (this.diff?.key === key) return "diff";
    return null;
  }

  // A dialog belongs to the chat it was opened in: leaving the chat closes it (and tells the Mac to stop a feed).
  #sync(key) {
    for (const name of ["viewer", "confirm", "diff"]) {
      if (this[name] && this[name].key !== key) this[name] = null;
    }
    if (this.sub && this.sub.key !== key) this.#dropSub();
  }

  #closeAll() {
    this.viewer = null;
    this.confirm = null;
    this.diff = null;
    this.#dropSub();
  }

  closeTop() {
    if (this.confirm) {
      if (!this.confirm.busy) this.confirm = null;
    } else if (this.viewer) this.viewer = null;
    else if (this.sub) this.#dropSub();
    else if (this.diff) {
      if (this.diff.file !== null) {
        this.diff.file = null;
        this.diff.patch = null;
      } else this.diff = null;
    } else if (this.menuOpen !== null || this.setupOpen !== null) {
      this.menuOpen = null;
      this.setupOpen = null;
    } else return false;
    this.touch();
    return true;
  }

  anyDialog() {
    return Boolean(
      this.confirm || this.viewer || this.sub || this.diff || this.menuOpen !== null || this.setupOpen !== null,
    );
  }

  #onKey(event) {
    if (event.key !== "Escape" || !this.anyDialog()) return;
    if (this.closeTop()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  #focusDialog() {
    if (typeof document === "undefined") return;
    frame(() => frame(() => document.querySelector('[data-keep="xdialog"]')?.focus()));
  }
}

/** The page makes one of these and hands it to the chat and Needs you panes as `env.extras`. */
export function createExtras(app, deps) {
  return new ChatExtras(app, deps);
}
