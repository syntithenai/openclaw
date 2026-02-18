# Linux Talk Mode - Feature Guide

## Overview

Linux Talk Mode enables continuous voice conversations with OpenClaw on Linux systems (bare metal, Docker, Raspberry Pi). This implementation brings feature parity with macOS/iOS/Android talk modes, with additional Linux-specific capabilities.

## Key Features

### 1. **Continuous Voice Conversation Loop**
- **Listen** → **Transcribe** → **Think** → **Speak** → Repeat
- Voice Activity Detection (VAD) automatically detects speech start/stop
- Silence windows trigger transcription (700ms configurable)
- Interrupt-on-speech: stop playback when user starts talking

### 2. **Voice Wake (Hands-free Activation)** 🆕
- **Background wake word detection** when talk mode is OFF
- Configurable wake words (e.g., "hey openclaw", "hey assistant")
- Automatically enables talk mode and forwards remainder phrase
- Example: "hey openclaw what's the weather" → sends "what's the weather"
- Punctuation/space-insensitive matching (robust to STT variations)

### 3. **Auto-disable After Inactivity** 🆕
- Talk mode auto-disables 20 seconds after speech playback completes
- **Only when activated by voice wake** (manual activation stays on)
- Timeout resets on new speech input (prevents premature disable)
- Manual disable clears auto-disable timeout

### 4. **Runtime Control Commands**
- `/talk on|off|status|help` - Control talk mode
- `/wakeword on|off|status|help` - Control voice wake 🆕

### 5. **Voice Directives**
Assistant can control TTS parameters via JSON prefix:
```json
{"voice_id":"amy","rate":1.2,"stability":0.5}
Hello, how can I help you today?
```

## Architecture

### System Components

```
┌─────────────────────────────────┐
│  User Microphone (PulseAudio)   │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Voice Wake Listener (Background)│ ← When talk mode OFF
│  - VAD-based speech detection    │
│  - Wake word transcription       │
│  - Auto-enable on match          │
└────────────┬────────────────────┘
             │ Wake detected
             ▼
┌─────────────────────────────────┐
│  Talk Mode Runtime (Active)      │ ← When talk mode ON
│  - Continuous audio capture      │
│  - Speech-to-text (Whisper)      │
│  - Agent interaction             │
│  - Text-to-speech (Piper/Coqui)  │
│  - Auto-disable timer (20s)      │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Speaker Output (PulseAudio)     │
└─────────────────────────────────┘
```

### Dependencies

**Required Docker Services:**
- **Whisper STT** (port 8086): Speech-to-text transcription
- **Piper TTS** (port 5002): Text-to-speech synthesis

**Linux Audio Stack:**
- PulseAudio (or PipeWire with PulseAudio compat)
- `parecord` for audio capture
- `paplay` for audio playback

## Installation

### Prerequisites

1. **Docker & Docker Compose** (for containerized deployment)
2. **PulseAudio** or **PipeWire** with PulseAudio compatibility
3. **Microphone** and **speakers** configured and working

### Quick Start (Docker)

1. **Clone and navigate to repository:**
   ```bash
   cd openclaw
   ```

2. **Start required services:**
   ```bash
   docker compose up -d whisper piper
   ```

3. **Verify services are running:**
   ```bash
   # Check Whisper STT
   curl -I http://localhost:8086/
   
   # Check Piper TTS
   curl -I http://localhost:5002/
   ```

4. **Configure OpenClaw** (see Configuration section below)

5. **Start gateway:**
   ```bash
   # Option A: Run on host (recommended for audio access)
   pnpm build
   node openclaw.mjs gateway
   
   # Option B: Run in Docker (requires audio device pass-through)
   docker compose up openclaw-gateway
   ```

### Verify Audio Devices

```bash
# List recording devices
parecord --list-devices

# List playback devices  
paplay --list-devices

# Test microphone
parecord -d default --channels=1 --rate=16000 test.wav
# (Ctrl+C to stop, then play back:)
paplay test.wav
```

## Configuration

### Basic Talk Mode Settings

Add to `.openclaw/openclaw.json` or `~/.openclaw/openclaw.json`:

