# Ulanzi TC002 Pixel Studio

[简体中文](README.md) | English

Turns the Ulanzi TC002 pixel clock (52×16 LED) into a multi-channel content studio: market
data, notices, timers, pixel animations, canvas artwork, official community assets — plus a
complete music lyrics player. Everything is composed in the browser and rendered into pixel
frames by a local Bun service that pushes them to the clock.

![Ulanzi TC002 multi-channel content studio control panel](docs/images/tc002-control-panel.png)

## What it does

**A channel = one Custom App on the clock**, directly selectable with the TC002 knob;
multiple items in one channel are composed into an ordered carousel.

| Category | Content |
| --- | --- |
| Market | 10 built-in assets (BTC, gold, AAPL, …); search-and-add any crypto, stock / ETF, FX pair, or precious metal — no API keys |
| Tools | Notice board, interval timer column |
| Visual | Langton's ant, aquarium, fire, flip clock, Matrix clock, maze, pixel pet, falling sand, starfield |
| Creative | 52×16 canvas (pen, pixel text, image pixelization); Ulanzi community pixel assets imported through the Library (PNG / GIF) |

The top-right settings dialog reads and writes the clock's brightness, volume, timezone, and
other general settings directly; phone browsers get a dedicated touch layout with
add-to-home-screen support.

<p align="center">
  <img src="docs/images/tc002-mobile-content.png" width="390" alt="Ulanzi TC002 Pixel Studio mobile channel composition">
</p>

## Pixel lyrics player

![Music workspace: switchable NetEase / Spotify sources, cover art in the track list, the player console, and the live 52×16 pixel preview](docs/images/tc002-music-studio.png)

The **Music** view is a complete music console with two interchangeable sources —
**NetEase Cloud Music** and **Spotify**. Search, playlists, cover art, timed lyrics with
translations, and the live 52×16 pixel preview are shared between them, with four display
modes × four palettes.

- **NetEase**: QR login, and the TC002 downloads the track and plays it through its own
  speaker.
- **Spotify**: official Spotify Connect — playback happens on whichever device you pick
  (phone, desktop client, speaker) and both the studio and the clock act as a remote plus a
  lyric screen; change the song on your phone and they follow within two seconds. It needs a
  free app registered in your own developer dashboard, see the
  [technical reference](docs/reference.en.md#music).

Two paths put lyrics on the clock:

- **Device mirror**: no flashing — lyric frames are pushed to the stock firmware while
  audio plays in the browser.
- **Native music firmware**: one click on the web page sideloads the C++ player shipped in
  this repository — speaker audio on the device, lyrics driving the LED matrix directly,
  bidirectional real-time sync with the web. The sideload lives only in device memory: a
  power cycle or one click restores the stock firmware, and flash is never written.

<p align="center">
  <img src="docs/images/tc002-music-firmware-preview.png" width="720" alt="The 52×16 pixel lyric screen — the preview and the music firmware share one rendering algorithm">
</p>

## Quick start

Requires [Bun](https://bun.sh) (`mise.toml` pins 1.3.14 — with mise, just `mise install`):

```bash
bun install
CLOCK_HOST=TC002_IP bun start        # replace TC002_IP with the clock's LAN IP or hostname
```

Then open `http://127.0.0.1:43820/`. Install as a resident service (pick one):

```bash
bash scripts/install.sh --host TC002_IP          # macOS LaunchAgent
bash scripts/install-docker.sh --host TC002_IP   # Docker Compose
```

## More documentation

- [Technical reference](docs/reference.en.md): environment variables, market data sources, Library and Music details, architecture, and the local API
- [Music firmware](device/tc002-lyrics-player/README.md): firmware sources, protocol, build, and sideload safety
- [ADRs](docs/adr/): key architecture decisions

## License

This project is **GPL-3.0-only** because it adapts and modifies GPL-3.0 PixDeck material.
Review [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before
distributing source or binaries.
