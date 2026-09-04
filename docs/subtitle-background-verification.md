# Subtitle background work and manual rules

Verified on macOS ARM64, September 3, 2026. Version 0.9.21.

## Implemented

- A separate durable subtitle worker runs independently of navigation and cloud preparation. It wakes immediately when work is queued, honors provider limits, and recovers interrupted tasks after reopening the app. The app must remain running to process tasks.
- Downloads shows subtitle progress with a direct task drawer. Queue confirmations, season status, and monitoring rules link to the appropriate tasks.
- Each task explains its result: missing provider configuration, rejected credentials, provider failure, quota/cooldown, missing video, no results, or no safe match. Actions include retry, settings, locate video, and manual subtitle import when appropriate.
- Manual imports accept bounded UTF-8 SRT/VTT/ASS files and preserve existing subtitle and video files. Playback timing still needs review.
- Monitoring rules can opt into repairing subtitles for matching existing downloads. New downloads retain the rule's subtitle policy. Editing a rule can queue repair; merely pausing or resuming it cannot.
- New rules default to manual-only checks and no future episodes. Automatic checks reveal the existing schedule controls. Existing schedules are preserved; manual rules are excluded from the scheduler, including after restart or backup restore.
- Queue deduplication, provider cooldown enforcement, bounded retries, revision checks, and a restore guard protect against duplicate work and stale task updates.

## Verification

| Check                                                        | Result                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed frontend files: `pnpm run check`                     | Passed; no formatting, lint, or type errors                                                                                                    |
| `pnpm run typecheck`                                         | Passed                                                                                                                                         |
| Frontend test suite                                          | 103 passed                                                                                                                                     |
| `cargo check --manifest-path src-tauri/Cargo.toml --offline` | Passed                                                                                                                                         |
| Native library test suite                                    | 87 passed; 3 opt-in live-provider tests skipped                                                                                                |
| Browser UI                                                   | Dark/light subtitle drawer, progress, navigation, Escape dismissal, existing rule preservation, manual toggle, and new-rule defaults inspected |
| Browser error/warning log                                    | Empty after visual checks                                                                                                                      |
| Optimized release build                                      | Passed; macOS ARM64 app and DMG                                                                                                                |
| App signature verification                                   | `codesign --verify --deep --strict` passed; ad-hoc signature                                                                                   |
| Disk image verification                                      | `hdiutil verify` passed                                                                                                                        |

Native fixtures exercise restart recovery, concurrent enqueue deduplication, cooldown refusal, precise failure reasons, French subtitle retrieval, safe imports, selected-episode repair scope, manual scheduling, and backup restoration. UI inspection used temporary in-memory fixtures; no real rule or provider account was changed. The temporary QA screen was removed before packaging.

## Existing issues and verification limits

- Repository-wide `pnpm run check` still reports formatting issues in 527 untouched files. The changed frontend files pass separately; unrelated files were not reformatted.
- The frontend build retains large legacy chunk warnings. This task did not redesign legacy bundling.
- The required `pnpm tauri:build:linux-system --config src-tauri/tauri.release.generated.json --ci` command ran successfully. On this macOS host it builds macOS artifacts, not a Linux executable. Windows/Linux execution remains unverified.
- This release is ad-hoc signed, not notarized. It was built and inspected, not installed or launched against the user's live data.
- Live TorBox/Real-Debrid/OpenSubtitles account tests and real subtitle timing were not performed. Local provider fixtures are not proof of live account behavior.

## Release artifact

`src-tauri/target/release/bundle/dmg/MoviBox_0.9.21_aarch64.dmg`

SHA-256: `0660ba8db673c586f064c2b0fac51e67650cc070427a3b01b66bffba02c9d91b`