```json5
{
  "talk": {
    // === Basic Settings ===
    "voiceId": "amy",                              // Piper voice ID
    "interruptOnSpeech": true,                     // Stop TTS when user speaks
    
    // === Speech-to-Text (Whisper) ===
    "sttEndpoint": "http://localhost:8086/transcribe",
    "sttTimeoutMs": 45000,                         // STT request timeout (ms)
    "sttLanguage": "en",                           // Language code
    
    // === Text-to-Speech (Piper/Coqui) ===
    "ttsProvider": "piper",                        // "piper" or "coqui"
    "ttsEndpoint": "http://localhost:5002/api/tts",
    "ttsTimeoutMs": 45000,                         // TTS request timeout (ms)
    
    // === Audio Capture ===
    "audioDevice": "default",                      // PulseAudio device name
    "captureBackend": "pulse"                      // Audio backend
  }
}
```

### Voice Wake Settings 🆕

Add voice wake configuration to enable hands-free activation:

```json5
{
  "talk": {
    // ... basic settings above ...
    
    // === Voice Wake (Background Wake Word Detection) ===
    "voiceWakeEnabled": true,                      // Enable voice wake listener
    "voiceWakeWords": "hey openclaw",              // Space-separated wake words
    "voiceWakeConfidence": 0.5,                    // STT confidence threshold (0-1)
    "voiceWakePhraseTimeoutMs": 5000              // Max phrase duration (ms)
  }
}
```

### Configuration Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **Basic** |
| `voiceId` | string | `"amy"` | Piper voice identifier |
| `interruptOnSpeech` | boolean | `true` | Interrupt TTS when user speaks |
| `autoStart` | boolean | `false` | Auto-start talk mode on gateway start |
| **Speech-to-Text** |
| `sttEndpoint` | string | `"http://localhost:8086/transcribe"` | Whisper STT service URL |
| `sttTimeoutMs` | number | `45000` | STT request timeout in milliseconds |
| `sttLanguage` | string | `"en"` | ISO language code for transcription |
| **Text-to-Speech** |
| `ttsProvider` | string | `"piper"` | TTS engine: `"piper"` or `"coqui"` |
| `ttsEndpoint` | string | `"http://localhost:5002/api/tts"` | TTS service URL |
| `ttsTimeoutMs` | number | `45000` | TTS request timeout in milliseconds |
| **Audio** |
| `audioDevice` | string | `"default"` | PulseAudio device name |
| `captureBackend` | string | `"pulse"` | Audio backend system |
| **Voice Wake** 🆕 |
| `voiceWakeEnabled` | boolean | `false` | Enable background wake word detection |
| `voiceWakeWords` | string | `""` | Space-separated wake words (e.g., "hey openclaw") |
| `voiceWakeConfidence` | number | `0.5` | Minimum STT confidence (0.0-1.0) |
| `voiceWakePhraseTimeoutMs` | number | `5000` | Maximum phrase capture duration in ms |

## Usage

### Enabling Talk Mode

#### Via Command
```bash
# Send via any connected channel (Telegram, Discord, etc.)
/talk on

# Check status
/talk status

# Disable
/talk off
```

#### Via Gateway RPC
```bash
# Using OpenClaw CLI
node openclaw.mjs gateway rpc talk.enable

# Check status
node openclaw.mjs gateway rpc talk.status
```

### Using Voice Wake

#### Enable Voice Wake
```bash
# Via command
/wakeword on

# Check status (shows wake words, listener state)
/wakeword status

# Disable
/wakeword off
```

#### Voice Wake Workflow
1. Configure wake words in `openclaw.json`
2. Start gateway (voice wake listener starts automatically if enabled)
3. Ensure talk mode is OFF
4. Speak wake phrase: **"hey openclaw what's the time"**
5. System behavior:
   - Detects wake words "hey openclaw"
   - Automatically enables talk mode
   - Sends "what's the time" to agent
   - Returns response via TTS
   - Auto-disables 20 seconds after playback

#### Wake Word Matching
- Punctuation-insensitive: "hey, openclaw!" matches "hey openclaw"
- Space-normalization: "heyopenclaw" won't match "hey openclaw"
- Case-insensitive: "HEY OPENCLAW" matches "hey openclaw"

### Voice Directives

Assistant responses can include TTS control via JSON prefix:

```
{"voice_id":"amy","rate":1.2,"stability":0.5}
I'll speak this with Amy's voice at 1.2x speed.
```

**Supported directive keys:**
- `voice` / `voice_id` / `voiceId` - Voice identifier
- `rate` / `speed` - Speech rate multiplier (e.g., 1.2 = 20% faster)
- `stability` - Voice stability (provider-specific, 0-1)
- `similarity` - Voice similarity (provider-specific, 0-1)
- `lang` - Language override
- `once` - Apply only to current response (boolean)

## Docker Deployment

### docker-compose.yml Example

