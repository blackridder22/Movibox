# Movie Box UI implementation

The approved Paper design is now an interactive React UI with a local demo service. The default frontend opens this interface. `?legacy=1` explicitly loads the previous Harbor-based client.

## Run

- Preview: http://localhost:1420
- Development: `npx --yes pnpm@11.9.0 dev --host 127.0.0.1`
- TypeScript: `pnpm run typecheck`
- Changed-file verification: `pnpm run check src/moviebox src/main.tsx src/legacy-main.tsx index.html tests/moviebox-ui.test.ts`
- Model tests: `node --test tests/moviebox-ui.test.ts`
- Web build: `pnpm run build`

The host's global pnpm is 10.20.0 while this checkout uses pnpm 11.9.0 and a v11 store. Use the pinned pnpm command for installations and native builds. No global package-manager settings were changed.

## Implemented surfaces

| Paper reference     | UI implementation                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01–09, 41–46        | Discover, search suggestions/results, filters, sorting, grid/list, pagination, movie details, source choices, uncached preparation confirmation, monitoring form, custom cron preview, empty/loading/offline states                     |
| 10–13, 47, 54       | Series, season selection, episode checkboxes, existing-file handling, pack/individual choice, missing-source review, series monitoring, library seasons                                                                                 |
| 14–16, 49–51        | Queue filters, detail drawer, pause/resume, reorder, destination changes, expired-source retry confirmation, bulk selection, cancellation, history clearing, explicit demo completion                                                   |
| 17–20, 48           | Rule creation/editing, preferences, schedules, pause/resume, simulated checks, history and event expansion, deletion confirmation                                                                                                       |
| 21–23B              | Local-library movies/series, search/sort, file details, open/reveal handoffs, missing-file relink simulation, separate remove-entry/delete-file confirmations                                                                           |
| 24–32, 37–40, 52–53 | All nine Settings sections, provider validation, add-on URL validation/order, storage, transfer preferences, scheduling, appearance, shortcut capture/conflict handling, notification previews, logs, local report export, license text |
| 33–36, 53           | Four-step setup, back/continue, browse-only skip and return                                                                                                                                                                             |
| 42–45, 50–54        | Shared accessible menus/dialogs, validation, confirmations, toast feedback, scenario controls, and menu-bar preview                                                                                                                     |

Settings → About & diagnostics exposes preview scenarios, first-run setup, menu-bar controls, and workspace reset. The sidebar explicitly labels the workspace as a demo. Queue rows expose explicit demo completion/preparation actions; progress does not pretend to be a live transfer.

## Structure and boundaries

- `src/moviebox/`: new UI, controls, styles, local catalog fixtures, state, navigation, and pure queue/rule helpers.
- `src/main.tsx`: selects the new UI or the explicit legacy client. The new branch never imports the old `App` or `AutomationRunner`.
- `src/legacy-main.tsx`: preserves the old entry point. Legacy remote fonts/preconnects are held in an HTML template and activated only for that client.
- `public/moviebox/`: local copies of the exact Paper poster/backdrop assets.
- Storage is isolated under `moviebox-ui-demo-v1`; existing application storage and credentials are not read or reset.
- Owned control patterns were adapted from `/Users/werleydessources/Synara/blackridder22UI`. Base UI supplies dialog/menu/select/switch/checkbox behavior. Paper supplies the layout and visual tokens.

**No real provider calls, add-on installations, downloads, file deletion, application launching, system notifications, autostart registration, or background scheduling are connected to this UI.** The only provider key accepted by the preview is `demo-key`; it is neither transmitted nor saved. File/system actions announce their integration boundary. Reports are downloaded locally and exclude provider keys and add-on URLs.

Rust/native acquisition code was not changed. Do not use the compiled native app to establish acquisition safety: its existing native scheduler was not changed or live-tested. Use the browser preview for this UI review.

## Verification

- Existing TypeScript baseline passed before changes.
- Changed-file format, lint, and type checks passed with no warnings.
- Eleven meaningful model tests passed: idempotent submission, overlapping episodes, local duplicate protection, provider/network/storage/source guards, preparing vs scheduled states, pause preservation, isolated rule edits, cron validation, timezone preview, and empty-series rejection.
- Browser flows verified: filtering, source/detail navigation, movie submission, duplicate rejection, pause retaining progress, simulated completion appearing in Library, custom rule save and persistence after reload, episode fallback review, provider invalid-key recovery, theme persistence, four-step setup, and offline retry.
- Input activation and Escape behavior were exercised: Enter enables editing and the first Escape leaves the dialog open. The in-app browser did not advance native Tab focus with its keypress tools, so full Tab traversal, screen readers, remotes, and gamepads are **not claimed as verified**.
- Browser console inspection returned no warnings or errors during the checked flows.
- Full-size screenshots at 1440×900 and narrow-window screenshots at 390×844 were inspected. Discover and the narrow detail drawer had no horizontal overflow.
- Browser screenshots and the visual comparison ledger are in `design/movie-box-v1/implementation/`.

## Build limits

`pnpm tauri:build:linux-system` was attempted. On this macOS host it builds the host architecture, not Linux. The frontend and release native executable compiled, but DMG packaging failed in the existing `bundle_dmg.sh` step. Re-running with `--bundles app` successfully produced the macOS application bundle. Linux packaging requires a Linux host. No native playback, real acquisition, scheduler, or filesystem behavior was tested.

The web build retains the legacy application's large `tmdb-client` chunk warning. The new UI bootstrap is a separate smaller chunk; legacy modules are not loaded on the default preview path. No unrelated legacy code was refactored to suppress that warning.
