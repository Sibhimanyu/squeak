// Electron main process for the duck.
//
// Deliberately plain JavaScript with no build step: this is a small personal
// UI, and a bundler between "edit the duck" and "see the duck" would cost more
// than it returns. The logic worth testing — what mood the duck is in — lives
// in the daemon under src/fleet/duck-mood.ts, where CI covers it. Everything
// here is window management and drawing.

const { app, BrowserWindow, Menu, ipcMain, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const COLLAPSED = { width: 132, height: 132 };
const EXPANDED = { width: 380, height: 500 };
const MARGIN = 24;

let win = null;
let expanded = false;

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
  const port = process.env.FLEET_HOOK_PORT || "8477";
  win.loadFile(path.join(__dirname, "renderer", "index.html"), { query: { port } });
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
  if (!next) {
    writeSettings({ position: { x: placed.x + size.width - COLLAPSED.width, y: placed.y + size.height - COLLAPSED.height } });
  }
}

ipcMain.on("duck:toggle", () => setExpanded(!expanded));
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
  Menu.buildFromTemplate([
    { label: "Reset position", click: () => {
      const position = defaultPosition();
      writeSettings({ position });
      if (win) {
        win.setBounds({ ...position, ...COLLAPSED });
        expanded = false;
        win.webContents.send("duck:expanded", false);
      }
    } },
    { type: "separator" },
    { label: "Quit duck", click: () => app.quit() },
  ]).popup({ window: win ?? undefined });
});

/**
 * Write PNGs of the duck by asking the window to photograph itself. Used to
 * review the UI without granting anything Screen Recording permission.
 */
async function captureTo(prefix) {
  if (!win) {
    return;
  }
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

  const capturePrefix = process.env.DUCK_CAPTURE;
  if (capturePrefix && win) {
    win.webContents.once("did-finish-load", () => void captureTo(capturePrefix));
  }
});

// The duck is the whole app; closing its window means quitting, on every
// platform including macOS.
app.on("window-all-closed", () => app.quit());
