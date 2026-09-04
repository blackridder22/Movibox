import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { downloadDir as systemDownloadDir } from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { useSyncExternalStore } from "react";
import type { Meta } from "@/lib/cinemeta";
import { isWindowsDesktop } from "@/lib/platform";
import type { PlayEpisode } from "@/lib/view";
import { buildDefaultFilename, sanitizeName } from "./filename";

export type DownloadStatus =
  | "queued"
  | "scheduled"
  | "paused"
  | "downloading"
  | "done"
  | "error"
  | "canceled"
  | "canceling"
  | "interrupted"
  | "needsResolution";

export type DownloadItem = {
  id: string;
  metaId: string;
  mediaType: string;
  title: string;
  subtitle: string | null;
  poster: string | null;
  season: number | null;
  episode: number | null;
  streamLabel: string | null;
  provider: string | null;
  infoHash: string | null;
  fileIndex: number | null;
  sourceContext: unknown;
  url: string;
  path: string;
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes: number | null;
  ratio: number;
  bytesPerSec: number;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  scheduledAt: number | null;
};

export type SubtitleSidecar = {
  url: string;
  language: string;
  format?: string;
  label?: string;
};

export type EnqueueArgs = {
  meta: Meta;
  episode?: PlayEpisode;
  streamLabel?: string | null;
  provider?: string | null;
  infoHash?: string | null;
  fileIndex?: number | null;
  sourceContext?: unknown;
  url: string;
  headers?: Record<string, string> | null;
  destinationDir?: string | null;
  scheduledAt?: number | null;
  subtitleSidecar?: SubtitleSidecar | null;
};

type NativeJob = {
  id: string;
  mediaId: string;
  mediaType: string;
  title: string;
  subtitle: string | null;
  poster: string | null;
  season: number | null;
  episode: number | null;
  streamLabel: string | null;
  provider: string | null;
  infoHash: string | null;
  fileIndex: number | null;
  sourceContext: unknown;
  url: string;
  path: string;
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  scheduledAt: number | null;
};

const items = new Map<string, DownloadItem>();
const speed = new Map<string, { bytes: number; at: number; bps: number }>();
const listeners = new Set<() => void>();
let snapshot: DownloadItem[] = [];
let bridgePromise: Promise<void> | null = null;
let unlisten: UnlistenFn | null = null;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function fromNative(job: NativeJob): DownloadItem {
  const previous = speed.get(job.id);
  let bytesPerSec = previous?.bps ?? 0;
  if (previous && job.updatedAt > previous.at && job.receivedBytes >= previous.bytes) {
    const elapsed = job.updatedAt - previous.at;
    if (elapsed >= 500) {
      bytesPerSec = ((job.receivedBytes - previous.bytes) / elapsed) * 1000;
      speed.set(job.id, { bytes: job.receivedBytes, at: job.updatedAt, bps: bytesPerSec });
    }
  } else {
    speed.set(job.id, { bytes: job.receivedBytes, at: job.updatedAt, bps: 0 });
  }
  if (job.status !== "downloading") bytesPerSec = 0;
  return {
    id: job.id,
    metaId: job.mediaId,
    mediaType: job.mediaType,
    title: job.title,
    subtitle: job.subtitle,
    poster: job.poster,
    season: job.season,
    episode: job.episode,
    streamLabel: job.streamLabel,
    provider: job.provider,
    infoHash: job.infoHash,
    fileIndex: job.fileIndex,
    sourceContext: job.sourceContext,
    url: job.url,
    path: job.path,
    status: job.status,
    receivedBytes: job.receivedBytes,
    totalBytes: job.totalBytes,
    ratio: job.totalBytes ? Math.min(1, job.receivedBytes / job.totalBytes) : 0,
    bytesPerSec,
    error: job.error,
    startedAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    scheduledAt: job.scheduledAt,
  };
}

function rebuild(): void {
  snapshot = [...items.values()].sort((a, b) => b.startedAt - a.startedAt);
  listeners.forEach((listener) => listener());
}

function upsert(job: NativeJob): void {
  items.set(job.id, fromNative(job));
  rebuild();
}

