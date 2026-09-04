# MoviBox native acquisition bridge

The bridge runs inside the existing Rust desktop backend. It needs no Sonarr/Radarr process. Stremio source add-ons remain supported. All bridge code is original; no Sonarr, Radarr, or Prowlarr implementation was copied.

## Connect sources

Settings → Sources & add-ons → Built-in search bridge → Add indexer.
Supply a Torznab API endpoint, a display name, and its optional API key. A direct compatible indexer works; Prowlarr is an optional aggregator. HTTPS is required except on localhost. Keys are stored in the OS credential store. The renderer receives the origin and capabilities, not keys or private URLs. Redirects are not followed when sending credentials.

The connector negotiates capabilities, prefers supported media IDs, and falls back to known title aliases. It searches up to three pages per title. Native search does not provide a built-in catalogue of torrent sites. A source must be connected before it can find releases.

## Season flow

1. Select a season or episodes and choose Season pack or Individual episodes.
2. Search checks native season releases first. Available file manifests establish episode coverage; Stremio episode queries fill uncovered episodes.
3. Review shows existing, ready, pending, and missing episodes. Sources failing language, quality, identity, season, or size constraints are rejected with reasons.
4. Prepare / check submits unresolved torrent candidates to TorBox and inspects the resulting file list. Cloud preparation can fetch the entire torrent. Recheck while metadata is pending. Only selected ready files are downloaded locally.
5. Queue persists a bundle and its file jobs in one SQLite transaction before any worker starts. Repeated submission of the same plan returns the existing group. A multi-episode file is downloaded once.
6. Downloads groups file jobs by season, with pause, resume, retry, cancellation, and individual file inspection. Completed files are retained. Unresolved episodes can be monitored separately.

Scheduled series checks use this same planner and queue. They retain release-date checks, scheduling windows, rule revision checks, and restart recovery. The desktop process must remain running for local background work; fully quitting or sleeping the computer does not create an always-on cloud scheduler.

## Evidence and safety

- A pack label alone does not establish coverage. Explicit SxxExx, multi-episode/range, NxNN, and Sxx NN filenames are recognized. Unknown/absolute numbering and conflicting encodes need another source.
- Media IDs allow localized release titles. Without IDs, conservative title/known-alias and year checks apply. Similar titles are not enough.
- Audio language is advertised release evidence. Subtitles and MULTI labels are not proof of the requested audio language. This version does not inspect actual audio tracks with ffprobe.
- Stremio direct links retain the add-on's episode-scoped claim. The review explicitly states that their file contents are not inspected. An identical opaque link is not downloaded twice for different episodes.
- Torrent file IDs are obtained from TorBox, not inferred from Stremio file indices. Reviewed filenames are checked again before requesting download URLs.
- Native indexers support v1 info-hashes/magnets and bounded v1 .torrent metadata downloads. Pure v2 torrents, redirects requiring credential forwarding, and oversized metainfo are not supported.
- A persistent per-hash preparation record plus a shared lock prevents duplicate submissions. After an uncertain creation response, the bridge reconciles the account rather than submitting again. If TorBox never exposes that submission, it remains a visible error instead of risking duplicate cloud work.
- Local success means a completed download and atomic file finalization. It does not claim that the advertised language or every media frame was inspected.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml --lib` covers pack coverage, missing episodes, duplicate encodes, multi-episode files, identity/language checks, a real HTTP Torznab fixture, concurrent/restarted preparation, uncertain submissions, atomic/idempotent queue persistence, and existing downloader range/cancel/recovery behavior.

`scripts/moviebox-bridge-fixture.py` serves generated owned media as a local Stremio source plus a Torznab capabilities endpoint. Use an isolated app identifier/database for native UI testing. The script makes no external requests.

Full build command: `pnpm tauri:build:linux-system`. The script name does not select a cross-compilation target: on macOS it produces macOS artifacts. Linux still requires a Linux build environment.
