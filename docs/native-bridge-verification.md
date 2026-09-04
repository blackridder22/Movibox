# Native bridge verification — 2026-08-30

## Checks

- Scoped `pnpm run check --fix`: passed, no lint/type warnings in changed TypeScript files.
- `pnpm run typecheck`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 46 passed.
- `pnpm test`: 80 passed, 2 existing legacy startup-loader assertions failed. They expect the old startup implementation in untouched `src/main.tsx`; the current entry point dispatches to MovieBox or the legacy client. No unrelated startup changes were made.
- `pnpm tauri:build:linux-system`: completed on macOS, producing the app and arm64 DMG. Existing large-bundle Vite warning remains. No Linux build or Linux runtime verification was performed.

## Native desktop exercise

An isolated build used identifier `app.movibox.bridgeqa`, its own SQLite database, and `/tmp/movibox-bridge-qa/downloads`. Production preferences, provider credentials, downloads, and rules were not modified.

1. Connected a keyless local Torznab fixture through Settings → Sources & add-ons → Add indexer. Capability validation and persistence succeeded.
2. Seeded a loopback Stremio fixture into the QA database. This bypassed only fixture setup: normal add-on installation requires HTTPS. Search, review, queue, pause, resume, and scheduling were driven through the actual desktop UI and native backend.
3. Requested three episodes: two had direct links to locally generated video, one intentionally had no source. Review showed two ready and one missing.
4. Queued one season group containing exactly two file jobs. The third episode was never enqueued.
5. Collapsed the group, paused both files with Pause bundle, quit and reopened the QA app, and verified that both remained paused at approximately 49%.
6. Resumed the bundle. The fixture received HTTP 206 range requests for both files.
7. Both completed files contained 3,442,896 bytes and matched SHA-256 `bf424170a0f203b202925e225d3e1cb8e833dc5b9e81a7191ff6ab0655a0ecf0`. No `.part` files remained.
8. Discover showed two episodes in the library and selected only the one missing episode.
9. Created a QA monitoring rule and used Run now. The shared planner marked episodes 1 and 2 existing and episode 3 missing. Result: `0 queued · 0 downloading · 1 waiting for a source · 0 failed`; queue count stayed at two.
10. Expanded long review diagnostics in the rebuilt native UI. The dialog body scrolls independently and footer actions remain visible.

The QA app and local fixture server were stopped after testing. Evidence is retained under `/tmp/movibox-bridge-qa/`, including `file-verification.json`, `scheduler-verification.json`, and screenshots. The early QA jobs used `.mkv` local names for direct MP4 links; source-extension preservation was corrected before the final build. Their bytes were unchanged.

## Limits

The native UI transfer exercise used Stremio direct links to owned local media. Native Torznab pack planning, real v1 torrent metadata parsing, TorBox preparation concurrency/restart behavior, uncertain submission handling, and atomic bundle commits were tested with controlled HTTP/SQLite fixtures. No live TorBox account acquisition was submitted. Actual audio tracks were not probed, and no claim is made about language accuracy beyond release metadata.

The available UI automation intermittently returned stale native-menu accessibility state. Persisted pause/resume results and HTTP range requests were independently checked. Physical trackpad behavior was not part of this bridge verification.

## Artifacts

- `src-tauri/target/release/bundle/macos/MoviBox.app`
- `src-tauri/target/release/bundle/dmg/MoviBox_0.9.21_aarch64.dmg`
- Pre-change source backup: `/tmp/movibox-bridge-baseline-20260830-003524.tar.gz`
