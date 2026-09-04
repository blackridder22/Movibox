import { useCallback } from "react";
import type { Meta } from "@/lib/cinemeta";
import { useView, type PlayEpisode } from "@/lib/view";

type PlayOpts = { autoPlay?: boolean; resume?: boolean };

export function useLocalAwareSeriesPlay() {
  const { openPicker } = useView();
  return useCallback(
    (args: {
      meta: Meta;
      episode: PlayEpisode;
      opts?: PlayOpts;
      imdbId?: string | null;
      videos?: Meta["videos"];
    }) => {
      const { meta, episode, opts } = args;
      openPicker(meta, episode, opts);
    },
    [openPicker],
  );
}
