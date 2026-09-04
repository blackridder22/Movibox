# Subtitles, persistent searches, and catalog verification

Verified locally on macOS ARM64, 2026-08-30.

## Implemented

- Subtitle-only repair from completed download details, bundle headers, and Library entries. Existing videos and subtitle sidecars are preserved.
- Monitoring subtitle mode: global, off, or up to four custom languages. Policies are frozen when acquisition is approved, including delayed cloud preparation.
- Bundle completeness separates saved videos from subtitles per language.
- Manual source searches live in Rust/SQLite. Navigation does not cancel them; explicit Cancel does. Interrupted work is requeued on restart. Saved results reopen for review without approving a download.
- Optional TMDB catalog, personal credential-store token, language selection, pagination, IMDb mapping, original-title aliases, and Stremio catalog fallback.
- Optional accent cursor within the webview; text input cursors remain standard.
- Open in IINA uses the installed macOS player. No embedded or bundled IINA.

## Automated checks

- Scoped `pnpm run check`: no new warnings, lint errors, or type errors.
- `pnpm run typecheck` and `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- Rust suite: 63 passed. Includes redirect credential boundaries, bounded subtitle fallback, exact video preservation, policy freezing, search deduplication/cancellation/restart storage, and TMDB episode/IMDb mapping through a loopback server.
- Frontend suite: 80 passed, 2 existing failures in `tests/startup-loader.test.ts`. Those tests inspect the legacy startup entry point; the untouched baseline already failed them.
- Python fixture syntax checked.

## Desktop and visual verification

Used the isolated `app.movibox.providerqa` profile and locally generated video files, not production downloads or provider credentials.

1. With global automatic subtitles off, clicked Find subtitles in a completed episode and selected French. The worker followed the local HTTP 301 and saved a `.fr.srt`. The native UI showed French available and bundle completeness `French subtitles 1/2`.
2. The 3,442,896-byte video retained SHA-256 `bf424170a0f203b202925e225d3e1cb8e833dc5b9e81a7191ff6ab0655a0ecf0`. No video transfer occurred. The fixture tests language routing and sidecar delivery; it does not establish real subtitle translation or playback timing.
3. Clicked Open in IINA. The running IINA process held the exact test video open, confirmed through its local file handle. Playback synchronization was not assessed.
4. Reopened a saved season review from Downloads after relaunch. With a deliberately delayed source, clicked Back while searching and saw “Search continues in the background.” The same search completed; the video queue stayed at the original two jobs. Restart recovery for interrupted jobs is additionally covered by the Rust persistence test.
5. Inspected Catalog settings and connection dialog, monitoring custom-language controls, Library episode actions, subtitle repair dialog, and native bundle summary. Checked rendered spacing at the available 1280px browser and 1227px native widths. Corrected Library action-column alignment for missing episodes. The custom-cursor toggle produced the accent cursor while the text input retained `cursor: text`.

## Build and remaining boundaries

- Ran the required `pnpm tauri:build:linux-system` command with a temporary local signing override. Because the host is macOS, it generated a macOS `.app` and ARM64 `.dmg`; this does not prove a Linux build.
- macOS application is ad-hoc signed; no notarization credentials were available. Existing legacy Vite large-chunk warnings remain.
- Production provider accounts and files were not changed. Live OpenSubtitles and TMDB account requests were not exercised during this implementation. TMDB requires the user's Read Access Token.
- Embedded subtitle inspection needs `ffprobe` available to the desktop process; otherwise external subtitle discovery proceeds. MKV files are not rewritten.
- Background work requires the desktop process to remain running. Persistent searches resume after restart; they do not execute while the app or computer is off.

## Final artifact

- Installer: `src-tauri/target/release/bundle/dmg/MoviBox_0.9.21_aarch64.dmg`
- SHA-256: `2537b7e688d2bf330d731e7225c2827fe7923fc051005c7d4d90676938f5f06b`
- `codesign --verify --deep --strict`: passed.
- `hdiutil verify`: passed.
- Built locally; not installed over the production app or published.
