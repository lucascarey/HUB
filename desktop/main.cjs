// Jarvis de escritorio: a transparent, always-on-top window where Jarvis's face lives,
// starting with Windows. The face and its behaviour come from the HUB's /compa page.
const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, session } = require("electron");
const path = require("path");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const HUB = process.env.JARVIS_HUB_URL || "https://hub-sigma-beige.vercel.app";
const VOICE = process.env.JARVIS_VOICE || "es-AR-TomasNeural";
const WIN_W = 300;
const WIN_H = 260;

let win = null;
let tray = null;
let anim = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => win && win.showInactive());

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function createWindow() {
  const a = workArea();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: a.x + a.width - WIN_W - 24,
    y: a.y + a.height - WIN_H,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    backgroundColor: "#00000000",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true);
  // Clicks go through to the desktop except over the head (the page switches this on hover).
  win.setIgnoreMouseEvents(true, { forward: true });
  win.once("ready-to-show", () => win.showInactive());

  win.webContents.on("did-fail-load", (_e, code, _desc, url) => {
    if (code === -3 || !url.startsWith(HUB)) return;
    win.loadFile(path.join(__dirname, "offline.html"));
    setTimeout(() => win && win.loadURL(`${HUB}/compa`), 15000);
  });
  // Links (and the HUB itself) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL(`${HUB}/compa`);
}

function moveTo(x, y, ms = 900) {
  if (!win) return;
  clearInterval(anim);
  const [sx, sy] = win.getPosition();
  const t0 = Date.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  anim = setInterval(() => {
    if (!win) return clearInterval(anim);
    const t = Math.min(1, (Date.now() - t0) / Math.max(1, ms));
    const k = ease(t);
    win.setPosition(Math.round(sx + (x - sx) * k), Math.round(sy + (y - sy) * k));
    if (t >= 1) clearInterval(anim);
  }, 16);
}

async function speak(text) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(String(text).slice(0, 1500), { rate: "+6%" });
    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15000);
      audioStream.on("data", (c) => chunks.push(c));
      audioStream.on("end", () => { clearTimeout(timer); resolve(); });
      audioStream.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const buf = Buffer.concat(chunks);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (e) {
    console.error("speak", e);
    return null;
  } finally {
    tts.close();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Jarvis");
  const menu = () =>
    Menu.buildFromTemplate([
      { label: "Mostrar a Jarvis", click: () => { win.showInactive(); win.webContents.reload(); } },
      { label: "Abrir el HUB", click: () => shell.openExternal(HUB) },
      { type: "separator" },
      {
        label: "Arrancar con Windows",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { label: "Ocultar", click: () => win.hide() },
      { label: "Salir", click: () => app.quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on("click", () => (win.isVisible() ? win.hide() : win.showInactive()));
  tray.on("right-click", () => tray.setContextMenu(menu()));
}

app.whenReady().then(() => {
  // First run: start with Windows (it can be turned off from the tray icon).
  const flag = path.join(app.getPath("userData"), ".autostart-set");
  const fs = require("fs");
  if (!fs.existsSync(flag)) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(flag, "1");
  }

  // The microphone is only granted to the HUB.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === "media" && wc.getURL().startsWith(HUB));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && String(origin).startsWith(HUB));

  ipcMain.handle("speak", (_e, text) => speak(text));
  ipcMain.handle("work-area", () => ({ ...workArea(), winW: WIN_W, winH: WIN_H }));
  ipcMain.on("move-to", (_e, x, y, ms) => moveTo(x, y, ms));
  ipcMain.on("clickable", (_e, on) => win && win.setIgnoreMouseEvents(!on, { forward: true }));
  ipcMain.on("open-hub", (_e, p) => shell.openExternal(HUB + (typeof p === "string" ? p : "/")));
  ipcMain.on("hide", () => win && win.hide());

  createWindow();
  createTray();
  screen.on("display-metrics-changed", () => win && win.webContents.reload());
});

app.on("window-all-closed", (e) => e.preventDefault());
