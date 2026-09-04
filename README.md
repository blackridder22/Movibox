# MoviBox

MoviBox is a fast, download-only desktop companion for the Stremio ecosystem. It keeps Harbor's discovery, collections, metadata, addon catalog, stream ranking, debrid integrations, and TorBox support, then turns the source picker into a durable background acquisition queue.

There is deliberately no media player in MoviBox. The app cannot watch or stream a title. Completed downloads are ordinary files that you can reveal in Finder and open with VLC, IINA, Infuse, Plex, Jellyfin, or any other tool you choose.

## What it does

- Browse movies, series, anime, people, awards, catalogs, and Stremio collections.
- Search the same Stremio addons used by Harbor and preserve account addon order.
- Resolve sources through Real-Debrid, AllDebrid, Premiumize, Debrid-Link, TorBox, direct URLs, or the built-in torrent acquisition engine.
- Rank sources by resolution, release quality, cache state, language, size, seeders, and trust signals.
- Download one movie, one episode, selected seasons, multiple seasons, or every available season.
- Monitor a series and automatically acquire newly released episodes in the background.
- Resume partial files, retry failed jobs, cancel work, refresh expired source URLs, and persist the queue across restarts.
- Organize files by movie, series, season, and episode in a user-selected destination.
- Run in the macOS background after the main window closes.

## Product boundary

MoviBox is an acquisition manager, not a playback client:

```text
connect Stremio
      ↓
discover / search / collections
      ↓
addons + debrid + TorBox + torrent resolution
      ↓
persistent Rust download queue
      ↓
ordinary local media files
      ↓
external application chosen by the user
```

Player routes, libmpv, player overlays, casting, DVR, Live TV, Multiview, PiP, transcoding, Anime4K/SVP, Discord playback presence, and bundled ffmpeg/yt-dlp sidecars are not part of the MoviBox runtime.

## Architecture

MoviBox is built with Tauri 2, React, TypeScript, and Rust.

- `src/` contains discovery, Stremio integration, source ranking, automation UI, and the native command bridge.
- `src/lib/acquisition/` owns source selection and automation orchestration.
- `src/lib/download/` exposes the native queue as a React-friendly external store.
- `src-tauri/src/acquisition.rs` owns SQLite persistence, scheduling, retries, cancellation, resume support, and progress events.
- `src-tauri/src/download.rs` performs resumable HTTP file transfer.
- `src-tauri/src/torrent_engine.rs` resolves torrent sources for acquisition.
- `harbor-core/` is the inherited Rust stream parsing and ranking crate.

SQLite is the source of truth for jobs and automation rules. React renders native state; it does not own queue durability in local storage.

## Automation

Open a series, expand the download automation panel, and choose:

- all seasons or any combination of seasons;
- a quality profile such as Best available, Balanced, 1080p, 4K, or Efficient;
- whether the rule should keep checking for future episodes.

MoviBox checks release dates, skips episodes already queued or completed, resolves each missing episode through the normal addon/debrid pipeline, and adds it to the native queue. A one-time multi-season rule disables itself after its first scan; a future-episode rule remains active.

## Development

Requirements:

- Node.js and pnpm 11.9.0
- Rust and Cargo
- the platform prerequisites for Tauri 2

```bash
pnpm install
pnpm run dev
```

Validation gates:

```bash
pnpm run check
pnpm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml
pnpm run build
pnpm tauri:build:linux-system
```

To build a macOS application bundle:

```bash
pnpm tauri build --bundles app,dmg
```

## Privacy and legal use

MoviBox does not bundle content addons, host media, index media, or provide media sources. Addons, accounts, API keys, debrid services, and download destinations are configured by the user. Use MoviBox only for files you are legally permitted to acquire, and comply with the laws and terms that apply in your jurisdiction.

MoviBox is independent and is not affiliated with, endorsed by, or sponsored by Stremio Ltd. Stremio and all third-party service names are used only to identify compatible integrations.

## Upstream and license

MoviBox is a fork of [Harbor](https://github.com/harborstremio/harbor). The retained discovery and Stremio integration work builds on that project's architecture; the download-only native acquisition system is the defining MoviBox fork boundary.

Licensed under the [MIT License](LICENSE).
