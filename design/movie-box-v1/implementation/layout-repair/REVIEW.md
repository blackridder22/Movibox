# Movie Box layout repair

Reference: the accepted [Paper file](https://app.paper.design/file/01M181DPYRWPZ6RDMSNQGPNS08/1-0), checked against the local JSX exports and interaction specification. No design-source edits or backend changes were made.

## Measured layout

- At 1440 × 900, all nine Settings pages have an 800 px content column beginning at x = 468: 208 px sidebar, 32 px page inset, 180 px settings navigation and 48 px column gap.
- Settings sections use 22 px gaps, with 16 px gaps for Appearance, Shortcuts and Notifications, matching their reference layouts.
- Shared action groups use an explicit 8 px gap and wrap. The reported preview buttons now have measured gaps of 8 px and 8 px.
- Dialogs use 24 px padding and 20 px section gaps. At a 390 px viewport, the provider dialog is 366 px wide with 12 px side margins and no horizontal overflow.

Evidence: [settings measurements](settings-measurements.json), [reported button measurements](preview-button-measurements.json), [About actions](32-about-preview-actions.jpeg), [narrow dialog](mobile-connect-provider.jpeg).

## Changes and browser coverage

Settings now uses the measured Paper layout and shared rows/action groups. Preview tools are a separate section. Filters and source selection are anchored popovers. Dialog sizing, stacked backdrops, destructive actions, hover contrast and narrow layouts are corrected. Library series and monitoring history open as full pages and reset scroll position.

Browser review covered all nine Settings pages; Discover, Downloads, Monitoring and Library; inspectors; source and filter popovers; movie/season selection; monitoring forms and validation; confirmations; all four setup steps; diagnostics and license previews; empty, loading, offline, provider-error and storage-error states. Reviewed at 1440 × 900, the 960 × 600 desktop minimum, and 390 × 844. Light mode was checked and Dark mode restored.

[All screenshots](SCREENSHOTS.md) document the review. Later captures include the final button spacing, narrow-dialog containment and [stacked confirmation backdrop](51-quit-confirm-layering.jpeg). Early captures can precede final shared refinements. A fresh page load had no current console warnings or errors; see [runtime check](runtime-check.json).

## Verification

- Scoped `pnpm run check`: passed for changed TypeScript and CSS; no lint or type errors.
- `pnpm run typecheck`: passed.
- Existing `node --test tests/moviebox-ui.test.ts`: 11/11 passed.
- Project-pinned `npx --yes pnpm@11.9.0 tauri:build:linux-system`: passed on macOS, producing the Apple Silicon app and DMG. Despite its script name, this did not build or verify a Linux binary.
- The existing large legacy TMDB bundle warning remains outside this layout repair.

Logs: [checks](checks.log), [typecheck](typecheck.log), [tests](tests.log), [final build](build.log).

## Scope and limits

This is measured layout and browser-interaction evidence, not certification that every one of the 56 artboards is pixel-identical. Fixture content, preview notices and supporting demo forms can differ. Inspectors remain adjacent and non-modal as specified in `INTERACTIONS.md`. Native OS pickers, live providers, scheduling and actual file downloads/deletion were not verified; demo previews do not imply those services are connected.
