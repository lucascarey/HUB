// Bridge between the companion page (hub /compa) and the desktop: window movement, voice, tray actions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvisDesktop", {
  speak: (text) => ipcRenderer.invoke("speak", text),
  moveTo: (x, y, ms) => ipcRenderer.send("move-to", x, y, ms),
  workArea: () => ipcRenderer.invoke("work-area"),
  setClickable: (on) => ipcRenderer.send("clickable", !!on),
  openHub: (path) => ipcRenderer.send("open-hub", path || "/"),
  hide: () => ipcRenderer.send("hide"),
  screenshot: () => ipcRenderer.invoke("screenshot"),
});
