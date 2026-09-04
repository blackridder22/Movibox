import type { Meta } from "@/lib/cinemeta";
import { readActiveStremioAuthKey } from "@/lib/auth";
import { buildDebridClients } from "@/lib/debrid/registry";
import { enqueueDownload } from "@/lib/download/downloads-store";
import { readCurrentSettings } from "@/lib/settings";
import { gatherSubtitleAddons } from "@/lib/subtitles/addon-source";
import { searchSubtitles } from "@/lib/subtitles/search";
import { buildEpisodePipelineInput } from "@/lib/streams/episode-pipeline-input";
import { runPipeline } from "@/lib/streams/pipeline";
import { resolveStream, type ResolveResult } from "@/lib/streams/resolve";
import { buildStreamIds } from "@/lib/streams/stream-ids";
import type { ScoredStream } from "@/lib/streams/types";
import type { PlayEpisode } from "@/lib/view";
import { discoverAddons } from "@/views/play-picker/use-addons";
import { resolveImdbId } from "@/views/play-picker/use-imdb-id";

export type QualityProfile = "best" | "balanced" | "1080p" | "4k" | "efficient";

export type AcquireMediaInput = {
  meta: Meta;
  episode?: PlayEpisode;
  qualityProfile?: QualityProfile | string;
  destination?: string | null;
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  scheduledAt?: number | null;
  signal?: AbortSignal;
};

export type AcquireMediaResult = {
  jobId: string;
  provider: string;
  stream: ScoredStream;
};

export type AcquisitionSourceContext = {
  meta: Meta;
  episode?: PlayEpisode;
  qualityProfile: string;
  audioLanguage: string | null;
  subtitleLanguage: string | null;
  streamIds: string[];
  imdbId: string | null;
  addonId?: string;
  addonUrl?: string;
  parsedTitle?: string;
};

export type SelectedAcquisitionSource = {
  stream: ScoredStream;
  resolved: Extract<ResolveResult, { ok: true }>;
  streamLabel: string;
  context: AcquisitionSourceContext;
  subtitleSidecar: {
    url: string;
    language: string;
    format?: string;
    label?: string;
  } | null;
};

const LANGUAGE_ALIASES: Record<string, string[]> = {
  english: ["english", "eng", "en"],
  japanese: ["japanese", "jpn", "ja"],
  french: ["french", "fra", "fre", "fr"],
  spanish: ["spanish", "spa", "es"],
  german: ["german", "deu", "ger", "de"],
  italian: ["italian", "ita", "it"],
  portuguese: ["portuguese", "por", "pt"],
  korean: ["korean", "kor", "ko"],
  chinese: ["chinese", "zho", "chi", "zh"],
  hindi: ["hindi", "hin", "hi"],
  arabic: ["arabic", "ara", "ar"],
  russian: ["russian", "rus", "ru"],
};

function languageAliases(language: string): string[] {
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized] ?? [normalized];
}

function languageValueMatches(value: string, language: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_-].*$/, "");
  return languageAliases(language).some(
    (alias) => normalized === alias || normalized.startsWith(`${alias} `),
  );
}

export function streamMatchesRequestedAudio(stream: ScoredStream, language: string): boolean {
  if (!language) return true;
  if (stream.audioLanguages.some((value) => languageValueMatches(value, language))) return true;
  const title = `${stream.parsedTitle} ${stream.title ?? ""} ${stream.name ?? ""}`;
  const aliases = languageAliases(language);
  return aliases.some((alias) => new RegExp(`\\b${alias}\\b`, "i").test(title));
}

export function filterStreamsForAudio(
  streams: ScoredStream[],
  language?: string | null,
): ScoredStream[] {
  if (!language) return streams;
  return streams.filter((stream) => streamMatchesRequestedAudio(stream, language));
}

export function filterStreamsForQuality(
  streams: ScoredStream[],
  profile?: string | null,
): ScoredStream[] {
  if (!profile || profile === "best") return streams;
  if (profile === "4k") return streams.filter((stream) => stream.resolution === "4K");
  if (profile === "1080p") return streams.filter((stream) => stream.resolution === "1080p");
  if (profile === "efficient") {
    return streams
      .filter((stream) => stream.resolution === "1080p" || stream.resolution === "720p")
      .slice()
      .sort((a, b) => (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER));
  }
  if (profile === "balanced") {
    return streams.filter(
      (stream) => stream.resolution === "1080p" || stream.resolution === "720p",
    );
  }
  return streams;
}

function pickForProfile(streams: ScoredStream[], profile: string): ScoredStream | null {
  if (streams.length === 0) return null;
  if (profile === "4k") return streams.find((stream) => stream.resolution === "4K") ?? streams[0];
  if (profile === "1080p") {
    return (
      streams.find((stream) => stream.resolution === "1080p") ??
      streams.find((stream) => stream.resolution === "720p") ??
      streams[0]
    );
  }
  if (profile === "efficient") {
    const efficient = streams
      .filter((stream) => stream.resolution === "1080p" || stream.resolution === "720p")
      .sort((a, b) => (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER));
    return efficient[0] ?? streams.at(-1) ?? streams[0];
  }
  if (profile === "balanced") {
    return streams.find((stream) => stream.resolution === "1080p") ?? streams[0];
  }
  return streams[0];
}

