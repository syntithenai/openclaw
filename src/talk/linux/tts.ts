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
  options?: Record<string, unknown>;
  onInterrupted?: (t?: number) => void;
}): Promise<{ generationMs: number; playbackMs: number; totalMs: number; audioPath: string }> {
  const tmpWav = path.join("/tmp", `talk-${Date.now()}.wav`);
  const ttsStart = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 45000);
  try {
    const payload: Record<string, unknown> = {
      text: params.text,
      voice: params.voice,
      provider: params.provider,
      ...params.options,
    };
    const res = await fetch(params.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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
  // Don't delete the file anymore - it will be linked in the session message
  // and cleaned up later by a scheduled task

  return {
    generationMs: generationEnd - ttsStart,
    playbackMs: playbackEnd - playbackStart,
    totalMs: playbackEnd - ttsStart,
    audioPath: tmpWav,
  };
}