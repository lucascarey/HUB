// Jarvis de escritorio: a transparent, always-on-top window where Jarvis's face lives,
// starting with Windows. The face and its behaviour come from the HUB's /compa page.
const { execFile } = require("child_process");
const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, screen, shell, Tray, Menu, nativeImage, session } = require("electron");
const path = require("path");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const HUB = process.env.JARVIS_HUB_URL || "https://hub-sigma-beige.vercel.app";
const VOICE = process.env.JARVIS_VOICE || "es-AR-TomasNeural";
const WIN_W = 300;
const WIN_H = 340;

let win = null;
let tray = null;
let anim = null;

// Audio (microphone and voice) works from the start, without waiting for a click.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

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
  // Jarvis doesn't appear in screen captures (his own and other apps').
  win.setContentProtection(true);
  // Clicks go through to the desktop except over the head (the page switches this on hover).
  win.setIgnoreMouseEvents(true, { forward: true });
  win.once("ready-to-show", () => win.showInactive());

  win.webContents.on("did-fail-load", (_e, code, _desc, url) => {
    if (code === -3 || !url.startsWith(HUB)) return;
    win.loadFile(path.join(__dirname, "offline.html"));
    setTimeout(() => win && win.loadURL(`${HUB}/compa`), 15000);
  });
  // After signing in with the pasted email link Supabase may land on another HUB page: come back to the face.
  win.webContents.on("did-navigate", (_e, url) => {
    if (url.startsWith(HUB) && !new URL(url).pathname.startsWith("/compa"))
      setTimeout(() => win && win.loadURL(`${HUB}/compa`), 2500);
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
    const { audioStream } = tts.toStream(String(text).slice(0, 1500), { rate: "-4%", pitch: "-9Hz" });
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

/** What Lucas has on screen right now: the main display as JPEG (base64), at most 1600 px wide. */
async function screenshot() {
  try {
    const d = screen.getPrimaryDisplay();
    const scale = Math.min(1, 1600 / d.size.width);
    const thumbnailSize = { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return src.thumbnail.toJPEG(70).toString("base64");
  } catch (e) {
    console.error("screenshot", e);
    return null;
  }
}

/** Leaves the text on the clipboard and, with paste, types it where the cursor is (Ctrl+V into the active app). */
async function write(text, paste) {
  clipboard.writeText(text);
  if (!paste || process.platform !== "win32") return true;
  // If Lucas clicked the head to talk, Jarvis has the focus: give it back to the app he was using.
  if (win && win.isFocused()) win.blur();
  await new Promise((r) => setTimeout(r, 250));
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"],
      { windowsHide: true, timeout: 8000 },
      (err) => resolve(!err),
    );
  });
}

/*
 * "Cosmo, hacé tal cosa": Windows' own speech recognizer (offline, free, built in) listens for the name
 * followed by anything, and hands the whole phrase (as WAV) to the page, which transcribes it properly.
 */
