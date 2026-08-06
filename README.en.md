# Ulanzi TC002 Pixel Market

[简体中文](README.md) | English

A configurable multi-asset pixel market dashboard maintained by zerah and powered by Bun. It fetches quotes from public, keyless data sources, renders native 52×16 pixel GIFs, and pushes them through the official TC002 Custom App HTTP API. The service supports a native macOS LaunchAgent and Docker Compose deployment.

## Local control panel

After the service starts, open:

```text
http://127.0.0.1:43820/
```

The control panel lets you:

- Select any combination of BTC, ETH, BNB, SOL, gold, and USD/CNY in a fixed rotation order.
- Configure the price-page duration, change-page duration, and minimum market refresh interval.
- Enable or disable change pages and inspect a live preview matching the physical 52×16 display.
- Save settings only, or use "Save and push" to update the clock immediately.
- Inspect device versions, the last push time, data sources, and degraded-source status.

![Ulanzi TC002 pixel market control panel](docs/images/tc002-control-panel.png)

Settings are persisted in the Git-ignored `.runtime/settings.json` file. The native macOS service listens only on `127.0.0.1`. The Docker container listens on all container interfaces for port forwarding, but Compose publishes the port only on the host's `127.0.0.1`. Neither deployment exposes the GUI or API to the LAN or public internet by default.

## Asset presets and data semantics

| Asset | Price source | Change period | Pixel icon |
| --- | --- | --- | --- |
| BTC/USD | Coinbase, with Kraken fallback | 24H | Bitcoin roundel |
| ETH/USD | Coinbase, with Kraken fallback | 24H | Ethereum diamond on a gray circle |
| BNB/USD | Coinbase, with Kraken fallback | 24H | White cube on a yellow circle |
| SOL/USD | Coinbase, with Kraken fallback | 24H | Solana tri-color bars |
| XAU/USD | Gold API | Not shown | Three angled gold-bar faces |
| USD/CNY | Frankfurter | 1D reference-rate change | Two-line USD / CNY mark |

The free gold endpoint does not provide a reliable 24-hour open field, so the program shows only its current reference price instead of inventing change data. USD/CNY is a central-bank daily reference rate aggregated by Frankfurter, not a tick-by-tick FX quote.

## Rotation and refresh behavior

Default settings:

- Price page: 12.5 seconds.
- Change page: 2.5 seconds.
- Minimum market refresh interval: 15 seconds.
- BTC/USD enabled by default.

Selecting more assets makes a complete rotation longer. The effective refresh interval is the greater of the configured minimum and the complete rotation duration. This prevents a new push from resetting the GIF before later assets have appeared.

Every background pixel is strict RGB `[0, 0, 0]`, which turns the corresponding LED fully off. Primary digits use two-pixel strokes and controlled brightness to reduce bloom through the TC002 faceplate.

## Development and direct execution

The project pins Bun 1.3.14 in `mise.toml`. With mise installed, run:

```bash
mise install
mise run test
mise run typecheck
mise run build
```

You can also use the declared Bun version directly:

```bash
bun install
bun test
bun run typecheck
bun run build
CLOCK_HOST=192.168.1.50 bun start
```

`bun run build` writes the service, status command, and preview command bundles to the Git-ignored `dist/` directory.

Generate the current GIF, frame previews, and six-icon overview:

```bash
bun run preview
```

Inspect the running service:

```bash
bun run status
```

## Native macOS installation

The installer installs dependencies, builds the bundles, writes `.runtime/service.env` with owner-only permissions, and installs and starts a LaunchAgent. When mise is available, the script uses the Bun version pinned by `mise.toml`. Without mise, it accepts only Bun 1.3.14 so the background service is not built with an unverified runtime.

```bash
bash scripts/install.sh
```

The script prompts for the TC002 LAN IP address or hostname. In a non-interactive installation, supply it explicitly through `--host` or `CLOCK_HOST`:

```bash
bash scripts/install.sh --host 192.168.1.50
```

If the TC002 must be reached through an unauthenticated local HTTP proxy:

```bash
bash scripts/install.sh \
  --host 192.168.1.50 \
  --proxy http://127.0.0.1:6152
```

The service label is `com.zerah.ulanzi-market-clock`. It starts at login and restarts after an unexpected exit. Logs are stored in `.runtime/service.log` and `.runtime/service.error.log`.

```bash
launchctl print gui/$(id -u)/com.zerah.ulanzi-market-clock
bash scripts/uninstall.sh
```

## Docker Compose installation

The Docker deployment does not require Bun on the host. The installer builds an image using the pinned Bun version with a non-root user and read-only root filesystem, writes `.runtime/docker.env`, and starts the Compose service:

```bash
bash scripts/install-docker.sh
```

The Docker installer also prompts for the TC002 address. For non-interactive deployment:

```bash
bash scripts/install-docker.sh --host 192.168.1.50
```

The Docker host must be able to route directly to that TC002 address. A public VPS cannot automatically discover or reach a `192.168.x.x` clock behind a home NAT. Establish a VPN or routed private network first. A DHCP reservation for the TC002 and a numeric LAN address are recommended.

Compose publishes the control panel at `http://127.0.0.1:43820/`; it is not exposed publicly by default. Inspect status and logs with:

```bash
docker compose --env-file .runtime/docker.env ps
docker compose --env-file .runtime/docker.env logs -f market-clock
```

Run `scripts/install-docker.sh` again to reinstall or change the clock address. To remove the container and Compose network:

```bash
bash scripts/uninstall-docker.sh
```

The uninstall script preserves the local image, `.runtime/docker.env`, and `.runtime/settings.json`. The native macOS service and Docker use the same control-panel port by default and should not run at the same time.

Shared configuration:

| Name | Default | Description |
| --- | --- | --- |
| `CLOCK_HOST` | None; required | TC002 address without `http://` or a port; installers prompt when omitted |
| `APP_NAME` | `btc` | TC002 Custom App name |
| `REQUEST_TIMEOUT_MS` | `5000` | Market and device request timeout |
| `SOURCE_STALE_MS` | `120000` | Maximum age of reusable cached market data |
| `DISPLAY_DURATION_SECONDS` | `90` | Minimum Custom App lifetime; extended automatically for long rotations |
| `HEALTH_PORT` | `43820` | Host port for the GUI, control API, and health endpoint |

`CLOCK_HTTP_PROXY` applies only to native macOS access to the TC002. Docker reaches the LAN device directly by default. The deployment method manages `CONTROL_HOST`: macOS fixes it to `127.0.0.1`; Docker fixes it to `0.0.0.0` inside the container while Compose restricts the host-side bind address.

## Local control API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/presets` | Six asset presets and source descriptions |
| `GET` / `PUT` | `/api/settings` | Read or save display settings |
| `GET` | `/api/state` | Device, market, and push state |
| `POST` | `/api/preview` | Render draft settings without saving or pushing |
| `POST` | `/api/push` | Push the saved settings immediately |
| `GET` | `/health` | Health data consumed by the status command |

Write operations require JSON and reject browser requests from a different Origin. The program needs no exchange API keys, reads no wallet or account data, and does not flash or modify TC002 firmware.
