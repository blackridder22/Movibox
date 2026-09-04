# Provider workflows

MoviBox keeps discovery, cloud preparation, local transfer, and subtitles separate. Rust owns their durable state. Stremio add-ons and Torznab remain supported.

## Discovery

- At most three discovery HTTP requests are in flight globally, and one per origin. Episode searches run in batches of three; a verified season pack prevents unnecessary episode searches.
- Requests to the same discovery origin or provider credential are spaced by at least two seconds. HTTP 429 and temporary failures apply shared cooldowns, exponential backoff, jitter, and `Retry-After`. No limit can guarantee that a third-party service will never block requests.
- Identical searches share a short response cache. Public Knaben results and torrent metadata are cached for five minutes. Torrent metadata keeps the existing size and request budgets.
- Manual source searches are persistent jobs. Closing a review or navigating away stops only the UI subscription. Downloads → Source searches reopens results; only Cancel search cancels work. Up to two search jobs run concurrently within the shared HTTP limits. Restart requeues interrupted searches. Results never approve a download, and matching completed searches are reused for 30 minutes unless explicitly refreshed.
- Settings → Sources & add-ons → Enable public search adds the optional [Knaben API](https://knaben.org/api/v1/) connector. It is not enabled automatically and does not guarantee a particular title or language.

## Cloud preparation

Each torrent has one persisted `cloud-task`, keyed by provider, account, and hash. Jobs and saved reviews retain their original provider binding when the default changes.

Preparation follows metadata → cloud queue → cloud download → ready, with separate stalled, retrying, and error states. File availability and cloud completion are distinct. A cache miss can be submitted to the provider; local transfer waits for ready files.

The submission intent is committed before the request. After a timeout or lost response, MoviBox reconciles the account rather than blindly submitting again. An unresolved submission can remain waiting until the provider exposes it; the API does not offer an exactly-once guarantee. Explicit capacity rejections can be retried. Known remote torrent IDs survive restart.

“Queue and wait” creates a durable `bundle-wait` intent. It resolves candidate manifests in the background, then atomically queues verified file mappings as one bundle. Pausing, canceling, or editing a monitoring rule cannot commit a stale approval. A restart after the queue commit recovers the same bundle. Unmatched episodes remain unresolved; nothing is silently substituted.

Cloud acquisition may fetch an entire release. Only the reviewed local files are downloaded. Pausing/canceling local preparation or disconnecting a provider does not delete or stop remote cloud torrents, which may be shared by other jobs.

## Providers

- **TorBox:** retains cache checks, torrent upload/magnet submission, queued submissions without an active ID, metadata polling, actual completion flags, and per-file download links.
- **Real-Debrid:** personal API token in the OS credential store; torrent submission, file selection, status polling, and individual link unrestriction. No speculative instant-availability endpoint is used. “Cached only” therefore excludes unverified Real-Debrid torrents; use “Cached first” or “Best quality.”
- A reused Real-Debrid torrent requiring file selection is left unchanged; the user selects files in Real-Debrid. MoviBox selects all cloud files only for torrents it submitted itself. Aggregate archive links are never treated as individual video files.
- Changing an account while its downloads/preparations remain unfinished is blocked. Connecting the other provider is allowed. There is no automatic cross-provider fallback.

Contracts: [TorBox torrents SDK documentation](https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/TorrentsService.md), [Real-Debrid API](https://api.real-debrid.com/).

## Subtitles

Settings → Subtitles enables independent post-download jobs. Monitoring rules can inherit global settings, disable subtitles, or select up to four languages. The effective policy is frozen when a download or cloud-wait intent is queued; later preference changes do not rewrite it. Existing library videos are not automatically bulk processed.

Find subtitles is available in completed download details, bundle headers, and Library episodes/movies. It queues only subtitle work for completed local files, including when global automatic subtitles are off. Relinked Library paths are respected. Bundle headers show saved videos and subtitle completeness per language. Each task has its own status, retry time, and errors; subtitle failure never changes a completed video into a failed download.

- Installed Stremio subtitle add-ons receive the video ID, file hash, size, and original filename.
- OpenSubtitles accepts a user-supplied API key and optional login. The key and token are stored in the OS credential store; the password is not saved. Expired sign-in requires reconnecting. API hosts are allowlisted before credentials are sent.
- Candidates are filtered by language and episode identity and ranked by hash/release evidence. An optional strict mode rejects add-on results without evidence. Multi-episode files require a hash match.
- Bounded HTTP redirects are followed with pacing per hop. Credentials are never forwarded across origins, HTTPS is not downgraded, and write requests are not replayed. Up to three candidate file URLs can be tried; unavailable OpenSubtitles credentials do not prevent a permitted add-on fallback.
- A preferred full embedded subtitle track is detected when `ffprobe` is available on the app's PATH. `ffprobe` is not bundled. Without it, external subtitles are searched normally.
- UTF-8 SRT, VTT, or ASS files are saved atomically beside the video and never overwrite an existing sidecar. MKV files are not rewritten. A match does not prove playback synchronization.
- Account quota failures are deferred and surfaced independently from video status.

Contracts: [OpenSubtitles getting started](https://opensubtitles.tawk.help/article/getting-started), [OpenSubtitles endpoint documentation](https://ai.opensubtitles.com/docs), [Stremio subtitle handler](https://stremio.github.io/stremio-addon-sdk/api/requests/defineSubtitlesHandler.html).

## Optional catalog and playback

Settings → Catalog connects a personal TMDB API Read Access Token in the OS credential store. Metadata language is independent of audio/subtitle preferences. TMDB pagination, genres, episode metadata, and IMDb aliases feed the existing source bridge; TMDB is not a source provider. Enabled Stremio catalogs provide fallback if TMDB fails. Attribution appears in Catalog and About. Live TMDB access requires the user’s token.

Open in IINA launches the installed macOS application for a completed local file, using a native argument-safe process call. IINA is not bundled or embedded. Existing default-player actions remain available. Appearance offers an optional accent cursor limited to the app webview; text inputs retain the text cursor.

## Runtime boundary

Cloud work may continue remotely while MoviBox is closed. Local transfers, monitoring, and subtitle jobs run only while the desktop process is running. Close to tray and launch at login remain the available background options; this is not an always-on system service. Restart recovers persisted work instead of replaying every missed schedule tick.
