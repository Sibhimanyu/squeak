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

const { openAppWindow, registerAppIpc } = require("./app-window");
const service = require("./squeak-service");

// One settings folder whether it runs from Squeak.app or from the checkout,
// so the duck's position and the single-instance lock below are shared.
app.setPath(
  "userData",
  // A capture run is a test: it must not share settings, or the lock, with
  // the duck already running.
  process.env.SQUEAK_CAPTURE || process.env.DUCK_CAPTURE
    ? fs.mkdtempSync(path.join(require("node:os").tmpdir(), "squeak-capture-"))
    : // Inside the daemon's folder rather than beside it: macOS paths are
      // case-insensitive, so a sibling "Squeak" would be the daemon's
      // "squeak" folder, and Chromium's caches would land among its secrets.
      path.join(app.getPath("appData"), "squeak", "desktop"),
);

// One Squeak. Opening it again (Finder, Spotlight, the Dock) must reach the
// running copy and show its window, not start a second duck.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

/** Started by launchd at login: duck and menu bar only, no window. */
const STARTED_IN_BACKGROUND = process.argv.includes("--background");

const COLLAPSED = { width: 132, height: 132 };
const EXPANDED = { width: 380, height: 500 };
const MARGIN = 24;

// Duck geometry, in CSS px — must match duck.css (#duck-wrap, #duck-sprite).
// Collapsed, the duck sits bottom-right; expanded-right, bottom-left. Its
// center is not the same distance from the window's left edge in the two
// layouts, so opening to the right has to nudge the window by the difference
// to keep the duck itself pixel-still on screen.
const DUCK_WRAP_PX = 108;
const DUCK_SPRITE_PX = 96;
const COLLAPSED_DUCK_CENTER = COLLAPSED.width - DUCK_WRAP_PX + DUCK_WRAP_PX / 2;
const EXPANDED_RIGHT_DUCK_CENTER = (DUCK_WRAP_PX - DUCK_SPRITE_PX) / 2 + DUCK_SPRITE_PX / 2;
const RIGHT_SHIFT = COLLAPSED_DUCK_CENTER - EXPANDED_RIGHT_DUCK_CENTER;

/**
 * ⌃⌥D by default. Avoids ⌘⌃D, which macOS uses for dictionary lookup, and
 * anything with ⌥Space, which most launchers take.
 */
const DEFAULT_SHORTCUT = "Control+Alt+D";
/** Separate from the peek shortcut on purpose: this only ever shows/hides
 * the duck, and never touches the panel. */
const DEFAULT_VISIBILITY_SHORTCUT = "Control+Alt+H";

let win = null;
/** The native glass behind the open panel (createGlass); null where there is none. */
let glass = null;
/** Where the panel sits inside `win`, as the renderer last measured it. */
let panelRect = null;
let tray = null;
let expanded = false;
/** Which way the panel opens: "left" pins the duck to the window's right edge. */
let expandSide = "left";
/** A resize waiting on the renderer to stage the matching layout. */
let pendingExpand = null;
/**
 * Whether opening the panel made this the active app, and nothing has taken
 * that back since. Then a collapse that was not a click elsewhere hands
 * activation back, or your typing would land nowhere.
 */
let activatedForPanel = false;

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
    if (suppressBlurClose) {
      return; // Our own context menu; the panel stays, and so does activation.
    }
    // Whatever took focus — another app, or the Squeak window — now has it.
    activatedForPanel = false;
    if (expanded) {
      setExpanded(false);
    }
  });

  hidden = readSettings().hidden === true;
  createGlass();

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
    if (glass) {
      applyFloatingBehavior(glass, 0);
      win.webContents.send("duck:glass", true);
    }
    if (!hidden) {
      win.showInactive();
    }
  });
}

