// Electron main process for the duck.
//
// Deliberately plain JavaScript with no build step: this is a small personal
// UI, and a bundler between "edit the duck" and "see the duck" would cost more
// than it returns. The logic worth testing — what mood the duck is in — lives
// in the daemon under src/fleet/duck-mood.ts, where CI covers it. Everything
// here is window management and drawing.

const { Tray, app, BrowserWindow, Menu, globalShortcut, ipcMain, nativeImage, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const COLLAPSED = { width: 132, height: 132 };
const EXPANDED = { width: 380, height: 500 };
const MARGIN = 24;

/**
 * ⌃⌥D by default. Avoids ⌘⌃D, which macOS uses for dictionary lookup, and
 * anything with ⌥Space, which most launchers take.
 */
const DEFAULT_SHORTCUT = "Control+Alt+D";
/** Separate from the peek shortcut on purpose: this only ever shows/hides
 * the duck, and never touches the panel. */
const DEFAULT_VISIBILITY_SHORTCUT = "Control+Alt+H";

let win = null;
let tray = null;
let expanded = false;
/** Which way the panel opens: "left" pins the duck to the window's right edge. */
let expandSide = "left";
/** A resize waiting on the renderer to stage the matching layout. */
let pendingExpand = null;

/** Give up waiting for the renderer and open anyway, rather than wedging. */
const EXPAND_READY_TIMEOUT_MS = 250;
let hidden = false;
let lastState = null;
/** Suppressed while a context menu is up, and while capturing screenshots. */
let suppressBlurClose = false;

function settingsPath() {
  return path.join(app.getPath("userData"), "duck.json");
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), ...patch }, null, 2));
  } catch {
    // Losing the remembered position is not worth crashing the duck over.
  }
}

/** Bottom-right of the work area, which is where a pet belongs by default. */
function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - COLLAPSED.width - MARGIN,
    y: area.y + area.height - COLLAPSED.height - MARGIN,
  };
}

function clampToDisplay(x, y, width, height) {
  // Use the display the duck is actually on, so a second monitor works.
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(y, area.y), area.y + area.height - height),
  };
}

