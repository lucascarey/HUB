/**
 * Live voice chat with Cosmo (Gemini Live): the microphone streams to Gemini and his voice streams back,
 * so it feels like talking to someone. You can interrupt him, he can use all his tools, and the chat
 * ends when you say goodbye or after a while of silence.
 */
import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";
import { ensureRunning } from "./audio-unlock";

const IN_RATE = 16000;
const OUT_RATE = 24000;
const IDLE_MS = 25_000;
const MAX_MS = 10 * 60_000;

const WORKLET = `
class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1600); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = v * 32767;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("live-mic", Mic);
`;

export type LiveState = "connecting" | "listening" | "thinking" | "speaking";
export interface LiveHooks {
  bearer: string;
  desktop: boolean;
  onState(s: LiveState): void;
  /** Running transcript: what Lucas said and what Cosmo said (each turn as it grows). */
  onTurn(role: "user" | "assistant", text: string, done: boolean): void;
  /** Runs a tool and returns what it answered (the app decides where: HUB server or this computer). */
  runTool(name: string, args: Record<string, unknown>): Promise<string>;
  onEnd(reason: "bye" | "idle" | "error" | "stopped"): void;
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Any WAV (base64) → 16 kHz mono PCM16 chunks of 100 ms, to replay the phrase that woke Cosmo up. */
async function wavToPcmChunks(wav: string): Promise<Uint8Array[]> {
  const bytes = Uint8Array.from(atob(wav), (c) => c.charCodeAt(0));
  const tmp = new AudioContext();
  const decoded = await tmp.decodeAudioData(bytes.buffer.slice(0));
  void tmp.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * IN_RATE), IN_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const data = (await off.startRendering()).getChannelData(0);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 1600) {
    const part = data.subarray(i, i + 1600);
    const pcm = new Int16Array(part.length);
    for (let j = 0; j < part.length; j++) pcm[j] = Math.max(-1, Math.min(1, part[j])) * 32767;
    chunks.push(new Uint8Array(pcm.buffer));
  }
  return chunks;
}

export class LiveChat {
  private session: Session | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private media: MediaStream | null = null;
  private playing: AudioBufferSourceNode[] = [];
  private playAt = 0;
  private lastActivity = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = Date.now();
  private ended = false;
  private userText = "";
  private botText = "";
  private toolsBusy = 0;

  constructor(private hooks: LiveHooks) {}

