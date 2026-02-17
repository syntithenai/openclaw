import fs from "node:fs";

export async function runWhisper(params: {
  wavPath: string;
  endpoint: string;
  language?: string;
  timeoutMs?: number;
}) {
  const audio = await fs.promises.readFile(params.wavPath);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  if (params.language) form.append("language", params.language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 45000);
  try {
    const res = await fetch(params.endpoint, { method: "POST", body: form, signal: controller.signal });
    if (!res.ok) throw new Error(`whisper service failed (${res.status})`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await res.json();
      return (body.text ?? "").toString().trim();
    }
    return (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}