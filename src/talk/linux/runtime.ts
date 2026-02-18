import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import crypto from "node:crypto";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../../config/config.js";
import { isSilentReplyText } from "../../auto-reply/tokens.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSessionFilePath, resolveStorePath } from "../../config/sessions.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { loadSessionStore } from "../../config/sessions.js";
import { GatewayConnection } from "./gateway-connection.js";
import { TalkDirectiveParser } from "./directive.js";
import { createVad } from "./vad.js";
import { captureAudio } from "./audio.js";
import { runWhisper } from "./whisper.js";
import { speakTts } from "./tts.js";

export type TalkPhase = "idle" | "listening" | "thinking" | "speaking";

// Modified to send chat messages with TTS audio links
export class LinuxTalkRuntime {
  private log = createSubsystemLogger("talk/linux");
  private phase: TalkPhase = "idle";
  private enabled = false;
  private paused = false;
  private lifecycleGen = 0;
  private turnGen = 0;

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
  private voiceWakeListenerAbort: AbortController | null = null;

  private audioChunks: Int16Array[] = [];
  private preRoll: Int16Array[] = [];
  private capturingSpeech = false;
  
  // Voice wake tracking
  private voiceWakeTranscript = "";
  private voiceWakeLastHeardAt: number | null = null;
  private voiceWakeGen = 0;
  private voiceWakeActivated = false;
  private voiceWakeAutoDisableTimeout: NodeJS.Timeout | null = null;

  getStatus() {
    return {
      enabled: this.enabled,
      paused: this.paused,
      phase: this.phase,
    };
  }

  getVoiceWakeStatus() {
    const cfg = loadConfig();
    const talkCfg = cfg.talk ?? {};
    return {
      enabled: talkCfg.voiceWakeEnabled ?? false,
      words: talkCfg.voiceWakeWords ?? "",
      listenerActive: this.voiceWakeListenerAbort !== null,
    };
  }

  async setVoiceWakeEnabled(enabled: boolean) {
    const cfg = loadConfig();
    const talkCfg = cfg.talk ?? {};
    
    // Update config in memory
    cfg.talk = {
      ...talkCfg,
      voiceWakeEnabled: enabled,
    };
    
    if (enabled) {
      // Start voice wake listener if not already running
      if (!this.voiceWakeListenerAbort) {
        this.startVoiceWakeListener();
      }
    } else {
      // Stop voice wake listener
      if (this.voiceWakeListenerAbort) {
        this.voiceWakeListenerAbort.abort();
        this.voiceWakeListenerAbort = null;
        this.voiceWakeGen++;
        this.log.info("Voice wake listener stopped");
      }
      // Clear any auto-disable timeout
      this.clearVoiceWakeAutoDisable();
      this.voiceWakeActivated = false;
    }
  }

  async setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.lifecycleGen++;
    
    const cfg = loadConfig();
    const talkCfg = cfg.talk ?? {};
    
    // Clear auto-disable timeout when manually disabling
    if (!enabled) {
      this.clearVoiceWakeAutoDisable();
      this.voiceWakeActivated = false;
    }
    
    // Make sure voice wake listener is running if enabled
    if (talkCfg.voiceWakeEnabled && !this.voiceWakeListenerAbort) {
      this.startVoiceWakeListener();
    }
    
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

