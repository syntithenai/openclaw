# Docker Audio Setup Guide - MPD Integration

## Overview

This guide covers setting up the OpenClaw Gateway Docker container with audio hardware access and MPD (Music Player Daemon) for voice-controlled music playback and playlist creation.

## Key Changes

### 1. Docker Container (Dockerfile)

- ✅ **MPD and MPC installed** - Music player daemon and client
- ✅ **ALSA utilities included** - Low-level audio access
- ✅ **PulseAudio utils included** - High-level audio server support

### 2. Docker Compose (docker-compose.yml)

- ✅ **Audio device mounts** - `/dev/snd` for ALSA access
- ✅ **PulseAudio socket** - `/run/user/1000/pulse` for network audio
- ✅ **Environment variables** - MPD_HOST, MPD_PORT, PULSE_SERVER, ALSA_CARD
- ✅ **Network mode** - Host networking for localhost MPD access

### 3. Install Scripts

- ✅ **Ubuntu install script** - Includes mpd, mpc, pulseaudio packages
- ✅ **Raspbian install script** - Same audio packages for Pi
- ✅ **Configuration prompts** - Asks for music directory and MPD port during setup

## Audio Access Methods

### Option A: PulseAudio (Recommended for desktop/Raspberry Pi)

**Best for:** Ubuntu desktop, Raspberry Pi with default audio setup

**Setup:**

```bash
# The docker-compose.yml already includes PulseAudio volume mounts:
- /run/user/1000/pulse:/run/user/1000/pulse:ro
- /etc/pulse:/etc/pulse:ro

# Environment variables are set:
PULSE_SERVER: unix:${XDG_RUNTIME_DIR:-/run/user/1000}/pulse/native
```

**Verify PulseAudio is running on host:**

```bash
# On host machine
pactl list sources short  # Show available audio inputs
pactl list sinks short    # Show available audio outputs
```

**From container:**

```bash
# MPD will automatically use PulseAudio if available
docker exec <container> mpd --version

# Test audio playback (requires music in library)
docker exec <container> mpc status
```

### Option B: ALSA (Lower-level, direct hardware access)

**Best for:** Server environments, custom audio setups

**Setup:**

```bash
# The docker-compose.yml includes ALSA device mount:
- /dev/snd:/dev/snd

# Environment variables:
ALSA_CARD: ${ALSA_CARD:-default}
ALSA_PCM_CARD: ${ALSA_PCM_CARD:-default}
```

**Configure ALSA on host:**

```bash
# List sound cards
cat /proc/asound/cards

# Set default card (example: card 1)
echo "defaults.pcm.card 1" >> ~/.asoundrc
echo "defaults.ctl.card 1" >> ~/.asoundrc
```

**Override in docker-compose.override.yml:**

```yaml
services:
  openclaw-gateway:
    environment:
      ALSA_CARD: "1"
      ALSA_PCM_CARD: "1"
```

## MPD Configuration for Container

### Default Configuration

The container includes a basic MPD configuration that:

- Listens on `localhost:6600`
- Uses `/home/node/.local/share/mpd` for state
- Watches music directories for changes

### Custom MPD Configuration

**Mount MPD config from host:**

```yaml
# docker-compose.override.yml
volumes:
  - /etc/mpd.conf:/etc/mpd.conf:ro
  - ~/.config/mpd/music:/music:ro
```

**Or configure via environment + auto-start:**

```bash
# In .env or docker-compose.yml
MPD_MUSIC_DIRECTORY=/home/node/Music
MPD_PORT=6600
MPD_HOST=localhost
```

### MPD State Persistence

**Mount MPD state directory:**

```yaml
volumes:
  - ~/.config/mpd:/home/node/.config/mpd
  - ~/.local/share/mpd:/home/node/.local/share/mpd
```

This preserves:

- Playlists
- Current playback position
- Library database

## Voice Command Examples

Once MPD is running in the container:

```bash
# Test from container
docker exec <container> python3 \
  /home/node/.openclaw/workspace-voice/skills/mpd/scripts/mpd_remote.py status

# Voice commands (via OpenClaw)
"Play my music"
→ mpd_remote.py play

"Create a playlist with Beatles songs"
→ mpd_remote.py search-and-add "Beatles" "artist:Beatles"

"Set volume to 75"
→ mpd_remote.py volume 75

"Skip to next song"
→ mpd_remote.py next
```

