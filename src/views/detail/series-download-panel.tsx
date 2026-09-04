import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Download, Loader2, X } from "lucide-react";
import {
  AcquisitionPreferences,
  dateTimeInputToMs,
  msToDateTimeInput,
} from "@/components/acquisition-preferences";
import type { Meta } from "@/lib/cinemeta";
import {
  removeAutomationRule,
  upsertAutomationRule,
  useAutomationRules,
  type EpisodeSelection,
} from "@/lib/acquisition/automation-store";
import { fetchEpisodeList } from "@/lib/series-episodes";
import { manualWatchedState } from "@/lib/manual-watched";
import { readCurrentSettings } from "@/lib/settings";
import { readActiveStremioAuthKey } from "@/lib/auth";
import { libraryGetOne } from "@/lib/stremio";
import { decodeWatchedEpisodes } from "@/lib/stremio-watched";
import { resolveMeta } from "@/lib/meta-resource";
import type { PlayEpisode } from "@/lib/view";
import { runAutomationRule } from "@/lib/acquisition/automation-runner";

type SelectionMode = "aired" | "unwatched" | "manual";

function episodeKey(episode: Pick<PlayEpisode, "season" | "episode">): string {
  return String(episode.season) + ":" + String(episode.episode);
}

function isReleased(episode: PlayEpisode): boolean {
  return !episode.airDate || Date.parse(episode.airDate) <= Date.now();
}

function choiceClass(active: boolean): string {
  return active
    ? "border-[#ff704f]/60 bg-[#ff704f]/12 text-[#ff8a68]"
    : "border-edge bg-canvas text-ink-muted hover:border-edge-strong hover:text-ink";
}

