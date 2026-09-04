# Priority acceptance — 2026-08-30

Scope: uncached TorBox, native backup/restore, and release preparation. IINA remains an external player; embedding a player would be separate libmpv work.

## TorBox

- The earlier real uncached Sintel acquisition completed, resumed through HTTP 206 in a new process, and passed every BitTorrent piece hash. See [live acceptance](live-acceptance.md).
- This follow-up made cloud processing distinct from downloadable readiness. A completed cloud transfer is not enough until TorBox exposes the files.
- Controlled HTTP tests verify queued/metadata/stalled/processing/ready transitions across runtime restarts, cooldowns, terminal processing failures, and a single cloud submission.
- A new read-only request confirmed the existing test torrent was ready. It submitted no new torrent and downloaded no additional video bytes.
- Peer-only/no-seeder behavior remains covered by fixtures, not a live swarm test.

## Backup and restore

- A separate macOS app identifier and owned fixture database were used; the production database was never restored or modified by the test.
- Native backup creation and latest-copy review succeeded. The confirmation dialog was visually inspected with its disabled-until-confirmed action, counts, missing-file warning and spaced controls.
- Native restore succeeded. A read-only database check confirmed the rule was paused, its revision advanced from 8 to 9, and its running flag/history were reset. A private safety backup was written first.
- After relaunch, importing the original file by its full path also opened a valid preview and restored successfully; the rule remained paused with revision 10. Both import and confirmation dialogs were visually checked in the native app.
- Native save/open panels kept their confirmation buttons disabled during this environment's automation, including the existing JSON diagnostics exporter. Backup creation therefore writes directly into the recovery folder. Import also supports a full file path; the OS picker is not required for recovery.
- Backend tests cover atomic replacement, preserved connections/files, reopening the database, corrupt or changed archives, schema/reference validation, active-work rejection and no overwrite of existing backup files.
- Archives exclude credentials and media bytes but contain personal library information. They are not encrypted. Copy them off the device for device-loss recovery.

## Release evidence and remaining gates

- macOS native suite: 78 passed, 3 opt-in tests ignored. Linux native suite: 81 passed, 3 opt-in tests ignored.
- Signed-update fixture acceptance and modified-payload rejection pass through Tauri's actual updater verifier. The ephemeral fixture private key was deleted; only the public key, signed sample and signature remain.
- Scoped formatting/lint, TypeScript checking and Cargo checking pass.
- The JavaScript suite passes all 90 tests. The initial baseline had two legacy startup tests reading `src/main.tsx`; their file reference now points to `src/legacy-main.tsx`, with all assertions retained and no startup behavior changes. Repository-wide formatting still has 527 existing failures in unrelated files; these were not auto-reformatted.
- macOS app/DMG and Linux ARM64 DEB builds were produced. Local macOS signing is ad-hoc, not Developer ID signing or notarization.
- The final Linux DEB was installed in an isolated Debian container and launched as a non-root user under Xvfb/D-Bus. It stayed running and initialized its database. This exposed and verified a fix for first launch without an XDG Downloads directory: the app falls back to the user's Downloads folder. This is a startup smoke check, not interactive Linux UI verification; the minimal container reports a missing accessibility bus.
- The native macOS About view correctly disabled update actions and explained that no signed feed is configured. The final app passed `codesign --verify --deep --strict`.
- No production updater endpoint/key, Apple signing/notarization credentials, Windows signing service or Git remote is configured. No release was uploaded or published.
- Production update installation, notarization/Gatekeeper distribution, Windows runtime/signing, and other CPU architectures remain unverified. The artifact-only CI workflow is prepared, not executed remotely.

Setup and release commands: [release readiness](release-readiness.md). User recovery steps: [backup and restore](backup-restore.md).

Local installers and SHA-256 checksums are in `release-output/0.9.21-local/`. The macOS build is named **MoviBox Release Candidate** so building it does not overwrite the running app. Neither installer was installed on the user's host, and the production app was not stopped.
