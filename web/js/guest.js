// The web guest page: `join.html#<code>`. Reads the invite from the fragment (never sent anywhere, then taken out of the
// address bar), asks for a name, waits for the owner's approval, then shows the pond, its shared threads and one thread
// live. Wiring only: the engine is guest-pond.js, what is said is guest-model.js, what is drawn is guest-view.js.

import { clearFragment, codeFrom, readInvite } from "./guest-invite.js";
import { foldEvents, pendingSends, workingRow } from "./guest-model.js";
import { GuestError, GuestPond } from "./guest-pond.js";
import { watchPond } from "./guest-relay.js";
import { createThreadScreen, endScreen, nameScreen, pondScreen, waitingScreen, page } from "./guest-view.js";
import { h } from "./dom.js";
import { KeyStore } from "./key-store.js";

const MIN_GAP_MS = 1_500;
const HEARTBEAT_MS = 30_000;
const HOLD_RENEW_MS = 10_000;

export function startGuest({
  root,
  win = globalThis,
  vault = new KeyStore(),
  fetch,
  socket,
  minGapMs = MIN_GAP_MS,
} = {}) {
  const ui = {
    pond: null,
    invite: null,
    screen: "loading",
    error: null,
    busy: false,
    view: null,
    note: null,
    thread: null,
    threadUi: null,
    extraHolds: [],
    sig: "",
  };
  let watcher = null;
  let beat = null;
  let running = false;
  let dirty = false;
  let last = 0;
  let timer = null;

  const mount = (...nodes) => {
    root.replaceChildren(...nodes.filter(Boolean));
    ui.sig = "";
  };
  const banner = () => (ui.note ? h("p", { class: "g-note", role: "alert" }, ui.note) : null);

  function showEnd(title, body, action) {
    stopLive();
    ui.threadUi = null;
    mount(endScreen({ title, body, action }));
  }

  function showName() {
    ui.threadUi = null;
    ui.screen = "name";
    mount(
      nameScreen({
        pondName: ui.invite.name,
        role: ui.invite.role,
        error: ui.error,
        busy: ui.busy,
        onSubmit: join,
      }),
    );
  }

  async function join(name) {
    if (ui.busy) return;
    ui.busy = true;
    ui.error = null;
    showName();
    try {
      ui.pond = await GuestPond.join(ui.invite, name, { vault, fetch });
      ui.busy = false;
      await resume();
    } catch (error) {
      ui.busy = false;
      ui.error =
        error instanceof GuestError ? error.message : "I couldn't reach the pond. Check your connection and try again.";
      showName();
    }
  }

  async function leave() {
    stopLive();
    await ui.pond?.forget();
    ui.pond = null;
    ui.thread = null;
    ui.view = null;
    ui.threadUi = null;
    if (ui.invite) showName();
    else showEnd("You've left the pond", "Open an invite link to join a pond.");
  }

  // live

  function startLive() {
    stopLive();
    watcher = watchPond({ store: ui.pond.store, wake: schedule, ...(socket ? { socket } : {}) });
    beat = setInterval(() => {
      if (win.document?.visibilityState === "hidden" || ui.pond?.status !== "active") return;
      void ui.pond.setPresence({ viewing: ui.thread?.id }).catch(() => undefined);
    }, HEARTBEAT_MS);
  }
  function stopLive() {
    watcher?.stop();
    watcher = null;
    clearInterval(beat);
    clearTimeout(timer);
    beat = null;
  }

  function schedule() {
    if (running) {
      dirty = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(pass, Math.max(0, last + minGapMs - Date.now()));
  }

  async function pass() {
    running = true;
    do {
      dirty = false;
      last = Date.now();
      try {
        await tick();
        if (ui.note) {
          ui.note = null;
          paint();
        }
      } catch {
        ui.note = "I can't reach the pond right now. I'll keep trying.";
        paint();
      }
    } while (dirty);
    running = false;
  }

  async function tick() {
    const pond = ui.pond;
    if (!pond) return;
    const before = pond.status;
    const status = await pond.refresh();
    if (status === "pending") {
      paint();
      return;
    }
    if (status !== "active") {
      paint();
      return;
    }
    if (before === "pending") {
      // Let in: the pond-scoped token has arrived, so the stream moves to it and the guest says hello.
      startLive();
      await pond.setPresence({}).catch(() => undefined);
    }
    try {
      ui.view = await pond.view();
    } catch (error) {
      if (error instanceof GuestError) {
        paint();
        return;
      }
      throw error;
    }
    ui.extraHolds = ui.extraHolds.filter(
      (x) => x.until > Date.now() && !ui.view.holds.some((hold) => hold.requestId === x.requestId),
    );
    if (ui.thread) await readThread();
    paint();
  }

  async function readThread() {
    const t = ui.thread;
    const { events, lastSeq } = await ui.pond.readEvents(t.id, t.lastSeq).catch((error) => {
      if (error instanceof GuestError && error.status === 404) return { events: null };
      throw error;
    });
    if (events === null) {
      t.gone = true;
      return;
    }
    const known = new Set(t.events.map((e) => e.seq));
    t.events = [...t.events, ...events.filter((e) => !known.has(e.seq))].sort((a, b) => a.seq - b.seq);
    t.lastSeq = lastSeq;
  }

  // drawing

  function paint() {
    const pond = ui.pond;
    if (!pond) return;
    switch (pond.status) {
      case "pending":
        ui.screen = "waiting";
        mount(
          banner(),
          waitingScreen({ pondName: pond.record.pondName, ownerName: pond.record.ownerName, onCancel: leave }),
        );
        return;
      case "denied":
        stopLive();
        showEnd(
          `${pond.record.ownerName || "The owner"} didn't let you in`,
          "The request was declined or the invite lapsed. Ask for a new link if you want to try again.",
          { label: "Start over", onClick: leave },
        );
        return;
      case "removed":
        showEnd(
          `You're no longer in ${pond.record.pondName}`,
          "The owner took you out of the pond. What you read here is gone from this browser.",
          {
            label: "Done",
            onClick: leave,
          },
        );
        return;
      default:
        break;
    }
    if (!ui.view) {
      ui.screen = "loading";
      mount(page(h("p", { class: "g-lead" }, "Opening the pond…")));
      return;
    }
    if (ui.thread && !ui.thread.gone) paintThread();
    else paintPond();
  }

  function paintPond() {
    ui.threadUi = null;
    const sig = JSON.stringify([ui.view, ui.note]);
    if (ui.screen === "pond" && sig === ui.sig) return;
    ui.screen = "pond";
    const screen = pondScreen({ view: ui.view, now: Date.now(), onOpen: openThread, onLeave: leave });
    mount(screen);
    if (ui.note) root.prepend(banner());
    ui.sig = sig;
  }

  function paintThread() {
    const t = ui.thread;
    const thread = ui.view.threads.find((x) => x.id === t.id);
    if (!thread) {
      t.gone = true;
      ui.note = "That thread is no longer shared with the pond.";
      paintPond();
      return;
    }
    if (!ui.threadUi || ui.screen !== "thread") {
      ui.threadUi = createThreadScreen({
        onBack: () => (win.history.state?.t ? win.history.back() : closeThread()),
        onSend: send,
        onHold: holdQuestion,
        onAnswer: answer,
        onTakeBack: takeBack,
      });
      ui.screen = "thread";
      mount(ui.threadUi.node);
    }
    const { rows, state } = foldEvents(t.events, ui.view.me.id);
    const shown = thread.state || state;
    ui.threadUi.update({
      thread,
      role: ui.view.me.role,
      me: ui.view.me,
      state: shown,
      rows,
      working: workingRow(rows, shown),
      holds: [...ui.view.holds, ...ui.extraHolds],
      answered: t.answered,
      pending: pendingSends(t.sends, t.events, Date.now()),
    });
  }

  // doing

  function openThread(id) {
    ui.thread = { id, events: [], lastSeq: 0, sends: [], answered: new Set(), lastHold: {}, gone: false };
    win.history.pushState({ t: id }, "");
    ui.screen = "pond";
    void ui.pond.setPresence({ viewing: id }).catch(() => undefined);
    paint();
    schedule();
  }

  function closeThread() {
    ui.thread = null;
    ui.threadUi = null;
    ui.screen = "loading";
    void ui.pond.setPresence({}).catch(() => undefined);
    paint();
  }

  async function send(text, mode) {
    const t = ui.thread;
    const item = { id: `${Date.now()}-${Math.random()}`, text, mode, at: Date.now(), after: t.lastSeq, failed: false };
    t.sends.push(item);
    paint();
    try {
      await ui.pond.sendCommand(t.id, { kind: mode === "steer" ? "steer" : "message", text });
    } catch (error) {
      if (error instanceof GuestError) {
        // Refused before anything was written: nothing was sent, so the words go back in the box.
        t.sends = t.sends.filter((s) => s !== item);
        ui.note = error.message;
        paint();
        ui.threadUi?.setDraft(text);
      } else {
        // The write may or may not have arrived: said so, never sent again by itself.
        item.failed = true;
        paint();
      }
    }
  }

  function takeBack(item) {
    const t = ui.thread;
    t.sends = t.sends.filter((s) => s !== item);
    paint();
    ui.threadUi?.setDraft(item.text);
  }

  async function holdQuestion(requestId) {
    const t = ui.thread;
    if (Date.now() - (t.lastHold[requestId] ?? 0) < HOLD_RENEW_MS) return;
    t.lastHold[requestId] = Date.now();
    try {
      const r = await ui.pond.hold(requestId);
      if (!r.ok) noteHolder(requestId, r.heldBy);
      else schedule();
    } catch {
      // The next keystroke tries again.
    }
  }

  function noteHolder(requestId, byName) {
    ui.extraHolds.push({ requestId, by: "someone-else", byName, until: Date.now() + 30_000 });
    paint();
  }

  async function answer(requestId, text) {
    const t = ui.thread;
    try {
      const r = await ui.pond.hold(requestId);
      if (!r.ok) return noteHolder(requestId, r.heldBy);
      await ui.pond.sendCommand(t.id, { kind: "answer", requestId, answer: text });
      t.answered.add(requestId);
    } catch (error) {
      ui.note = error instanceof GuestError ? error.message : "I couldn't confirm that answer arrived.";
    }
    paint();
  }

  // start

  async function resume() {
    const pond = ui.pond;
    ui.screen = "loading";
    paint();
    startLive();
    if (pond.status === "active") await pond.setPresence({}).catch(() => undefined);
    schedule();
  }

  win.addEventListener?.("popstate", () => {
    if (ui.thread && !win.history.state?.t) closeThread();
  });
  win.document?.addEventListener?.("visibilitychange", () => {
    if (!ui.pond || ui.pond.status !== "active") return;
    if (win.document.visibilityState === "visible") {
      void ui.pond.setPresence({ viewing: ui.thread?.id }).catch(() => undefined);
      schedule();
    } else {
      void ui.pond.setPresence({ online: false }).catch(() => undefined);
    }
  });

  return (async () => {
    mount(page(h("p", { class: "g-lead" }, "One moment…")));
    const code = codeFrom(win.location?.hash);
    const parsed = code ? readInvite(code, Date.now(), win.location.origin) : null;
    if (code) clearFragment(win);
    if (parsed?.ok) ui.invite = parsed.invite;
    const saved = await GuestPond.load({ vault, fetch }).catch(() => null);
    if (
      saved &&
      (saved.status === "active" || saved.status === "pending") &&
      (!ui.invite || ui.invite.pondId === saved.pondId)
    ) {
      ui.pond = saved;
      return resume();
    }
    if (saved && ui.invite && (saved.status === "active" || saved.status === "pending")) {
      // Another pond's invite while this browser is already in one: the person chooses.
      return showEnd(
        `You're already in ${saved.record.pondName}`,
        `This browser keeps one pond at a time. To join ${ui.invite.name}, leave ${saved.record.pondName} first.`,
        {
          label: `Leave ${saved.record.pondName} and join ${ui.invite.name}`,
          onClick: async () => {
            await saved.forget();
            showName();
          },
        },
      );
    }
    if (saved) {
      if (!ui.invite) {
        ui.pond = saved;
        return paint();
      }
      await saved.forget();
    }
    if (ui.invite) return showName();
    if (parsed && !parsed.ok) return showEnd("This link can't be used", parsed.reason);
    return showEnd("Open an invite link", "This page opens from the link someone sent you to join their pond.");
  })();
}