```yaml
services:
  whisper:
    image: jjajjara/rocm-whisper-api
    ports:
      - "8086:8080"
    devices:
      - /dev/kfd   # AMD GPU (ROCm)
      - /dev/dri   # AMD GPU (ROCm)
    # For NVIDIA GPU, use:
    # runtime: nvidia
    # environment:
    #   - NVIDIA_VISIBLE_DEVICES=all

  piper:
    build:
      context: ./docker/piper1-gpl
    ports:
      - "5002:5000"
    volumes:
      - ./docker/piper-data:/app/voices

  openclaw-gateway:
    build:
      context: .
      dockerfile: Dockerfile.linux.full
    ports:
      - "18789:18789"
    volumes:
      - ~/.openclaw:/home/node/.openclaw
      - /run/user/1000/pulse:/run/user/1000/pulse  # PulseAudio socket
    environment:
      - PULSE_SERVER=unix:/run/user/1000/pulse/native
    devices:
      - /dev/snd  # Audio devices (optional, depends on setup)
    depends_on:
      - whisper
      - piper
```

### Audio in Docker (Advanced)

For audio access from Docker container:

1. **Share PulseAudio socket:**
   ```yaml
   volumes:
     - /run/user/1000/pulse:/run/user/1000/pulse
   environment:
     - PULSE_SERVER=unix:/run/user/1000/pulse/native
   ```

2. **Or use host PulseAudio server:**
   ```yaml
   environment:
     - PULSE_SERVER=tcp:host.docker.internal:4713
   network_mode: host
   ```

3. **Or run gateway on host** (recommended):
   ```bash
   # Services in Docker
   docker compose up -d whisper piper
   
   # Gateway on host with direct audio access
   node openclaw.mjs gateway
   ```

## Troubleshooting

### Voice Wake Not Starting

**Check logs:**
```bash
docker logs openclaw-openclaw-gateway-1 | grep "voice wake"
```

**Expected:**
```
[talk/linux] voice wake listener started with words: hey, openclaw
```

**Issues:**

1. **"Voice wake enabled but no wake words configured"**
   - Set `voiceWakeWords` in config

2. **Listener not active when talk mode is off**
   - Verify `voiceWakeEnabled: true` in config
   - Check `/wakeword status` output

3. **Wake words not detected**
   - Test microphone: `parecord -d default test.wav`
   - Check STT endpoint: `curl http://localhost:8086/`
   - Reduce `voiceWakeConfidence` to 0.3 for testing
   - Check logs for transcript vs wake phrase comparison

### Talk Mode Not Responding

**Check Whisper service:**
```bash
docker logs openclaw-whisper-1
curl -I http://localhost:8086/
```

**Check Piper service:**
```bash
docker logs openclaw-piper-1
curl -I http://localhost:5002/
```

**Check audio devices:**
```bash
parecord --list-devices
paplay --list-devices
```

### No Audio Capture

```bash
# Check PulseAudio
pactl info

# Check default source (microphone)
pactl list sources | grep -A 10 "Name: alsa"

# Test capture directly
parecord -d default --channels=1 --rate=16000 test.wav
# Speak for a few seconds, then Ctrl+C
paplay test.wav
```

### No Audio Playback

```bash
# Check default sink (speakers)
pactl list sinks | grep -A 10 "Name: alsa"

# Test playback
paplay /usr/share/sounds/alsa/Front_Center.wav

# Check volume
pactl set-sink-volume @DEFAULT_SINK@ 100%
pactl set-sink-mute @DEFAULT_SINK@ 0
```

### Auto-disable Not Working

**Check if talk mode was activated by voice wake:**
- Auto-disable only applies when talk mode enabled via wake word
- Manual `/talk on` does NOT auto-disable

**Check logs:**
```
[talk/linux] voice wake auto-disable: starting 20s timeout
[talk/linux] voice wake auto-disable: timeout expired, disabling talk mode
```

**Timeout reset behavior:**
- Timeout clears when user speaks during talk mode
- New speech = new timeout starts after playback

### High CPU Usage

**Voice wake listener:**
- Idle: <2% CPU
- During speech: 8-12% CPU (VAD processing)

**If consistently high (>20%):**
- Check VAD loop is properly aborting
- Verify only one listener instance running
- Check for memory leaks: `docker stats openclaw-openclaw-gateway-1`

## Performance Tuning

### Latency Optimization

