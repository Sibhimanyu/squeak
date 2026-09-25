// The Squeak window: the whole picture, where the duck is only the glance.
// Main process only. It owns no state of its own — the renderer polls the
// daemon through squeak-service.js — so opening and closing it is free.

const { BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const service = require("./squeak-service");

let appWindow = null;

function openAppWindow() {
  if (appWindow && !appWindow.isDestroyed()) {
    if (appWindow.isMinimized()) {
      appWindow.restore();
    }
    appWindow.show();
    appWindow.focus();
    return appWindow;
  }

  appWindow = new BrowserWindow({
    width: 1040,
    height: 680,
    minWidth: 760,
    minHeight: 480,
    title: "Squeak",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#09090b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "app-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A capture run photographs the window while other apps may cover it;
      // throttled, macOS stops painting it and the shots come out empty.
      backgroundThrottling: !process.env.SQUEAK_CAPTURE,
    },
  });
  if (process.env.SQUEAK_CAPTURE) {
    appWindow.setAlwaysOnTop(true, "floating");
  }

  appWindow.loadFile(path.join(__dirname, "renderer", "app.html"));
  appWindow.once("ready-to-show", () => appWindow?.show());
  if (process.env.SQUEAK_CAPTURE) {
    void captureTo(appWindow, process.env.SQUEAK_CAPTURE);
  }
  appWindow.on("closed", () => {
    appWindow = null;
  });
  // Links in a rendered message open in the browser, never inside Squeak.
  appWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  appWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  return appWindow;
}

/**
 * Photograph the window without Screen Recording permission, the way
 * DUCK_CAPTURE does for the duck: one shot as loaded, one per session row
 * clicked (up to four), then quit.
 */
async function captureTo(target, prefix) {
  const fs = require("node:fs");
  const { app } = require("electron");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => target.webContents.once("did-finish-load", resolve));
  await wait(3500);
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const shot = async (name) => fs.writeFileSync(`${prefix}-${name}.png`, (await target.webContents.capturePage()).toPNG());
  await shot("0-loaded");
  const rows = await target.webContents.executeJavaScript("document.querySelectorAll('.row').length");
  for (let index = 0; index < Math.min(rows, 4); index += 1) {
    await target.webContents.executeJavaScript(`document.querySelectorAll('.row')[${index}].click()`);
    await wait(1800);
    await shot(`${index + 1}-row`);
  }
  // If the first row asks a lettered question, answer B and photograph the receipt.
  await target.webContents.executeJavaScript("document.querySelectorAll('.row')[0]?.click()");
  await wait(1500);
  const options = await target.webContents.executeJavaScript("document.querySelectorAll('.option').length");
  if (options > 1) {
    await shot("5-decision");
    await target.webContents.executeJavaScript("document.querySelectorAll('.option')[1].click()");
    await wait(1500);
    await shot("6-sent");
  }
  app.quit();
}

function registerAppIpc({ showDuck }) {
  ipcMain.handle("squeak:state", () => service.readState());
  ipcMain.handle("squeak:service", () => service.serviceStatus());
  ipcMain.handle("squeak:restart-service", () => service.restartService());
  ipcMain.handle("squeak:message", (_event, sessionId) => service.sessionMessage(sessionId));
  ipcMain.handle("squeak:reply", (_event, sessionId, text) => service.reply(sessionId, text));
  ipcMain.handle("squeak:open-in-conductor", (_event, target) => service.openInConductor(target));
  ipcMain.handle("squeak:remote", (_event, action, deviceId) => service.remote(action, deviceId ?? null));
  ipcMain.handle("squeak:pairing-qr", () => service.pairingQr());
  ipcMain.on("squeak:show-duck", () => showDuck());
}

module.exports = { openAppWindow, registerAppIpc };
