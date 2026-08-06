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