const COSMO_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$recs = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$info = $recs | Where-Object { $_.Culture.Name -like 'es*' } | Select-Object -First 1
if (-not $info) { $info = $recs | Where-Object { $_.Culture.Name -like 'en*' } | Select-Object -First 1 }
if (-not $info) { $info = $recs | Select-Object -First 1 }
if (-not $info) { [Console]::Out.WriteLine('ERR norecognizer'); exit 2 }
$eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
$names = New-Object System.Speech.Recognition.Choices
$names.Add([string[]]@('Cosmo', 'Kosmo', 'Cosmos'))
$withCmd = New-Object System.Speech.Recognition.GrammarBuilder
$withCmd.Culture = $info.Culture
$withCmd.Append($names)
$withCmd.AppendWildcard()
$g1 = New-Object System.Speech.Recognition.Grammar($withCmd)
$g1.Name = 'cmd'
$alone = New-Object System.Speech.Recognition.GrammarBuilder
$alone.Culture = $info.Culture
$alone.Append($names)
$g2 = New-Object System.Speech.Recognition.Grammar($alone)
$g2.Name = 'name'
$eng.LoadGrammar($g1)
$eng.LoadGrammar($g2)
$eng.SetInputToDefaultAudioDevice()
$eng.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(900)
$eng.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1200)
[Console]::Out.WriteLine('READY ' + $info.Culture.Name)
while ($true) {
  $r = $eng.Recognize([TimeSpan]::FromSeconds(30))
  if (-not $r) { [Console]::Out.WriteLine('LEVEL ' + $eng.AudioLevel + ' ' + $eng.AudioState); continue }
  $first = $r.Words | Select-Object -First 1
  $conf = if ($first) { $first.Confidence } else { $r.Confidence }
  if ($conf -lt $env:COSMO_MIN) { [Console]::Out.WriteLine('LOW ' + [Math]::Round($conf, 2) + ' ' + $r.Text); continue }
  $wav = ''
  if ($r.Grammar.Name -eq 'cmd' -and $r.Audio) {
    $ms = New-Object IO.MemoryStream
    $r.Audio.WriteToWaveStream($ms)
    $wav = [Convert]::ToBase64String($ms.ToArray())
  }
  [Console]::Out.WriteLine('HEARD ' + $r.Grammar.Name + ' ' + [Math]::Round($conf, 2) + ' ' + $wav)
}
`;
let cosmo = null;

function startCosmo(send) {
  if (cosmo || process.platform !== "win32") {
    if (process.platform !== "win32") send({ type: "error", reason: "platform" });
    return;
  }
  const fs = require("fs");
  const file = path.join(app.getPath("userData"), "cosmo.ps1");
  fs.writeFileSync(file, COSMO_PS1);
  const child = execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, COSMO_MIN: process.env.COSMO_MIN || "0.4" } },
  );
  cosmo = child;
  let buf = "";
  let ready = false;
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("READY")) {
        ready = true;
        send({ type: "ready", culture: line.slice(6) });
      } else if (line.startsWith("HEARD")) {
        const [, grammar, conf, wav] = line.split(" ");
        send({ type: "heard", only: grammar !== "cmd" || !wav, confidence: Number(conf), wav: wav || null });
      } else if (line.startsWith("ERR")) send({ type: "error", reason: line.slice(4) });
      else if (line.startsWith("LOW") || line.startsWith("LEVEL")) send({ type: "debug", line: line.slice(0, 200) });
    }
  });
  child.stderr.on("data", (d) => console.error("cosmo", String(d).slice(0, 300)));
  child.on("exit", (code) => {
    if (cosmo !== child) return;
    cosmo = null;
    // It never got going: let the page fall back to "Hey Jarvis". If it died later, start it again.
    if (!ready) send({ type: "error", reason: `exit ${code}` });
    else setTimeout(() => win && startCosmo(send), 3000);
  });
}

function stopCosmo() {
  const c = cosmo;
  cosmo = null;
  c?.kill();
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
  ipcMain.handle("screenshot", () => screenshot());
  // Where the mouse is, relative to the centre of Cosmo's window: his eyes follow it.
  ipcMain.handle("gaze", () => {
    if (!win) return null;
    const p = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    return { dx: p.x - (x + WIN_W / 2), dy: p.y - (y + WIN_H / 2) };
  });
  ipcMain.on("cosmo-start", (e) => startCosmo((m) => !e.sender.isDestroyed() && e.sender.send("cosmo", m)));
  ipcMain.on("cosmo-stop", () => stopCosmo());
  ipcMain.handle("write", (_e, text, paste) => write(String(text).slice(0, 8000), !!paste));
  ipcMain.on("open-url", (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) void shell.openExternal(String(url));
  });

  createWindow();
  createTray();
  screen.on("display-metrics-changed", () => win && win.webContents.reload());
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => stopCosmo());
