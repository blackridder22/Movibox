import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { activeDownloadFor, refreshDownloads } from "@/lib/download/downloads-store";
import { readCurrentSettings } from "@/lib/settings";
import { readActiveStremioAuthKey } from "@/lib/auth";
import { manualWatchedState } from "@/lib/manual-watched";
import { fetchEpisodeList } from "@/lib/series-episodes";
import { libraryGetOne } from "@/lib/stremio";
import { decodeWatchedEpisodes } from "@/lib/stremio-watched";
import { resolveMeta } from "@/lib/meta-resource";
import { acquireMedia } from "./source-selection";
import {
  markAutomationChecked,
  startAutomationBridge,
  type AutomationRule,
} from "./automation-store";

const running = new Set<string>();

export type AutomationRunResult = {
  candidates: number;
  queued: number;
  skipped: number;
  failed: number;
  firstError: string | null;
};

function episodeSelected(rule: AutomationRule, season: number, episode: number): boolean {
  if (rule.episodes.length > 0) {
    return rule.episodes.some((item) => item.season === season && item.episode === episode);
  }
  return rule.seasons.length === 0 || rule.seasons.includes(season);
}

function hasAired(airDate?: string): boolean {
  if (!airDate) return true;
  const timestamp = Date.parse(airDate);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

export async function runAutomationRule(rule: AutomationRule): Promise<AutomationRunResult> {
  const result: AutomationRunResult = {
    candidates: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
    firstError: null,
  };
  if (!rule.enabled || running.has(rule.metaId)) return result;
  running.add(rule.metaId);
  try {
    await refreshDownloads();
    const settings = readCurrentSettings();
    const episodes = await fetchEpisodeList(rule.meta, { tmdbKey: settings.tmdbKey });
    const watched = new Set<string>();
    if (rule.unwatchedOnly) {
      for (const episode of episodes) {
        if (manualWatchedState(rule.metaId, episode.season, episode.episode) === true) {
          watched.add(String(episode.season) + ":" + String(episode.episode));
        }
      }
      const authKey = readActiveStremioAuthKey();
      if (authKey) {
        const [item, fullMeta] = await Promise.all([
          libraryGetOne(authKey, rule.metaId).catch(() => null),
          rule.meta.videos?.length
            ? Promise.resolve(rule.meta)
            : resolveMeta(authKey, "series", rule.metaId).catch(() => null),
        ]);
        const stremioWatched = await decodeWatchedEpisodes(
          item?.state?.watched,
          fullMeta?.videos,
        ).catch(() => new Set<string>());
        for (const key of stremioWatched) watched.add(key);
      }
    }
    const candidates = episodes
      .filter((episode) => episode.season >= 1)
      .filter((episode) => episodeSelected(rule, episode.season, episode.episode))
      .filter(
        (episode) =>
          !rule.unwatchedOnly ||
          !watched.has(String(episode.season) + ":" + String(episode.episode)),
      )
      .filter((episode) => hasAired(episode.airDate))
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
    result.candidates = candidates.length;
    for (const episode of candidates) {
      const existing = activeDownloadFor(rule.metaId, episode.season, episode.episode);
      if (existing && !["error", "canceled", "interrupted"].includes(existing.status)) {
        result.skipped += 1;
        continue;
      }
      try {
        await acquireMedia({
          meta: rule.meta,
          episode,
          qualityProfile: rule.qualityProfile,
          audioLanguage: rule.audioLanguage,
          subtitleLanguage: rule.subtitleLanguage,
          destination: rule.destination,
        });
        result.queued += 1;
      } catch (error) {
        result.failed += 1;
        result.firstError ??= error instanceof Error ? error.message : "Source selection failed.";
        console.warn(
          `[movibox] automatic source selection failed for ${rule.title} S${episode.season}E${episode.episode}`,
          error,
        );
      }
    }
  } finally {
    await markAutomationChecked(rule.metaId).catch(() => undefined);
    running.delete(rule.metaId);
  }
  return result;
}

async function runDue(rules?: AutomationRule[]): Promise<void> {
  const due = (rules ?? (await invoke<AutomationRule[]>("automation_due"))).filter(
    (rule) => rule.nextCheckAt <= Date.now(),
  );
  for (const rule of due) void runAutomationRule(rule);
}

export function AutomationRunner(): null {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void startAutomationBridge().then(() => {
      if (!disposed) void runDue();
    });
    void listen<AutomationRule[]>("movibox://automation-due", ({ payload }) => {
      void runDue(payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return null;
}