function createWindow() {
  const saved = readSettings().position;
  const start = saved ?? defaultPosition();
  const placed = clampToDisplay(start.x, start.y, COLLAPSED.width, COLLAPSED.height);

  win = new BrowserWindow({
    ...COLLAPSED,
    x: placed.x,
    y: placed.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false, // Dragging is handled manually so a click stays a click.
    skipTaskbar: true,
    alwaysOnTop: true,
    // Shown explicitly once we know whether it was hidden last time. Creating
    // it visible and calling hide() afterwards can still flash a frame.
    show: false,
    fullscreenable: false,
    // An NSPanel rather than a normal window. macOS treats panels as utility
    // windows and leaves them in place across Space transitions instead of
    // animating them between Spaces, which is what made the duck vanish and
    // reappear when swiping between fullscreen desktops. Checked that a panel
    // can still take focus, which click-away-to-close depends on.
    type: "panel",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  applyFloatingBehavior(win);

  // Clicking anywhere else dismisses the panel, the way a popover does.
  win.on("blur", () => {
    if (expanded && !suppressBlurClose) {
      setExpanded(false);
    }
  });

  hidden = readSettings().hidden === true;

  const port = process.env.FLEET_HOOK_PORT || "8477";
  win.loadFile(path.join(__dirname, "renderer", "index.html"), { query: { port } });

  // Reveal only once there is something to draw, and only if it was not
  // hidden last time. showInactive keeps focus where the user left it.
  win.once("ready-to-show", () => {
    // Re-apply after the native window actually exists. Several Electron
    // issues report the collection-behavior flags not sticking reliably when
    // set immediately after construction, before the window has a backing
    // NSWindow; re-asserting once it is realized is a documented mitigation.
    applyFloatingBehavior(win);
    if (!hidden) {
      win.showInactive();
    }
  });
}

/**
 * "screen-saver" is the level real screensavers use, and WindowServer is
 * believed to special-case that level during the Mission Control Space-swipe
 * animation — plausibly why the duck vanished and reappeared on swipe even
 * after switching to a panel. "floating" still sits above ordinary windows
 * (which is all the duck needs) without that special handling.
 */
function applyFloatingBehavior(win) {
  win.setAlwaysOnTop(true, "floating");
  // skipTransformProcessType: without it Electron flips the process between
  // UIElementApplication and ForegroundApplication, which by its own
  // documentation "will hide the window and dock for a short time". The dock
  // is hidden before this window is built, so the app is already a
  // UIElementApplication and that transform is pure cost.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

/**
 * Grow up and to the left so the duck itself does not move when the panel
 * opens. The duck sits at the bottom-right of the window in both sizes, so
 * shifting the origin by the size difference pins it in place.
 *
 * Except when there is no room on the left: a duck parked against the left
 * edge would be shoved across the screen by the clamp below. Then the panel
 * opens to the right instead and the renderer mirrors the duck to the
 * bottom-left corner, so it still does not move.
 */
function setExpanded(next) {
  if (!win) {
    return;
  }
  // A toggle-twice during the staging window must not strand the old timer.
  cancelPendingExpand();
  if (next === expanded) {
    return;
  }
  if (!next) {
    // Collapse back onto the duck, pinning whichever edge it sits on.
    // Resize first, notify after: at 132px the two duck corners are 24px
    // apart, so a frame of the old layout barely reads. Opening is the
    // reverse — see finishExpand — because there the corners are 248px apart.
    const bounds = win.getBounds();
    const x = expandSide === "left" ? bounds.x + bounds.width - COLLAPSED.width : bounds.x;
    const y = bounds.y + bounds.height - COLLAPSED.height;
    const placed = clampToDisplay(x, y, COLLAPSED.width, COLLAPSED.height);
    win.setBounds({ ...placed, width: COLLAPSED.width, height: COLLAPSED.height });
    expanded = false;
    win.webContents.send("duck:expanded", { expanded: false, side: expandSide });
    writeSettings({ position: { x: placed.x, y: placed.y } });
    return;
  }

  const bounds = win.getBounds();
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const need = EXPANDED.width - bounds.width;
  const roomLeft = bounds.x - area.x;
  const roomRight = area.x + area.width - (bounds.x + bounds.width);
  expandSide = roomLeft >= need || roomRight < need ? "left" : "right";
  const placed = clampToDisplay(
    expandSide === "left" ? bounds.x - need : bounds.x,
    bounds.y + bounds.height - EXPANDED.height,
    EXPANDED.width,
    EXPANDED.height,
  );

  // The window grows synchronously but the renderer repaints a frame or two
  // later. Growing first would show the old layout stretched across the new
  // size — on expand-right that is the duck sitting in the wrong corner and
  // then jumping. So the renderer stages the matching layout first and the
  // resize lands on top of it. The timeout is the backstop, not the path:
  // the renderer answers after a frame, in single-digit milliseconds.
  pendingExpand = { x: placed.x, y: placed.y };
  win.webContents.send("duck:will-expand", { side: expandSide });
  pendingExpand.timer = setTimeout(() => finishExpand(), EXPAND_READY_TIMEOUT_MS);
}

/**
 * Grow the window onto the layout the renderer has staged. Idempotent: the
 * ack and the timeout race, and the loser finds nothing to do.
 */
function finishExpand() {
  if (!pendingExpand || !win || expanded) {
    pendingExpand = null;
    return;
  }
  const { x, y, timer } = pendingExpand;
  pendingExpand = null;
  if (timer) {
    clearTimeout(timer);
  }
  win.setBounds({ x, y, width: EXPANDED.width, height: EXPANDED.height });
  expanded = true;
  win.webContents.send("duck:expanded", { expanded: true, side: expandSide });

  // Behave like a popover: an open panel takes focus, which is what makes
  // clicking anywhere else dismiss it. Collapsed, the duck must never steal
  // focus from whatever you are typing in.
  win.focus();
}

function cancelPendingExpand() {
  if (pendingExpand?.timer) {
    clearTimeout(pendingExpand.timer);
  }
  pendingExpand = null;
}

/* ---------- visibility ---------- */

function setHidden(next) {
  if (!win || next === hidden) {
    return;
  }
  hidden = next;
  if (hidden) {
    setExpanded(false);
    win.hide();
  } else {
    win.showInactive(); // never steal focus from what you are typing in
  }
  writeSettings({ hidden });
  refreshTray();
}

/**
 * The shortcut is a peek: if the duck is hidden it comes back with its panel
 * open, otherwise it just toggles the panel. Hiding again is the tray's job,
 * so the same keystroke never makes the duck disappear unexpectedly.
 */
function peek() {
  if (hidden) {
    setHidden(false);
    setExpanded(true);
    return;
  }
  setExpanded(!expanded);
}

/* ---------- menu bar ---------- */

function trayTitle(state) {
  if (!state) {
    return "";
  }
  if (state.duck?.mood === "offline") {
    return "";
  }
  // Only a count worth interrupting for earns space in the menu bar.
  return state.duck?.blockedCount > 0 ? ` ${state.duck.blockedCount}` : "";
}

function trayTooltip(state) {
  if (!state) {
    return "Squeak — starting up";
  }
  const duck = state.duck ?? {};
  const bits = [];
  if (duck.blockedCount > 0) bits.push(`${duck.blockedCount} waiting on you`);
  if (duck.workingCount > 0) bits.push(`${duck.workingCount} working`);
  return bits.length > 0 ? `Squeak — ${bits.join(", ")}` : "Squeak — nothing running";
}

/** e.g. "Control+Alt+H" -> "⌃⌥H", for a menu item's keyboard hint. */
function describeAccelerator(shortcut) {
  return shortcut.replace("Control", "⌃").replace("Alt", "⌥").replace("Shift", "⇧").replace("Command", "⌘").replace(/\+/g, "");
}

/**
 * The tray dropdown's job is a glance at provider usage, not a second copy
 * of the session list — that already lives in the duck's own panel, one
 * click away. Codex reports real account-wide quota; Claude only ever
 * reports a per-session running cost, so it is shown as a total across
 * whatever sessions are currently active rather than implying a quota that
 * does not exist for it.
 */
function usageMenuItems(state) {
  const items = [];
  const usage = state?.codexUsage;

  if (usage?.primary) {
    const resets = formatCountdown(usage.primary.resetsAt);
    items.push({ label: `Codex 5h: ${Math.round(usage.primary.usedPercent)}% · resets ${resets}`, enabled: false });
  }
  if (usage?.secondary) {
    const resets = formatCountdown(usage.secondary.resetsAt);
    items.push({ label: `Codex 7d: ${Math.round(usage.secondary.usedPercent)}% · resets ${resets}`, enabled: false });
  }

  const claudeCost = (state?.active ?? [])
    .filter((session) => typeof session.costUsd === "number")
    .reduce((total, session) => total + session.costUsd, 0);
  if (claudeCost > 0) {
    // Almost always our own estimate from token counts, not Anthropic's own
    // figure — Claude Code only reports a real cost for the interactive CLI,
    // essentially never for a Conductor-driven session. Said plainly so it
    // does not read as a precise bill.
    items.push({ label: `Claude: ~$${claudeCost.toFixed(2)} est. (active sessions)`, enabled: false });
  }

  return items.length > 0 ? items : [{ label: "No usage data yet", enabled: false }];
}

/** "3h", "45m" — resetsAt is always in the future, so this counts down to it. */
function formatCountdown(iso) {
  const remainingMs = Date.parse(iso) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return "now";
  }
  const minutes = Math.ceil(remainingMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function refreshTray() {
  if (!tray) {
    return;
  }
  const state = lastState;

  tray.setTitle(trayTitle(state));
  tray.setToolTip(trayTooltip(state));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: state ? trayTooltip(state).replace("Squeak — ", "") : "starting up", enabled: false },
      { type: "separator" },
      ...usageMenuItems(state),
      { type: "separator" },
      // Toggle, so pass the negation. Passing `hidden` made this a no-op:
      // setHidden returns early when the requested state already matches.
      {
        label: `Show duck (${describeAccelerator(DEFAULT_VISIBILITY_SHORTCUT)})`,
        type: "checkbox",
        checked: !hidden,
        click: () => setHidden(!hidden),
      },
      { label: `Peek at panel (${describeAccelerator(DEFAULT_SHORTCUT)})`, click: peek },
      { label: "Reset duck position", click: resetPosition },
      { type: "separator" },
      { label: "Quit duck (back at next login)", click: () => app.quit() },
    ]),
  );
}

