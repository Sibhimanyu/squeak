const { contextBridge, ipcRenderer } = require("electron");

// The renderer gets exactly these verbs and no Node access.
contextBridge.exposeInMainWorld("duck", {
  toggle: () => ipcRenderer.send("duck:toggle"),
  collapse: () => ipcRenderer.send("duck:collapse"),
  drag: (dx, dy) => ipcRenderer.send("duck:drag", { dx, dy }),
  dragEnd: () => ipcRenderer.send("duck:drag-end"),
  menu: () => ipcRenderer.send("duck:menu"),
  openPath: (target) => ipcRenderer.send("duck:open-path", target),
  reportState: (state) => ipcRenderer.send("duck:state", state),
  onExpanded: (handler) => ipcRenderer.on("duck:expanded", (_event, value) => handler(value)),
  onWillExpand: (handler) => ipcRenderer.on("duck:will-expand", (_event, value) => handler(value)),
  expandReady: () => ipcRenderer.send("duck:expand-ready"),
});