async function startBridge(): Promise<void> {
  if (!isTauri()) return;
  if (bridgePromise) return bridgePromise;
  bridgePromise = (async () => {
    unlisten?.();
    unlisten = await listen<NativeJob>("movibox://acquisition-updated", ({ payload }) =>
      upsert(payload),
    );
    const jobs = await invoke<NativeJob[]>("acquisition_list");
    items.clear();
    for (const job of jobs) items.set(job.id, fromNative(job));
    rebuild();
  })().catch((error) => {
    bridgePromise = null;
    console.error("[movibox] acquisition bridge failed", error);
  });
  return bridgePromise;
}

function sep(): string {
  return isWindowsDesktop() ? "\\" : "/";
}

async function resolveDir(): Promise<string> {
  try {
    const raw =
      localStorage.getItem("movibox.settings.v1") ?? localStorage.getItem("harbor.settings");
    const fromSettings = raw
      ? (JSON.parse(raw) as { downloadDir?: string }).downloadDir?.trim()
      : "";
    if (fromSettings) return fromSettings;
  } catch {
    // Fall through to the operating-system default.
  }
  return (await systemDownloadDir().catch(() => "")) || "";
}

async function pathTaken(path: string): Promise<boolean> {
  for (const download of items.values()) if (download.path === path) return true;
  return exists(path).catch(() => false);
}