function resetPosition() {
  const position = defaultPosition();
  writeSettings({ position });
  if (win) {
    cancelPendingExpand();
    win.setBounds({ ...position, ...COLLAPSED });
    expanded = false;
    win.webContents.send("duck:expanded", false);
  }
}

ipcMain.on("duck:toggle", () => setExpanded(!expanded));
// The renderer staged the layout the pending resize needs; grow onto it.
ipcMain.on("duck:expand-ready", () => finishExpand());

// The renderer already polls /state; reuse its answer rather than polling twice.
ipcMain.on("duck:state", (_event, state) => {
  lastState = state;
  refreshTray();
});
ipcMain.on("duck:collapse", () => setExpanded(false));

ipcMain.on("duck:drag", (_event, delta) => {
  if (!win) {
    return;
  }
  // A drag during the staging window wins over the pending open: unstage the
  // layout and stay collapsed rather than teleporting on the ack.
  if (pendingExpand) {
    cancelPendingExpand();
    win.webContents.send("duck:expanded", { expanded: false, side: expandSide });
  }
  const bounds = win.getBounds();
  const placed = clampToDisplay(bounds.x + delta.dx, bounds.y + delta.dy, bounds.width, bounds.height);
  win.setBounds({ ...placed, width: bounds.width, height: bounds.height });
});

