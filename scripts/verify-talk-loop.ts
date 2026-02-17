import { loadConfig } from "../src/config/config.js";
import { resolveMainSessionKey } from "../src/config/sessions.js";
import { GatewayChatClient } from "../src/tui/gateway-chat.js";
import { runWhisper } from "../src/talk/linux/whisper.js";
import { speakTts } from "../src/talk/linux/tts.js";
import { TalkDirectiveParser } from "../src/talk/linux/directive.js";

const AUDIO_PATH = process.env.TALK_WAV_PATH ?? "/tmp/test.wav";
const POLL_MS = 500;
const TIMEOUT_MS = 45000;

function extractAssistantText(history: any): string | null {
  const messages = history?.messages ?? [];
  const assistant = [...messages].reverse().find((m: any) => m.role === "assistant");
  if (!assistant) return null;
  const parts = (assistant.content ?? []).map((c: any) => c.text).filter(Boolean);
  const text = parts.join("\n").trim();
  return text || null;
}

async function main() {
  const cfg = loadConfig();
  const talkCfg = cfg.talk ?? {};
  const sessionKey = resolveMainSessionKey(cfg);

  console.log(`Using audio: ${AUDIO_PATH}`);
  const transcript = await runWhisper({
    wavPath: AUDIO_PATH,
    endpoint: talkCfg.sttEndpoint ?? "http://localhost:8086/transcribe",
    language: talkCfg.sttLanguage ?? "en",
    timeoutMs: talkCfg.sttTimeoutMs ?? 45000,
  });

  console.log(`Transcript: ${transcript || "(empty)"}`);
  if (!transcript) {
    console.error("No transcript detected. Say something louder and retry.");
    process.exit(1);
  }

  const client = new GatewayChatClient({});
  client.start();
  await client.waitForReady();

  const prompt = `You are in talk mode.\nUser said: ${transcript}`;
  await client.sendChat({ sessionKey, message: prompt, thinking: "low" });

  const deadline = Date.now() + TIMEOUT_MS;
  let assistantText: string | null = null;
  while (Date.now() < deadline) {
    const history = await client.loadHistory({ sessionKey, limit: 40 });
    assistantText = extractAssistantText(history);
    if (assistantText) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (!assistantText) {
    console.error("Timed out waiting for assistant response.");
    client.stop();
    process.exit(1);
  }

  console.log(`Assistant: ${assistantText}`);
  const parsed = TalkDirectiveParser.parse(assistantText);
  const cleaned = parsed.stripped.trim();
  if (!cleaned) {
    console.error("Assistant response empty after directive stripping.");
    client.stop();
    process.exit(1);
  }

  await speakTts({
    text: cleaned,
    voice: parsed.directive?.voiceId ?? talkCfg.voiceId,
    provider: talkCfg.ttsProvider ?? "piper",
    endpoint: talkCfg.ttsEndpoint ?? "http://localhost:5002",
    timeoutMs: talkCfg.ttsTimeoutMs ?? 45000,
    signal: new AbortController().signal,
  });

  client.stop();
  console.log("Full talk loop completed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