/**
 * Real glass behind the panel. A web page cannot blur what is behind its
 * window — CSS backdrop-filter only blurs the page's own content, so the
 * panel's "20px blur" was a flat fill with other apps' text showing through
 * — and macOS's material (NSVisualEffectView, Electron's `vibrancy`) covers
 * a whole window, not part of one. The duck's window is mostly empty space
 * around the duck, so the glass gets a window of its own, sized to the
 * panel and kept just beneath the duck's. It never takes focus or clicks,
 * so click-away-to-close and dragging are exactly as they were.
 */
function createGlass() {
  // A capture photographs the page only, where the glass is not; it keeps
  // the opaque panel so the shot is honest. DUCK_CAPTURE_GLASS=1 keeps the
  // glass anyway, for a screen-level shot (screencapture) of the real thing.
  if (process.platform !== "darwin" || (process.env.DUCK_CAPTURE && !process.env.DUCK_CAPTURE_GLASS)) {
    return;
  }
  try {
    glass = new BrowserWindow({
      width: EXPANDED.width,
      height: EXPANDED.height,
      frame: false,
      transparent: true,
      show: false,
      focusable: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      fullscreenable: false,
      hasShadow: true, // the panel's shadow is the native one now
      roundedCorners: true,
      type: "panel",
      vibrancy: "popover", // follows light and dark, like a system popover
      visualEffectState: "active", // stays glass when Squeak is not the active app
    });
    glass.setIgnoreMouseEvents(true);
    applyFloatingBehavior(glass, 0);
    void glass.loadURL("data:text/html,<body style='background:transparent'></body>");
  } catch (error) {
    console.warn("duck: no glass, keeping the opaque panel", error);
    glass = null;
  }
}

/** Put the glass exactly under the panel, or put it away. */
function syncGlass() {
  if (!glass || glass.isDestroyed()) {
    return;
  }
  if (!win || !expanded || hidden || !panelRect) {
    glass.hide();
    return;
  }
  const bounds = win.getBounds();
  glass.setBounds({
    x: Math.round(bounds.x + panelRect.x),
    y: Math.round(bounds.y + panelRect.y),
    width: Math.round(panelRect.width),
    height: Math.round(panelRect.height),
  });
  if (!glass.isVisible()) {
    glass.showInactive();
  }
}

/**
 * "screen-saver" is the level real screensavers use, and WindowServer is
 * believed to special-case that level during the Mission Control Space-swipe
 * animation — plausibly why the duck vanished and reappeared on swipe even
 * after switching to a panel. "floating" still sits above ordinary windows
 * (which is all the duck needs) without that special handling.
 */