**Total latency chain:**
1. VAD finalization: ~700ms (silence window)
2. STT transcription: ~500-2000ms (audio length dependent)
3. Agent thinking: Variable (model dependent)
4. TTS synthesis: ~500-1500ms (text length dependent)
5. Audio playback: Real-time

**Optimization tips:**
- Use GPU-accelerated Whisper (ROCm/CUDA)
- Use faster models (Piper > Coqui for latency)
- Reduce silence window for faster finalization
- Configure shorter timeouts for faster failures
- Use streaming TTS when available (future enhancement)

### Resource Usage

**Typical resource consumption:**
- Memory: ~200MB base + ~15MB for voice wake listener
- CPU idle: 2-5% (voice wake listening)
- CPU active: 15-30% (talk mode conversation)
- GPU: Whisper transcription (duration dependent)

## Feature Comparison

| Feature | macOS | iOS | Android | **Linux** |
|---------|-------|-----|---------|-----------|
| Talk Mode | ✅ | ✅ | ✅ | ✅ |
| Voice Wake | ✅ | ✅ | ✅ | ✅ 🆕 |
| Background Wake Words | ✅ | ✅ | ✅ | ✅ 🆕 |
| Auto-disable Timeout | ❌ | ❌ | ❌ | ✅ 🆕 |
| Interrupt on Speech | ✅ | ✅ | ✅ | ✅ |
| Voice Directives | ✅ | ✅ | ✅ | ✅ |
| Runtime Control Commands | ⚠️ | ⚠️ | ⚠️ | ✅ 🆕 |
| STT Provider | Apple | Apple | Google | Whisper |
| TTS Provider | ElevenLabs | ElevenLabs | ElevenLabs | Piper/Coqui |

🆕 = New in Linux implementation  
⚠️ = UI-based, no CLI commands

## Advanced Topics

### Custom Piper Voices

1. Download voice model from [Piper voices](https://github.com/rhasspy/piper/releases)
2. Place in `docker/piper-data/` directory
3. Update `voiceId` in config to match model name
4. Restart Piper service

### Multiple Wake Words

Space-separated list in config:
```json
"voiceWakeWords": "hey openclaw hey assistant openclaw"
```

Matches any of: "hey openclaw", "hey assistant", "openclaw"

### Wake Word Testing

Enable debug logging:
```bash
# Check normalized vs original transcript
docker logs openclaw-openclaw-gateway-1 | grep "normalized:"

# Example output:
# normalized: 'hey openclaw whats the time', phrase: 'hey openclaw'
# wake phrase matched! Activating talk mode.
```

### Integration with Home Assistant

Voice wake can trigger Home Assistant automations via OpenClaw agent:

```yaml
# Example automation triggered by voice wake
automation:
  - alias: "Voice Wake Notification"
    trigger:
      platform: mqtt
      topic: openclaw/voice_wake/detected
    action:
      service: notify.mobile_app
      data:
        message: "Voice wake activated"
```

## Files Reference

### Implementation
- `src/talk/linux/runtime.ts` - Main state machine + voice wake
- `src/talk/linux/gateway-connection.ts` - Gateway API wrapper
- `src/talk/linux/gateway-integration.ts` - Initialization & control
- `src/talk/linux/vad.ts` - Voice activity detection
- `src/talk/linux/whisper.ts` - STT client
- `src/talk/linux/tts.ts` - TTS client
- `src/talk/linux/audio.ts` - Audio I/O (PulseAudio)
- `src/talk/linux/directive.ts` - Directive parser

### Commands
- `src/auto-reply/reply/commands-talk.ts` - `/talk` command
- `src/auto-reply/reply/commands-wakeword.ts` - `/wakeword` command 🆕

### Configuration
- `src/config/types.gateway.ts` - TypeScript types
- `src/config/zod-schema.ts` - Runtime validation
- `src/gateway/protocol/schema/channels.ts` - Protocol schema
- `src/gateway/server-methods/talk.ts` - RPC handlers

### Documentation
- `README_LINUX_TALK_MODE.md` - This file
- `TALK_MODE_QUICK_START.md` - Quick start guide
- `TALK_MODE_COMPLETION.md` - Implementation notes
- `docs/nodes/talk.md` - Talk mode reference

## Contributing

Talk mode is actively developed. Contributions welcome:

- Bug reports: GitHub Issues
- Feature requests: GitHub Discussions
- Pull requests: See CONTRIBUTING.md

## License

OpenClaw is open source. See LICENSE file for details.

---

**Last updated:** 2026-02-18  
**Version:** Linux Talk Mode with Voice Wake v1.0
