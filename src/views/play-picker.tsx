import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { AcquisitionPreferences, dateTimeInputToMs } from "@/components/acquisition-preferences";
import { filterStreamsForAudio, filterStreamsForQuality } from "@/lib/acquisition/source-selection";
import { useT } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import type { Meta } from "@/lib/cinemeta";
import { useDebridClients } from "@/lib/debrid/registry";
import { peekCachedLogo, resolveLogo } from "@/lib/logo";
import { useSettings } from "@/lib/settings";
import { isAddonRanked } from "@/lib/streams/addon-detect";
import { hasUncachedMarker } from "@/lib/streams/cached";
import type { ScoredStream } from "@/lib/streams/types";
import { torrentsDisabled } from "@/lib/torrent/stremio-stream";
import { useWindowFullscreen } from "@/lib/use-window-fullscreen";
import { exitWindowFullscreen } from "@/lib/fullscreen-state";
import { useScrollMemory, useView, type PlayEpisode } from "@/lib/view";
import { BackdropLayer } from "./play-picker/backdrop-layer";
import { CachedTip } from "./play-picker/cached-tip";
import { CinematicLoader } from "./play-picker/cinematic-loader";
import { NoSourcesConfiguredModal } from "./play-picker/no-sources-modal";
import { PickerEmptyLadder } from "./play-picker/picker-empty-ladder";
import { PickerHeader } from "./play-picker/picker-header";
import { hasCachedMarker, orderByAddonNative } from "./play-picker/picker-utils";
import { StremioLayout } from "./play-picker/stremio-layout";
import { useAddons } from "./play-picker/use-addons";
import { useImdbId } from "./play-picker/use-imdb-id";
import { usePickHandler } from "./play-picker/use-pick-handler";
import { usePipelineResult } from "./play-picker/use-pipeline-result";
import { useStreamIds } from "./play-picker/use-stream-ids";

type PlayPickerProps = {
  meta: Meta;
  episode?: PlayEpisode;
  autoPlay?: boolean;
  attempt?: number;
  intent?: "play" | "download";
  resume?: boolean;
};

