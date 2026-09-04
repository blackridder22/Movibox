export type Page =
  | "discover"
  | "downloads"
  | "history"
  | "monitoring"
  | "library"
  | "settings"
  | "setup";
export type Media = {
  tmdbId?: number;
  catalog?: string;
  id: string;
  title: string;
  description?: string;
  year: string;
  kind: "movie" | "series";
  genre: string;
  genres: string[];
  runtime: string;
  rating: number;
  poster: string;
  episodes: { title: string; season: number; episode: number; released: string }[];
};
export type JobStatus =
  | "active"
  | "queued"
  | "paused"
  | "failed"
  | "completed"
  | "preparing"
  | "scheduled"
  | "canceled";
export type SubtitleTask = {
  ruleId?: string;
  reason?: string;
  id: string;
  jobId?: string;
  label?: string;
  bundleId?: string;
  season?: number;
  episodes?: number[];
  state: string;
  message: string;
  language: string;
  nextCheckAt: number;
  quotaUntil?: number;
};
export type Job = {
  provider?: string;
  cloud?: {
    provider: string;
    phase: string;
    message: string;
    progress: number;
    lastCheckedAt: number;
    nextCheckAt: number;
  };
  subtitles?: SubtitleTask[];
  bundleId?: string;
  id: string;
  mediaId: string;
  label: string;
  quality: string;
  size: number;
  progress: number;
  status: JobStatus;
  speed: number;
  destination: string;
  episodes: number[];
  season: number;
  events: string[];
  error?: string;
  receivedBytes?: number;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  attempt?: number;
  trigger?: "manual" | "monitoring";
  ruleId?: string;
};
export type DownloadHistoryEntry = {
  id: string;
  jobId: string;
  mediaId: string;
  label: string;
  status: "completed" | "failed" | "canceled";
  quality: string;
  provider?: string;
  destination: string;
  size: number;
  season: number;
  episodes: number[];
  attempt: number;
  startedAt: number;
  finishedAt: number;
  trigger: "manual" | "monitoring";
  ruleId?: string;
  bundleId?: string;
  error?: string;
  fileExists: boolean;
  events: string[];
};
export type Rule = {
  scheduleMode?: "manual" | "scheduled";
  subtitleExisting?: boolean;
  subtitleRepair?: { queued: number; videos: number; missing: number };
  subtitleMode?: "global" | "off" | "custom";
  subtitleLanguages?: string[];
  running?: boolean;
  nextCheckAt?: number | null;
  lastCheckedAt?: number;
  episodes?: number[];
  id: string;
  mediaId: string;
  name: string;
  quality: string;
  language: string;
  frequency: string;
  cron: string;
  timezone: string;
  window: string;
  destination: string;
  skipExisting: boolean;
  future: boolean;
  season: number;
  status: "active" | "paused" | "error" | "complete";
  result: string;
  history: string[];
};
export type LibraryEntry = {
  subtitles?: Job["subtitles"];
  id: string;
  mediaId: string;
  quality: string;
  size: number;
  missing: boolean;
  episodes: number[];
  season: number;
  path: string;
};
export type RecentSearch = {
  id: string;
  query: string;
  mediaId?: string;
  title?: string;
  kind?: "movie" | "series";
  searchedAt: number;
};
export type WatchState = {
  mediaId: string;
  movieWatchedAt?: number;
  episodes: { season: number; episode: number; watchedAt: number }[];
  updatedAt: number;
};
export type Preferences = {
  autoCheckUpdates?: boolean;
  customCursor?: boolean;
  catalogProvider?: "addons" | "tmdb";
  catalogLanguage?: string;
  tmdbConnected?: boolean;
  defaultProvider?: "torbox" | "realdebrid";
  providerAccounts?: Record<string, { connected: boolean }>;
  subtitlesEnabled?: boolean;
  subtitleLanguage?: string;
  subtitleAddons?: boolean;
  subtitleExactOnly?: boolean;
  subtitlesAccount?: { connected: boolean; signedIn?: boolean };
  provider: boolean;
  sourcePreference: string;
  sourceTimeout: string;
  addons: { id: string; name: string; url: string; enabled: boolean; capabilities?: string[] }[];
  folder: string;
  movieFolder: string;
  seriesFolder: string;
  naming: string;
  reserve: string;
  cleanup: boolean;
  quality: string;
  language: string;
  maxSize: string;
  concurrency: string;
  bandwidth: string;
  retries: string;
  duplicates: boolean;
  frequency: string;
  cron: string;
  timezone: string;
  transferWindow: string;
  autoStart: boolean;
  background: boolean;
  catchUp: boolean;
  sidebarCollapsed: boolean;
  theme: string;
  accent: string;
  density: string;
  radius: string;
  glass: boolean;
  shadows: boolean;
  motion: string;
  notifications: boolean;
  notifyComplete: boolean;
  notifyError: boolean;
  notifyMatch: boolean;
  notifyTitles: boolean;
  notifySound: boolean;
  quietHours: string;
  shortcuts: Record<string, string>;
  setupComplete: boolean;
};
export type Scenario =
  | "normal"
  | "empty"
  | "offline"
  | "no-source"
  | "provider-error"
  | "storage-error"
  | "loading";
export type Preparation = {
  id: string;
  title: string;
  season: number;
  state: string;
  message: string;
  nextCheckAt: number;
};
export type DemoState = {
  subtitleTasks?: SubtitleTask[];
  searches?: SearchTask[];
  preparations?: Preparation[];
  indexers?: Indexer[];
  bundles?: Bundle[];
  version: 1;
  jobs: Job[];
  history: DownloadHistoryEntry[];
  recentSearches: RecentSearch[];
  watchStates: WatchState[];
  rules: Rule[];
  library: LibraryEntry[];
  preferences: Preferences;
  scenario: Scenario;
};

export type Indexer = {
  id: string;
  name: string;
  origin: string;
  enabled: boolean;
  hasKey: boolean;
  capabilities: Record<string, unknown>;
};
export type BundleRow = {
  episode: number;
  title: string;
  status: "existing" | "ready" | "pending" | "missing";
  reason: string;
  sourceId?: string;
  sourceName?: string;
  filename?: string;
  size?: number;
  quality?: string;
  languageEvidence: string;
  pack: boolean;
};
export type Bundle = {
  health?: {
    videos: number;
    total: number;
    subtitles: {
      language: string;
      ready: number;
      total: number;
      waiting: number;
      failed: number;
    }[];
  };
  id: string;
  mediaId: string;
  title: string;
  season: number;
  createdAt: number;
  sourceCount: number;
  jobIds: string[];
  rows: BundleRow[];
  unresolved: number[];
};

export type SearchTask = {
  id: string;
  kind: "bundle" | "sources";
  mediaId: string;
  title: string;
  state: "queued" | "running" | "complete" | "error" | "canceled";
  message: string;
  destination?: string;
  createdAt: number;
  request: {
    id: string;
    season?: number;
    episodes?: number[];
    method?: string;
    quality?: string;
    language?: string;
  };
};
