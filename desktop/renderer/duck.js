// Renderer: draws whatever the daemon says. It deliberately decides nothing —
// mood, which sessions count as active, and what each one is doing all come
// from /state, so the duck and Telegram can never tell you different stories.

const POLL_MS = 2000;
const port = new URLSearchParams(location.search).get("port") ?? "8477";
const STATE_URL = `http://127.0.0.1:${port}/state`;

const els = {
  body: document.body,
  panel: document.getElementById("panel"),
  sub: document.getElementById("panel-sub"),
  foot: document.getElementById("panel-foot"),
  sessions: document.getElementById("sessions"),
  badge: document.getElementById("badge"),
  wrap: document.getElementById("duck-wrap"),
};

/* ---------- the duck drawing ---------- */

/**
 * Use a generated sprite if one has been dropped next to this file, and the
 * hand-drawn fallback otherwise. Probing rather than requiring it means the
 * app always has a duck, and replacing the art is just saving a PNG.
 */
function loadSprite(id, file, bodyClass) {
  const img = document.getElementById(id);
  const probe = new Image();
  probe.addEventListener("load", () => {
    img.src = file;
    document.body.classList.add(bodyClass);
  });
  probe.src = file;
}

loadSprite("duck-sprite", "duck.png", "has-sprite");
loadSprite("duck-sprite-asleep", "duck-asleep.png", "has-asleep-sprite");

/* ---------- polling ---------- */

async function poll() {
  try {
    const response = await fetch(STATE_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    render(await response.json());
  } catch {
    // The daemon is not running, or not running the fleet. Say so plainly
    // rather than showing a cheerful duck next to stale information.
    renderOffline();
  }
}

/* ---------- rendering ---------- */

function render(state) {
  const duck = state.duck ?? { mood: "asleep", blockedCount: 0, workingCount: 0, justFinished: [] };
  const active = state.active ?? [];

  els.body.dataset.offline = "false";
  els.body.dataset.mood = duck.mood;

  renderBadge(duck);
  els.sub.textContent = summarize(duck, active.length);
  els.foot.textContent = `${active.length} active · ${state.trackedCount ?? 0} tracked`;
  els.wrap.title = summarize(duck, active.length);

  if (active.length === 0) {
    els.sessions.innerHTML = `<div class="empty">Nothing running.<br />Go outside.</div>`;
    return;
  }

  els.sessions.replaceChildren(...active.map((session) => sessionRow(session)));
}

function renderOffline() {
  els.body.dataset.offline = "true";
  els.body.dataset.mood = "asleep";
  els.badge.hidden = true;
  els.sub.textContent = "bridge offline";
  els.foot.textContent = `no daemon on 127.0.0.1:${port}`;
  els.sessions.innerHTML = `<div class="empty">Can't reach the bridge.<br />Is conductor-tg running?</div>`;
  els.wrap.title = "conductor-tg is not running";
}

function renderBadge(duck) {
  if (duck.blockedCount > 0) {
    els.badge.hidden = false;
    els.badge.className = "";
    els.badge.textContent = String(duck.blockedCount);
    return;
  }
  if (duck.justFinished.length > 0) {
    els.badge.hidden = false;
    els.badge.className = "done";
    els.badge.textContent = "✓";
    return;
  }
  els.badge.hidden = true;
}

function summarize(duck, activeCount) {
  if (duck.blockedCount > 0) {
    return `${duck.blockedCount} waiting on you`;
  }
  if (duck.justFinished.length > 0) {
    return "just finished";
  }
  if (duck.workingCount > 0) {
    return `${duck.workingCount} working`;
  }
  return activeCount > 0 ? "idle" : "nothing running";
}

const STATE_WORD = {
  working: "working",
  awaiting_approval: "needs approval",
  awaiting_input: "needs an answer",
  finished: "done",
  error: "errored",
  idle: "waiting",
};

function sessionRow(session) {
  const row = document.createElement("div");
  row.className = `session ${session.state}${session.cwd ? " clickable" : ""}`;

  const dot = document.createElement("div");
  dot.className = "dot";

  const main = document.createElement("div");

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = label(session);
  if (session.cwd) {
    name.title = session.cwd;
    name.addEventListener("click", (event) => {
      event.stopPropagation();
      window.duck.openPath(session.cwd);
    });
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [
    STATE_WORD[session.state] ?? session.state,
    session.detail,
    age(session.lastActivityAt),
    session.origin === "conductor" ? null : session.origin,
    session.contextPercent !== null && session.contextPercent >= 60
      ? `ctx ${Math.round(session.contextPercent)}%`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  main.append(name, meta);

  const git = describeGit(session.git);
  if (git) {
    const gitLine = document.createElement("div");
    gitLine.className = "git";
    gitLine.textContent = git;
    main.append(gitLine);
  }

  row.append(dot, main);
  return row;
}

function label(session) {
  if (session.repoName && session.branch && session.branch !== "HEAD") {
    return `${session.repoName} · ${session.branch}`;
  }
  if (session.cwd) {
    const parts = session.cwd.split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  }
  return session.title ?? session.key;
}

function describeGit(git) {
  if (!git) {
    return null;
  }
  const parts = [];
  if (git.insertions > 0 || git.deletions > 0) {
    parts.push(`+${git.insertions}/−${git.deletions}`);
  }
  const touched = git.filesChanged + git.untracked;
  if (touched > 0) {
    parts.push(`${touched} file${touched === 1 ? "" : "s"}`);
  }
  if (git.hasUpstream && git.ahead > 0) {
    parts.push(`${git.ahead} unpushed`);
  } else if (!git.hasUpstream && git.aheadOfBase > 0) {
    parts.push(`${git.aheadOfBase} commit${git.aheadOfBase === 1 ? "" : "s"}, not pushed`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function age(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/* ---------- dragging, which must not swallow clicks ---------- */

const DRAG_THRESHOLD_PX = 4;
let drag = null;

els.wrap.addEventListener("mousedown", (event) => {
  if (event.button !== 0) {
    return;
  }
  // Track in screen coordinates: the window moves out from under the cursor,
  // so client coordinates jump around mid-drag.
  drag = { lastX: event.screenX, lastY: event.screenY, travelled: 0 };
  event.preventDefault();
});

window.addEventListener("mousemove", (event) => {
  if (!drag) {
    return;
  }
  const dx = event.screenX - drag.lastX;
  const dy = event.screenY - drag.lastY;
  drag.lastX = event.screenX;
  drag.lastY = event.screenY;
  drag.travelled += Math.abs(dx) + Math.abs(dy);
  if (drag.travelled > DRAG_THRESHOLD_PX) {
    window.duck.drag(dx, dy);
  }
});

window.addEventListener("mouseup", () => {
  if (!drag) {
    return;
  }
  const wasClick = drag.travelled <= DRAG_THRESHOLD_PX;
  drag = null;
  if (wasClick) {
    window.duck.toggle();
  } else {
    window.duck.dragEnd();
  }
});

els.wrap.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.duck.menu();
});

// The main process owns whether the panel is open, because it also owns the
// window size; the renderer just reflects what it is told.
window.duck.onExpanded((value) => {
  els.body.classList.toggle("expanded", Boolean(value));
});

/* ---------- go ---------- */

void poll();
setInterval(() => void poll(), POLL_MS);
