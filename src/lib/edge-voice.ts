import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

/** Voice used everywhere Jarvis speaks. Male, rioplatense. */
export const EDGE_VOICE = process.env.JARVIS_VOICE || "es-AR-TomasNeural";
/** Cosmo's delivery: lower, a little slower and flatter than Tomás's natural voice. */
export const EDGE_PROSODY = { rate: "-4%", pitch: "-9Hz" };

/** Text → MP3 with Microsoft Edge's free neural voices (the Read Aloud service). */
export async function edgeSpeak(text: string, voice = EDGE_VOICE): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, EDGE_PROSODY);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("edge tts timeout")), 15000);
      audioStream.on("data", (c: Buffer) => chunks.push(c));
      audioStream.on("end", () => { clearTimeout(timer); resolve(); });
      audioStream.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    });
    return Buffer.concat(chunks);
  } finally {
    tts.close();
  }
}