async function uniquePath(path: string): Promise<string> {
  if (!(await pathTaken(path))) return path;
  const separator = sep();
  const slash = path.lastIndexOf(separator);
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const extension = dot > 0 ? file.slice(dot) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${dir}${stem} (${index})${extension}`;
    if (!(await pathTaken(candidate))) return candidate;
  }
  return path;
}

export function activeDownloadFor(
  metaId: string,
  season?: number | null,
  episode?: number | null,
): DownloadItem | null {
  for (const download of items.values()) {
    if (download.mediaType === "subtitle") continue;
    if (download.metaId !== metaId) continue;
    if (season != null && episode != null) {
      if (download.season !== season || download.episode !== episode) continue;
    } else if (download.season != null || download.episode != null) {
      continue;
    }
    return download;
  }
  return null;
}

export async function enqueueDownload(args: EnqueueArgs): Promise<string> {
  if (!isTauri()) throw new Error("MoviBox downloads require the desktop app");
  await startBridge();
  const { meta, episode, streamLabel, url, headers } = args;
  let dir = args.destinationDir?.trim() || (await resolveDir());
  try {
    const raw =
      localStorage.getItem("movibox.settings.v1") ?? localStorage.getItem("harbor.settings");
    const settings = raw ? (JSON.parse(raw) as { downloadCreateFolders?: boolean }) : null;
    if (settings?.downloadCreateFolders && dir) {
      const folderName = sanitizeName(meta.name || "download");
      dir = `${dir}${dir.endsWith(sep()) ? "" : sep()}${folderName}`;
      if (episode) {
        const season = episode.imdbSeason ?? episode.season;
        dir = `${dir}${sep()}Season ${String(season).padStart(2, "0")}`;
      }
      await mkdir(dir, { recursive: true }).catch(() => undefined);
    }
  } catch {
    // The native downloader will still create the final parent directory.
  }
  const filename = buildDefaultFilename(meta, episode, url, streamLabel);
  const path = await uniquePath(
    dir ? `${dir}${dir.endsWith(sep()) ? "" : sep()}${filename}` : filename,
  );
  const subtitle = episode
    ? `S${episode.imdbSeason ?? episode.season} · E${String(episode.imdbEpisode ?? episode.episode).padStart(2, "0")}${episode.name ? ` · ${episode.name}` : ""}`
    : (meta.releaseInfo ?? null);
  const job = await invoke<NativeJob>("acquisition_enqueue", {
    input: {
      mediaId: meta.id,
      mediaType: meta.type,
      title: meta.name ?? "Download",
      subtitle,
      poster: meta.poster ?? null,
      season: episode?.season ?? null,
      episode: episode?.episode ?? null,
      streamLabel: streamLabel ?? null,
      provider: args.provider ?? null,
      infoHash: args.infoHash ?? null,
      fileIndex: args.fileIndex ?? null,
      sourceContext: args.sourceContext ?? null,
      url,
      headers: headers ?? {},
      path,
      scheduledAt: args.scheduledAt ?? null,
    },
  });
  upsert(job);
  if (args.subtitleSidecar) {
    const requestedFormat = args.subtitleSidecar.format?.toLowerCase().replace(/[^a-z0-9]/g, "");
    const format =
      requestedFormat && ["srt", "vtt", "ass", "ssa"].includes(requestedFormat)
        ? requestedFormat
        : "srt";
    const dot = path.lastIndexOf(".");
    const stem = dot > path.lastIndexOf(sep()) ? path.slice(0, dot) : path;
    const lang = sanitizeName(args.subtitleSidecar.language).replace(/\s+/g, ".");
    const subtitlePath = await uniquePath(`${stem}.${lang}.${format}`);
    const sidecar = await invoke<NativeJob>("acquisition_enqueue", {
      input: {
        mediaId: meta.id,
        mediaType: "subtitle",
        title: meta.name ?? "Subtitle",
        subtitle: `${args.subtitleSidecar.language} subtitle sidecar`,
        poster: meta.poster ?? null,
        season: episode?.season ?? null,
        episode: episode?.episode ?? null,
        streamLabel: args.subtitleSidecar.label ?? "Subtitle addon",
        provider: "subtitle",
        infoHash: null,
        fileIndex: null,
        sourceContext: null,
        url: args.subtitleSidecar.url,
        headers: {},
        path: subtitlePath,
        scheduledAt: args.scheduledAt ?? null,
      },
    });
    upsert(sidecar);
  }
  return job.id;
}

export function cancelDownload(id: string): void {
  void invoke<NativeJob>("acquisition_cancel", { id }).then(upsert);
}

export function pauseDownload(id: string): void {
  void invoke<NativeJob>("acquisition_pause", { id }).then(upsert);
}

export function resumeDownload(id: string): void {
  void invoke<NativeJob>("acquisition_resume", { id }).then(upsert);
}

export async function pauseAllDownloads(): Promise<void> {
  const jobs = await invoke<NativeJob[]>("acquisition_pause_all");
  for (const job of jobs) upsert(job);
}

export async function resumeAllDownloads(): Promise<void> {
  const jobs = await invoke<NativeJob[]>("acquisition_resume_all");
  for (const job of jobs) upsert(job);
}

export function retryDownload(id: string): void {
  void invoke<NativeJob>("acquisition_retry", { id }).then(upsert);
}

export async function refreshExpiredDownload(id: string): Promise<void> {
  const item = items.get(id);
  const context = item?.sourceContext as
    | {
        meta?: Meta;
        episode?: PlayEpisode;
        qualityProfile?: string;
        audioLanguage?: string | null;
        subtitleLanguage?: string | null;
      }
    | undefined;
  if (!item || !context?.meta) {
    throw new Error("This older job has no source recipe. Choose the episode again to refresh it.");
  }
  const { selectAcquisitionSource } = await import("@/lib/acquisition/source-selection");
  const selected = await selectAcquisitionSource({
    meta: context.meta,
    episode: context.episode,
    qualityProfile: context.qualityProfile ?? "balanced",
    audioLanguage: context.audioLanguage ?? null,
    subtitleLanguage: context.subtitleLanguage ?? null,
  });
  const job = await invoke<NativeJob>("acquisition_refresh_source", {
    id,
    url: selected.resolved.data.url,
    headers: selected.resolved.data.headers ?? {},
    provider: selected.resolved.via,
    sourceContext: selected.context,
  });
  upsert(job);
}

export function removeDownload(id: string, deleteFile = true): void {
  void invoke("acquisition_remove", { id, deleteFile }).then(() => {
    items.delete(id);
    speed.delete(id);
    rebuild();
  });
}

export async function revealDownload(id: string): Promise<void> {
  await invoke("acquisition_reveal", { id });
}

export async function openDownloadExternal(id: string): Promise<void> {
  await invoke("acquisition_open", { id });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void startBridge();
  return () => listeners.delete(listener);
}

export function useDownloads(): DownloadItem[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

export function useActiveDownloadCount(): number {
  const all = useDownloads();
  return all.filter((download) =>
    ["queued", "scheduled", "downloading", "canceling"].includes(download.status),
  ).length;
}

export async function refreshDownloads(): Promise<DownloadItem[]> {
  await startBridge();
  if (isTauri()) {
    const jobs = await invoke<NativeJob[]>("acquisition_list");
    items.clear();
    for (const job of jobs) items.set(job.id, fromNative(job));
    rebuild();
  }
  return snapshot;
}