export async function findSubtitleSidecarForStream({
  meta,
  episode,
  subtitleLanguage,
  authKey,
  imdbId,
  streamIds,
  stream,
  settings,
}: {
  meta: Meta;
  episode?: PlayEpisode;
  subtitleLanguage?: string | null;
  authKey: string | null;
  imdbId: string | null;
  streamIds: string[];
  stream: ScoredStream;
  settings: ReturnType<typeof readCurrentSettings>;
}): Promise<SelectedAcquisitionSource["subtitleSidecar"]> {
  const requested = subtitleLanguage?.trim();
  if (!requested) return null;
  const subtitleAddons = await gatherSubtitleAddons(authKey);
  const results = await searchSubtitles(
    {
      imdbId: imdbId ?? undefined,
      stremioId: streamIds.find((id) => id.startsWith("tt")) ?? streamIds[0] ?? meta.id,
      type: meta.type === "movie" ? "movie" : "series",
      title: meta.name,
      season: episode?.imdbSeason ?? episode?.season,
      episode: episode?.imdbEpisode ?? episode?.episode,
      langs: [requested],
      filename: stream.parsedTitle,
      videoSize: stream.size ?? undefined,
    },
    {
      providers: settings.subProvidersEnabled,
      addons: subtitleAddons,
      preferredLangs: [requested],
    },
  );
  const match = results.find((result) => languageValueMatches(result.lang ?? "", requested));
  if (!match) {
    throw new Error(
      `No ${requested} subtitle was found. Nothing was queued; choose another subtitle language or None.`,
    );
  }
  return {
    url: match.url,
    language: requested,
    format: match.format,
    label: match.title,
  };
}

export async function selectAcquisitionSource(
  input: AcquireMediaInput,
): Promise<SelectedAcquisitionSource> {
  const signal = input.signal ?? new AbortController().signal;
  const settings = readCurrentSettings();
  const authKey = readActiveStremioAuthKey();
  const [{ addons }, imdb] = await Promise.all([
    discoverAddons(authKey, settings),
    resolveImdbId(input.meta, settings.tmdbKey),
  ]);
  if (signal.aborted) throw new DOMException("Download selection canceled", "AbortError");
  const debrids = buildDebridClients({
    rdKey: settings.rdKey,
    tbKey: settings.tbKey,
    adKey: settings.adKey,
    pmKey: settings.pmKey,
    dlKey: settings.dlKey,
  });
  const streamIds = buildStreamIds(
    input.meta.id,
    input.episode,
    imdb.id,
    input.meta.behaviorHints?.defaultVideoId,
  );
  const pipeline = await runPipeline(
    buildEpisodePipelineInput({
      meta: input.meta,
      episode: input.episode,
      imdbId: imdb.id,
      streamIds,
      addons,
      debrids,
      settings,
      strictMode: false,
      filterDisabled: false,
    }),
    signal,
  );
  const audioSafe = filterStreamsForAudio(pipeline.picker.all, input.audioLanguage);
  if (input.audioLanguage && audioSafe.length === 0) {
    throw new Error(
      `No source explicitly identifies ${input.audioLanguage} audio. Nothing was queued.`,
    );
  }
  const qualitySafe = filterStreamsForQuality(audioSafe, input.qualityProfile ?? "balanced");
  const qualityProfile = input.qualityProfile ?? "balanced";
  if (qualityProfile !== "best" && qualitySafe.length === 0) {
    throw new Error(
      "No " + qualityProfile + " source matches the selected audio language. Nothing was queued.",
    );
  }
  const stream = pickForProfile(qualitySafe, qualityProfile);
  if (!stream) throw new Error("No downloadable source was returned by your Stremio add-ons");
  const resolved = await resolveStream(
    stream,
    debrids,
    signal,
    true,
    false,
    input.episode
      ? {
          season: input.episode.imdbSeason ?? input.episode.season,
          episode: input.episode.imdbEpisode ?? input.episode.episode,
        }
      : undefined,
  );
  if (!resolved.ok) throw new Error(`Could not resolve a downloadable source (${resolved.code})`);
  const subtitleSidecar = await findSubtitleSidecarForStream({
    meta: input.meta,
    episode: input.episode,
    subtitleLanguage: input.subtitleLanguage,
    authKey,
    imdbId: imdb.id,
    streamIds,
    stream,
    settings,
  });
  const streamLabel = [
    stream.resolution,
    stream.source,
    stream.audioLanguages.length ? stream.audioLanguages.join("/") : null,
    stream.releaseGroup,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    stream,
    resolved,
    streamLabel,
    context: {
      meta: input.meta,
      episode: input.episode,
      qualityProfile: input.qualityProfile ?? "balanced",
      audioLanguage: input.audioLanguage?.trim() || null,
      subtitleLanguage: input.subtitleLanguage?.trim() || null,
      streamIds,
      imdbId: imdb.id,
      addonId: stream.addonId,
      addonUrl: stream.addonUrl,
      parsedTitle: stream.parsedTitle,
    },
    subtitleSidecar,
  };
}

export async function acquireMedia(input: AcquireMediaInput): Promise<AcquireMediaResult> {
  const { stream, resolved, streamLabel, context, subtitleSidecar } =
    await selectAcquisitionSource(input);
  const jobId = await enqueueDownload({
    meta: input.meta,
    episode: input.episode,
    streamLabel,
    provider: resolved.via,
    infoHash: stream.infoHash ?? null,
    fileIndex: stream.fileIdx ?? null,
    sourceContext: context,
    url: resolved.data.url,
    headers: resolved.data.headers ?? null,
    destinationDir: input.destination ?? null,
    scheduledAt: input.scheduledAt ?? null,
    subtitleSidecar,
  });
  return { jobId, provider: resolved.via, stream };
}