## Troubleshooting

### MPD won't start

```bash
# Check if MPD is running in container
docker exec <container> pgrep -a mpd
# Should show: /usr/bin/mpd ...

# Check logs
docker logs <container> | grep -i mpd
```

### No audio output

**Check PulseAudio:**

```bash
# On host
pactl info
ps aux | grep pulseaudio

# In container
docker exec <container> pactl info
# Error: "Connection refused" = PulseAudio not available
```

**Check ALSA:**

```bash
# In container
docker exec <container> arecord -l    # Record devices
docker exec <container> aplay -l      # Playback devices
```

**Verify permissions:**

```bash
# /dev/snd permissions
ls -l /dev/snd/

# Should be readable by container user (1000:1000)
# If not, fix on host:
sudo chmod a+rw /dev/snd/*
```

### Library is empty or slow

```bash
# Update MPD library
docker exec <container> mpc update

# Check library status
docker exec <container> mpc stats

# Monitor update progress
docker logs -f <container> | grep mpd
```

### Port 6600 in use

If another service uses port 6600:

```yaml
# docker-compose.override.yml
environment:
  MPD_PORT: "6601" # Use different port
```

Then configure mpd_remote.py to use the new port:

```bash
docker exec <container> \
  MPD_PORT=6601 python3 mpd_remote.py status
```

## File Locations in Container

| Item          | Path                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| MPD binary    | `/usr/bin/mpd`                                                          |
| MPD config    | `/etc/mpd.conf` (host-mounted)                                          |
| Music library | `/home/node/Music`                                                      |
| MPD state     | `/home/node/.config/mpd`                                                |
| MPD socket    | `/run/mpd/socket`                                                       |
| Python script | `/home/node/.openclaw/workspace-voice/skills/mpd/scripts/mpd_remote.py` |

## Environment Variables

| Variable        | Default                       | Purpose                |
| --------------- | ----------------------------- | ---------------------- |
| `MPD_HOST`      | `localhost`                   | MPD server hostname    |
| `MPD_PORT`      | `6600`                        | MPD server port        |
| `PULSE_SERVER`  | `/run/user/1000/pulse/native` | PulseAudio socket path |
| `ALSA_CARD`     | `default`                     | ALSA audio card        |
| `ALSA_PCM_CARD` | `default`                     | ALSA PCM device        |

## Docker Compose Example

```yaml
version: "3.8"

services:
  openclaw-gateway:
    image: openclaw:local
    user: "1000:1000"
    network_mode: host

    environment:
      HOME: /home/node
      # Audio configuration
      MPD_HOST: localhost
      MPD_PORT: 6600
      PULSE_SERVER: unix:/run/user/1000/pulse/native
      ALSA_CARD: default

    volumes:
      # Audio devices
      - /dev/snd:/dev/snd
      - /run/user/1000/pulse:/run/user/1000/pulse:ro
      - /etc/pulse:/etc/pulse:ro

      # Music directory
      - ~/.config/mpd/music:/home/node/Music:ro

      # MPD state
      - ~/.config/mpd:/home/node/.config/mpd

      # Standard volumes
      - ~/.openclaw:/home/node/.openclaw
      - ~/.openclaw/workspace:/home/node/.openclaw/workspace

    ipc: host
    restart: unless-stopped
```

## Next Steps

1. **Rebuild container** with MPD support:

   ```bash
   cd openclaw/
   docker-compose build
   ```

2. **Configure music directory** in host:

   ```bash
   mkdir -p ~/.config/mpd/music
   # Copy your music files here
   ```

3. **Start container:**

   ```bash
   docker-compose up -d
   ```

4. **Verify MPD:**

   ```bash
   docker exec openclaw-openclaw-gateway-1 mpc status
   ```

5. **Test voice commands:**
   ```
   "Create a playlist with rock songs"
   "Play my collection"
   "Skip to next song"
   ```

---

## References

- [MPD Documentation](https://www.musicpd.org/doc/html/)
- [Docker Audio Documentation](https://docs.docker.com/engine/reference/run/#runtime-audio-support)
- [ALSA Guide](https://wiki.archlinux.org/title/Advanced_Linux_Sound_Architecture)
- [PulseAudio Configuration](https://wiki.freedesktop.org/wiki/Software/PulseAudio/)