export function PlayPicker({ meta, episode }: PlayPickerProps) {
  const { authKey } = useAuth();
  const { settings } = useSettings();
  const { openSettings, exitPickerToDetail, setView } = useView();
  const fullscreen = useWindowFullscreen();
  const debrids = useDebridClients();
  const resolvedImdb = useImdbId(meta, settings.tmdbKey);
  const streamIds = useStreamIds(meta, episode, resolvedImdb.id);
  const { addons, discovering: discoveringAddons } = useAddons(authKey, settings);
  const mainRef = useRef<HTMLElement>(null);
  const [strictMode, setStrictMode] = useState(settings.streamFilterLevel === "strict");
  const [forceShowAll, setForceShowAll] = useState(false);
  const [failedStreams, setFailedStreams] = useState<Set<ScoredStream>>(new Set());
  const [resolving, setResolving] = useState<{ stream: ScoredStream } | null>(null);
  const [maxWaitElapsed, setMaxWaitElapsed] = useState(false);
  const [qualityProfile, setQualityProfile] = useState("best");
  const [audioLanguage, setAudioLanguage] = useState("English");
  const [subtitleLanguage, setSubtitleLanguage] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [logo, setLogo] = useState<string | undefined>(() =>
    peekCachedLogo(settings.tmdbKey, meta, { preferOwn: true }),
  );

  useEffect(() => {
    let cancelled = false;
    void resolveLogo(settings.tmdbKey, meta, { preferOwn: true })
      .then((url) => {
        if (!cancelled && url) setLogo(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [meta, settings.tmdbKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setMaxWaitElapsed(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [streamIds]);

  const displayMeta = useMemo(() => (logo ? { ...meta, logo } : meta), [logo, meta]);
  const { result, loading, pipelineDone, resolveError, refresh, setResolveError } =
    usePipelineResult({
      meta,
      episode,
      imdbId: resolvedImdb.id,
      streamIds,
      addons,
      debrids,
      settings,
      strictMode,
      filterDisabled: forceShowAll,
    });

  const isCached = useCallback(
    (stream: ScoredStream) =>
      (stream.url != null && !stream.infoHash && !hasUncachedMarker(stream)) ||
      debrids.some(
        (debrid) => stream.cached[debrid.slug] === true || stream.inLibrary[debrid.slug] === true,
      ) ||
      hasCachedMarker(stream),
    [debrids],
  );

  const anyAddonRanked = useMemo(() => addons.some((addon) => isAddonRanked(addon)), [addons]);
  const preserveAddonOrder = settings.streamSort === "addon" || anyAddonRanked;
  const availableStreams = useMemo(() => {
    const streams = result?.picker.all ?? [];
    const ordered =
      preserveAddonOrder && result
        ? orderByAddonNative(streams, result.raw.addon, addons)
        : streams;
    return ordered.slice().sort((left, right) => Number(isCached(right)) - Number(isCached(left)));
  }, [addons, isCached, preserveAddonOrder, result]);
  const audioSafeStreams = useMemo(
    () => filterStreamsForAudio(availableStreams, audioLanguage),
    [availableStreams, audioLanguage],
  );
  const qualitySafeStreams = useMemo(
    () => filterStreamsForQuality(audioSafeStreams, qualityProfile),
    [audioSafeStreams, qualityProfile],
  );
  const displayStreams = qualitySafeStreams;

  const addonCount = useMemo(
    () => new Set(displayStreams.map((stream) => stream.addonId)).size,
    [displayStreams],
  );
  const addonsSettled = (pipelineDone && !discoveringAddons) || maxWaitElapsed;
  const allCount = displayStreams.length;
  const rawCount = (result?.raw.addon.length ?? 0) + (result?.raw.library.length ?? 0);
  const noSourcesConfigured = !discoveringAddons && addons.length === 0 && debrids.length === 0;
  const isAnime = /^(kitsu|mal|anilist|anidb):/.test(meta.id);
  const scrollKey = episode
    ? `picker:${meta.id}:${episode.season}:${episode.episode}:download`
    : `picker:${meta.id}:download`;
  useScrollMemory(scrollKey, mainRef, true);

  const { onDownload, abortResolve } = usePickHandler({
    meta: displayMeta,
    episode,
    debrids,
    onDownloadStarted: () => setView("downloads"),
    setFailedStreams,
    setResolveError,
    setResolving,
    authKey,
    settings,
    imdbId: resolvedImdb.id,
    streamIds: streamIds ?? [],
    qualityProfile,
    audioLanguage,
    subtitleLanguage,
    scheduledAt: dateTimeInputToMs(scheduledFor),
  });

  if (noSourcesConfigured) return <NoSourcesConfiguredModal meta={meta} />;

  const backToDetail = () => {
    abortResolve();
    void exitWindowFullscreen();
    exitPickerToDetail(meta);
  };

  return (
    <main
      ref={mainRef}
      data-tv-focus-scope
      className="absolute inset-0 z-50 overflow-y-auto bg-canvas"
    >
      <BackdropLayer src={episode?.still || meta.background || meta.poster} />
      <div
        aria-hidden
        data-tauri-drag-region={fullscreen ? "false" : "true"}
        className="absolute inset-x-0 top-0 z-10 h-20"
      />

      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-12 pb-32 pt-32">
        <PickerHeader
          meta={displayMeta}
          episode={episode}
          onBack={backToDetail}
          onRefresh={refresh}
          refreshing={loading}
        />

        <div className="rounded-2xl border border-edge-soft bg-elevated/60 px-5 py-3.5 text-[13.5px] text-ink-muted">
          Choose a Stremio source to save offline. MoviBox resolves it through your configured
          add-ons or debrid provider, then continues the download in the background.
        </div>

        <AcquisitionPreferences
          quality={qualityProfile}
          onQuality={setQualityProfile}
          audioLanguage={audioLanguage}
          onAudioLanguage={setAudioLanguage}
          subtitleLanguage={subtitleLanguage}
          onSubtitleLanguage={setSubtitleLanguage}
          scheduledFor={scheduledFor}
          onScheduledFor={setScheduledFor}
        />

        {availableStreams.length > 0 && audioLanguage && audioSafeStreams.length === 0 && (
          <div className="rounded-2xl border border-danger/30 bg-danger/10 px-5 py-3.5 text-[13px] text-ink">
            None of the returned sources explicitly identify {audioLanguage} audio. MoviBox has
            hidden them so an unknown or wrong-language file cannot be queued.
          </div>
        )}

        {audioSafeStreams.length > 0 && qualitySafeStreams.length === 0 && (
          <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-5 py-3.5 text-[13px] text-amber-100">
            No {qualityProfile} source matches the selected audio language. Change quality or wait
            for another add-on result.
          </div>
        )}

        {torrentsDisabled() && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/30 bg-amber-400/10 px-5 py-3.5 text-[13px] text-amber-100">
            <span>
              Torrents are disabled. Uncached torrent sources cannot be acquired until they are
              enabled or resolved by a debrid service.
            </span>
            <button
              type="button"
              onClick={() => openSettings("streaming")}
              className="rounded-md border border-amber-300/40 px-3 py-1 text-[12px] font-semibold transition-colors hover:bg-amber-300/10"
            >
              Open Settings
            </button>
          </div>
        )}

        {!addonsSettled && allCount === 0 && <CinematicLoader meta={displayMeta} />}

        {allCount > 0 && (!pipelineDone || discoveringAddons) && (
          <div className="flex items-center gap-2 rounded-xl border border-edge-soft/60 bg-canvas/55 px-4 py-2.5 text-[12.5px] text-ink-muted">
            <Loader2 size={14} className="animate-spin text-accent" />
            Showing available sources while the remaining add-ons finish.
          </div>
        )}

        <PickerEmptyLadder
          meta={meta}
          result={result}
          addonsSettled={addonsSettled}
          pipelineDone={pipelineDone}
          streamIds={streamIds}
          debridCount={debrids.length}
          addonCount={addons.length}
          allCount={allCount}
          rawCount={rawCount}
          strictMode={strictMode}
          forceShowAll={forceShowAll}
          onOpenLibrarySettings={() => openSettings("library")}
          onOpenStreamingSettings={() => openSettings("streaming")}
          onShowAll={() => setForceShowAll(true)}
          onSearchWider={() => {
            if (strictMode) setStrictMode(false);
            else setForceShowAll(true);
          }}
        />

        {debrids.length > 0 && allCount > 0 && <CachedTip />}

        {allCount > 0 && (
          <StremioLayout
            streams={displayStreams}
            addons={addons}
            pipelineDone={pipelineDone}
            loadingAddonCount={Math.max(0, addons.length - addonCount)}
            failedStreams={failedStreams}
            preserveOrder={preserveAddonOrder}
            onDownload={onDownload}
            isAnime={isAnime}
          />
        )}

        {resolving && (
          <div className="flex items-center gap-3 rounded-2xl border border-edge-soft bg-elevated/60 px-5 py-4 text-[13.5px] text-ink-muted">
            <Loader2 size={16} className="animate-spin text-accent" />
            Resolving {resolving.stream.addonName || "source"} for download…
            <button
              type="button"
              className="ml-auto text-ink hover:text-accent"
              onClick={abortResolve}
            >
              Cancel
            </button>
          </div>
        )}

        {resolveError && (
          <div className="rounded-2xl border border-danger/30 bg-danger/15 px-5 py-4 text-[13.5px] text-ink">
            {resolveError}
          </div>
        )}
      </div>

      {allCount > 0 && <PickerScrollTop scrollRef={mainRef} />}
    </main>
  );
}

function PickerScrollTop({ scrollRef }: { scrollRef: React.RefObject<HTMLElement | null> }) {
  const t = useT();
  const [show, setShow] = useState(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setShow(element.scrollTop > 500);
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, [scrollRef]);

  if (!show) return null;
  return (
    <button
      type="button"
      aria-label={t("common.backToTop")}
      onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
      className="fixed bottom-6 right-6 z-[70] grid h-10 w-10 place-items-center rounded-full border border-edge-soft bg-elevated text-ink shadow-lg transition hover:border-edge hover:text-accent"
    >
      <ArrowUp size={17} />
    </button>
  );
}
