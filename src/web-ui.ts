export function controlPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f4f4f4">
  <meta name="description" content="Ulanzi TC002 像素市场时钟本地控制台">
  <title>Pixel Market — TC002 控制台</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    :root {
      --background: #f4f4f4;
      --foreground: oklch(12% 0 0);
      --foreground-soft: oklch(38% 0 0);
      --muted: oklch(91.5% 0 0);
      --border: oklch(84% 0 0);
      --brand: oklch(68% 0.19 142);
      --brand-strong: oklch(51% 0.17 142);
      --danger: oklch(57.7% 0.19 27.3);
      --screen: oklch(10.5% 0 0);
      --white: oklch(98.5% 0 0);
      --font-sans: Inter, "SF Pro Display", "Helvetica Neue", "PingFang SC", sans-serif;
      --font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace;
      --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
      color: var(--foreground);
      background: var(--background);
      font-family: var(--font-sans);
      font-synthesis: none;
    }

    * { box-sizing: border-box; }

    html {
      min-width: 20rem;
      scroll-behavior: smooth;
      background: var(--background);
    }

    body {
      margin: 0;
      min-height: 100dvh;
      padding-bottom: max(7rem, calc(5.5rem + env(safe-area-inset-bottom)));
      background: var(--background);
      color: var(--foreground);
      font-feature-settings: "cv11", "ss01", "ss03";
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
    }

    button,
    input { font: inherit; }

    button { color: inherit; }

    ::selection {
      color: var(--white);
      background: var(--brand-strong);
    }

    .skip-link {
      position: fixed;
      inset: 0 auto auto 0;
      z-index: 100;
      padding: 0.75rem 1rem;
      color: var(--white);
      background: var(--foreground);
      transform: translateY(-110%);
      transition: transform 180ms var(--ease-out);
    }

    .skip-link:focus { transform: translateY(0); }

    :focus-visible {
      outline: 2px solid var(--brand-strong);
      outline-offset: 4px;
    }

    .status-rule {
      position: absolute;
      z-index: 30;
      top: max(2.5rem, env(safe-area-inset-top));
      left: clamp(1.5rem, 4.5vw, 6rem);
      width: clamp(7.5rem, 11vw, 9.25rem);
      height: 3px;
      overflow: hidden;
      background: var(--border);
    }

    .status-progress {
      display: block;
      width: 100%;
      height: 100%;
      background: var(--brand);
      transform: scaleX(0.15);
      transform-origin: left;
      transition: transform 600ms var(--ease-out), background-color 240ms ease;
    }

    .status-progress.healthy { transform: scaleX(1); }
    .status-progress.degraded { transform: scaleX(0.62); }
    .status-progress.offline { background: var(--danger); transform: scaleX(0.24); }

    .shell {
      width: min(100%, 96rem);
      margin-inline: auto;
      padding-inline: clamp(1.5rem, 4.5vw, 6rem);
      animation: enter 620ms var(--ease-out) both;
    }

    .masthead {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: start;
      gap: 2rem;
      padding-block: max(3.75rem, calc(env(safe-area-inset-top) + 2.75rem)) 2rem;
      border-bottom: 1px solid var(--border);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.85rem;
    }

    .brand-mark {
      display: grid;
      grid-template-columns: repeat(2, 0.32rem);
      place-content: center;
      gap: 0.16rem;
      width: 1.2rem;
      height: 1.2rem;
      border-radius: 50%;
      background: color-mix(in oklch, var(--brand) 28%, var(--background));
    }

    .brand-mark i {
      width: 0.32rem;
      height: 0.32rem;
      background: var(--brand-strong);
    }

    .brand-name {
      margin: 0;
      font-family: var(--font-mono);
      font-size: 0.76rem;
      font-weight: 500;
      letter-spacing: 0.02em;
    }

    .brand-name span { color: var(--foreground-soft); }

    .device-chip {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.18rem 0.65rem;
      min-width: 14rem;
      text-align: left;
    }

    .status-dot {
      grid-row: 1 / span 2;
      width: 0.55rem;
      height: 0.55rem;
      margin-top: 0.29rem;
      border-radius: 50%;
      background: var(--border);
      box-shadow: 0 0 0 4px color-mix(in oklch, var(--border) 35%, transparent);
    }

    .status-dot.healthy {
      background: var(--brand);
      box-shadow: 0 0 0 4px color-mix(in oklch, var(--brand) 20%, transparent);
    }

    .status-dot.degraded { background: oklch(73% 0.15 83); }
    .status-dot.offline { background: var(--danger); }

    .device-chip strong {
      font-size: 0.82rem;
      font-weight: 500;
      line-height: 1.3;
    }

    .device-chip small {
      color: var(--foreground-soft);
      font-family: var(--font-mono);
      font-size: 0.67rem;
      line-height: 1.45;
    }

    .page-heading {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 2rem;
      padding-block: 2rem 1.75rem;
    }

    .page-heading h1 {
      margin: 0;
      font-size: clamp(1.55rem, 2.5vw, 2rem);
      font-weight: 500;
      line-height: 1.1;
      letter-spacing: -0.04em;
    }

    .page-heading p {
      max-width: 32rem;
      margin: 0;
      color: var(--foreground-soft);
      font-size: 0.8rem;
      line-height: 1.5;
      text-wrap: pretty;
    }

    main { padding-bottom: 2rem; }

    .workspace {
      display: grid;
      gap: clamp(1.1rem, 2vw, 1.6rem);
      padding-top: 0;
    }

    .preview-column {
      min-width: 0;
    }

    .section-heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 2rem;
      margin-bottom: 0.7rem;
    }

    .section-heading h2 {
      margin: 0;
      font-size: clamp(1.15rem, 1.8vw, 1.45rem);
      font-weight: 500;
      line-height: 1.2;
      letter-spacing: -0.03em;
    }

    .settings-grid .section-heading h2 { font-size: clamp(1.05rem, 1.5vw, 1.25rem); }

    .section-kicker,
    .section-index,
    .field-label,
    .telemetry dt,
    .preview-meta {
      font-family: var(--font-mono);
      font-size: 0.68rem;
      font-weight: 400;
      letter-spacing: 0.01em;
    }

    .section-kicker,
    .section-index { color: var(--brand-strong); }

    .preview-heading {
      align-items: center;
      margin-bottom: 0.35rem;
    }

    .preview-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.35rem 0.9rem;
      color: var(--foreground-soft);
    }

    .preview-meta span + span::before {
      content: "·";
      margin-right: 0.9rem;
      color: var(--border);
    }

    .clock-stage {
      display: grid;
      place-items: center;
      min-width: 0;
    }

    .clock-visual {
      position: relative;
      width: min(100%, 44rem);
      aspect-ratio: 2292 / 1036;
      filter: drop-shadow(0 0.8rem 0.8rem rgba(12, 12, 12, 0.12));
    }

    .clock-frame {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: block;
      width: 100%;
      height: 100%;
      pointer-events: none;
      user-select: none;
    }

    .pixel-screen {
      position: absolute;
      z-index: 1;
      top: 13.996%;
      left: 2.748%;
      display: grid;
      place-items: center;
      width: 94.59%;
      height: 57.626%;
      overflow: hidden;
      background: #000;
    }

    .pixel-screen::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(to right, transparent calc(100% - 1px), rgba(255, 255, 255, 0.11) 100%),
        linear-gradient(to bottom, transparent calc(100% - 1px), rgba(255, 255, 255, 0.11) 100%);
      background-size: calc(100% / 52) calc(100% / 16);
      opacity: 0.28;
    }

    #preview-image {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: fill;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }

    .preview-empty {
      position: relative;
      z-index: 1;
      color: oklch(63% 0 0);
      font-family: var(--font-mono);
      font-size: 0.7rem;
    }

    .telemetry {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      width: min(100%, 44rem);
      margin: 0.3rem auto 0;
      border-block: 1px solid var(--border);
    }

    .telemetry div {
      display: grid;
      gap: 0.22rem;
      padding: 0.55rem 0.85rem;
    }

    .telemetry div + div { border-left: 1px solid var(--border); }
    .telemetry dt { color: var(--foreground-soft); }

    .telemetry dd {
      margin: 0;
      font-family: var(--font-mono);
      font-size: clamp(0.95rem, 1.5vw, 1.15rem);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.04em;
    }

    .settings-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.14fr) minmax(28rem, 0.86fr);
      gap: clamp(2rem, 4vw, 4rem);
      min-width: 0;
      padding-top: 0.9rem;
      border-top: 1px solid var(--border);
    }

    .control-section {
      min-width: 0;
      scroll-margin-top: 4rem;
    }

    fieldset {
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }

    .legend-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      width: 100%;
      margin-bottom: 0.55rem;
      padding: 0;
      color: var(--foreground-soft);
      font-size: 0.78rem;
      line-height: 1.4;
    }

    .legend-row strong { color: var(--foreground); font-weight: 500; }

    .asset-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border-top: 1px solid var(--border);
    }

    .asset-option {
      position: relative;
      display: grid;
      grid-template-columns: 1.2rem 1.85rem minmax(0, 1fr) 1.2rem;
      align-items: center;
      gap: 0.45rem;
      min-height: 3.55rem;
      padding: 0.35rem 0.55rem;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background-color 180ms ease, color 180ms ease;
    }

    .asset-option:not(:nth-child(3n)) { border-right: 1px solid var(--border); }

    .asset-option input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }

    .asset-index {
      color: var(--foreground-soft);
      font-family: var(--font-mono);
      font-size: 0.7rem;
      font-variant-numeric: tabular-nums;
    }

    .asset-icon {
      width: 1.85rem;
      height: 1.85rem;
      border-radius: 0.3rem;
      image-rendering: pixelated;
      filter: grayscale(1);
      transition: filter 420ms ease, transform 420ms var(--ease-out);
    }

    .asset-copy {
      display: grid;
      gap: 0.18rem;
      min-width: 0;
    }

    .asset-copy strong {
      overflow: hidden;
      font-size: 0.8rem;
      font-weight: 500;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 180ms ease;
    }

    .asset-copy small {
      overflow: hidden;
      color: var(--foreground-soft);
      font-size: 0.6rem;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .asset-check {
      display: grid;
      place-items: center;
      width: 1.15rem;
      height: 1.15rem;
      border: 1px solid var(--border);
      border-radius: 50%;
      color: transparent;
      font-size: 0.65rem;
      transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease;
    }

    .asset-option:has(input:checked) {
      background: color-mix(in oklch, var(--brand) 9%, var(--background));
    }
    .asset-option:has(input:checked) .asset-copy strong { color: var(--brand-strong); }
    .asset-option:has(input:checked) .asset-icon { filter: grayscale(0); transform: scale(1.04); }

    .asset-option:has(input:checked) .asset-check {
      color: var(--white);
      border-color: var(--brand-strong);
      background: var(--brand-strong);
    }

    .asset-option:has(input:focus-visible) {
      outline: 2px solid var(--brand-strong);
      outline-offset: 4px;
    }

    .timing-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border-block: 1px solid var(--border);
    }

    .field {
      display: grid;
      grid-template-columns: 1fr;
      align-content: space-between;
      gap: 0.55rem;
      min-height: 5.6rem;
      padding: 0.6rem;
    }

    .field + .field { border-left: 1px solid var(--border); }

    .field-copy {
      display: grid;
      gap: 0.3rem;
    }

    .field-label {
      color: var(--foreground);
      font-size: 0.72rem;
    }

    .field-help {
      max-width: 24ch;
      color: var(--foreground-soft);
      font-size: 0.63rem;
      line-height: 1.35;
      text-wrap: pretty;
    }

    .number-unit {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: baseline;
      gap: 0.5rem;
      padding-bottom: 0.35rem;
      border-bottom: 1px solid var(--foreground-soft);
    }

    .number-unit:focus-within { border-color: var(--brand-strong); }

    .number-unit input {
      min-width: 0;
      padding: 0;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--foreground);
      font-family: var(--font-mono);
      font-size: clamp(1.35rem, 2.5vw, 1.7rem);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.06em;
    }

    .number-unit span {
      color: var(--foreground-soft);
      font-family: var(--font-mono);
      font-size: 0.7rem;
    }

    .toggle-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 2rem;
      margin-top: 0.55rem;
      padding: 0.5rem 0;
      border-block: 1px solid var(--border);
    }

    .toggle-copy {
      display: grid;
      gap: 0.3rem;
    }

    .toggle-copy strong { font-size: 0.86rem; font-weight: 500; }
    .toggle-copy small { max-width: 48ch; color: var(--foreground-soft); font-size: 0.66rem; line-height: 1.4; }

    .switch { position: relative; display: block; cursor: pointer; }

    .switch input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
    }

    .switch-track {
      display: block;
      width: 3.25rem;
      height: 1.75rem;
      padding: 0.2rem;
      border: 1px solid var(--border);
      border-radius: 99rem;
      background: var(--muted);
      transition: border-color 180ms ease, background-color 180ms ease;
    }

    .switch-thumb {
      display: block;
      width: 1.25rem;
      height: 1.25rem;
      border-radius: 50%;
      background: var(--foreground-soft);
      transform: translateX(0);
      transition: transform 220ms var(--ease-out), background-color 180ms ease;
    }

    .switch input:checked + .switch-track { border-color: var(--brand-strong); background: var(--brand); }
    .switch input:checked + .switch-track .switch-thumb { background: var(--white); transform: translateX(1.45rem); }
    .switch input:focus-visible + .switch-track { outline: 2px solid var(--brand-strong); outline-offset: 4px; }

    .source-note {
      max-width: 60ch;
      margin: 0.6rem 0 0;
      color: var(--foreground-soft);
      font-size: 0.68rem;
      line-height: 1.55;
    }

    .source-note summary {
      width: max-content;
      max-width: 100%;
      cursor: pointer;
      list-style: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .source-note summary::-webkit-details-marker { display: none; }
    .source-note summary::before { content: "+ "; color: var(--brand-strong); }
    .source-note[open] summary::before { content: "− "; }

    .source-note p {
      max-width: 60ch;
      margin: 0.45rem 0 0;
    }

    .action-rail {
      position: fixed;
      z-index: 20;
      inset: auto 0 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      align-items: center;
      gap: 0.65rem;
      min-height: 5.25rem;
      padding: 0.75rem max(1.5rem, calc((100vw - 84rem) / 2)) max(0.75rem, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border);
      background: color-mix(in oklch, var(--background) 91%, transparent);
      backdrop-filter: blur(18px) saturate(1.15);
    }

    .action-context {
      min-width: 0;
      margin-right: 1rem;
    }

    .action-context strong,
    .action-context small {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .action-context strong { font-size: 0.79rem; font-weight: 500; }
    .action-context small { margin-top: 0.16rem; color: var(--foreground-soft); font-size: 0.67rem; }

    .button {
      min-height: 2.8rem;
      padding: 0.68rem 1rem;
      border: 1px solid var(--border);
      border-radius: 0.38rem;
      background: transparent;
      font-size: 0.76rem;
      font-weight: 500;
      cursor: pointer;
      transition: transform 150ms var(--ease-out), border-color 180ms ease, background-color 180ms ease, color 180ms ease;
    }

    .button.primary {
      min-width: 8rem;
      border-color: var(--foreground);
      background: var(--foreground);
      color: var(--white);
    }

    .button.preview { border-color: transparent; }
    .button:disabled { cursor: wait; opacity: 0.48; }
    .button:active:not(:disabled) { transform: scale(0.98); }

    .toast {
      position: fixed;
      z-index: 40;
      right: max(1.5rem, env(safe-area-inset-right));
      bottom: max(6.5rem, calc(env(safe-area-inset-bottom) + 6rem));
      max-width: min(26rem, calc(100vw - 3rem));
      padding: 0.9rem 1rem;
      border-radius: 0.4rem;
      background: var(--foreground);
      color: var(--white);
      font-size: 0.78rem;
      opacity: 0;
      transform: translateY(0.7rem);
      pointer-events: none;
      transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out);
    }

    .toast.visible { opacity: 1; transform: translateY(0); }
    .toast.error { background: var(--danger); }

    @media (min-width: 68.01rem) and (max-height: 60rem) {
      body { padding-bottom: max(5.5rem, calc(5.25rem + env(safe-area-inset-bottom))); }
      .status-rule { top: max(1.75rem, env(safe-area-inset-top)); }

      .masthead {
        padding-block: max(2.9rem, calc(env(safe-area-inset-top) + 2.15rem)) 1.25rem;
      }

      .page-heading { padding-block: 1.25rem 1rem; }
      .page-heading h1 { font-size: 1.55rem; }
      .section-heading { margin-bottom: 0.65rem; }
      .clock-visual { width: min(100%, 40rem); }
      .telemetry { width: min(100%, 40rem); }
      .settings-grid { padding-top: 0.7rem; }

      .asset-option {
        min-height: 3.25rem;
        padding-block: 0.25rem;
      }

      .asset-icon { width: 1.9rem; height: 1.9rem; }
      .asset-copy strong { font-size: 0.8rem; }
      .asset-copy small { font-size: 0.61rem; }

      .field {
        min-height: 5.55rem;
        padding: 0.55rem 0.7rem;
      }

      .field-copy { gap: 0.18rem; }
      .field-help { font-size: 0.62rem; line-height: 1.3; }
      .number-unit { padding-bottom: 0.2rem; }
      .number-unit input { font-size: 1.3rem; }

      .toggle-row {
        margin-top: 0.6rem;
        padding-block: 0.5rem;
      }

      .toggle-copy small { font-size: 0.65rem; }
      .source-note { margin-top: 0.45rem; }
    }

    @media (hover: hover) {
      .asset-option:hover { background: var(--muted); }
      .asset-option:hover .asset-copy strong { color: var(--brand-strong); }
      .asset-option:hover .asset-icon { filter: grayscale(0); transform: scale(1.04); }
      .button:hover:not(:disabled) { border-color: var(--foreground); }
      .button.primary:hover:not(:disabled) { border-color: var(--brand-strong); background: var(--brand-strong); }
    }

    @media (max-width: 68rem) {
      .settings-grid { grid-template-columns: 1fr; gap: 2rem; }
    }

    @media (max-width: 42rem) {
      .status-rule { top: max(1.5rem, env(safe-area-inset-top)); }
      .masthead { grid-template-columns: 1fr; gap: 1rem; padding-top: max(3.4rem, calc(env(safe-area-inset-top) + 2.6rem)); }
      .device-chip { min-width: 0; }
      .page-heading { display: grid; gap: 0.5rem; padding-block: 1.5rem; }
      .preview-heading { align-items: start; }
      .preview-meta { justify-content: flex-start; }
      .telemetry { grid-template-columns: repeat(2, 1fr); }
      .telemetry div:nth-child(3) { border-left: 0; }
      .telemetry div:nth-child(n + 3) { border-top: 1px solid var(--border); }
      .asset-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .asset-option:not(:nth-child(3n)) { border-right: 0; }
      .asset-option:nth-child(odd) { border-right: 1px solid var(--border); }
      .asset-option { grid-template-columns: 1.55rem 2.15rem minmax(0, 1fr) auto; gap: 0.65rem; }
      .timing-list { grid-template-columns: 1fr; }
      .field { min-height: auto; padding-inline: 0; }
      .field + .field { border-top: 1px solid var(--border); border-left: 0; }
      .field-help { max-width: 42ch; }
      .action-rail { grid-template-columns: repeat(3, 1fr); padding-inline: 0.75rem; }
      .action-context { display: none; }
      .button { width: 100%; padding-inline: 0.55rem; }
      .button.primary { min-width: 0; }
    }

    @media (max-width: 30rem) {
      .shell { padding-inline: 1rem; }
      .status-rule { left: 1rem; }
      .legend-row { display: grid; }
      .asset-list { grid-template-columns: 1fr; }
      .asset-option:nth-child(odd) { border-right: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }

      *,
      *::before,
      *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }

    @keyframes enter {
      from { opacity: 0; transform: translateY(1.2rem); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">跳到控制区</a>
  <div class="status-rule" aria-hidden="true"><span id="status-progress" class="status-progress"></span></div>

  <div class="shell">
    <header class="masthead">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <p class="brand-name">Pixel Market <span>/ Ulanzi TC002</span></p>
      </div>
      <div class="device-chip" aria-live="polite">
        <span id="status-dot" class="status-dot"></span>
        <strong id="device-status">正在连接时钟…</strong>
        <small id="device-detail">等待设备信息…</small>
      </div>
    </header>

    <main id="main-content">
      <section class="page-heading" aria-labelledby="page-title">
        <h1 id="page-title">市场显示设置</h1>
        <p>选择资产、调整轮播节奏，并在推送到时钟前确认画面。</p>
      </section>

      <div class="workspace">
        <section class="preview-column" aria-labelledby="output-title">
          <div class="section-heading preview-heading">
            <h2 id="output-title">实时画面</h2>
            <div class="preview-meta">
              <span id="preview-format">52×16 / 等待数据</span>
              <span id="preview-assets">BTC / USD</span>
            </div>
          </div>
          <div class="clock-stage">
            <div class="clock-visual">
              <div class="pixel-screen" id="pixel-screen">
                <span class="preview-empty" id="preview-empty">正在生成像素画面…</span>
                <img id="preview-image" alt="时钟像素画面预览" hidden>
              </div>
              <img class="clock-frame" src="/assets/tc002-frame.png" alt="" aria-hidden="true">
            </div>
          </div>
          <dl class="telemetry">
            <div><dt>完整轮播</dt><dd id="loop-duration">15.0s</dd></div>
            <div><dt>实际更新</dt><dd id="effective-refresh">15.0s</dd></div>
            <div><dt>上次推送</dt><dd id="last-push">—</dd></div>
            <div><dt>行情状态</dt><dd id="market-status">等待</dd></div>
          </dl>
        </section>

        <div class="settings-grid">
          <section class="control-section" aria-labelledby="assets-title">
            <div class="section-heading">
              <h2 id="assets-title">选择市场</h2>
              <span class="section-index">01 / Assets</span>
            </div>

            <fieldset>
              <legend class="legend-row">
                <strong>资产队列</strong>
                <span>按当前顺序循环，可多选</span>
              </legend>
              <div id="asset-list" class="asset-list"></div>
            </fieldset>
          </section>

          <section class="control-section" aria-labelledby="timing-title">
            <div class="section-heading">
              <h2 id="timing-title">播放节奏</h2>
              <span class="section-index">02 / Timing</span>
            </div>

            <div class="timing-list">
              <label class="field" for="price-duration">
                <span class="field-copy">
                  <span class="field-label">价格页</span>
                  <span class="field-help">资产图标与当前价格的显示时间。</span>
                </span>
                <span class="number-unit">
                  <input id="price-duration" type="number" min="1" max="60" step="0.1" inputmode="decimal" value="12.5">
                  <span>秒</span>
                </span>
              </label>
              <label class="field" for="change-duration">
                <span class="field-copy">
                  <span class="field-label">涨跌页</span>
                  <span class="field-help">24H 或日参考涨跌的显示时间。</span>
                </span>
                <span class="number-unit">
                  <input id="change-duration" type="number" min="0.5" max="30" step="0.1" inputmode="decimal" value="2.5">
                  <span>秒</span>
                </span>
              </label>
              <label class="field" for="refresh-interval">
                <span class="field-copy">
                  <span class="field-label">行情刷新下限</span>
                  <span class="field-help">完整轮播结束前不会重置画面。</span>
                </span>
                <span class="number-unit">
                  <input id="refresh-interval" type="number" min="10" max="900" step="0.1" inputmode="decimal" value="15">
                  <span>秒</span>
                </span>
              </label>
            </div>

            <div class="toggle-row">
              <div class="toggle-copy">
                <strong>显示涨跌页</strong>
                <small>黄金缺少可靠的免费开盘字段，因此始终只显示价格。</small>
              </div>
              <label class="switch">
                <input id="show-change" type="checkbox" checked aria-label="显示涨跌页">
                <span class="switch-track"><span class="switch-thumb"></span></span>
              </label>
            </div>

            <details class="source-note" id="source-note">
              <summary>数据来源：Coinbase · Kraken · Gold API · Frankfurter</summary>
              <p>加密资产优先使用 Coinbase，失败时切换 Kraken；黄金使用 Gold API；USD/CNY 使用 Frankfurter 央行日参考汇率。</p>
            </details>
          </section>

        </div>
      </div>
    </main>
  </div>

  <footer class="action-rail">
    <div class="action-context">
      <strong id="draft-status">尚未修改</strong>
      <small>设置保存在本机，不上传账户或密钥</small>
    </div>
    <button class="button preview" id="preview-button" type="button">更新预览</button>
    <button class="button" id="save-button" type="button">仅保存</button>
    <button class="button primary" id="push-button" type="button">保存并推送</button>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script type="module">
    const ui = {
      assetList: document.querySelector('#asset-list'),
      priceDuration: document.querySelector('#price-duration'),
      changeDuration: document.querySelector('#change-duration'),
      refreshInterval: document.querySelector('#refresh-interval'),
      showChange: document.querySelector('#show-change'),
      previewImage: document.querySelector('#preview-image'),
      previewEmpty: document.querySelector('#preview-empty'),
      previewFormat: document.querySelector('#preview-format'),
      previewAssets: document.querySelector('#preview-assets'),
      loopDuration: document.querySelector('#loop-duration'),
      effectiveRefresh: document.querySelector('#effective-refresh'),
      lastPush: document.querySelector('#last-push'),
      marketStatus: document.querySelector('#market-status'),
      statusDot: document.querySelector('#status-dot'),
      statusProgress: document.querySelector('#status-progress'),
      deviceStatus: document.querySelector('#device-status'),
      deviceDetail: document.querySelector('#device-detail'),
      draftStatus: document.querySelector('#draft-status'),
      previewButton: document.querySelector('#preview-button'),
      saveButton: document.querySelector('#save-button'),
      pushButton: document.querySelector('#push-button'),
      toast: document.querySelector('#toast'),
    };

    let presets = [];
    let savedSettings;
    let previewUrl;
    let previewTimer;
    let toastTimer;

    const errorTranslations = {
      'settings must be an object': '设置格式无效',
      'select at least one asset': '请至少选择一个资产',
      'settings contain an unknown asset': '设置中包含未知资产',
      'each asset can only be selected once': '同一资产只能选择一次',
      'showChange must be true or false': '涨跌页开关格式无效',
      'request origin is invalid': '请求来源无效',
      'cross-origin changes are not allowed': '不允许跨来源修改设置',
      'request body is too large': '请求内容过大',
      'Content-Type must be application/json': '请求必须使用 JSON 格式',
      'request body must contain valid JSON': '请求内容不是有效 JSON',
      'saved settings contain invalid JSON': '已保存的设置文件不是有效 JSON',
      'not found': '请求的控制接口不存在',
    };

    function localizeErrorMessage(message) {
      const durationLabels = {
        priceDurationMs: '价格页时间',
        changeDurationMs: '涨跌页时间',
        refreshIntervalMs: '刷新间隔',
      };
      for (const [field, label] of Object.entries(durationLabels)) {
        if (message.startsWith(field + ' must be')) {
          return label + '超出允许范围或格式不正确';
        }
      }
      return errorTranslations[message] || message;
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
      if (!response.ok) {
        let message = '请求失败';
        try { message = (await response.json()).error || message; } catch {}
        throw new Error(localizeErrorMessage(message));
      }
      return response;
    }

    function seconds(milliseconds) {
      return (milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 1) + 's';
    }

    function selectedAssetIds() {
      return [...ui.assetList.querySelectorAll('input[type="checkbox"]:checked')]
        .map((input) => input.value);
    }

    function collectSettings() {
      const assets = selectedAssetIds();
      if (!assets.length) throw new Error('请至少选择一个资产');
      const toMilliseconds = (input, label) => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) throw new Error(label + '需要填写数字');
        return Math.round(value * 1000 / 100) * 100;
      };
      return {
        assets,
        priceDurationMs: toMilliseconds(ui.priceDuration, '价格页时间'),
        changeDurationMs: toMilliseconds(ui.changeDuration, '涨跌页时间'),
        refreshIntervalMs: toMilliseconds(ui.refreshInterval, '刷新间隔'),
        showChange: ui.showChange.checked,
      };
    }

    function computeLoopDuration(settings) {
      const changeCount = settings.showChange
        ? settings.assets.filter((id) => presets.find((preset) => preset.id === id)?.changePeriod).length
        : 0;
      return settings.assets.length * settings.priceDurationMs
        + changeCount * settings.changeDurationMs;
    }

    function updateDraftMetrics() {
      try {
        const draft = collectSettings();
        const loop = computeLoopDuration(draft);
        ui.loopDuration.textContent = seconds(loop);
        ui.effectiveRefresh.textContent = seconds(Math.max(loop, draft.refreshIntervalMs));
        ui.previewAssets.textContent = draft.assets
          .map((id) => presets.find((preset) => preset.id === id)?.pair || id)
          .join('  ·  ');
        ui.draftStatus.textContent = savedSettings && JSON.stringify(draft) === JSON.stringify(savedSettings)
          ? '设置已保存'
          : '有尚未保存的修改';
      } catch (error) {
        ui.draftStatus.textContent = error.message;
      }
    }

    function createAssetOption(preset, index) {
      const label = document.createElement('label');
      label.className = 'asset-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = preset.id;
      const order = document.createElement('span');
      order.className = 'asset-index';
      order.textContent = String(index + 1).padStart(2, '0');
      const icon = document.createElement('img');
      icon.className = 'asset-icon';
      icon.src = preset.iconUrl;
      icon.alt = '';
      const copy = document.createElement('span');
      copy.className = 'asset-copy';
      const title = document.createElement('strong');
      title.textContent = preset.pair;
      const source = document.createElement('small');
      source.textContent = preset.sourceLabel;
      copy.append(title, source);
      const check = document.createElement('span');
      check.className = 'asset-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      label.append(input, order, icon, copy, check);
      return label;
    }

    function applySettings(settings) {
      savedSettings = structuredClone(settings);
      for (const input of ui.assetList.querySelectorAll('input[type="checkbox"]')) {
        input.checked = settings.assets.includes(input.value);
      }
      ui.priceDuration.value = settings.priceDurationMs / 1000;
      ui.changeDuration.value = settings.changeDurationMs / 1000;
      ui.refreshInterval.value = settings.refreshIntervalMs / 1000;
      ui.showChange.checked = settings.showChange;
      updateDraftMetrics();
    }

    function showToast(message, error = false) {
      clearTimeout(toastTimer);
      ui.toast.textContent = message;
      ui.toast.classList.toggle('error', error);
      ui.toast.classList.add('visible');
      toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 3200);
    }

    function setBusy(button, busy, busyLabel) {
      if (busy) {
        button.dataset.label = button.textContent;
        button.textContent = busyLabel;
      } else if (button.dataset.label) {
        button.textContent = button.dataset.label;
      }
      button.disabled = busy;
    }

    async function refreshPreview() {
      let draft;
      try { draft = collectSettings(); }
      catch (error) { showToast(error.message, true); return; }
      setBusy(ui.previewButton, true, '生成中…');
      ui.previewEmpty.textContent = '正在获取行情并绘制…';
      try {
        const response = await fetch('/api/preview', {
          method: 'POST',
          headers: { Accept: 'image/*', 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        if (!response.ok) {
          const body = await response.json();
          throw new Error(body.error || '无法生成预览');
        }
        const blob = await response.blob();
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(blob);
        ui.previewImage.src = previewUrl;
        ui.previewImage.hidden = false;
        ui.previewEmpty.hidden = true;
        ui.previewFormat.textContent = '52×16 / ' + (blob.type === 'image/gif' ? 'ANIMATED GIF' : 'STATIC PNG');
      } catch (error) {
        ui.previewImage.hidden = true;
        ui.previewEmpty.hidden = false;
        ui.previewEmpty.textContent = '预览不可用';
        showToast(error.message, true);
      } finally {
        setBusy(ui.previewButton, false);
      }
    }

    function schedulePreview() {
      clearTimeout(previewTimer);
      updateDraftMetrics();
      previewTimer = setTimeout(refreshPreview, 420);
    }

    async function save(pushAfterSave) {
      let draft;
      try { draft = collectSettings(); }
      catch (error) { showToast(error.message, true); return; }
      const button = pushAfterSave ? ui.pushButton : ui.saveButton;
      setBusy(button, true, pushAfterSave ? '正在推送…' : '正在保存…');
      try {
        const response = await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify(draft),
        });
        savedSettings = (await response.json()).settings;
        if (pushAfterSave) {
          await api('/api/push', { method: 'POST' });
          showToast('完成：新画面已推送到时钟');
        } else {
          showToast('设置已保存，下一轮自动生效');
        }
        updateDraftMetrics();
        await Promise.all([refreshState(), refreshPreview()]);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        setBusy(button, false);
      }
    }

    async function refreshState() {
      try {
        const response = await api('/api/state');
        const state = await response.json();
        const status = state.healthy ? (state.degraded ? 'degraded' : 'healthy') : 'offline';
        ui.statusDot.className = 'status-dot ' + status;
        ui.statusProgress.className = 'status-progress ' + status;
        ui.deviceStatus.textContent = state.healthy
          ? (state.degraded ? '时钟在线 · 部分行情降级' : '时钟在线 · 正常播放')
          : '等待时钟推送';
        ui.deviceDetail.textContent = state.deviceVersions
          ? 'MCU ' + (state.deviceVersions.mcu || '—') + ' · APP ' + (state.deviceVersions.app || '—')
          : '本机控制台 127.0.0.1';
        ui.lastPush.textContent = state.lastPushAt
          ? new Date(state.lastPushAt).toLocaleTimeString('zh-CN', { hour12: false })
          : '—';
        const available = state.assets?.length || 0;
        const failed = Object.keys(state.assetErrors || {}).length;
        ui.marketStatus.textContent = failed ? available + ' 正常 / ' + failed + ' 异常' : available + ' / ' + state.settings.assets.length + ' 正常';
      } catch {
        ui.statusDot.className = 'status-dot offline';
        ui.statusProgress.className = 'status-progress offline';
        ui.deviceStatus.textContent = '控制服务不可用';
      }
    }

    async function boot() {
      try {
        const [presetResponse, settingsResponse] = await Promise.all([
          api('/api/presets'),
          api('/api/settings'),
        ]);
        presets = (await presetResponse.json()).presets;
        const settings = (await settingsResponse.json()).settings;
        presets.forEach((preset, index) => ui.assetList.append(createAssetOption(preset, index)));
        applySettings(settings);
        ui.assetList.addEventListener('change', schedulePreview);
        [ui.priceDuration, ui.changeDuration, ui.refreshInterval, ui.showChange]
          .forEach((input) => input.addEventListener('input', schedulePreview));
        ui.previewButton.addEventListener('click', refreshPreview);
        ui.saveButton.addEventListener('click', () => save(false));
        ui.pushButton.addEventListener('click', () => save(true));
        await Promise.all([refreshState(), refreshPreview()]);
        setInterval(refreshState, 10_000);
      } catch (error) {
        showToast('控制台启动失败：' + error.message, true);
        ui.previewEmpty.textContent = '控制服务不可用';
      }
    }

    boot();
  </script>
</body>
</html>`;
}