  private isTurn(gen: number) {
    return gen === this.turnGen && this.enabled;
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

  private clearVoiceWakeAutoDisable() {
    if (this.voiceWakeAutoDisableTimeout) {
      clearTimeout(this.voiceWakeAutoDisableTimeout);
      this.voiceWakeAutoDisableTimeout = null;
      this.log.debug("voice wake auto-disable timeout cleared");
    }
  }

  private startVoiceWakeAutoDisable() {
    // Only auto-disable if talk mode was activated by voice wake
    if (!this.voiceWakeActivated) return;
    
    this.clearVoiceWakeAutoDisable();
    
    this.log.info("voice wake auto-disable: starting 20s timeout");
    this.voiceWakeAutoDisableTimeout = setTimeout(() => {
      this.log.info("voice wake auto-disable: timeout expired, disabling talk mode");
      this.voiceWakeActivated = false;
      this.setEnabled(false);
    }, 20000);
  }

  private startVoiceWakeListener() {
    if (this.voiceWakeListenerAbort) return;
    this.voiceWakeListenerAbort = new AbortController();
    const abortController = this.voiceWakeListenerAbort;
    const listenerGen = ++this.voiceWakeGen;

    (async () => {
      try {
        const cfg = loadConfig();
        const talkCfg = cfg.talk ?? {};
        const wakeWords = (talkCfg.voiceWakeWords ?? "").trim().toLowerCase().split(/\s+/).filter(w => w);
        
        if (!wakeWords.length) {
          this.log.warn("Voice wake enabled but no wake words configured");
          return;
        }

        this.log.info(`voice wake listener started with words: ${wakeWords.join(", ")}`);

        const vad = createVad();
        let captureTimeout: NodeJS.Timeout | null = null;
        let audioChunks: Int16Array[] = [];
        let preRoll: Int16Array[] = [];
        let capturingSpeech = false;
        let captureStartedAt: number | null = null;

        for await (const chunk of captureAudio(abortController.signal, {
          device: talkCfg.audioDevice,
          backend: talkCfg.captureBackend,
          onError: (err) => this.log.debug(`voice wake audio error: ${String(err)}`),
          onExit: (code, sig) =>
            this.log.debug(`voice wake audio exited code=${code} signal=${sig}`),
        })) {
          if (listenerGen !== this.voiceWakeGen) return; // Abort if listener restarted
          if (this.enabled) continue; // Skip if talk mode is already enabled
          
          const rms = vad.note(chunk);

          if (rms.speech && !capturingSpeech) {
            capturingSpeech = true;
            audioChunks = [];
            preRoll = preRoll.slice(); // Keep current preRoll
            captureStartedAt = Date.now();
            
            if (captureTimeout) clearTimeout(captureTimeout);
            captureTimeout = setTimeout(() => {
              // Buffer timeout - finalize this segment
              this.finalizeVoiceWakeSegment(
                audioChunks,
                preRoll,
                wakeWords,
                talkCfg,
                listenerGen,
              );
              capturingSpeech = false;
              audioChunks = [];
              preRoll = [];
            }, talkCfg.voiceWakePhraseTimeoutMs ?? 5000);
          }

          // Build preRoll before speech detection
          if (!capturingSpeech) {
            preRoll.push(chunk);
            if (preRoll.length > 6) {
              preRoll.shift();
            }
          }

          if (capturingSpeech) {
            audioChunks.push(chunk);
          }

          if (!rms.speech && capturingSpeech && audioChunks.length > 0) {
            // Speech ended
            capturingSpeech = false;
            if (captureTimeout) clearTimeout(captureTimeout);
            
            await this.finalizeVoiceWakeSegment(
              audioChunks,
              preRoll,
              wakeWords,
              talkCfg,
              listenerGen,
            );
            
            audioChunks = [];
            preRoll = [];
          }
        }
      } catch (err) {
        if ((err as any)?.name !== "AbortError") {
          this.log.error(`voice wake listener error: ${String(err)}`);
        }
      } finally {
        this.voiceWakeListenerAbort = null;
      }
    })();
  }

  private async finalizeVoiceWakeSegment(
    audioChunks: Int16Array[],
    preRoll: Int16Array[],
    wakeWords: string[],
    talkCfg: any,
    listenerGen: number,
  ) {
    try {
      if (listenerGen !== this.voiceWakeGen || this.enabled) return;
      if (!audioChunks.length) return;

      // Combine preRoll and audio chunks
      const allChunks = [...preRoll, ...audioChunks];
      
      // Write to WAV file and transcribe
      const wavPath = path.join("/tmp", `voicewake-${Date.now()}.wav`);
      await this.writeWavFile(wavPath, allChunks, 16000, 1);
      
      const transcript = await runWhisper({
        wavPath,
        endpoint: talkCfg.sttEndpoint ?? "http://localhost:8086/transcribe",
        language: talkCfg.sttLanguage ?? "en",
        timeoutMs: talkCfg.sttTimeoutMs ?? 30000,
      });

      if (!transcript || listenerGen !== this.voiceWakeGen) return;

      const normalizedTranscript = transcript.toLowerCase().trim();
      const wakePhrase = wakeWords.join(" ");
      
      // Normalize text for matching: remove punctuation, collapse spaces
      const normalizeForMatching = (text: string) =>
        text.replace(/[.,!?;:]/g, " ").replace(/\s+/g, " ").trim();
      
      const normalizedForMatch = normalizeForMatching(normalizedTranscript);
      const wakePhraseForMatch = normalizeForMatching(wakePhrase);

      this.log.debug(`voice wake detected: "${normalizedTranscript}" (normalized: "${normalizedForMatch}")`);
      this.log.debug(`checking against wake phrase: "${wakePhrase}" (normalized: "${wakePhraseForMatch}")`);

      // Check if transcript starts with wake words (allowing for punctuation/spaces)
      if (normalizedForMatch.startsWith(wakePhraseForMatch)) {
        // Extract remainder, preserving original text quality
        const wakePhraseLength = wakePhrase.length;
        const remainder = normalizedTranscript.substring(wakePhraseLength).replace(/^[.,!?;:\s]+/, "").trim();
        
        this.log.info(`voice wake triggered! transcript="${normalizedTranscript}" remainder="${remainder}"`);

        // Enable talk mode
        if (!this.enabled) {
          this.log.info("enabling talk mode...");
          this.voiceWakeActivated = true;
          await this.setEnabled(true);
        }

        // Send remainder as a message if present
        if (remainder) {
          try {
            this.log.info(`sending voice wake remainder to agent: "${remainder}"`);
            const sessionKey = await GatewayConnection.shared.mainSessionKey();
            this.log.info(`got session key: ${sessionKey}`);
            
            await GatewayConnection.shared.chatSend({
              sessionKey,
              message: remainder,
            });
            this.log.info(`voice wake message sent successfully`);
          } catch (err) {
            this.log.error(`failed to send voice wake message: ${String(err)}`);
          }
        } else {
          this.log.info(`voice wake triggered with no remainder text`);
        }
      } else {
        this.log.debug(`transcript does not start with wake phrase (${normalizedForMatch} vs ${wakePhraseForMatch})`);
      }

      // Clean up temp file
      try {
        await fs.promises.unlink(wavPath);
      } catch (e) {
        // Ignore
      }
    } catch (err) {
      this.log.debug(`voice wake finalize error: ${String(err)}`);
    }
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
          backend: talkCfg.captureBackend,
          onError: (err) => this.log.warn(`audio capture error: ${String(err)}`),
          onExit: (code, sig) =>
            this.log.warn(`audio capture exited code=${code ?? "null"} signal=${sig ?? "null"}`),
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
              this.turnGen++;
              await this.stopPlayback("speech");
              await this.startListening();
            }
            continue;
          }