function applyFloatingBehavior(win, relativeLevel = 1) {
  // Closing the app window while quitting runs this after the duck's window is gone.
  if (!win || win.isDestroyed()) return;
  // The duck sits one step above "floating" so the glass window, at
  // "floating" itself, is always just behind it.
  win.setAlwaysOnTop(true, "floating", relativeLevel);
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
 * bottom-left corner. The corners are not symmetric — the duck's center sits
 * RIGHT_SHIFT further right in the collapsed layout — so the window is nudged
 * by exactly that much and the duck stays pixel-still; a 24px panel slide
 * reads as the window opening, while the duck teleporting reads as a glitch.
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
    // Collapse back onto the duck, pinning it where it sits on screen.
    const bounds = win.getBounds();
    const x = bounds.x + (expandSide === "left" ? bounds.width - COLLAPSED.width : -RIGHT_SHIFT);
    const y = bounds.y + bounds.height - COLLAPSED.height;
    const placed = clampToDisplay(x, y, COLLAPSED.width, COLLAPSED.height);
    win.setBounds({ ...placed, width: COLLAPSED.width, height: COLLAPSED.height });
    expanded = false;
    syncGlass();
    win.webContents.send("duck:expanded", { expanded: false, side: expandSide });
    // placed.x is already the collapsed-equivalent position: both branches
    // above derive it by pinning the duck, just from opposite edges.
    writeSettings({ position: { x: placed.x, y: placed.y } });
    handBackActivation();
    return;
  }

  const bounds = win.getBounds();
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const need = EXPANDED.width - bounds.width;
  const roomLeft = bounds.x - area.x;
  const roomRight = area.x + area.width - (bounds.x + bounds.width);
  expandSide = roomLeft >= need || roomRight < need + RIGHT_SHIFT ? "left" : "right";
  const placed = clampToDisplay(
    // Opening right, the window itself slides RIGHT_SHIFT so the duck — which
    // sits closer to the window's left edge in this layout — lands exactly
    // where it was. Collapsing mirrors it back (see above).
    expandSide === "left" ? bounds.x - need : bounds.x + RIGHT_SHIFT,
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
  syncGlass(); // with the last measured rect; the renderer re-measures a frame later
  win.webContents.send("duck:expanded", { expanded: true, side: expandSide });

  // Behave like a popover: an open panel takes focus, which is what makes
  // clicking anywhere else dismiss it. Collapsed, the duck must never steal
  // focus from whatever you are typing in.
  //
  // Focus alone is not enough. The panel is non-activating, so the app you
  // were in stays the active one, and clicking back into it — the usual way
  // to dismiss a popover — never takes focus from the panel: no blur, and the
  // panel stayed open (probed: Conductor frontmost, panel focused, Conductor
  // activated again, still focused). Becoming the active app fixes that. But
  // activating raises every window the app has, so not while the Squeak
  // window is showing: it would jump in front of your work (probed too).
  const othersShowing = BrowserWindow.getAllWindows().some(
    (other) => other !== win && other.isVisible() && !other.isMinimized(),
  );
  if (!othersShowing) {
    app.focus({ steal: true });
    activatedForPanel = true;
  }
  win.focus();
}

/**
 * The panel closed some other way than a click elsewhere — the duck, the
 * shortcut, Escape — while this was still the active app. Hiding the app
 * returns activation to whichever app had it, and showing the duck again
 * without activating keeps it on screen; it is gone for well under a frame.
 */
