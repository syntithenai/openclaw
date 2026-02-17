import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { loadConfig } from "../../config/config.js";
import { isSilentReplyText } from "../../auto-reply/tokens.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { GatewayConnection } from "./gateway-connection.js";
import { TalkDirectiveParser } from "./directive.js";
import { createVad } from "./vad.js";
import { captureAudio } from "./audio.js";
import { runWhisper } from "./whisper.js";
import { speakTts } from "./tts.js";

export type TalkPhase = "idle" | "listening" | "thinking" | "speaking";

export class LinuxTalkRuntime {
  private log = createSubsystemLogger("talk/linux");
  private phase: TalkPhase = "idle";
  private enabled = false;
  private paused = false;
  private lifecycleGen = 0;

  private lastTranscript = "";
  private lastHeardAt: number | null = null;
  private lastInterruptedAtSeconds: number | null = null;
  private lastSpokenText: string | null = null;
  private lastRmsLogAt: number | null = null;
  private captureStartedAt: number | null = null;
  private lastSpeechFinalizedAt: number | null = null;
  private lastSttCompletedAt: number | null = null;
  private lastLlmCompletedAt: number | null = null;

  private captureAbort: AbortController | null = null;
  private playbackAbort: AbortController | null = null;

  private audioChunks: Int16Array[] = [];
  private preRoll: Int16Array[] = [];
  private capturingSpeech = false;