ipcMain.on("duck:drag-end", () => {
  if (!win || expanded) {
    return;
  }
  const bounds = win.getBounds();
  writeSettings({ position: { x: bounds.x, y: bounds.y } });
});

ipcMain.on("duck:open-path", (_event, target) => {
  if (typeof target === "string" && target.startsWith("/")) {
    void shell.openPath(target);
  }
});

ipcMain.on("duck:menu", () => {
  // A context menu takes focus away; that is not clicking off the panel.
  suppressBlurClose = true;
  Menu.buildFromTemplate([
    { label: "Hide duck", click: () => setHidden(true) },
    { label: "Reset position", click: resetPosition },
    { type: "separator" },
    { label: "Quit duck (back at next login)", click: () => app.quit() },
  ]).popup({
    window: win ?? undefined,
    callback: () => {
      suppressBlurClose = false;
    },
  });
});

/**
 * Write PNGs of the duck by asking the window to photograph itself. Used to
 * review the UI without granting anything Screen Recording permission.
 */
async function captureTo(prefix) {
  if (!win) {
    return;
  }
  // Screenshots hold the panel open deliberately, with nothing else focused.
  suppressBlurClose = true;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(2500); // let the first poll land and the idle animation settle

  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(prefix), { recursive: true });
    fs.writeFileSync(`${prefix}-${name}.png`, image.toPNG());
  };

  await shot("collapsed");
  setExpanded(true);
  await wait(900);
  await shot("expanded");
  app.quit();
}

app.whenReady().then(() => {
  // A pet does not belong in the dock or the app switcher.
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  createWindow();

  // No "click" handler here: Electron already opens the context menu itself
  // when setContextMenu is set, and clicking the tray icon used to also fire
  // peek() on top of that — so left-clicking to open the menu popped the
  // agents panel open at the same time. The menu is all a tray click should do.
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "duckTemplate.png")));
  tray.setIgnoreDoubleClickEvents(true);
  refreshTray();

  const shortcut = readSettings().shortcut ?? DEFAULT_SHORTCUT;
  if (!globalShortcut.register(shortcut, peek)) {
    // Another app already owns it. Say so rather than failing silently.
    console.warn(`duck: could not register ${shortcut} — something else has it`);
  }

  // A separate shortcut from the peek above: this only ever shows or hides
  // the duck and never touches the panel, so it cannot be confused with the
  // click-away-to-close behaviour the panel has.
  const visibilityShortcut = readSettings().visibilityShortcut ?? DEFAULT_VISIBILITY_SHORTCUT;
  if (!globalShortcut.register(visibilityShortcut, () => setHidden(!hidden))) {
    console.warn(`duck: could not register ${visibilityShortcut} — something else has it`);
  }

  const capturePrefix = process.env.DUCK_CAPTURE;
  if (capturePrefix && win) {
    win.webContents.once("did-finish-load", () => void captureTo(capturePrefix));
  }
});

app.on("will-quit", () => globalShortcut.unregisterAll());

// The duck can be hidden while the app keeps running for the menu bar, so a
// closed window must not mean quit the way it did before the tray existed.
app.on("window-all-closed", () => {
  if (!tray) {
    app.quit();
  }
});
