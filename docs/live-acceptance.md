# Live provider acceptance

This is a bounded, opt-in test of production Rust provider, transfer, and subtitle routines. It does not modify the production database or existing download/rule records. It is not a native UI replay or a complete season-pack acceptance result.

## Results — 2026-08-30

| Check                  | Observed result                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real TorBox cache miss | Confirmed before submission of the uniquely hashed, freely licensed Sintel fixture.                                                                                                                                           |
| Torrent upload         | Initially rejected with HTTP 400 / `BOZO_TORRENT`. Adding the torrent MIME type fixed the real submission.                                                                                                                    |
| Cloud preparation      | Recovered the persisted task in another process. Fresh status polling returned ready with the expected video file.                                                                                                            |
| Local transfer restart | Paused at 4,202,496 bytes. A new process received HTTP 206 and resumed from exactly that offset.                                                                                                                              |
| Completed video        | 129,241,752 bytes. All original BitTorrent piece hashes verified.                                                                                                                                                             |
| French subtitle        | Initial fallback was 30 seconds late. With codec-aware ranking, all 26 start/end timings match the published reference. Translation wording differs; playback was not manually reviewed.                                      |
| Existing season audit  | Read-only: all seven episodes have readable video files, matching episode filenames and French sidecars. One sidecar's final cue extends approximately five seconds beyond its video; manual timing review remains necessary. |

The subtitle API returned four French candidates and **no exact video-hash matches**. Codec ranking improves fallback selection but does not guarantee synchronization. Result messages now distinguish video-hash matches, full release-name matches and title/episode fallback. No existing user subtitle was replaced.

Production fixes from this run:

- `.torrent` uploads declare `application/x-bittorrent`.
- Cloud status and reconciliation request fresh TorBox snapshots, retaining existing pacing.
- Documented stalled/no-seeder states remain visible as stalled.
- Bounded error parsing preserves allowlisted TorBox reasons and retry behavior without logging response details, credentials or private URLs.
- Subtitle fallback ranks codec compatibility before popularity, preserves encode tags during release-name normalization, and never treats the title fallback alone as an exact release name.

Validation: 70 Rust tests passed; two opt-in live tests are excluded from ordinary runs. `cargo check` passed. The full build command produces a macOS app/DMG on this host, **not a Linux binary**. Repository-wide `pnpm run check` remains blocked by 527 pre-existing formatting failures in untouched files; it was not auto-fixed. The scoped check has no Rust/Python lint target. Existing bundle-size/notarization warnings remain; the build is ad-hoc signed, not notarized or installed.

Local evidence is under `/tmp/movibox-live-acceptance`: `run-report.json`, `file-verification.json`, `file-verification-initial.json`, `existing-season-report.json`, and the preserved initial subtitle. The test torrent remains in TorBox; no cloud item was deleted. Do not publish the isolated database.

## Test material and limits

- [WebTorrent's published Creative Commons Sintel torrent](https://webtorrent.io/free-torrents), 129,302,391 bytes total; local video 129,241,752 bytes.
- The preparer retains original filenames, piece hashes and public webseed paths, and adds a unique `source` field to the torrent's info dictionary. The live run must still observe a successful TorBox cache miss before submitting it.
- This tests real uncached cloud acquisition through a webseed. Peer-only torrents and unavailable seeders remain separate cases.
- At most one torrent per prepared directory, no cloud deletions, no provider account changes. Provider quota/storage is used by the test. Re-running uses the same durable intent and hash.
- The only local output is the dedicated acceptance directory. Credentials are read normally from the OS credential store, never copied to files or printed. macOS may require the owner to approve access.
- French subtitle downloads are bounded: one initial attempt, and at most one replacement to validate a matching fix. A quota failure, expired sign-in, or missing candidate is a test result, not a video failure.

## Prepare (no credentials, no provider requests)

```sh
python3 scripts/moviebox-live-acceptance.py prepare /tmp/movibox-live-acceptance
cargo test --manifest-path src-tauri/Cargo.toml --lib --no-run
```

## Opt-in phases

Run the ignored test with these environment variables. Change `MOVIBOX_LIVE_PHASE` explicitly for each step: `preflight`, `cloud-submit`, `pause`, then `finish`.

```sh
MOVIBOX_LIVE_ACCEPTANCE=torbox \
MOVIBOX_LIVE_ROOT=/tmp/movibox-live-acceptance \
MOVIBOX_LIVE_PHASE=preflight \
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  live_torbox_uncached_recovery_and_french_subtitles -- --ignored --nocapture
```

1. `preflight`: authenticate the configured TorBox account and check access to the saved OpenSubtitles credential. Never submit a torrent or request a subtitle download. An expired subtitle sign-in is reported.
2. `cloud-submit`: require an observed cache miss, submit once, persist its intent, and exit. Even uncertain provider responses retain the intent for reconciliation.
3. `pause`: reopen that intent in a new process, wait up to 15 minutes using the regular 30-second polling interval, start only the expected video, stop after the first progress checkpoint, and exit with its partial file intact.
4. `finish`: reopen again, obtain a fresh link, require an actual range resume, finish the video, and run French subtitle acquisition. The video bytes must remain unchanged after subtitle work.

Stages intentionally run in separate processes. This verifies disk persistence and transfer recovery without quitting the user's running desktop app. No background GUI worker or monitoring rule is created.

After diagnosing a definitive rejection, `MOVIBOX_LIVE_RETRY_REJECTED=1` may accompany `cloud-submit`. It uses the regular retry marker and the same torrent hash. It refuses to replay an uncertain submission.

## File and subtitle evidence

```sh
python3 scripts/moviebox-live-acceptance.py verify /tmp/movibox-live-acceptance
```

The verifier checks every BitTorrent piece against the original file set, combining the TorBox-delivered video with the small published reference files. It computes a video SHA-256 and compares French cue text/timestamps against the published French subtitle. Different cues require playback review; merely saving an SRT is not synchronization proof.

Evidence stays in `manifest.json`, `run-report.json`, `file-verification.json`, and the isolated `acceptance.sqlite3`. Do not publish the database: provider tasks can include private download information. The JSON reports omit credentials, account identities and download URLs.

## Full acceptance still requires

- A real mixed-source season with missing-episode reconciliation and actual French subtitle playback checks.
- Peer-only uncached torrent acquisition and no-seeder behavior.
- Monitoring dispatch through the desktop app, source-search navigation, and restart behavior of the complete app.
- Real-Debrid testing after an account is configured.

Controlled tests cover these branches where available; they do not replace these live checks.

## Priority follow-up — 2026-08-30

Uncached TorBox now distinguishes cloud processing from downloadable files: `download_finished` alone is insufficient; local downloads wait for `download_present`. The existing polling interval remains 30 seconds (120 seconds for stalled/no-seeder tasks). Controlled HTTP tests reopen the runtime between queued, metadata, stalled, processing and ready states, verify polling cooldowns, and prove one submission across those restarts.

A fresh **GET-only** status check of the already authorized Sintel cloud task reported `download_finished=true`, `download_present=true`, 100% progress, and 11 files. No new torrent was submitted and no additional video bytes were downloaded. Evidence: `/tmp/movibox-live-acceptance/readiness-recheck.json`. This recheck validates current readiness interpretation; it is not a second cache-miss acquisition.

The earlier real uncached/resume/piece-hash evidence above remains applicable. Peer-only and no-seeder behavior is covered by controlled tests, not a new live swarm test.
