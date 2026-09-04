# Provider workflow verification — 2026-08-30

Implementation behavior and limitations are documented in [Provider workflows](provider-workflows.md).

## Automated checks

- Scoped `pnpm run check` passed for the eight changed TypeScript/TSX files.
- `pnpm run typecheck` and `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- Rust tests: 56 passed, zero failed.
- Frontend tests: 80 passed; two existing failures in untouched `tests/startup-loader.test.ts` still expect the old startup entrypoint. They were not changed by this task.
- The updated Python bridge fixture passes syntax compilation.

Rust coverage includes bounded concurrency and per-origin serialization, shared response caching and cooldowns, Retry-After handling, TorBox queue/metadata/download transitions, capacity retry, Real-Debrid selection and per-file link mapping, account mismatch, archive rejection, persistent preparation recovery, rule edits and queue commit recovery, subtitle hashing, host restrictions, and sidecar preservation.

Logs: `/tmp/movibox-provider-rust-tests.log` and `/tmp/movibox-provider-tests.log`.

## Native desktop verification

An isolated macOS app using identifier `app.movibox.providerqa` and a separate SQLite database exercised the local bridge fixture. Production credentials and downloads were not used.

- Opened provider settings and the Real-Debrid connection dialog.
- Enabled subtitle jobs and searched the owned three-episode fixture.
- Reviewed two available episodes and one missing episode; queued only the two verified files as one bundle.
- Both video files completed at 3,442,896 bytes and matched the source SHA-256: `bf424170a0f203b202925e225d3e1cb8e833dc5b9e81a7191ff6ab0655a0ecf0`.
- Both Stremio subtitle jobs saved `.en.srt` sidecars; no partial download files remained.
- Download details displayed completion, transfer information, subtitle outcome, and activity.
- The isolated QA app and fixture server were stopped afterward.

Evidence: `/tmp/movibox-provider-qa/native-file-verification.json`, `native-download-details.txt`, and `fixture.log`.

## Layout and public discovery

Providers, Subtitles, and connection dialogs were inspected in the browser at 1280px. At the 960px minimum window width, provider controls stayed within the content area and the main view had no horizontal overflow. Evidence: `/tmp/movibox-provider-qa/providers-960.png`.

A single public Knaben request for a Debian Linux ISO returned HTTP 200 and the expected result fields. No result was submitted to a provider or downloaded. Evidence: `/tmp/movibox-provider-qa/public-search-check.json`.

## Packaging

The full `pnpm tauri:build:linux-system` script completed on macOS and produced the macOS app and ARM64 DMG. Despite the script name, this did not build or test a Linux binary.

A temporary build configuration disabled pnpm's conflicting automatic package-manager setup for the nested frontend build and set macOS `signingIdentity` to `-`. The final app passes `codesign --verify --deep --strict`, and its bundle identifier is `app.movibox`. The DMG passes `hdiutil verify` with a valid checksum.

Artifacts:

- `src-tauri/target/release/bundle/macos/MoviBox.app`
- `src-tauri/target/release/bundle/dmg/MoviBox_0.9.21_aarch64.dmg`

This is a locally ad-hoc-signed build, not a Developer ID signed or notarized release. No installed application was overwritten. The existing Vite large-chunk warning remains. Build log: `/tmp/movibox-provider-build.log`.

## Verification limits

- Real TorBox and Real-Debrid account acquisition was not exercised; controlled HTTP fixtures cover their workflows.
- OpenSubtitles credential login and live account quotas were not exercised. Native subtitle verification used the owned Stremio fixture.
- Subtitle matching and successful file saving do not prove playback synchronization.
- Embedded track detection requires `ffprobe` on the application's PATH; it is not bundled.
- Local transfers, monitoring, and subtitle jobs require the desktop process to remain running.