export function SeriesDownloadPanel({
  meta,
  seasons,
}: {
  meta: Meta;
  seasons: Array<{ seasonNumber: number }>;
}) {
  const rules = useAutomationRules();
  const saved = rules.find((rule) => rule.metaId === meta.id);
  const seasonNumbers = useMemo(
    () => seasons.map((season) => season.seasonNumber).filter((season) => season >= 1),
    [seasons],
  );
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<PlayEpisode[]>([]);
  const [stremioWatched, setStremioWatched] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<SelectionMode>("unwatched");
  const [selectedSeasons, setSelectedSeasons] = useState<number[]>(seasonNumbers);
  const [selectedEpisodes, setSelectedEpisodes] = useState<Set<string>>(new Set());
  const [includeFuture, setIncludeFuture] = useState(true);
  const [quality, setQuality] = useState("balanced");
  const [audioLanguage, setAudioLanguage] = useState("English");
  const [subtitleLanguage, setSubtitleLanguage] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");

  useEffect(() => {
    setSelectedSeasons(seasonNumbers);
  }, [meta.id, seasonNumbers]);

  useEffect(() => {
    if (!saved) return;
    setSelectedSeasons(saved.seasons.length > 0 ? saved.seasons : seasonNumbers);
    setSelectedEpisodes(
      new Set(
        saved.episodes.map((episode) => String(episode.season) + ":" + String(episode.episode)),
      ),
    );
    setMode(saved.episodes.length > 0 ? "manual" : saved.unwatchedOnly ? "unwatched" : "aired");
    setIncludeFuture(saved.includeFuture);
    setQuality(saved.qualityProfile);
    setAudioLanguage(saved.audioLanguage ?? "");
    setSubtitleLanguage(saved.subtitleLanguage ?? "");
    setScheduledFor(msToDateTimeInput(saved.nextCheckAt));
  }, [saved, seasonNumbers]);

  useEffect(() => {
    if (!open || episodes.length > 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const settings = readCurrentSettings();
    void fetchEpisodeList(meta, { tmdbKey: settings.tmdbKey })
      .then(async (result) => {
        if (cancelled) return;
        setEpisodes(result);
        if (!saved || saved.episodes.length === 0) {
          setSelectedEpisodes(new Set(result.filter(isReleased).map(episodeKey)));
        }
        const authKey = readActiveStremioAuthKey();
        if (!authKey) return;
        const [item, fullMeta] = await Promise.all([
          libraryGetOne(authKey, meta.id).catch(() => null),
          meta.videos?.length
            ? Promise.resolve(meta)
            : resolveMeta(authKey, "series", meta.id).catch(() => null),
        ]);
        const watched = await decodeWatchedEpisodes(item?.state?.watched, fullMeta?.videos).catch(
          () => new Set<string>(),
        );
        if (!cancelled) setStremioWatched(watched);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not load episodes.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, episodes.length, meta, saved]);

  const visibleEpisodes = useMemo(
    () =>
      episodes.filter(
        (episode) =>
          selectedSeasons.includes(episode.season) && (includeFuture || isReleased(episode)),
      ),
    [episodes, selectedSeasons, includeFuture],
  );

  const unwatchedCount = visibleEpisodes.filter((episode) => {
    const key = episodeKey(episode);
    return (
      manualWatchedState(meta.id, episode.season, episode.episode) !== true &&
      !stremioWatched.has(key)
    );
  }).length;

  const manualCount = visibleEpisodes.filter((episode) =>
    selectedEpisodes.has(episodeKey(episode)),
  ).length;

  function toggleSeason(season: number): void {
    setSelectedSeasons((current) =>
      current.includes(season) ? current.filter((value) => value !== season) : [...current, season],
    );
  }

  function toggleEpisode(episode: PlayEpisode): void {
    const key = episodeKey(episode);
    setSelectedEpisodes((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const picked: EpisodeSelection[] =
        mode === "manual"
          ? visibleEpisodes
              .filter((episode) => selectedEpisodes.has(episodeKey(episode)))
              .map((episode) => ({ season: episode.season, episode: episode.episode }))
          : [];
      if (selectedSeasons.length === 0) throw new Error("Choose at least one season.");
      if (mode === "manual" && picked.length === 0) throw new Error("Choose at least one episode.");
      const scheduledAt = dateTimeInputToMs(scheduledFor);
      const rule = await upsertAutomationRule({
        metaId: meta.id,
        mediaType: "series",
        title: meta.name,
        poster: meta.poster ?? null,
        meta,
        seasons: selectedSeasons,
        episodes: picked,
        includeFuture: mode === "manual" ? false : includeFuture,
        missingOnly: true,
        unwatchedOnly: mode === "unwatched",
        qualityProfile: quality,
        audioLanguage: audioLanguage || null,
        subtitleLanguage: subtitleLanguage || null,
        enabled: true,
        checkIntervalMinutes: 60,
        nextCheckAt: scheduledAt,
      });
      if (scheduledAt) {
        setNotice(`Downloads scheduled for ${new Date(scheduledAt).toLocaleString()}.`);
      } else {
        setNotice("Starting downloads now in the background…");
        void runAutomationRule(rule)
          .then((result) => {
            if (result.queued > 0) {
              setNotice(
                `${result.queued} download${result.queued === 1 ? "" : "s"} queued. Open Downloads to follow progress.`,
              );
              if (result.failed > 0) {
                setError(
                  `${result.failed} episode${result.failed === 1 ? "" : "s"} could not be queued. ${result.firstError ?? "Check the selected guardrails."}`,
                );
              }
              return;
            }
            if (result.failed > 0) {
              setNotice(null);
              setError(
                result.firstError ??
                  "No download could be queued. Check the selected language and quality.",
              );
              return;
            }
            setNotice(
              result.candidates === 0
                ? "No matching released episodes need downloading."
                : "Every matching episode is already queued or downloaded.",
            );
          })
          .catch((reason: unknown) => {
            setNotice(null);
            setError(reason instanceof Error ? reason.message : "Could not start downloads.");
          });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save monitoring.");
    } finally {
      setSaving(false);
    }
  }

  async function stop(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await removeAutomationRule(meta.id);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not stop monitoring.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-edge-soft bg-elevated/45">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-elevated"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#ff704f]/12 text-[#ff8060]">
            <Download size={17} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13.5px] font-semibold text-ink">
              {saved ? "Monitoring active" : "Download or monitor this series"}
            </span>
            <span className="block truncate text-[11.5px] text-ink-subtle">
              {saved
                ? "MoviBox checks hourly and downloads only matches to your guardrails."
                : "Choose seasons, episodes, language, subtitles, quality, and start time."}
            </span>
          </span>
        </span>
        <ChevronDown
          size={17}
          className={
            open
              ? "rotate-180 text-ink transition-transform"
              : "text-ink-muted transition-transform"
          }
        />
      </button>

      {open && (
        <div className="space-y-4 border-t border-edge-soft p-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                [
                  "unwatched",
                  "Only unwatched",
                  "Skip episodes already watched in Stremio or MoviBox",
                ],
                ["aired", "All episodes", "Download aired episodes and optionally future releases"],
                ["manual", "Pick manually", "Select exact episodes—nothing else will be queued"],
              ] as const
            ).map(([value, title, description]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={
                  "rounded-xl border p-3 text-left transition-colors " + choiceClass(mode === value)
                }
              >
                <span className="block text-[12.5px] font-semibold">{title}</span>
                <span className="mt-1 block text-[10.5px] leading-relaxed opacity-70">
                  {description}
                </span>
              </button>
            ))}
          </div>

          <div>
            <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-subtle">
              Seasons
            </p>
            <div className="flex flex-wrap gap-2">
              {seasonNumbers.map((season) => (
                <button
                  key={season}
                  type="button"
                  onClick={() => toggleSeason(season)}
                  className={
                    "h-9 rounded-xl border px-3 text-[12px] font-semibold transition-colors " +
                    choiceClass(selectedSeasons.includes(season))
                  }
                >
                  Season {season}
                </button>
              ))}
            </div>
          </div>

          {mode !== "manual" && (
            <label className="flex items-center gap-3 rounded-xl border border-edge bg-canvas px-3.5 py-3 text-[12px] text-ink">
              <input
                type="checkbox"
                checked={includeFuture}
                onChange={(event) => setIncludeFuture(event.target.checked)}
                className="accent-[#ff704f]"
              />
              Automatically download new episodes when they are released
            </label>
          )}

          {mode === "manual" && (
            <div className="max-h-72 overflow-y-auto rounded-xl border border-edge bg-canvas p-2">
              {loading && (
                <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-ink-muted">
                  <Loader2 size={15} className="animate-spin" /> Loading episodes
                </div>
              )}
              {!loading && visibleEpisodes.length === 0 && (
                <p className="py-8 text-center text-[12px] text-ink-muted">No episodes found.</p>
              )}
              {visibleEpisodes.map((episode) => {
                const selected = selectedEpisodes.has(episodeKey(episode));
                return (
                  <button
                    key={episodeKey(episode)}
                    type="button"
                    onClick={() => toggleEpisode(episode)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-elevated"
                  >
                    <span
                      className={
                        selected
                          ? "grid h-5 w-5 place-items-center rounded-md bg-[#ff704f] text-white"
                          : "grid h-5 w-5 place-items-center rounded-md border border-edge-strong text-transparent"
                      }
                    >
                      <Check size={13} />
                    </span>
                    <span className="w-16 shrink-0 text-[11px] font-semibold text-ink-muted">
                      S{episode.season} E{episode.episode}
                    </span>
                    <span className="min-w-0 truncate text-[12px] text-ink">
                      {episode.name || "Episode " + String(episode.episode)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <AcquisitionPreferences
            quality={quality}
            onQuality={setQuality}
            audioLanguage={audioLanguage}
            onAudioLanguage={setAudioLanguage}
            subtitleLanguage={subtitleLanguage}
            onSubtitleLanguage={setSubtitleLanguage}
            scheduledFor={scheduledFor}
            onScheduledFor={setScheduledFor}
          />

          {error && (
            <p className="rounded-xl border border-red-500/25 bg-red-500/8 px-3 py-2.5 text-[11.5px] text-red-300">
              {error}
            </p>
          )}

          {notice && (
            <p className="rounded-xl border border-[#ff704f]/25 bg-[#ff704f]/8 px-3 py-2.5 text-[11.5px] text-[#ff9a7d]">
              {notice}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11.5px] text-ink-subtle">
              {mode === "manual"
                ? String(manualCount) + " selected"
                : mode === "unwatched"
                  ? String(unwatchedCount) + " unwatched episodes found"
                  : String(visibleEpisodes.length) + " episodes found"}
            </p>
            <div className="flex items-center gap-2">
              {saved && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void stop()}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-edge px-3.5 text-[12px] font-semibold text-ink-muted hover:text-ink disabled:opacity-50"
                >
                  <X size={14} /> Stop monitoring
                </button>
              )}
              <button
                type="button"
                disabled={saving || loading}
                onClick={() => void save()}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#ff704f] px-4 text-[12px] font-bold text-white hover:bg-[#ff8060] disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {scheduledFor
                  ? saved
                    ? "Update schedule"
                    : "Schedule downloads"
                  : saved
                    ? "Save & run now"
                    : "Start downloads now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
