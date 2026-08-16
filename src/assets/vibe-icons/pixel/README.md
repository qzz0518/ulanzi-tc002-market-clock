# 16x16 VIBE provider marks

This directory contains transparent, native-resolution PNGs for the four
providers selected for the reusable pixel-logo set:

- `claude.png`
- `codex.png`
- `opencode.png`
- `grok.png`

The editable source of truth is `src/vibe/vibe-pixel-logos.ts`. Regenerate the
PNGs and the enlarged review sheet with:

```sh
mise exec -- bun run scripts/gen-vibe-icons.ts
```

The generated review sheet is `docs/images/vibe-pixel-logos-16x16.png`; its
order is Claude, Codex, OpenCode, Grok from left to right, top to bottom.

Do not smooth or resample these files. Scale them by an integer factor with
nearest-neighbour interpolation (`image-rendering: pixelated` on the web).

Claude follows the user-provided orange pixel-creature reference. Codex,
OpenCode and Grok were redrawn locally against the vector marks in the parent
directory; no Pixilart artwork was copied. All names and marks remain trademarks
of their respective owners and are used only to identify compatible services.
