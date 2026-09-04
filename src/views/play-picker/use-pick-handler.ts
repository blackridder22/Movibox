import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Meta } from "@/lib/cinemeta";
import type { DebridStore } from "@/lib/debrid/types";
import { enqueueDownload } from "@/lib/download/downloads-store";
import {
  findSubtitleSidecarForStream,
  streamMatchesRequestedAudio,
} from "@/lib/acquisition/source-selection";
import type { Settings } from "@/lib/settings";
import { resolveStream } from "@/lib/streams/resolve";
import type { ScoredStream } from "@/lib/streams/types";
import type { PlayEpisode } from "@/lib/view";
import { humanError, isDebridFailure } from "./picker-utils";

const SAME_SOURCE_MAX_RETRIES = 4;
const SAME_SOURCE_RETRY_DELAY_MS = 1_500;

export function usePickHandler({
  meta,
  episode,
  debrids,
  onDownloadStarted,
  setFailedStreams,
  setResolveError,
  setResolving,
  authKey,
  settings,
  imdbId,
  streamIds,
  qualityProfile,
  audioLanguage,
  subtitleLanguage,
  scheduledAt,
}: {
  meta: Meta;
  episode?: PlayEpisode;
  debrids: DebridStore[];
  onDownloadStarted?: (label?: string | null) => void;
  setFailedStreams: Dispatch<SetStateAction<Set<ScoredStream>>>;
  setResolveError: (message: string | null) => void;
  setResolving: Dispatch<SetStateAction<{ stream: ScoredStream } | null>>;
  authKey: string | null;
  settings: Settings;
  imdbId: string | null;
  streamIds: string[];
  qualityProfile: string;
  audioLanguage: string;
  subtitleLanguage: string;
  scheduledAt: number | null;
}) {
  const resolveControllerRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  const clearRetry = () => {
    if (retryTimerRef.current == null) return;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  };

  const resolveAndDownload = async (stream: ScoredStream, retryCount = 0) => {
    if (audioLanguage && !streamMatchesRequestedAudio(stream, audioLanguage)) {
      setResolveError(
        "This source does not explicitly identify " + audioLanguage + " audio. Nothing was queued.",
      );
      setResolving(null);
      return;
    }
    const controller = new AbortController();
    resolveControllerRef.current?.abort();
    resolveControllerRef.current = controller;

    const episodeHint = episode
      ? { season: episode.season ?? null, episode: episode.episode ?? null }
      : undefined;
    const result = await resolveStream(
      stream,
      debrids,
      controller.signal,
      true,
      false,
      episodeHint,
    );
    if (controller.signal.aborted) return;

    if (!result.ok) {
      const canRetry =
        isDebridFailure(result.code, result.tried) && retryCount < SAME_SOURCE_MAX_RETRIES;
      if (canRetry) {
        const nextRetry = retryCount + 1;
        retryTimerRef.current = window.setTimeout(
          () => void resolveAndDownload(stream, nextRetry),
          SAME_SOURCE_RETRY_DELAY_MS * nextRetry,
        );
        return;
      }

      setFailedStreams((current) => new Set(current).add(stream));
      setResolveError(
        result.code === "web-page"
          ? "This source only opens a web page and cannot be downloaded. Choose another source."
          : humanError(result.code),
      );
      setResolving(null);
      return;
    }

    const label =
      [stream.resolution, stream.source].filter(Boolean).join(" ") ||
      stream.parsedTitle ||
      stream.title ||
      stream.name ||
      stream.addonName ||
      null;

    try {
      const subtitleSidecar = await findSubtitleSidecarForStream({
        meta,
        episode,
        subtitleLanguage,
        authKey,
        imdbId,
        streamIds,
        stream,
        settings,
      });
      await enqueueDownload({
        meta,
        episode,
        streamLabel: label,
        provider: result.via,
        infoHash: stream.infoHash ?? null,
        fileIndex: result.data.fileIdx ?? stream.fileIdx ?? null,
        sourceContext: {
          meta,
          episode,
          qualityProfile,
          audioLanguage: audioLanguage || null,
          subtitleLanguage: subtitleLanguage || null,
          streamIds,
          imdbId,
          addonId: stream.addonId,
          addonUrl: stream.addonUrl,
          parsedTitle: stream.parsedTitle,
        },
        url: result.data.url,
        headers: result.data.headers,
        scheduledAt,
        subtitleSidecar,
      });
      setResolving(null);
      onDownloadStarted?.(label);
    } catch (error) {
      setFailedStreams((current) => new Set(current).add(stream));
      setResolveError(
        error instanceof Error ? error.message : "Could not add this source to Downloads.",
      );
      setResolving(null);
    }
  };

  const onDownload = (stream: ScoredStream) => {
    clearRetry();
    setResolveError(null);
    setResolving({ stream });
    void resolveAndDownload(stream);
  };

  const abortResolve = () => {
    resolveControllerRef.current?.abort();
    resolveControllerRef.current = null;
    clearRetry();
    setResolving(null);
  };

  useEffect(
    () => () => {
      resolveControllerRef.current?.abort();
      if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
    },
    [],
  );

  return { onDownload, abortResolve };
}