function handBackActivation() {
  if (!activatedForPanel || !win) {
    return;
  }
  activatedForPanel = false;
  if (!win.isFocused()) {
    return;
  }
  app.hide();
  if (!hidden) {
    win.showInactive();
  }
  // Collapsed by now, so the glass stays put away; app.hide() already hid it.
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
    syncGlass();
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
  return shortcut
    .replace("Control", "⌃")
    .replace("Alt", "⌥")
    .replace("Shift", "⇧")
    .replace("Command", "⌘")
    .replace(/\+/g, "");
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

  // A window that has reset since the reading is empty again; its old number is the last window's.
  const line = (name, reading) =>
    Date.parse(reading.resetsAt) <= Date.now()
      ? `Codex ${name}: reset, not read since`
      : `Codex ${name}: ${Math.round(reading.usedPercent)}% · resets ${formatCountdown(reading.resetsAt)}`;
  if (usage?.primary) {
    items.push({ label: line("5h", usage.primary), enabled: false });
  }
  if (usage?.secondary) {
    items.push({ label: line("7d", usage.secondary), enabled: false });
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

/**
 * The window gets a Dock icon and a ⌘-Tab entry while it is open; the duck on
 * its own stays out of both, as a pet should. Switching activation policy
 * briefly hides every window, so the duck's floating behaviour is re-applied
 * after each switch (see applyFloatingBehavior).
 */
function openSqueak() {
  const appWindow = openAppWindow();
  if (process.platform === "darwin" && app.dock && !app.dock.isVisible()) {
    void app.dock.show().then(() => {
      if (win) applyFloatingBehavior(win);
      if (glass) applyFloatingBehavior(glass, 0);
      appWindow.focus();
    });
  }
  if (!appWindow.__squeakDockHook) {
    appWindow.__squeakDockHook = true;
    appWindow.on("closed", () => {
      if (process.platform === "darwin" && app.dock) {
        app.dock.hide();
        if (glass) applyFloatingBehavior(glass, 0);
        if (win) {
          applyFloatingBehavior(win);
          if (!hidden) win.showInactive();
        }
      }
    });
  }
}

/** "1h 23m" / "45m" / "under a minute" until an ISO time. Display only. */
function awakeLeft(untilIso) {
  const minutes = Math.ceil((Date.parse(untilIso) - Date.now()) / 60_000);
  if (!(minutes > 1)) return "under a minute";
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Changes the awake session; the menu shows the daemon's answer at once, and /state settles it after. */
async function changeAwake(request) {
  const result = await service.awake(request);
  if (result.ok && lastState) {
    lastState = { ...lastState, keepAwake: result.awake !== null, awake: result.awake };
    refreshTray();
  }
}

const AWAKE_CHOICES = [
  { label: "For 1 hour", minutes: 60 },
  { label: "For 2 hours", minutes: 120 },
  { label: "For 4 hours", minutes: 240 },
  { label: "For 8 hours", minutes: 480 },
  { label: "Until I turn it off", minutes: null },
];

/** The awake session's menu items: a way to start one, or how long the running one has left. */
function awakeMenuItems(state) {
  if (!state || !("keepAwake" in state)) {
    return [];
  }
  const session = state.awake;
  if (!session && !state.keepAwake) {
    return [
      {
        label: "Keep Mac awake",
        submenu: AWAKE_CHOICES.map((choice) => ({
          label: choice.label,
          click: () => void changeAwake({ action: "start", minutes: choice.minutes }),
        })),
      },
      // Only once the sudoers rule is installed (the window's Stay awake pane sets it up); always timed.
      ...(state.awakeLidReady
        ? [
            {
              label: "Keep awake, lid closed too",
              submenu: AWAKE_CHOICES.filter((choice) => choice.minutes !== null).map((choice) => ({
                label: choice.label,
                click: () => void changeAwake({ action: "start", minutes: choice.minutes, lid: true }),
              })),
            },
          ]
        : []),
    ];
  }
  const until = session?.until ?? null;
  return [
    {
      label: `${until ? `Awake · ${awakeLeft(until)} left` : "Awake until you end it"}${
        session?.lid ? (session.lidStatus === "failed" ? " · lid-closed failed" : " · lid closed too") : ""
      }`,
      enabled: false,
    },
    ...(until ? [{ label: "Add 1 hour", click: () => void changeAwake({ action: "extend", minutes: 60 }) }] : []),
    { label: "End awake session", click: () => void changeAwake({ action: "end" }) },
  ];
}

async function restartServiceFromMenu() {
  await service.restartService();
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
      { label: "Open Squeak…", click: openSqueak },
      { type: "separator" },
      ...usageMenuItems(state),
      { type: "separator" },
      // Holds the Mac awake on battery too, so the phone can reach it; the lid still sleeps it.
      ...awakeMenuItems(state),
      ...(state && "keepAwake" in state ? [{ type: "separator" }] : []),
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
      { label: "Restart Squeak service", click: () => void restartServiceFromMenu() },
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
    syncGlass();
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

ipcMain.on("duck:panel-rect", (_event, rect) => {
  const valid =
    rect &&
    [rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n)) &&
    rect.width > 0 &&
    rect.height > 0;
  if (valid) {
    panelRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    syncGlass();
  }
});

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
  syncGlass();
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
    { label: "Open Squeak…", click: openSqueak },
    { type: "separator" },
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

registerAppIpc({ showDuck: () => setHidden(false) });

app.on("second-instance", () => openSqueak());
// Clicking Squeak in Finder or the Dock while it is already running.
app.on("activate", () => openSqueak());

app.whenReady().then(() => {
  // A pet does not belong in the dock or the app switcher.
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  createWindow();
  if (!STARTED_IN_BACKGROUND && !process.env.DUCK_CAPTURE) {
    openSqueak();
  }

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
