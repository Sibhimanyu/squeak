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

let win = null;
let tray = null;
let expanded = false;
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Float above everything, including other apps' fullscreen spaces.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

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
    if (!hidden) {
      win.showInactive();
    }
  });
}

/**
 * Grow up and to the left so the duck itself does not move when the panel
 * opens. The duck sits at the bottom-right of the window in both sizes, so
 * shifting the origin by the size difference pins it in place.
 */
function setExpanded(next) {
  if (!win || next === expanded) {
    return;
  }
  const size = next ? EXPANDED : COLLAPSED;
  const bounds = win.getBounds();
  const x = bounds.x + bounds.width - size.width;
  const y = bounds.y + bounds.height - size.height;
  const placed = clampToDisplay(x, y, size.width, size.height);

  win.setBounds({ ...placed, width: size.width, height: size.height });
  expanded = next;
  win.webContents.send("duck:expanded", expanded);

  // Behave like a popover: an open panel takes focus, which is what makes
  // clicking anywhere else dismiss it. Collapsed, the duck must never steal
  // focus from whatever you are typing in.
  if (next) {
    win.focus();
  }

  if (!next) {
    writeSettings({ position: { x: placed.x + size.width - COLLAPSED.width, y: placed.y + size.height - COLLAPSED.height } });
  }
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

function refreshTray() {
  if (!tray) {
    return;
  }
  const state = lastState;
  const active = state?.active ?? [];

  const sessionItems = active.slice(0, 8).map((session) => ({
    label: `${session.repoName ?? "?"} · ${session.branch ?? "?"} — ${session.state}`,
    click: () => {
      if (session.cwd) {
        void shell.openPath(session.cwd);
      }
    },
  }));

  tray.setTitle(trayTitle(state));
  tray.setToolTip(trayTooltip(state));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: state ? trayTooltip(state).replace("Squeak — ", "") : "starting up", enabled: false },
      { type: "separator" },
      ...(sessionItems.length > 0 ? sessionItems : [{ label: "No active sessions", enabled: false }]),
      { type: "separator" },
      { label: "Show duck", type: "checkbox", checked: !hidden, click: () => setHidden(hidden) },
      { label: `Peek at panel (${DEFAULT_SHORTCUT.replace("Control", "⌃").replace("Alt", "⌥").replace(/\+/g, "")})`, click: peek },
      { label: "Reset duck position", click: resetPosition },
      { type: "separator" },
      { label: "Quit Squeak duck", click: () => app.quit() },
    ]),
  );
}

function resetPosition() {
  const position = defaultPosition();
  writeSettings({ position });
  if (win) {
    win.setBounds({ ...position, ...COLLAPSED });
    expanded = false;
    win.webContents.send("duck:expanded", false);
  }
}

ipcMain.on("duck:toggle", () => setExpanded(!expanded));

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
    { label: "Quit Squeak duck", click: () => app.quit() },
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

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "duckTemplate.png")));
  tray.setIgnoreDoubleClickEvents(true);
  tray.on("click", peek);
  refreshTray();

  const shortcut = readSettings().shortcut ?? DEFAULT_SHORTCUT;
  if (!globalShortcut.register(shortcut, peek)) {
    // Another app already owns it. Say so rather than failing silently.
    console.warn(`duck: could not register ${shortcut} — something else has it`);
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
