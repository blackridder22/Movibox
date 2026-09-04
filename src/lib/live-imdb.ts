import { useEffect, useState } from "react";
import type { Meta } from "@/lib/cinemeta";
import { harborImdbTitle } from "@/lib/providers/harbor-imdb";
import { useTmdbImdbId } from "@/lib/providers/tmdb";

type LiveImdb = {
  value: string | null;
  isImdb: boolean;
};

export function useLiveImdbRating(meta: Meta): LiveImdb {
  const tmdbImdbId = useTmdbImdbId(meta.id);
  const resolved = meta.id.startsWith("tt") ? meta.id : tmdbImdbId;
  const [harbor, setHarbor] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHarbor(null);
    if (!resolved) return;
    void harborImdbTitle(resolved)
      .then((rating) => {
        if (!cancelled) setHarbor(rating);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [resolved]);

  if (harbor != null) return { value: harbor.toFixed(1), isImdb: true };
  return { value: meta.imdbRating ?? null, isImdb: false };
}
