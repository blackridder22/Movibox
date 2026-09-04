# Release readiness

## Implemented

- Native signed update checks, optional launch/daily checks, explicit install confirmation, progress/error feedback, signature verification before installation, and a safety recovery backup before restarting.
- Update feed and trusted public key are pinned at compilation using `MOVIBOX_UPDATE_ENDPOINT` and `MOVIBOX_UPDATE_PUBLIC_KEY`. Release URLs and redirect transport must be HTTPS. No unsigned fallback.
- Install requires paused downloads/rules and no running background work. Debian/RPM users update through installers or their package manager; in-app Linux updates require AppImage.
- `.github/workflows/tauri-build.yml` builds macOS ARM/Intel, Windows x64 and Linux ARM/x64 installers. It uploads artifacts only; it does not publish a release. Obsolete Harbor media-binary downloads were removed.
- `scripts/release.mjs` checks version alignment and release prerequisites, and generates updater manifests/checksums from detached-signature artifacts.

## Local macOS build

```sh
export npm_config_manage_package_manager_versions=false
node scripts/release.mjs config local
pnpm tauri:build:linux-system --bundles app,dmg --config src-tauri/tauri.release.generated.json
```

The script name does not cross-compile. This produces an ad-hoc macOS build on macOS. Ad-hoc signing is not Developer ID signing or notarization.

## Distribution prerequisites

Configure a stable HTTPS update feed, the Tauri updater public key, and its private signing key/password in CI. Keep the private key out of source control and preserve it securely for future updates. Set `MOVIBOX_UPDATE_ENDPOINT` and `MOVIBOX_UPDATE_PUBLIC_KEY` as GitHub repository variables, and `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as secrets.

macOS also requires `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (Developer ID Application), `APPLE_ID`, `APPLE_PASSWORD` (app-specific), and `APPLE_TEAM_ID`. The build workflow imports the certificate through tauri-action, notarizes, and checks the stapled app and Gatekeeper assessment. Local notarization can alternatively use Apple's API credentials.

Windows updater signatures authenticate updates but are **not Authenticode**. Windows installers still require a Windows certificate/signing service and verification on Windows before public distribution. Do not describe an unsigned installer as fully release-ready.

Run the installer workflow with `signed=true` only after configuring these prerequisites. No production keys or update domain are invented by the app. Local builds clearly show that no feed is configured.

## Prepare an update feed

Collect one signed updater artifact per supported platform. Give each artifact a unique filename (including architecture) and rename its `.sig` file alongside it. macOS uses `.app.tar.gz`, Windows uses the NSIS `.exe`, Linux uses `.AppImage`. DMGs and DEBs are installers, not updater payloads.

```sh
node scripts/release.mjs manifest 0.9.22 https://YOUR-HOST/releases/0.9.22/ release-output \
  darwin-aarch64=/path/MoviBox-aarch64.app.tar.gz \
  linux-x86_64=/path/MoviBox-x86_64.AppImage
```

This writes `latest.json` and `SHA256SUMS` without publishing. Upload artifacts and signatures first, verify them, then publish the feed at the pinned endpoint. The installed client verifies the detached signature against its pinned key. The generator checks signature presence/shape, not cryptographic validity.

## Real Linux build on another host

`scripts/release.Dockerfile` provides Debian Bookworm, Rust 1.96, Node 24, pnpm 11.9 and native build dependencies. Copy the project without host `node_modules`/`target` directories or credentials into `/workspace` and run `pnpm install --frozen-lockfile`, `pnpm run setup:fonts`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`, then `pnpm tauri:build:linux-system --bundles deb`. Use a non-login shell (`bash -c`) so Cargo remains on PATH. This builds for the container architecture.

## Verification limits

See `docs/live-acceptance.md` for real TorBox acquisition evidence. Fixture tests cover stalled/processing/restart recovery and signed-update tamper rejection. They do not establish public-feed deployment, production update installation, Apple notarization, Windows runtime behavior, or playback correctness. Actual platform build and UI results are recorded separately during acceptance.

Primary references: [Tauri updater](https://v2.tauri.app/plugin/updater/), [macOS signing](https://v2.tauri.app/distribute/sign/macos/), [TorBox processing labels](https://support.torbox.app/en/articles/9835759-download-labels).