  async setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.lifecycleGen++;
    if (enabled) await this.start();
    else await this.stop();
  }

  async setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.enabled) return;
    if (paused) {
      this.resetTranscript();
      await this.stopCapture();
      return;
    }
    if (this.phase === "idle" || this.phase === "listening") {
      await this.startCapture();
      this.phase = "listening";
    }
  }

  private isCurrent(gen: number) {
    return gen === this.lifecycleGen && this.enabled;
  }

  private async start() {
    const gen = this.lifecycleGen;
    if (this.paused) {
      this.phase = "idle";
      return;
    }
    await this.startCapture();
    if (!this.isCurrent(gen)) return;
    this.phase = "listening";
  }

  private async stop() {
    await this.stopPlayback("manual");
    await this.stopCapture();
    this.resetTranscript();
    this.phase = "idle";
  }

  private resetTranscript() {
    this.lastTranscript = "";
    this.lastHeardAt = null;
  }

  private resetCaptureBuffers() {
    this.audioChunks = [];
    this.preRoll = [];
    this.capturingSpeech = false;
    this.captureStartedAt = null;
  }

  private async startCapture() {
    await this.stopCapture();
    this.captureAbort = new AbortController();
    const abortController = this.captureAbort;
    this.resetCaptureBuffers();
    const vad = createVad();

    const gen = this.lifecycleGen;

    const cfg = loadConfig();
    const talkCfg = cfg.talk ?? {};

    (async () => {
      try {
        for await (const chunk of captureAudio(abortController.signal, {
          device: talkCfg.audioDevice,
          onError: (err) => this.log.warn(`parecord error: ${String(err)}`),
          onExit: (code, sig) =>
            this.log.warn(`parecord exited code=${code ?? "null"} signal=${sig ?? "null"}`),
        })) {
          if (this.paused || this.phase === "idle") continue;
          const now = Date.now();
          const rms = vad.note(chunk);
          const shouldLog = !this.lastRmsLogAt || Date.now() - this.lastRmsLogAt > 5000;
          if (shouldLog) {
            this.lastRmsLogAt = Date.now();
            this.log.debug(
              `vad rms=${rms.rms.toFixed(6)} threshold=${rms.threshold.toFixed(6)}`,
            );
          }
          if (rms.speech) {
            this.lastHeardAt = now;
          }
          if (this.phase === "speaking" && rms.speech) {
            const shouldInterrupt = vad.shouldInterrupt(this.lastSpokenText ?? "");
            if (shouldInterrupt) {
              await this.stopPlayback("speech");
              await this.startListening();
            }
            continue;
          }

          if (this.phase !== "listening") continue;

          if (!this.capturingSpeech) {
            this.preRoll.push(chunk);
            if (this.preRoll.length > 6) {
              this.preRoll.shift();
            }
          }

          if (rms.speech) {
            if (!this.capturingSpeech) {
              this.log.info("speech detected; capturing segment");
              this.capturingSpeech = true;
              this.captureStartedAt = now;
              this.audioChunks = [...this.preRoll, chunk];
            } else {
              this.audioChunks.push(chunk);
            }
          } else if (this.capturingSpeech) {
            this.audioChunks.push(chunk);
          }

          const captureTooLong =
            this.capturingSpeech &&
            this.captureStartedAt != null &&
            now - this.captureStartedAt > 12000;
          if (captureTooLong) {
            this.log.warn("speech segment exceeded 12s; forcing finalize");
          }

          if (this.capturingSpeech && (captureTooLong || vad.shouldFinalize(this.lastHeardAt))) {
            const chunks = this.audioChunks;
            this.resetCaptureBuffers();
            const speechEndedAt = Date.now();
            this.lastSpeechFinalizedAt = speechEndedAt;
            this.log.info(
              `finalizing speech segment (chunks=${chunks.length}) at ${speechEndedAt}`,
            );
            await this.transcribeAndSend(chunks, speechEndedAt);
          }
        }
      } catch (err) {
        this.log.warn(`capture loop error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (abortController.signal.aborted) return;
        if (!this.isCurrent(gen) || this.paused) return;
        this.log.warn("parecord ended; restarting capture");
        await new Promise((r) => setTimeout(r, 500));
        if (this.isCurrent(gen) && !this.paused) {
          await this.startCapture();
        }
      }
    })().catch(() => {});
  }

  private async stopCapture() {
    this.captureAbort?.abort();
    this.captureAbort = null;
  }

  private async startListening() {
    this.phase = "listening";
    this.resetTranscript();
    this.resetCaptureBuffers();
  }

  private async finalizeTranscript(text: string) {
    this.resetTranscript();
    this.phase = "thinking";
    await this.stopCapture();
    await this.sendAndSpeak(text);
  }

  private async transcribeAndSend(chunks: Int16Array[], speechEndedAt?: number) {
    if (!chunks.length) return;
    const cfg = loadConfig();
    const talkCfg = cfg.talk ?? {};
    const wavPath = path.join("/tmp", `talk-${Date.now()}.wav`);
    try {
      const sttStart = Date.now();
      await this.writeWavFile(wavPath, chunks, 16000, 1);
      const transcript = await runWhisper({
        wavPath,
        endpoint: talkCfg.sttEndpoint ?? "http://localhost:8086/transcribe",
        language: talkCfg.sttLanguage ?? "en",
        timeoutMs: talkCfg.sttTimeoutMs ?? 45000,
      });
      const sttEnd = Date.now();
      this.lastSttCompletedAt = sttEnd;
      const sttDuration = sttEnd - sttStart;
      const speechToStt = speechEndedAt ? sttEnd - speechEndedAt : null;
      this.log.info(
        `latency: speech->stt=${speechToStt ?? "n/a"}ms, stt=${sttDuration}ms`,
      );
      const cleaned = transcript.trim();
      this.log.info(`STT transcript: ${cleaned ? JSON.stringify(cleaned) : "<empty>"}`);
      if (!cleaned) {
        await this.resumeListeningIfNeeded();
        return;
      }
      await this.finalizeTranscript(cleaned);
    } catch (err) {
      this.log.warn(`STT failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.resumeListeningIfNeeded();
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
    }
  }

  private async writeWavFile(
    filePath: string,
    chunks: Int16Array[],
    sampleRate: number,
    channels: number,
  ) {
    const buffers = chunks.map((chunk) =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    );
    const data = Buffer.concat(buffers);
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * 2;
    const blockAlign = channels * 2;

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);

    await fs.promises.writeFile(filePath, Buffer.concat([header, data]));
  }

  private async sendAndSpeak(transcript: string) {
    const gen = this.lifecycleGen;
    const prompt = this.buildPrompt(transcript);
    const sessionKey = await GatewayConnection.shared.mainSessionKey();
    const runId = crypto.randomUUID();
    const sendTime = Date.now();

    const response = await GatewayConnection.shared.chatSend({
      sessionKey,
      message: prompt,
      thinking: "low",
      idempotencyKey: runId,
      attachments: [],
    });

    if (!this.isCurrent(gen)) return;

    this.log.info("waiting for assistant response...");
    const assistantReply = await this.waitForAssistantText(sessionKey, sendTime, 45);
    if (!assistantReply) {
      this.log.warn("no assistant text received within timeout");
      await this.resumeListeningIfNeeded();
      return;
    }
    const assistantAt = Date.now();
    this.lastLlmCompletedAt = assistantAt;
    const llmLatency = assistantAt - sendTime;
    const speechToLlm = this.lastSpeechFinalizedAt
      ? assistantAt - this.lastSpeechFinalizedAt
      : null;
    const sttToLlm = this.lastSttCompletedAt ? assistantAt - this.lastSttCompletedAt : null;
    this.log.info(
      `latency: stt->llm=${sttToLlm ?? "n/a"}ms, llm=${llmLatency}ms, speech->llm=${
        speechToLlm ?? "n/a"
      }ms`,
    );

    if (assistantReply.mediaPath) {
      this.log.info(`assistant response received: media=${assistantReply.mediaPath}`);
      await this.playAssistantMedia(assistantReply.mediaPath);
    } else if (assistantReply.text) {
      this.log.info(`assistant response received: ${assistantReply.text.substring(0, 100)}...`);
      await this.playAssistant(assistantReply.text);
    }
    if (!this.isCurrent(gen)) return;
    await this.resumeListeningIfNeeded();
  }

  private buildPrompt(transcript: string) {
    const interrupted = this.lastInterruptedAtSeconds;
    this.lastInterruptedAtSeconds = null;
    return (
      `You are in talk mode - ALWAYS respond with spoken text.\n` +
      `User said: ${transcript}` +
      (interrupted ? `\nInterrupted at ${interrupted}s` : "")
    );
  }

  private async waitForAssistantText(
    sessionKey: string,
    sinceMs: number,
    timeoutSeconds: number,
  ): Promise<{ text?: string; mediaPath?: string } | null> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const history = await GatewayConnection.shared.chatHistory(sessionKey);
      const messages = history.messages ?? [];
      const assistant = messages.findLast(
        (m: any) => m.role === "assistant" && (!sinceMs || (m.timestamp ?? 0) >= sinceMs),
      );
      if (assistant) {
        const text = (assistant.content ?? []).map((c: any) => c.text).join("\n").trim();
        if (text && !isSilentReplyText(text)) return { text };
        if (text && isSilentReplyText(text)) {
          this.log.debug("ignoring NO_REPLY assistant entry; waiting for real response");
        }
      }

      const ttsTool = messages.findLast(
        (m: any) =>
          m.role === "toolResult" &&
          m.toolName === "tts" &&
          (!sinceMs || (m.timestamp ?? 0) >= sinceMs),
      );
      if (ttsTool) {
        const mediaPath = (ttsTool.content ?? [])
          .map((c: any) => c.text)
          .join("\n")
          .split(/\r?\n/)
          .map((line: string) => line.trim())
          .find((line: string) => line.startsWith("MEDIA:"))
          ?.replace(/^MEDIA:\s*/, "")
          .trim();
        if (mediaPath) {
          return { mediaPath };
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  private async playAssistantMedia(mediaPath: string) {
    if (!mediaPath) return;
    this.lastSpokenText = "audio";
    this.phase = "speaking";
    await this.stopPlayback("manual");
    this.playbackAbort = new AbortController();
    const playbackStart = Date.now();
    const player = spawn("paplay", [mediaPath], { stdio: ["ignore", "inherit", "inherit"] });
    this.playbackAbort.signal.addEventListener("abort", () => player.kill("SIGTERM"));
    await new Promise<void>((resolve) => player.on("close", () => resolve()));
    const playbackEnd = Date.now();
    this.log.info(`latency: tts_playback=${playbackEnd - playbackStart}ms (media)`);
    this.logTimeline({
      playbackMs: playbackEnd - playbackStart,
      playbackEnd,
      ttsKind: "media",
    });
  }

  private async playAssistant(text: string) {
    this.log.info(`playAssistant called with text length: ${text.length}`);
    const parse = TalkDirectiveParser.parse(text);
    const parsedReply = parseReplyDirectives(parse.stripped ?? "");
    const cleaned = (parsedReply.text ?? parse.stripped).trim();
    if (!cleaned) {
      this.log.warn("playAssistant: cleaned text is empty, skipping TTS");
      return;
    }
    this.log.info(`playAssistant: speaking text: "${cleaned.substring(0, 100)}..."`);
    this.lastSpokenText = cleaned;

    this.phase = "speaking";
    await this.stopPlayback("manual");
    this.playbackAbort = new AbortController();

    const cfg = loadConfig();
    const talkCfg = cfg.talk ?? {};
    this.log.info(`TTS config: provider=${talkCfg.ttsProvider} endpoint=${talkCfg.ttsEndpoint}`);
    const ttsStart = Date.now();
    const ttsTimings = await speakTts({
      text: cleaned,
      voice: parse.directive?.voiceId,
      provider: talkCfg.ttsProvider ?? "piper",
      endpoint: talkCfg.ttsEndpoint ?? "http://piper:5002/api/tts",
      timeoutMs: talkCfg.ttsTimeoutMs ?? 45000,
      signal: this.playbackAbort.signal,
      onInterrupted: (t) => (this.lastInterruptedAtSeconds = t ?? null),
    });
    this.log.info(
      `latency: tts_generate=${ttsTimings.generationMs}ms, tts_playback=${ttsTimings.playbackMs}ms, tts_total=${ttsTimings.totalMs}ms`,
    );
    this.logTimeline({
      ttsGenerateMs: ttsTimings.generationMs,
      playbackMs: ttsTimings.playbackMs,
      playbackEnd: ttsStart + ttsTimings.totalMs,
      ttsKind: "piper",
    });
    this.log.info("TTS playback completed");
  }

  private logTimeline(params: {
    ttsGenerateMs?: number;
    playbackMs: number;
    playbackEnd: number;
    ttsKind: "piper" | "coqui" | "media";
  }) {
    const speechEndedAt = this.lastSpeechFinalizedAt;
    const sttAt = this.lastSttCompletedAt;
    const llmAt = this.lastLlmCompletedAt;
    const speechToStt = speechEndedAt && sttAt ? sttAt - speechEndedAt : null;
    const sttToLlm = sttAt && llmAt ? llmAt - sttAt : null;
    const llmToTts = llmAt ? params.playbackEnd - params.playbackMs - llmAt : null;
    const speechToEnd = speechEndedAt ? params.playbackEnd - speechEndedAt : null;
    const ttsGen = params.ttsGenerateMs ?? null;
    const ttsPlay = params.playbackMs;

    const parts = [
      `speech→stt=${speechToStt ?? "n/a"}ms`,
      `stt→llm=${sttToLlm ?? "n/a"}ms`,
      `llm→tts=${llmToTts ?? "n/a"}ms`,
      `tts_gen=${ttsGen ?? "n/a"}ms`,
      `tts_play=${ttsPlay}ms`,
      `speech→end=${speechToEnd ?? "n/a"}ms`,
    ];
    this.log.info(`timeline (${params.ttsKind}): ${parts.join(" | ")}`);
  }

  private async stopPlayback(reason: "manual" | "speech") {
    this.playbackAbort?.abort();
    this.playbackAbort = null;
    if (reason === "speech") {
      // interruption timestamp set by speakPico
    }
  }

  private async resumeListeningIfNeeded() {
    if (this.paused) return;
    await this.startListening();
    await this.startCapture();
  }
}