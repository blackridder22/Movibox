# Source discovery diagnostics repair

## Observed failure

Read-only native database inspection found TorBox configured, Cinemeta as the only enabled add-on, zero acquisition jobs, and no source-search log entries. Cinemeta successfully supplies catalog and episode metadata but has no stream resource. The original source search skipped it and returned an empty array without explaining the configuration gap. Series metadata and source candidates were also presented too close to download readiness.

## Changed behavior

- Source search returns a report: configuration missing, provider error, no usable matches, or candidates found. Each report has an ID and persistent start/provider/filter/cache/summary logs.
- Episode titles accept both standard `title` and Cinemeta `name` fields; the live Cinemeta response used `name`, which previously fell back to “Episode”.
- Movie details offer source setup and search logs alongside the result. Real audio, size, and availability replace hardcoded English/MKV/ready labels.
- Series review shows progress, pack candidates versus individual fallbacks, filename evidence, and unverified files. Individual mode no longer silently selects a pack. Missing configuration stops repeated episode requests and leaves queueing disabled.
- TorBox cache checks request file lists. Episode names are matched independently of provider file-list ordering; ambiguous, missing, or oversized files are blocked. Cache presence alone does not count as file verification. Pack aggregate size is not treated as per-episode size; the selected file is still limited before transfer.
- Application and per-search logs refresh while open, show fetch errors, and can be copied. Scheduler failures retain their cause instead of an unexplained failure count.
- Add-on resource URL construction preserves query parameters and encoded configuration paths. Source reports and logs exclude capability URLs and response bodies.

## Automated verification

- Scoped `pnpm run check`: passed; no warnings or lint/type errors in changed UI files.
- `pnpm run typecheck`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- Native suite: 33 passed. Covers metadata-only setup, persisted/request-scoped logs, provider HTTP failure, malformed source entries, quality rejection, private URL redaction, query-preserving resource requests, and correct/wrong/ambiguous cached episode files.
- Node suite: 80 passed, 2 existing failures in untouched `tests/startup-loader.test.ts` (legacy StartupLoader assumptions about `src/main.tsx`). Not changed by this repair.
- Build command: `pnpm tauri:build:linux-system`. Despite its name, running this on the current macOS host produces a macOS app and DMG, not a Linux executable. Existing large legacy bundle warnings remain.

## Live verification

Verified in the native desktop app through its real Rust API:

- Movie details displayed “Download sources not configured”, the Cinemeta/TorBox distinction, an Add download sources action, and a disabled Download now action.
- View search logs opened a native-backed dialog showing the search start, Cinemeta capability skip, and final configuration warning for that search.
- Reacher season-pack review marked all eight selected episodes “Setup needed” and disabled Queue 0 matched episodes. No file or pack was falsely marked ready.
- Saved preferences were byte-for-byte unchanged after UI QA. The native database still had zero acquisition jobs and the user's existing monitoring rule. Source-search events were persisted instead of disappearing.

Evidence: `movie-source-native.jpg`, `source-logs-native.jpg`, `source-logs-native.txt`, and `source-review-native.txt` beside this report.

The final package also includes the episode-name mapping correction and neutral colors for unverified sources. A repeated final native capture failed with ScreenCaptureKit -3811; those last presentation changes and the individual-mode selector were not visually reverified. The final binary launched and the complete build exited successfully. The screenshot evidence above comes from the preceding build with the same source-report and logging flow.

No real acquisition or provider mutation was started. Fixtures exercise source and file-matching logic; they do not prove a live TorBox transfer. A compatible download-source add-on or future indexer integration is still needed before acquisition can be verified. Prowlarr/Sonarr integration is not implemented by this repair.
