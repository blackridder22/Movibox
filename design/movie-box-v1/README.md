# Movie Box — desktop design specification

Status: the initial Discover direction was approved. The remaining V1 screens and state studies are now drawn for review. Application code is unchanged.

[Open the editable Paper file](https://app.paper.design/file/01M181DPYRWPZ6RDMSNQGPNS08/1-0). Start at **00 · Movie Box / Design index**. The numbered artboards are arranged left to right in four columns.

## Coverage

The file contains **56 artboards**: 55 app screens and state sheets, plus the index.

| Artboards | Area                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| 01–13     | Discover, movie details, sources, monitoring setup, search, filters, series, seasons and episode selection           |
| 14–23B    | Downloads, Monitoring, Library, item details, edits and destructive confirmations                                    |
| 24–32     | All nine Settings sections                                                                                           |
| 33–36     | Provider, source, storage and completion steps for first run                                                         |
| 37–45     | Connections, recovery, preferences, menus, keyboard states, empty/loading/error states and feedback                  |
| 46        | Light theme                                                                                                          |
| 47–54     | Series files, check history, bulk selection, queue states, context/tray menus, diagnostics and secondary transitions |

These are **static, editable designs**, not a wired click prototype. The interaction map identifies which artboard represents each outcome. Native operating-system pickers and external websites remain system-owned surfaces; their entry, cancel and return behavior is specified rather than imitating their platform UI.

See [INTERACTIONS.md](INTERACTIONS.md) for the control-to-state map and [SCREENS.md](SCREENS.md) for every exported screen.

## Visual foundation

The source is the user's blackridder22UI design system, read from `/Users/werleydessources/Synara/blackridder22UI/DESIGN.md`.

- Near-black canvas, charcoal surfaces, copper accent, fine dividers and open rows.
- SF Pro Text for interface text; SF Pro Display for headings. Fonts were checked in Paper.
- Main desktop layout: 1440 × 900, 208px sidebar, 32px content padding and 24px section gaps.
- Movie details: 440px adjacent, non-modal panel with 24px internal padding.
- Posters: 170 × 255px; six columns in Discover, four with the details panel open.
- Controls: 38–40px high; visible keyboard focus; labels accompany semantic status colors.
- Semantic colors and type/spacing/radius tokens are exported in `tokens.json`. Light mode has a separate token set. Appearance controls cover accent, density, radius, glass, shadows and reduced motion.
- State sheets grow to fit their content. They are comparison sheets, not alternative application window sizes.

## Product decisions expressed by the design

TorBox is the first provider. Catalog metadata and source discovery are separate connections. Other provider adapters and the final runtime have not been selected or implemented.

Downloads progress through source preparation, queued/scheduled, transferring, paused, failed and completed states. A monitoring rule has separate preferences and execution history. Saving a rule does not imply starting a download.

The proposed scheduler runs while Movie Box is running. Closing its window may leave it in the menu bar/tray; quitting or sleeping pauses work. On reopen, missed checks catch up once rather than replaying the entire backlog. This is a proposed implementation contract, not verified background behavior.

Completed files, library entries, download-history entries and incomplete files are distinct. Their remove/delete/cleanup actions state exactly what is affected and use separate confirmations.

## Verification and limits

Each new screen or state sheet was captured from Paper and visually reviewed for spacing, type, contrast, alignment, fit and repetition. Targeted corrections included the Shortcuts footer, shortcut recording text, tooltip contrast, light-theme icons, episode text contrast, action-menu selection marks, bulk-row consistency and sample counters.

`layout-audit.json` records bounding checks on principal content and trailing sections. It complements screenshot review; it is not an accessibility or runtime test. Paper sometimes returned an earlier render immediately after writes, so final captures were refreshed after the edits settled.

All account states, source availability, file sizes, transfer speeds, schedules, version numbers and diagnostics are illustrative. No account was connected, no credentials were read, and no movie files were downloaded. Public poster/backdrop assets and title metadata are recorded in `assets.json` and `series-assets.json`.

No application build, provider integration, real download, keyboard/remote test or accessibility audit was performed. TypeScript and Rust were not changed. Runtime selection, responsive behavior outside the designed desktop size, platform permissions, protocol capability checks and executable interaction tests remain implementation work.

Artifact checks are recorded in [VERIFICATION.md](VERIFICATION.md). The existing check wrapper has a zero-code-file lint limitation; no unrelated toolchain changes were made.

## Saved artifacts

- `*.jpeg`: screenshots from Paper.
- `*.paper.json`: direct Paper JSX/style exports for exact implementation reference.
- `paper-artboards.json`: durable screen IDs, dimensions, positions and screenshot paths.
- `paper-nodes.json` and `paper-suite.json`: detailed editing references.
- `tokens.json`: direct Paper token export.
- `assets/`, `assets.json`, `series-assets.json`: visual reference assets and provenance.

Paper is accessible through the installed plugin's documented local relay, `/Users/werleydessources/.paper/bin/paper mcp`. No plugin settings or permissions were changed. Continue editing the existing artboards and tokens rather than recreating them.