  /** Opens the chat; resolves false when Gemini Live can't be reached (the app then uses the normal flow). */
  async start(firstPhraseWav?: string | null): Promise<boolean> {
    this.hooks.onState("connecting");
    let model: number | null = 0;
    while (model !== null) {
      const res: Response | null = await fetch("/api/live", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.hooks.bearer}` },
        body: JSON.stringify({ model, desktop: this.hooks.desktop }),
      }).catch(() => null);
      const json: { token?: string; model?: string; next?: number | null } = res ? await res.json().catch(() => ({})) : {};
      if (json.token && json.model && (await this.connect(json.token, json.model))) break;
      model = typeof json.next === "number" ? json.next : null;
      if (model === null) return false;
    }
    await this.startMic();
    if (firstPhraseWav) {
      // What woke him up ("Cosmo, ¿qué tengo hoy?") goes first, so he answers it right away.
      for (const c of await wavToPcmChunks(firstPhraseWav).catch(() => [])) this.sendAudio(c);
    }
    this.hooks.onState("listening");
    this.timer = setInterval(() => {
      const quiet = Date.now() - this.lastActivity;
      if (quiet > IDLE_MS && !this.isPlaying() && !this.toolsBusy) this.stop("idle");
      else if (Date.now() - this.started > MAX_MS) this.stop("idle");
    }, 1000);
    return true;
  }

  /** Resolves true once Gemini confirms the session is set up; false if it closes, fails or takes too long. */
  private connect(token: string, model: string) {
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1beta" } });
    return new Promise<boolean>((resolve) => {
      let ready = false;
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(ok);
      };
      const timeout = setTimeout(() => {
        try {
          this.session?.close();
        } catch {}
        this.session = null;
        settle(false);
      }, 10_000);
      ai.live
        .connect({
          model,
          config: {},
          callbacks: {
            onmessage: (m) => {
              if (m.setupComplete && !ready) {
                ready = true;
                settle(true);
              }
              void this.onMessage(m);
            },
            onerror: (e) => {
              console.error("live", model, e);
              if (!ready) settle(false);
            },
            onclose: (e) => {
              if (!ready) {
                console.warn("live rejected", model, e?.code, e?.reason);
                this.session = null;
                return settle(false);
              }
              if (!this.ended) {
                console.warn("live closed", e?.code, e?.reason);
                this.stop("error");
              }
            },
          },
        })
        .then((s) => {
          if (settled && !ready) s.close();
          else this.session = s;
        }, (e) => {
          console.error("live connect", model, e);
          settle(false);
        });
    });
  }

  private sendAudio(pcm: Uint8Array) {
    this.session?.sendRealtimeInput({ audio: { data: b64(pcm), mimeType: `audio/pcm;rate=${IN_RATE}` } });
  }

  private async startMic() {
    this.media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.inCtx = new AudioContext({ sampleRate: IN_RATE });
    void ensureRunning(this.inCtx);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await this.inCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.inCtx, "live-mic");
    node.port.onmessage = (e: MessageEvent<Int16Array>) => this.sendAudio(new Uint8Array(e.data.buffer));
    this.inCtx.createMediaStreamSource(this.media).connect(node);
    this.outCtx = new AudioContext({ sampleRate: OUT_RATE });
    void ensureRunning(this.outCtx);
  }

  private isPlaying() {
    return !!this.outCtx && this.playAt > this.outCtx.currentTime + 0.05;
  }

  private play(base64: string) {
    const ctx = this.outCtx;
    if (!ctx) return;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const buf = ctx.createBuffer(1, pcm.length, OUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.playAt = Math.max(this.playAt, ctx.currentTime + 0.03);
    src.start(this.playAt);
    this.playAt += buf.duration;
    this.playing.push(src);
    src.onended = () => {
      this.playing = this.playing.filter((p) => p !== src);
      if (!this.isPlaying() && !this.ended) this.hooks.onState(this.toolsBusy ? "thinking" : "listening");
    };
    this.hooks.onState("speaking");
  }

  private hush() {
    for (const p of this.playing) p.stop();
    this.playing = [];
    this.playAt = 0;
  }

  private async onMessage(m: LiveServerMessage) {
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) {
        this.hush();
        this.hooks.onState("listening");
      }
      if (sc.inputTranscription?.text) {
        this.lastActivity = Date.now();
        this.userText += sc.inputTranscription.text;
        this.hooks.onTurn("user", this.userText.trim(), false);
      }
      if (sc.outputTranscription?.text) {
        this.lastActivity = Date.now();
        if (this.userText) {
          this.hooks.onTurn("user", this.userText.trim(), true);
          this.userText = "";
        }
        this.botText += sc.outputTranscription.text;
        this.hooks.onTurn("assistant", this.botText.trim(), false);
      }
      for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) this.play(p.inlineData.data);
      if (sc.turnComplete) {
        this.lastActivity = Date.now();
        if (this.userText) this.hooks.onTurn("user", this.userText.trim(), true);
        if (this.botText) this.hooks.onTurn("assistant", this.botText.trim(), true);
        this.userText = "";
        this.botText = "";
      }
    }
    const calls = m.toolCall?.functionCalls ?? [];
    if (!calls.length) return;
    this.toolsBusy++;
    this.lastActivity = Date.now();
    if (!this.isPlaying()) this.hooks.onState("thinking");
    let bye = false;
    const functionResponses = await Promise.all(calls.map(async (c) => {
      let output = "ok";
      if (c.name === "terminar_charla") bye = true;
      else if (c.name === "mirar_pantalla") {
        const shot = await this.hooks.runTool("mirar_pantalla", {});
        if (shot.startsWith("data:")) {
          this.session?.sendRealtimeInput({ video: { data: shot.slice(shot.indexOf(",") + 1), mimeType: "image/jpeg" } });
          output = "Captura enviada: es la imagen que acabás de recibir.";
        } else output = shot;
      } else output = await this.hooks.runTool(c.name ?? "", (c.args ?? {}) as Record<string, unknown>).catch((e) => `Error: ${e}`);
      return { id: c.id, name: c.name, response: { output } };
    }));
    this.toolsBusy--;
    this.lastActivity = Date.now();
    this.session?.sendToolResponse({ functionResponses });
    if (bye) {
      // Let him finish the goodbye, then hang up.
      const wait = () => (this.isPlaying() ? setTimeout(wait, 300) : this.stop("bye"));
      setTimeout(wait, 1500);
    }
  }

  stop(reason: "bye" | "idle" | "error" | "stopped" = "stopped") {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    this.hush();
    try {
      this.session?.close();
    } catch {}
    this.session = null;
    this.media?.getTracks().forEach((t) => t.stop());
    void this.inCtx?.close().catch(() => {});
    void this.outCtx?.close().catch(() => {});
    this.hooks.onEnd(reason);
  }
}
