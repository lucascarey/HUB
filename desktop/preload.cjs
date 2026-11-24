// Bridge between the companion page (hub /compa) and the desktop: window movement, voice, tray actions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvisDesktop", {
  speak: (text) => ipcRenderer.invoke("speak", text),
  moveTo: (x, y, ms) => ipcRenderer.send("move-to", x, y, ms),
  place: (x, y) => ipcRenderer.send("place", x, y),
  workArea: () => ipcRenderer.invoke("work-area"),
  setClickable: (on) => ipcRenderer.send("clickable", !!on),
  openHub: (path) => ipcRenderer.send("open-hub", path || "/"),
  hide: () => ipcRenderer.send("hide"),
  screenshot: () => ipcRenderer.invoke("screenshot"),
  gaze: () => ipcRenderer.invoke("gaze"),
  write: (text, paste) => ipcRenderer.invoke("write", String(text), paste !== false),
  openUrl: (url) => ipcRenderer.send("open-url", String(url)),
  onCosmo: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on("cosmo", h);
    ipcRenderer.send("cosmo-start");
    return () => {
      ipcRenderer.removeListener("cosmo", h);
      ipcRenderer.send("cosmo-stop");
    };
  },
});
