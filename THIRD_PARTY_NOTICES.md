# Third-party notices

## PixDeck

Parts of the content catalog and rendering behavior were adapted from PixDeck:

- Project: https://github.com/cailurus/PixDeck
- Upstream copyright: © 2026 cailurus
- Fixed source revision: `599f712d8ea086ce5b31041130f4353b3816fa0c`
- License: GNU General Public License version 3 only
- Local license copy: [LICENSE](LICENSE)

The AAPL, MSFT, NVIDIA, and Google 16×16 stock icons in
`src/stock-icons.ts` preserve the exact upstream PNG bytes and opaque pixel
layouts from `plugins/stock/assets/*1.png`. Their upstream SHA-256 values are:

| File | SHA-256 |
| --- | --- |
| `aapl1.png` | `da282197f269bae31b56995c74dba6ee0b03da4da7dffd8ec836c3a88a21f1f0` |
| `msft1.png` | `1d68ff4849741622ac5fd3d922bc602893e4cdb97fa3532835eb3aa2d7c4b3de` |
| `nvda1.png` | `11c4324008c049aaf9d4a9d15d335b9be65403dd1af6daa595a817a276685021` |
| `googl1.png` | `438e777d006c32ea5124152d5e430d43529cbeb58d34fc36c2dc27760a21a096` |

This repository's TypeScript renderers are modified implementations for a
centralized frame-composition architecture; they are not the original Python
plugin files. The modifications are identified by this repository's version
history.

## Cladd UI

The control panel uses the `@cladd-ui/react` component library:

- Project: https://github.com/cladd-ui/cladd
- Copyright: © 2026 cladd-ui
- License: MIT

The MIT license text is distributed with the installed package and applies to
Cladd UI only. The surrounding application remains licensed under GPL-3.0-only.

## gifuct-js

Imported community GIF assets are decoded with `gifuct-js`:

- Project: https://github.com/matt-way/gifuct-js
- Copyright: © 2015 Matt Way
- License: MIT

## pngjs

Imported community PNG assets are decoded with `pngjs`:

- Project: https://github.com/pngjs/pngjs
- Original work copyright: © 2015 Luke Page and contributors
- Derived work copyright: © 2012 Kuba Niegowski
- License: MIT

These libraries process user-requested assets at runtime. No Ulanzi community
artwork is bundled or redistributed with this repository.

## NetEase Cloud Music API Alger

The music workspace calls `netease-cloud-music-api-alger` version `4.30.0` as
a runtime dependency for QR login, search, playlists, track metadata, lyrics,
and permitted playback URLs:

- Package: `netease-cloud-music-api-alger@4.30.0`
- Upstream author field: binaryify
- License: MIT

The dependency's MIT license applies to that package only. Pixel Studio keeps
the resulting account cookie on the local server and does not bundle songs,
album artwork, or lyrics in this repository.

## AlgerMusicPlayer reference

The product flow and endpoint selection were checked against AlgerMusicPlayer:

- Project: https://github.com/algerkong/AlgerMusicPlayer
- Fixed source revision reviewed: `187ce573a4b7359dbbec9ca6d5d834b4f148434f`
- Copyright: Alger and contributors
- License: MIT

No AlgerMusicPlayer UI or source file is copied into Pixel Studio. Its public
implementation was used as a behavioral reference for the QR/search/lyric/audio
flow; this repository provides its own server boundary and interface.

## Fusion Pixel 12px Monospaced SC

The 52×16 lyrics preview uses the Simplified Chinese, 12-pixel monospaced build
of Fusion Pixel Font, version `5.3.0`:

- Upstream project: https://github.com/TakWolf/fusion-pixel-font
- Package: https://www.npmjs.com/package/@fontsource/fusion-pixel-12px-monospaced-sc
- Copyright: TakWolf and upstream font contributors
- License: SIL Open Font License 1.1

The package includes the applicable license text. The font is used unmodified
as a web font; the lyric renderer rasterizes it at its native 12×12 pixel
grid.
