# Native backend implementation and verification

Movie Box now uses the Tauri/Rust service in the desktop app. The browser at localhost:1420 remains an isolated UI preview: it does not have native filesystem access, credentials, or workers.

## Implemented

- Live Stremio-compatible catalog search and metadata, with Cinemeta installed by default. HTTPS add-on manifests are validated before installation. Stream providers remain user-configured.
- Native source discovery using Harbor's existing parser, with quality/audio/size checks, TorBox cache preference, and exact episode selection within season packs. Ambiguous pack files fail rather than download an arbitrary episode.
- TorBox account validation, torrent preparation/polling, file selection and fresh download links. Keys are stored in the operating system credential store. Private capability URLs remain in the native database; snapshots and new UI events do not expose them.
- A durable SQLite queue with pause/resume/cancel/retry, configurable concurrency, queue priority, partial-file recovery, signed-link refresh, bandwidth limits, download windows, storage reserve and maximum file size.
- HTTP range validation, cancellable requests, truncated-response rejection, partial-file writes and atomic completion. Canceled/paused transfers keep their concurrency slot until their writer stops.
- Native cron rules with IANA timezones, missed-check handling, released-episode filtering, duplicate checks and check history. Rules remain active while transfers are unfinished. A webview is not needed to run checks.
- Library entries from completed transfers, existing-file checks, file-manager/player handoffs, relinking, and explicit file deletion.
- Persistent bounded logs, redacted diagnostic exports, notification delivery and launch-at-login registration. The tray exposes pause/resume and settings.

## Runtime boundaries

Closing the window keeps workers alive when the background preference is enabled. Quit and system sleep stop work. Startup recovers unfinished jobs; missed cron checks run once per rule when catch-up is enabled. This is an application service, not an independently installed system daemon.

Data lives in the OS application-data directory under `app.movibox/movibox.sqlite3`. Native preferences never import browser demo jobs or demo credentials. On macOS/Linux the data directory is restricted to its owner. Configured add-on URLs may contain capability tokens and are kept in that private database. The TorBox API key is kept separately in Keychain/Credential Manager/Secret Service.

## Verification — 2026-08-29

- Scoped `pnpm run check`: passed without lint/type warnings.
- `pnpm run typecheck`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed on macOS.
- Rust tests: 28 passed. New tests exercise real local HTTP range responses, resume, incorrect 416/range responses, truncation, cancellation, transfer windows, atomic concurrency limits, stale-worker guards, recovery after an atomic rename, cron/DST semantics, season-pack matching, and catalog → metadata → parsed sources → SQLite reopen.
- Node suite: 80 passed, 2 pre-existing failures in `tests/startup-loader.test.ts`. Both expect the obsolete inline startup implementation in the untouched `src/main.tsx`. Reproduced against the pre-task native source in an isolated baseline copy. Updated the two assertions affected by the new native scheduler and cancellation implementation; did not refactor unrelated startup code.
- Real macOS desktop UI: first-run setup and browse-only entry; live Cinemeta search for Interstellar; title metadata; honest unavailable-source state; monitoring rule creation, native Run now, persisted result/history, and rule deletion; actual disk-space information; native diagnostic status and persistent logs. Temporary verification rule removed; no real movie download started. The final post-hardening bundle built successfully, but a final desktop replay was blocked by macOS ScreenCaptureKit error -3811 on two attempts. Earlier desktop checks above passed on the preceding bundle.
- Full bundle command: `pnpm tauri:build:linux-system`. Despite its name, on this macOS host it builds the macOS app and DMG. It does not verify a Linux executable. Existing frontend chunk-size advisory remains; no new Rust/compiler warnings.

## Not live-verified

TorBox account/transfer operations require the user's valid key and a stream add-on; neither was configured during this task. End-to-end TorBox transfer, real season-pack download, external-drive disconnect/reconnect, notification permission delivery, launch-at-login, Windows and Linux remain unverified. Automated transfer tests use synthetic local bytes, not media downloads.

Catalog paging/sorting/filtering currently operates on the batch returned by enabled add-ons (up to the first provider page). Metadata richness varies by add-on. Search is metadata discovery; Cinemeta alone does not supply downloadable streams. HLS/DASH manifests are excluded because the current engine downloads files, not segmented streams. Only TorBox and direct HTTP file sources are integrated.

Automatic app updates, a hosted issue-reporting destination, and an in-app external-player chooser are not configured. Files open in the OS default player; the library can reveal them for choosing another player. Existing visual design and motion are preserved; only the source retry action spacing was adjusted during live review.

## Build output

- `src-tauri/target/release/bundle/macos/MoviBox.app`
- `src-tauri/target/release/bundle/dmg/MoviBox_0.9.21_aarch64.dmg`

Open the desktop app, connect TorBox in Settings → Providers, install a compatible stream add-on under Sources & add-ons, and select the library destination under Storage. Use only sources you are authorized to download.
