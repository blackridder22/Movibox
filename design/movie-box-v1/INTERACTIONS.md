# Movie Box — interaction map

All referenced outcomes are drawn in Paper. Screens 37 onward often contain multiple labeled variants on a state sheet. Transitions are specified here but are not wired or implemented.

## Discover and titles

| Starting control       | Outcome / state                                                                                | Artboards        |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| Discover navigation    | Movie catalog; Series tab; light theme                                                         | 01, 10, 46       |
| Search / Command K     | Focus, edit, suggestions, results list, clear, no results, loading and failure                 | 07, 09, 42–44    |
| Sort                   | Open choices and selected option; results reuse the catalog/list layout                        | 41               |
| Filters                | Genre/year/rating/catalog controls, applied count, reset and empty results                     | 08, 43           |
| Grid / list            | Same title destinations in poster or row presentation                                          | 01, 09           |
| Pagination             | First-page disabled Previous, Next, loading and retained query                                 | 01, 42           |
| Movie card             | Hover action, focus ring, selection, artwork fallback, adjacent details                        | 02, 42           |
| Details close / Escape | Return to full catalog; restore originating focus                                              | 01–02            |
| Metadata failure       | Keep the search; retry or return                                                               | 44               |
| Source choice          | Cached/uncached alternatives with quality, audio and size                                      | 03, 06, 41, 54   |
| Uncached source        | Explicit preparation confirmation; Preparing job                                               | 54               |
| Source expired         | Search for a fresh link; ask before restarting a changed release                               | 44               |
| Destination            | Recent folders, system chooser handoff, unavailable drive, permissions and low space           | 35, 39           |
| Download now           | Submitting, queued confirmation, view queue, duplicate-file/job protection and enqueue failure | 14–15, 44–45     |
| Monitor availability   | Preferences, schedule, cron/timezone/window, validation and saved feedback                     | 04–05, 41–42, 45 |

## Series and seasons

| Starting control               | Outcome / state                                                                 | Artboards  |
| ------------------------------ | ------------------------------------------------------------------------------- | ---------- |
| Series card                    | Series catalog and season details                                               | 10–11      |
| Season selector                | All seasons / individual season menu                                            | 41         |
| Episode checkbox / select all  | Checked, unchecked, indeterminate, already downloaded and selected-count states | 11, 42     |
| Season pack                    | Selected episode review; missing sources fall back to individual matches        | 11, 13     |
| Download selected              | Ready episodes queue; unmatched episodes remain monitored when requested        | 13, 45     |
| Monitor series                 | Selected seasons, future episodes, quality and duplicate protection             | 12, 41, 54 |
| No available episodes          | Explanation and monitor-season action                                           | 54         |
| All selected episodes obtained | Complete rule; open library or monitor another season                           | 54         |

## Downloads

| Starting control            | Outcome / state                                                                   | Artboards      |
| --------------------------- | --------------------------------------------------------------------------------- | -------------- |
| Downloads navigation        | Loaded mixed queue, empty queue                                                   | 14, 43         |
| Status tabs                 | Same queue shell filtered to the relevant lifecycle state                         | 14, 50         |
| Download row / View details | Progress, source, folder, metadata and activity drawer                            | 15             |
| Pause / resume              | Preserved partial file and eligible resume action                                 | 42, 50         |
| Retry                       | Retrying source/request; provider, network and expired-link recovery              | 37, 44, 50, 54 |
| Scheduled / Start now       | Waiting for download window; explicit immediate start                             | 41, 50         |
| Context menu                | Details, pause, reorder, destination and cancel                                   | 51             |
| Selection                   | Three selected items with the same queue rows; bulk actions replace the tab strip | 49             |
| Cancel / bulk cancel        | Explicit job impact; optional incomplete-file deletion                            | 16, 50         |
| Completed                   | Open default player, reveal file, history removal                                 | 50–51          |
| Clear history               | Remove list entries while retaining local files and library entries               | 50             |

## Monitoring

| Starting control              | Outcome / state                                                         | Artboards  |
| ----------------------------- | ----------------------------------------------------------------------- | ---------- |
| Monitoring navigation         | Rules, next checks, waiting/no match/error/paused states; empty view    | 17, 43     |
| Rule row                      | Preferences, status, next check and recent execution results            | 18         |
| Edit                          | Quality, audio, size, schedule and destination                          | 19, 41     |
| Save / invalid form / discard | Saved feedback, inline validation, unsaved-change confirmation          | 42, 45, 54 |
| Pause / resume                | Toggle state, no scheduled check while paused                           | 42, 45, 54 |
| Run now                       | Checking sources, result counts, added downloads and unmatched episodes | 45, 54     |
| History / expand event        | Filtered history and execution summary                                  | 48, 54     |
| Delete rule                   | Confirm deletion; keep downloads and local files                        | 20         |

