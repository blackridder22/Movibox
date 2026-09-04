import { useEffect, useState } from "react";
import { narrowMediaType, isAddonNativeMeta, type Meta } from "@/lib/cinemeta";
import { animeKitsuMeta } from "@/lib/providers/anime-kitsu-addon";
import { kitsuToImdb } from "@/lib/providers/anime-mapping";
import { tmdbImdbId } from "@/lib/providers/tmdb";
import { cinemetaImdbFallback } from "./picker-utils";

export type ResolvedImdb = { id: string | null; verified: boolean };

const UNRESOLVED: ResolvedImdb = { id: null, verified: false };

export async function resolveImdbId(
  meta: Meta,
  tmdbKey: string | undefined,
): Promise<ResolvedImdb> {
  if (meta.id.startsWith("tt")) return { id: meta.id, verified: true };
  if (meta.id.startsWith("kitsu:") || meta.id.startsWith("mal:")) {
    const addonRes = await animeKitsuMeta(meta.id).catch(() => null);
    if (addonRes?.imdb_id) return { id: addonRes.imdb_id, verified: true };
    if (meta.id.startsWith("kitsu:")) {
      const number = parseInt(meta.id.slice("kitsu:".length), 10);
      if (Number.isFinite(number)) {
        const mapped = await kitsuToImdb(number).catch(() => null);
        return mapped ? { id: mapped, verified: true } : UNRESOLVED;
      }
    }
    return UNRESOLVED;
  }
  if (isAddonNativeMeta(meta)) return UNRESOLVED;
  if (tmdbKey) {
    const id = await tmdbImdbId(tmdbKey, meta.id).catch(() => null);
    if (id) return { id, verified: true };
  }
  const fallback = await cinemetaImdbFallback(
    meta.name,
    narrowMediaType(meta.type),
    meta.releaseInfo,
  ).catch(() => null);
  return fallback ? { id: fallback, verified: false } : UNRESOLVED;
}

export function useImdbId(meta: Meta, tmdbKey: string | undefined): ResolvedImdb {
  const [resolved, setResolved] = useState<ResolvedImdb>(UNRESOLVED);
  useEffect(() => {
    let cancelled = false;
    const set = (r: ResolvedImdb) => {
      if (!cancelled) setResolved(r);
    };
    void resolveImdbId(meta, tmdbKey).then(set);
    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.type, meta.addonOrigin?.id, tmdbKey]);
  return resolved;
}
