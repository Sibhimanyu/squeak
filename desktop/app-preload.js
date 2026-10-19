const { contextBridge, ipcRenderer } = require("electron");

// The Squeak window gets exactly these verbs: no Node, no token, no URLs.
// Every one is answered by the main process (squeak-service.js).
contextBridge.exposeInMainWorld("squeak", {
  state: () => ipcRenderer.invoke("squeak:state"),
  service: () => ipcRenderer.invoke("squeak:service"),
  restartService: () => ipcRenderer.invoke("squeak:restart-service"),
  message: (sessionId) => ipcRenderer.invoke("squeak:message", sessionId),
  activity: (sessionKey) => ipcRenderer.invoke("squeak:activity", sessionKey),
  reply: (sessionId, text) => ipcRenderer.invoke("squeak:reply", sessionId, text),
  openInConductor: (target) => ipcRenderer.invoke("squeak:open-in-conductor", target),
  openPath: (target) => ipcRenderer.send("duck:open-path", target),
  showDuck: () => ipcRenderer.send("squeak:show-duck"),
  remote: (action, deviceId) => ipcRenderer.invoke("squeak:remote", action, deviceId ?? null),
  pairingQr: () => ipcRenderer.invoke("squeak:pairing-qr"),
  awake: (request) => ipcRenderer.invoke("squeak:awake", request),
});