          if (this.phase === "thinking" && rms.speech) {
            this.turnGen++;
            await this.startListening();
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
        this.log.warn("audio capture ended; restarting");
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

  private stopVoiceWakeListener() {
    if (this.voiceWakeListenerAbort) {
      this.voiceWakeListenerAbort.abort();
      this.voiceWakeListenerAbort = null;
    }
  }

  private async startListening() {
    this.phase = "listening";
    this.resetTranscript();
    this.resetCaptureBuffers();
  }

  private async finalizeTranscript(text: string) {
    this.resetTranscript();
    this.phase = "thinking";
    const turn = ++this.turnGen;
    
    // Clear auto-disable timeout since new speech was detected
    this.clearVoiceWakeAutoDisable();
    
    const trimmed = text.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (lower === "stop") {
      this.log.info("barge-in: received 'stop' only; skipping send");
      await this.resumeListeningIfNeeded();
      return;
    }
    if (lower.startsWith("stop ")) {
      const remainder = trimmed.slice(5).trim();
      if (!remainder) {
        this.log.info("barge-in: 'stop' with empty remainder; skipping send");
        await this.resumeListeningIfNeeded();
        return;
      }
      await this.sendAndSpeak(remainder, turn);
      return;
    }
    await this.sendAndSpeak(trimmed, turn);
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

  private async sendAndSpeak(transcript: string, turn: number) {
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

    if (!this.isCurrent(gen) || !this.isTurn(turn)) return;

    this.log.info("waiting for assistant response...");
    const assistantReply = await this.waitForAssistantText(sessionKey, sendTime, 45, turn);
    if (!assistantReply) {
      if (this.isTurn(turn)) {
        this.log.warn("no assistant text received within timeout");
      }
      await this.resumeListeningIfNeeded();
      return;
    }
    if (!this.isTurn(turn)) return;
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
    if (!this.isCurrent(gen) || !this.isTurn(turn)) return;
    await this.resumeListeningIfNeeded();
  }

  private buildPrompt(transcript: string) {
    const interrupted = this.lastInterruptedAtSeconds;
    this.lastInterruptedAtSeconds = null;
    return (
      `You are in talk mode. Respond with SHORT, natural conversational text suitable for text-to-speech. Do NOT use the tts tool - your text response will be automatically converted to speech.\n` +
      `User said: ${transcript}` +
      (interrupted ? `\nInterrupted at ${interrupted}s` : "")
    );
  }

  private async waitForAssistantText(
    sessionKey: string,
    sinceMs: number,
    timeoutSeconds: number,
    turn?: number,
  ): Promise<{ text?: string; mediaPath?: string } | null> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (turn !== undefined && !this.isTurn(turn)) return null;
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
    await this.startCapture();
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
    
    // Start auto-disable timeout after media playback finishes
    this.startVoiceWakeAutoDisable();
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
    const spokenText = cleaned
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    this.log.info(`playAssistant: speaking text: "${spokenText.substring(0, 100)}..."`);
    this.lastSpokenText = spokenText;

    await this.startCapture();
    this.phase = "speaking";
    await this.stopPlayback("manual");
    this.playbackAbort = new AbortController();

    const cfg = loadConfig();
    const talkCfg = cfg.talk ?? {};
    const ttsProvider = talkCfg.ttsProvider === "coqui" ? "coqui" : "piper";
    this.log.info(`TTS config: provider=${ttsProvider} endpoint=${talkCfg.ttsEndpoint}`);
    const ttsStart = Date.now();
    const directive = parse.directive ?? {};
    const ttsVoice = directive.voiceId ?? talkCfg.ttsVoice ?? talkCfg.voiceId;
    const ttsOptions: Record<string, unknown> = {};
    if (directive.rate !== undefined) ttsOptions.rate = directive.rate;
    if (directive.speed !== undefined) ttsOptions.speed = directive.speed;
    if (directive.stability !== undefined) ttsOptions.stability = directive.stability;
    if (directive.similarity !== undefined) ttsOptions.similarity = directive.similarity;
    if (directive.style !== undefined) ttsOptions.style = directive.style;
    if (directive.speakerBoost !== undefined) ttsOptions.speaker_boost = directive.speakerBoost;
    if (directive.seed !== undefined) ttsOptions.seed = directive.seed;
    if (directive.normalize !== undefined) ttsOptions.normalize = directive.normalize;
    if (directive.lang !== undefined) ttsOptions.lang = directive.lang;
    if (directive.outputFormat !== undefined) {
      ttsOptions.output_format = directive.outputFormat;
    }
    if (directive.latencyTier !== undefined) {
      ttsOptions.latency_tier = directive.latencyTier;
    }
    if (directive.modelId !== undefined) {
      ttsOptions.model = directive.modelId;
    }
    // Send chat message BEFORE playback starts
    const sessionKey = await GatewayConnection.shared.mainSessionKey();
    await this.sendAudioMessageToSession(
      cleaned,
      ttsProvider,
      talkCfg.ttsEndpoint ?? "http://piper:5000",
      ttsVoice,
      sessionKey,
    );

    const ttsTimings = await speakTts({
      text: spokenText,
      voice: ttsVoice,
      provider: ttsProvider,
      endpoint: talkCfg.ttsEndpoint ?? "http://piper:5002/api/tts",
      timeoutMs: talkCfg.ttsTimeoutMs ?? 45000,
      signal: this.playbackAbort.signal,
      options: Object.keys(ttsOptions).length ? ttsOptions : undefined,
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
    
    // Start auto-disable timeout after playback finishes
    this.startVoiceWakeAutoDisable();
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

  private async sendAudioMessageToSession(
    text: string,
    provider: string,
    endpoint: string,
    voice: string | undefined,
    sessionKey: string,
  ) {
    try {
      const cfg = loadConfig();
      const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const store = loadSessionStore(storePath);
      const sessionId = store[sessionKey]?.sessionId ?? sessionKey;
      const transcriptPath = resolveSessionFilePath(sessionId, undefined, {
        sessionsDir: path.dirname(storePath),
        agentId,
      });

      const sessionManager = SessionManager.open(transcriptPath);

      // Build HTTP link to TTS endpoint with query parameters
      const ttsUrl = new URL(endpoint);
      const isLocalhost = ttsUrl.hostname === "localhost" || ttsUrl.hostname === "127.0.0.1";
      if (!isLocalhost) {
        ttsUrl.hostname = "localhost";
        if (!ttsUrl.port || ttsUrl.port === "5000") {
          ttsUrl.port = "5002";
        }
      }
      ttsUrl.searchParams.set("text", text);
      if (provider) ttsUrl.searchParams.set("provider", provider);
      if (voice) ttsUrl.searchParams.set("voice", voice);
      const audioLink = ttsUrl.toString();

      // Create a message with text and HTTP audio link
      const messageBody = {
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: `🔊 ${text}\n\n[Play Audio](${audioLink})`,
          },
        ],
        timestamp: Date.now(),
        stopReason: "stop" as const,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        api: "openai-responses" as const,
        provider: "openclaw-talk",
        model: "tts",
        idempotencyKey: crypto.randomUUID(),
        openclawTalkAudio: {
          audioLink,
          text,
        },
      };

      sessionManager.appendMessage(messageBody);
      this.log.info(`Sent audio message to session: ${audioLink}`);
    } catch (err) {
      this.log.error(`Failed to send audio message to session: ${err}`);
    }
  }
}