## Library

| Starting control        | Outcome / state                                                            | Artboards     |
| ----------------------- | -------------------------------------------------------------------------- | ------------- |
| Library navigation      | Movies and grouped series, empty state                                     | 21, 43        |
| Search / filter / sort  | Shared search/input/menu patterns applied to local titles                  | 07–09, 41–43  |
| Movie file              | Metadata and local file actions                                            | 22            |
| Series                  | Season selector and local/missing episode rows                             | 47            |
| Open / Open with        | Default player or operating-system application chooser; no-player recovery | 45, 51        |
| Reveal / library folder | Operating-system file manager at the selected file/folder                  | 21–22, 47, 51 |
| Missing file            | Preserve entry, locate/relink, or remove entry                             | 39            |
| Remove entry            | Keep local file                                                            | 23            |
| Delete local file       | Separate destructive confirmation                                          | 23B           |

## Settings and setup

| Section / control         | Outcome / state                                                                             | Artboards          |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| Providers                 | Connected account, masked key, connect/replace, verify, invalid/expired/offline, disconnect | 24, 33, 37         |
| Provider selection        | TorBox first; additional adapters explicitly unspecified                                    | 53                 |
| Sources & add-ons         | Add URL, validate capabilities, configure externally, enable/disable, remove, catalog order | 25, 34, 38         |
| Storage                   | Destination, naming, reserve, cleanup, permissions and recovery                             | 26, 35, 39         |
| Downloads                 | Quality, language, max size, concurrency, bandwidth, retries and duplicates                 | 27, 41, 45         |
| Scheduling                | Frequency, timezone, windows, autostart, background and catch-up behavior                   | 05, 28, 41, 51, 53 |
| Appearance                | Theme, accent picker, spacing, radius, glass, shadows, motion and reset                     | 29, 40, 42, 46, 53 |
| Shortcuts                 | Binding list, capture, conflict/replace and reset                                           | 30, 40             |
| Notifications             | Permission, notification types, quiet hours and test feedback                               | 31, 40, 45, 53     |
| About & diagnostics       | Version, update states, health, logs, local report export and license list/detail           | 32, 52–53          |
| First-run Back / Continue | Provider → source → storage → ready; invalid/busy states reuse connection patterns          | 33–38              |
| First-run skip            | Browse-only explanation and return to setup                                                 | 53                 |
| Menu bar / tray           | Open window, global pause, Settings and quit confirmation                                   | 51                 |

## Behavior contracts for implementation

- Focus and activation are separate. Keyboard/remote focus does not start navigation, editing or a download. Enter activates an input; Escape leaves editing before dismissing its parent surface.
- Details are adjacent and non-modal. Dialogs trap focus; menus use arrow navigation. Close restores focus to the trigger. Destructive actions do not receive initial focus.
- Search retains query and filters across title inspection. New queries return to page one. Paging moves the catalog to its start without discarding the query. Clear/reset controls announce the changed results count.
- Queue submission is idempotent. Busy actions reject repeat activation. Do not queue a duplicate merely because a request timed out; reconcile the provider/job state first.
- A season pack is usable only when its actual file list covers the selected episodes. Show omissions and fallback before submitting. Existing episodes are skipped unless the user explicitly chooses another copy.
- Scheduled checks belong to rules. Jobs separately respect concurrency and transfer windows. Source preparation is distinct from downloading to disk.
- Closing the window may keep the app running in the tray. Quitting or sleeping pauses checks and transfers. On resume, perform one catch-up check per eligible rule, then compute the next future check. This execution behavior still needs platform validation.
- Timezone changes recompute upcoming checks. Overnight windows can cross midnight. Invalid cron expressions cannot be saved. Display upcoming local times before confirming a custom schedule.
- Removing a rule, a history entry, a library entry, a temporary file and a completed local file are separate operations. State sheets document the affected data.
- Provider keys and token-bearing add-on URLs remain masked. Diagnostics omit them; exporting is local and does not send a report. File names/paths require explicit opt-in for reports.
- Toasts do not steal focus. Status changes use text as well as color and expose accessible announcements. Reduced motion removes sliding and shimmer, while retaining static busy text.
- Disabled and loading states are drawn, but actual screen-reader, keyboard, remote and platform behavior requires implementation tests.

## Explicit boundaries

This is the V1 desktop design set, not proof that the proposed provider, scheduler or filesystem behavior already exists. External provider pages, system folder/file/application pickers, notification settings, file managers and video players are not custom Movie Box screens. Their handoffs are specified above. Other desktop sizes and platform-specific native chrome require a responsive implementation pass.
