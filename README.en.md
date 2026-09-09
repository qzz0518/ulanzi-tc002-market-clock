# Ulanzi TC002 Pixel Studio

[简体中文](README.md) | English

Turns the Ulanzi TC002 pixel clock (52×16 LED) into a multi-channel content studio: market
data, notices, timers, pixel animations, a canvas, community assets, plus a music lyrics
player. Everything is composed in the browser and rendered into pixel frames by a local Bun
service that pushes them to the clock.

![Ulanzi TC002 multi-channel content studio control panel](images/tc002-control-panel.png)

## What it does

- **Channels**: a channel is one page on the clock, switched with the knob; several items in one channel play as a carousel.
- **Market**: BTC, gold, AAPL and friends built in; search-and-add any crypto, stock / ETF, FX pair or precious metal, no API keys.
- **Tools**: notice board (one POST from curl / iOS Shortcuts / Home Assistant puts a message on the clock), interval timer, pomodoro, countdown days.
- **Visual**: twenty-odd pixel animations and clock faces — aquarium, fire, flip clock, pixel pet, Game of Life, fireworks, Nyan Cat, weather clocks, a sunrise/sunset color clock and more.
- **Creative**: a 52×16 canvas, image pixelization, QR-code collaborative doodling; import Ulanzi community assets (PNG / GIF) or local videos.
- **Music**: NetEase and Spotify, karaoke-style per-word lyric highlighting, a live 52×16 preview, four display modes × four palettes.
- **Games**: Breakout, Flappy, Snake, two-player Pong, Racer, Shooter and Tetris, played in the browser and streamed to the clock; Pong can use a phone as the second gamepad via QR code.
- **VIBE**: shows the quota of AI coding agents such as Claude Code and Codex on the clock (needs ZOS, below).

Brightness, volume, timezone and the other clock settings are edited from the top-right of
the console. Phone browsers get a touch layout and can add the console to the home screen.

<p align="center">
  <img src="images/tc002-mobile-content.png" width="390" alt="Ulanzi TC002 Pixel Studio mobile channel composition">
</p>

## Quick start

Requires [Bun](https://bun.sh) (`mise.toml` pins the version — with mise, just `mise install`):

```bash
bun install
CLOCK_HOST=TC002_IP bun start        # replace TC002_IP with the clock's LAN IP or hostname
```

Then open `http://127.0.0.1:43820/`. Install as a resident service (pick one):

```bash
bash scripts/install.sh --host TC002_IP          # macOS LaunchAgent
bash scripts/install-docker.sh --host TC002_IP   # Docker Compose
```

## Music

![Music workspace: switchable NetEase / Spotify sources, cover art in the track list, the player console, and the live 52×16 pixel preview](images/tc002-music-studio.png)

- **NetEase Cloud Music**: scan to log in, then search and play; lyrics come with translations.
- **Spotify**: via Spotify Connect — playback happens on the device you picked, the console and the clock are a remote plus a lyric screen. Needs a free app in the Spotify developer dashboard; the console walks you through it.

Lyrics can be mirrored onto the official firmware without flashing anything. To have the
clock itself play, use ZOS below.

<p align="center">
  <img src="images/tc002-music-firmware-preview.png" width="720" alt="The 52×16 pixel lyric screen — the preview and the clock share one renderer">
</p>

## ZOS system firmware

The repository ships a firmware that replaces the stock app (`device/tc002-os/`). Flashed,
the clock has its own knob menu — **Music / Games / Channels / VIBE / Settings**: Channels
are the console's channels, Games are native versions of the same seven, the music page
shows the current track and lyric, and Settings covers Wi-Fi provisioning, volume and
brightness. The console can mirror the panel live, press the keys remotely, set night sleep,
and update the firmware over the air.

With Settings → 音乐播放 set to 时钟, the clock downloads NetEase tracks and plays them through
its own speaker (not yet verified on hardware, so off by default).

It can also be sideloaded without flashing: memory only, a power cycle restores the official
firmware. Build, sideload and flashing steps are in
[device/tc002-os/README.md](device/tc002-os/README.md).

VIBE reads the logins the agents' CLIs already keep on this machine — no API keys. If the
service runs elsewhere, run `bun run agent` on the machine that holds the logins and push;
the console's VIBE tab has a guide.

## License

This project is **GPL-3.0-only** because it adapts and modifies GPL-3.0 PixDeck material.
Review [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before
distributing source or binaries.
