import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function speakTts(params: {
  text: string;
  voice?: string;
  provider: "piper" | "coqui";
  endpoint: string;
  timeoutMs?: number;
  signal: AbortSignal;
  onInterrupted?: (t?: number) => void;
}): Promise<{ generationMs: number; playbackMs: number; totalMs: number }> {
  const tmpWav = path.join("/tmp", `talk-${Date.now()}.wav`);
  const ttsStart = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 45000);
  try {
    const res = await fetch(params.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: params.text, voice: params.voice, provider: params.provider }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`tts service failed (${res.status})`);
    const audio = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(tmpWav, audio);
  } finally {
    clearTimeout(timer);
  }

  const generationEnd = Date.now();

  const playbackStart = Date.now();
  const player = spawn("paplay", [tmpWav], { stdio: ["ignore", "inherit", "inherit"] });
  params.signal.addEventListener("abort", () => player.kill("SIGTERM"));
  await new Promise<void>((resolve) => player.on("close", () => resolve()));
  const playbackEnd = Date.now();
  fs.unlinkSync(tmpWav);

  return {
    generationMs: generationEnd - ttsStart,
    playbackMs: playbackEnd - playbackStart,
    totalMs: playbackEnd - ttsStart,
  };
}