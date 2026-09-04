import catalogData from "./catalog.json" with { type: "json" };
import type { DemoState, Job, JobStatus, Media, Preferences, Rule } from "./types";
const nativeRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const catalog = (nativeRuntime ? [] : catalogData) as Media[];
const catalogIndexes = new Map(catalog.map((media, index) => [media.id, index]));
const catalogById = new Map(catalog.map((media) => [media.id, media]));
export function registerMedia(items: Media[]) {
  for (const item of items) {
    const index = catalogIndexes.get(item.id);
    if (index === undefined) {
      catalogIndexes.set(item.id, catalog.length);
      catalog.push(item);
      catalogById.set(item.id, item);
    } else {
      const merged = { ...catalog[index], ...item };
      catalog[index] = merged;
      catalogById.set(item.id, merged);
    }
  }
}
export const mediaById = (id: string): Media =>
  catalogById.get(id) ?? {
    id,
    title: "Unknown title",
    kind: "movie",
    year: "",
    genre: "",
    genres: [],
    runtime: "",
    rating: 0,
    poster: "",
    episodes: [],
  };
export const defaultPreferences: Preferences = {
  customCursor: false,
  provider: true,
  sourcePreference: "Cached first",
  sourceTimeout: "20 seconds",
  addons: [
    {
      id: "cinemeta",
      name: "Cinemeta",
      url: "https://v3-cinemeta.strem.io/manifest.json",
      enabled: true,
    },
    {
      id: "demo-source",
      name: "Demo source provider",
      url: "https://example.com/manifest.json",
      enabled: true,
    },
  ],
  folder: "Movies",
  movieFolder: "Movies",
  seriesFolder: "Series",
  naming: "Title (Year)",
  reserve: "10",
  cleanup: true,
  quality: "4K or better",
  language: "English",
  maxSize: "40",
  concurrency: "3",
  bandwidth: "Unlimited",
  retries: "3",
  duplicates: true,
  frequency: "6 hours",
  cron: "0 */6 * * *",
  timezone: "America/Anchorage",
  transferWindow: "Any time",
  autoStart: false,
  background: true,
  catchUp: true,
  sidebarCollapsed: false,
  theme: "Dark",
  accent: "#F08B64",
  density: "Compact",
  radius: "10",
  glass: false,
  shadows: true,
  motion: "Use system setting",
  notifications: true,
  notifyComplete: true,
  notifyError: true,
  notifyMatch: true,
  notifyTitles: true,
  notifySound: false,
  quietHours: "Off",
  shortcuts: {
    Search: "⌘ K",
    Discover: "⌘ 1",
    Downloads: "⌘ 2",
    Monitoring: "⌘ 3",
    Library: "⌘ 4",
    Settings: "⌘ ,",
  },
  setupComplete: true,
};
export function createDemoState(): DemoState {
  const now = Date.now();
  const specs: [string, JobStatus, number, number, number, string][] = [
    ["interstellar", "active", 68, 21.8, 23.4, "4K · Blu-ray · English"],
    ["severance", "active", 42, 18.2, 7.8, "7 episodes · 1080p"],
    ["dune", "queued", 0, 16.4, 0, "4K · WEB-DL · English"],
    ["arrival", "paused", 35, 8.1, 0, "1080p · Blu-ray · English"],
    ["blade-runner-2049", "failed", 0, 24.6, 0, "4K · Blu-ray · English"],
    ["past-lives", "completed", 100, 6.2, 0, "1080p · WEB-DL · English"],
  ];
  return {
    version: 1,
    scenario: "normal",
    preferences: structuredClone(defaultPreferences),
    recentSearches: [
      {
        id: "title:severance",
        query: "",
        mediaId: "severance",
        title: "Severance",
        kind: "series",
        searchedAt: now - 8 * 60 * 1000,
      },
      {
        id: "query:science fiction",
        query: "science fiction",
        searchedAt: now - 2 * 60 * 60 * 1000,
      },
    ],
    watchStates: [],
    jobs: specs.map(([mediaId, status, progress, size, speed, quality]) => ({
      id: `job-${mediaId}`,
      mediaId,
      label: mediaById(mediaId).title + (mediaId === "severance" ? " · Season 1" : ""),
      status,
      progress,
      size,
      speed,
      quality,
      destination: "Movies",
      season: 1,
      episodes: mediaId === "severance" ? [3, 4, 5, 6, 7, 8, 9] : [],
      events: ["Demo source selected", "Demo job created"],
    })),
    history: [
      {
        id: "history-past-lives-2",
        jobId: "job-past-lives-2",
        mediaId: "past-lives",
        label: "Past Lives",
        status: "completed",
        quality: "1080p · WEB-DL · English",
        provider: "TorBox",
        destination: "Movies/Past Lives (2023)/Past Lives.mkv",
        size: 6.2,
        season: 1,
        episodes: [],
        attempt: 2,
        startedAt: now - 42 * 60 * 1000,
        finishedAt: now - 18 * 60 * 1000,
        trigger: "manual",
        fileExists: true,
        events: ["info · Source verified", "info · Download completed"],
      },
      {
        id: "history-severance-monitor",
        jobId: "job-severance-monitor",
        mediaId: "severance",
        label: "Severance · Season 1",
        status: "completed",
        quality: "1080p · 2 episodes",
        provider: "TorBox",
        destination: "Series/Severance/Season 1",
        size: 7.8,
        season: 1,
        episodes: [1, 2],
        attempt: 1,
        startedAt: now - 27 * 60 * 60 * 1000,
        finishedAt: now - 26 * 60 * 60 * 1000,
        trigger: "monitoring",
        ruleId: "rule-severance",
        bundleId: "bundle-severance-1",
        fileExists: true,
        events: ["info · Monitoring rule matched", "info · 2 files completed"],
      },
      {
        id: "history-past-lives-1",
        jobId: "job-past-lives-1",
        mediaId: "past-lives",
        label: "Past Lives",
        status: "canceled",
        quality: "1080p · WEB-DL · English",
        provider: "TorBox",
        destination: "Movies/Past Lives (2023)/Past Lives.mkv",
        size: 0.7,
        season: 1,
        episodes: [],
        attempt: 1,
        startedAt: now - 3 * 24 * 60 * 60 * 1000,
        finishedAt: now - 3 * 24 * 60 * 60 * 1000 + 11 * 60 * 1000,
        trigger: "manual",
        fileExists: false,
        events: ["info · Download started", "info · Canceled by you"],
      },
      {
        id: "history-blade-runner-failed",
        jobId: "job-blade-runner-2049",
        mediaId: "blade-runner-2049",
        label: "Blade Runner 2049",
        status: "failed",
        quality: "4K · Blu-ray · English",
        provider: "TorBox",
        destination: "Movies/Blade Runner 2049 (2017)/Blade Runner 2049.mkv",
        size: 0,
        season: 1,
        episodes: [],
        attempt: 1,
        startedAt: now - 4 * 24 * 60 * 60 * 1000,
        finishedAt: now - 4 * 24 * 60 * 60 * 1000 + 2 * 60 * 1000,
        trigger: "manual",
        error: "Source link expired before the transfer started.",
        fileExists: false,
        events: ["error · Source link expired", "info · Retry remains available in Downloads"],
      },
    ],
    rules: ["interstellar", "severance", "silo", "foundation", "dune", "dark"].map(
      (mediaId, i) => ({
        id: `rule-${mediaId}`,
        mediaId,
        name: mediaById(mediaId).title,
        quality: i === 1 || i === 3 ? "1080p+" : "4K",
        language: i === 5 ? "German" : "English",
        frequency: "6 hours",
        cron: "0 */6 * * *",
        timezone: "America/Anchorage",
        window: "Any time",
        destination: "Movies",
        skipExisting: true,
        future: mediaById(mediaId).kind === "series",
        season: 1,
        status: i === 2 ? "paused" : i === 3 ? "error" : i === 4 ? "complete" : "active",
        result: [
          "No quality match yet",
          "Watching for new episodes",
          "Paused by you",
          "Provider needs reconnecting",
          "Downloaded successfully",
          "No source for 2 episodes",
        ][i]!,
        history: [
          "Today, 09:00 · No new matching sources",
          "Yesterday, 21:00 · Existing files skipped",
        ],
      }),
    ),
    library: [
      "interstellar",
      "dune",
      "arrival",
      "the-batman",
      "past-lives",
      "grand-budapest",
      "severance",
      "dark",
    ].map((mediaId, i) => ({
      id: `file-${mediaId}`,
      mediaId,
      quality: i === 0 || i === 1 || i === 3 ? "4K" : "1080p",
      size: [21.8, 16.4, 8.1, 18.6, 6.2, 7.8, 23.4, 42.8][i]!,
      missing: false,
      episodes:
        mediaId === "severance"
          ? [1, 2]
          : mediaId === "dark"
            ? Array.from({ length: 26 }, (_, n) => n + 1)
            : [],
      season: 1,
      path: `${mediaById(mediaId).kind === "series" ? "Series" : "Movies"}/${mediaById(mediaId).title} (${mediaById(mediaId).year})`,
    })),
  };
}
export function enqueue(
  state: DemoState,
  input: Pick<Job, "mediaId" | "quality" | "size" | "destination" | "episodes" | "season"> & {
    uncached?: boolean;
  },
): { state: DemoState; added: boolean; reason?: string } {
  const reject = (reason: string) => ({ state, added: false, reason });
  if (!state.preferences.provider || state.scenario === "provider-error")
    return reject("Connect the demo provider in Settings first.");
  if (state.scenario === "offline")
    return reject("You're offline. Reconnect before adding a download.");
  if (state.scenario === "storage-error" || input.destination.includes("External"))
    return reject("Destination unavailable. Choose a local folder.");
  if (state.scenario === "no-source")
    return reject("No source is available. Create a monitoring rule.");
  if (!state.preferences.addons.some((a) => a.enabled && a.id !== "cinemeta"))
    return reject("Enable a source add-on in Settings first.");
  const quality = (value: string) => value.match(/4K|1080p|720p/)?.[0] ?? value;
  const related = state.jobs.filter(
    (j) =>
      j.mediaId === input.mediaId &&
      j.season === input.season &&
      j.status !== "failed" &&
      quality(j.quality) === quality(input.quality),
  );
  const known = state.library.filter(
    (f) => f.mediaId === input.mediaId && !f.missing && f.season === input.season,
  );
  if (!input.episodes.length && mediaById(input.mediaId).kind === "series")
    return reject("Select at least one episode.");
  if (!input.episodes.length && related.length)
    return reject("This release is already in Downloads.");
  if (
    state.preferences.duplicates &&
    !input.episodes.length &&
    known.some((f) => quality(f.quality) === quality(input.quality))
  )
    return reject("This quality is already in your library.");
  const episodes = [...new Set(input.episodes)].filter(
    (e) =>
      !related.some((j) => j.episodes.includes(e)) &&
      (!state.preferences.duplicates || !known.some((f) => f.episodes.includes(e))),
  );
  if (input.episodes.length && !episodes.length)
    return reject("All selected episodes are already in your library or queue.");
  const job: Job = {
    ...input,
    episodes,
    id: crypto.randomUUID(),
    label: mediaById(input.mediaId).title + (episodes.length ? ` · Season ${input.season}` : ""),
    progress: 0,
    speed: 0,
    status: input.uncached
      ? "preparing"
      : state.preferences.transferWindow !== "Any time"
        ? "scheduled"
        : "queued",
    events: ["Queued in demo workspace. No transfer started."],
  };
  return { added: true, state: { ...state, jobs: [...state.jobs, job] } };
}
export function changeJob(state: DemoState, id: string, status: JobStatus): DemoState {
  return {
    ...state,
    jobs: state.jobs.map((j) =>
      j.id === id
        ? {
            ...j,
            status,
            speed: status === "active" ? j.speed : 0,
            events: [`Demo: ${status}`, ...j.events],
          }
        : j,
    ),
  };
}
export function saveRule(state: DemoState, rule: Rule): DemoState {
  return {
    ...state,
    rules: state.rules.some((r) => r.id === rule.id)
      ? state.rules.map((r) => (r.id === rule.id ? rule : r))
      : [...state.rules, rule],
  };
}
export function validateCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return (
    fields.length === 5 &&
    fields.every((field, i) =>
      field.split(",").every((part) => {
        if (!/^(\*|\d+(-\d+)?)(\/\d+)?$/.test(part)) return false;
        const [range, step] = part.split("/");
        if (step !== undefined && (+step < 1 || +step > bounds[i]![1]!)) return false;
        if (range === "*") return true;
        const nums = range!.split("-").map(Number);
        return (
          nums.every((n) => n >= bounds[i]![0]! && n <= bounds[i]![1]!) &&
          (nums.length === 1 || nums[0]! <= nums[1]!)
        );
      }),
    )
  );
}
export function upcomingChecks(cron: string, zone: string, now = new Date()): string[] {
  if (!validateCron(cron)) return [];
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    minute: "2-digit",
    hour: "2-digit",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const fields = cron.trim().split(/\s+/);
  const week = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const matches = (f: string, n: number, minimum = 0) =>
    f.split(",").some((p) => {
      const [r, s] = p.split("/");
      const [a, b] = r === "*" ? [minimum, Infinity] : r!.split("-").map(Number);
      return n >= a! && n <= (b ?? a!) && (n - a!) % (s ? +s : 1) === 0;
    });
  const found: string[] = [];
  const start = Math.floor(+now / 60000) * 60000 + 60000;
  for (let t = start; t < start + 60 * 24 * 32 * 60000 && found.length < 3; t += 60000) {
    const parts = Object.fromEntries(format.formatToParts(t).map((p) => [p.type, p.value]));
    const values = [
      +parts.minute!,
      +parts.hour!,
      +parts.day!,
      +parts.month!,
      week.indexOf(parts.weekday!),
    ];
    const checks = fields.map(
      (f, i) =>
        matches(f, values[i]!, i === 2 || i === 3 ? 1 : 0) ||
        (i === 4 && values[i] === 0 && matches(f, 7)),
    );
    const dayMatch =
      fields[2] !== "*" && fields[4] !== "*" ? checks[2] || checks[4] : checks[2] && checks[4];
    if (checks[0] && checks[1] && checks[3] && dayMatch)
      found.push(
        new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          dateStyle: "medium",
          timeStyle: "short",
        }).format(t),
      );
  }
  return found;
}
