import { FindSubtitles, SubtitleStatus } from "./subtitles";
import { IinaButton } from "./player";
import { native } from "./backend";
import { runBackend } from "./store";
import { Presence } from "./motion";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowLeft, Check, Folder, Play, Search, Trash2 } from "lucide-react";
import { mediaById } from "./model";
import { navigate } from "./routing";
import { demoHandoff, notify, setWatched, updateDemo, useDemo } from "./store";
import { PosterCard } from "./discover";
import {
  ActionGroup,
  Actions,
  Banner,
  Button,
  Choice,
  Confirm,
  ContextActions,
  Drawer,
  Empty,
  Header,
  Input,
  Tabs,
} from "./ui";
import type { LibraryEntry, Media } from "./types";

type Removal = {
  entries: LibraryEntry[];
  label: string;
  trash: boolean;
  markWatched: boolean;
};

export function Library({ detail }: { detail?: string }) {
  const state = useDemo();
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("Recently added");
  const [remove, setRemove] = useState<Removal | null>(null);
  const entry = state.library.find((file) => file.id === detail);
  const media = entry ? mediaById(entry.mediaId) : undefined;
  const [seasonSelection, setSeasonSelection] = useState({ entryId: "", value: "Season 1" });
  const season =
    seasonSelection.entryId === entry?.id ? seasonSelection.value : `Season ${entry?.season ?? 1}`;

  const mediaMap = useMemo(
    () => new Map(state.library.map((file) => [file.mediaId, mediaById(file.mediaId)])),
    [state.library],
  );
  const watchMap = useMemo(
    () =>
      new Map(
        state.watchStates.map((watchState) => [
          watchState.mediaId,
          {
            movie: Boolean(watchState.movieWatchedAt),
            episodes: new Set(watchState.episodes.map((item) => `${item.season}:${item.episode}`)),
          },
        ]),
      ),
    [state.watchStates],
  );
  const watchedStatus = (mediaId: string, season?: number, episode?: number) => {
    const watchState = watchMap.get(mediaId);
    if (!watchState) return false;
    if (episode === undefined) return watchState.movie;
    return watchState.episodes.has(`${season}:${episode}`);
  };
  const allFiles = useMemo(
    () => (state.scenario === "empty" ? [] : state.library),
    [state.library, state.scenario],
  );
  const watchedEntryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const file of allFiles) {
      const item = mediaMap.get(file.mediaId) ?? mediaById(file.mediaId);
      const state = watchMap.get(file.mediaId);
      const watched =
        item.kind === "movie"
          ? Boolean(state?.movie)
          : file.episodes.length > 0 &&
            file.episodes.every((episode) => state?.episodes.has(`${file.season}:${episode}`));
      if (watched) ids.add(file.id);
    }
    return ids;
  }, [allFiles, mediaMap, watchMap]);
  const watchedEntry = (file: LibraryEntry) => watchedEntryIds.has(file.id);
  const groupedSeries = useMemo(() => {
    const groups = new Map<string, LibraryEntry[]>();
    for (const file of allFiles) {
      if ((mediaMap.get(file.mediaId) ?? mediaById(file.mediaId)).kind !== "series") continue;
      const group = groups.get(file.mediaId) ?? [];
      group.push(file);
      groups.set(file.mediaId, group);
    }
    return groups;
  }, [allFiles, mediaMap]);
  const movies = useMemo(
    () =>
      allFiles.filter(
        (file) => (mediaMap.get(file.mediaId) ?? mediaById(file.mediaId)).kind === "movie",
      ),
    [allFiles, mediaMap],
  );
  const watchedFiles = useMemo(
    () => allFiles.filter((file) => watchedEntryIds.has(file.id)),
    [allFiles, watchedEntryIds],
  );
  const reclaimableSize = useMemo(
    () => watchedFiles.reduce((total, file) => total + file.size, 0),
    [watchedFiles],
  );
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const visibleMovies = useMemo(
    () =>
      movies
        .filter((file) => {
          const item = mediaMap.get(file.mediaId)!;
          return (
            (tab === "all" ||
              tab === "movie" ||
              (tab === "watched" && watchedEntryIds.has(file.id))) &&
            item.title.toLowerCase().includes(normalizedQuery)
          );
        })
        .sort((a, b) =>
          sort === "Title A–Z"
            ? mediaMap.get(a.mediaId)!.title.localeCompare(mediaMap.get(b.mediaId)!.title)
            : 0,
        ),
    [mediaMap, movies, normalizedQuery, sort, tab, watchedEntryIds],
  );
  const visibleSeries = useMemo(
    () =>
      [...groupedSeries.entries()]
        .filter(([mediaId, entries]) => {
          const watched =
            entries.length > 0 && entries.every((file) => watchedEntryIds.has(file.id));
          return (
            (tab === "all" || tab === "series" || (tab === "watched" && watched)) &&
            mediaMap.get(mediaId)!.title.toLowerCase().includes(normalizedQuery)
          );
        })
        .sort(([a], [b]) =>
          sort === "Title A–Z" ? mediaMap.get(a)!.title.localeCompare(mediaMap.get(b)!.title) : 0,
        ),
    [groupedSeries, mediaMap, normalizedQuery, sort, tab, watchedEntryIds],
  );
  const visibleCount = visibleMovies.length + visibleSeries.length;
  const seasonNumber = Number(season.replace("Season ", ""));
  const seriesEntries = entry ? state.library.filter((file) => file.mediaId === entry.mediaId) : [];
  const seasonEntries = seriesEntries.filter((file) => file.season === seasonNumber);
  const episodeFiles = new Map<number, LibraryEntry>();
  for (const file of seasonEntries)
    for (const episode of file.episodes) if (!file.missing) episodeFiles.set(episode, file);
  const episodeRows = native
    ? (media?.episodes ?? []).filter((episode) => episode.season === seasonNumber)
    : Array.from({ length: media?.episodes.length || 8 }, (_, index) => ({
        episode: index + 1,
        title: media?.episodes[index]?.title ?? `Episode ${index + 1}`,
      }));
  const availableSeasons = media
    ? [
        ...new Set([
          ...media.episodes.map((episode) => episode.season),
          ...seriesEntries.map((file) => file.season),
          ...(!native ? [1, 2, ...(media.id === "dark" ? [3] : [])] : []),
        ]),
      ]
        .filter((value) => value > 0)
        .sort((a, b) => a - b)
    : [];
  const highestDownloadedSeason = Math.max(0, ...seriesEntries.map((file) => file.season));
  const nextSeason = availableSeasons.find((value) => value > highestDownloadedSeason);
  const missing = entry?.missing || state.scenario === "storage-error";

  const fileAction = (action: string, id = entry?.id) => {
    if (id) void runBackend(`library.${action}`, { id }).catch(() => {});
  };
  const open = () =>
    missing
      ? notify("File not found. Locate the file or reconnect its drive.")
      : native
        ? fileAction("open")
        : demoHandoff("Open in default player");
  const episodesForEntry = (file: LibraryEntry) =>
    file.episodes.length
      ? file.episodes
      : (mediaMap.get(file.mediaId)?.episodes ?? [])
          .filter((episode) => episode.season === file.season)
          .map((episode) => episode.episode);
  const markEntries = (entries: LibraryEntry[], watched: boolean) => {
    for (const file of entries) {
      const item = mediaMap.get(file.mediaId) ?? mediaById(file.mediaId);
      setWatched(
        item.kind === "movie"
          ? { mediaId: file.mediaId, watched }
          : {
              mediaId: file.mediaId,
              season: file.season,
              episodes: episodesForEntry(file),
              watched,
            },
      );
    }
    notify(watched ? "Marked watched." : "Marked unwatched.");
  };
  const requestRemoval = (
    entries: LibraryEntry[],
    label: string,
    trash: boolean,
    markWatched = false,
  ) => setRemove({ entries, label, trash, markWatched });
  const seriesActions = (item: Media, entries: LibraryEntry[]) => {
    const watched = entries.length > 0 && entries.every(watchedEntry);
    const highest = Math.max(0, ...entries.map((file) => file.season));
    const next = [...new Set(item.episodes.map((episode) => episode.season))]
      .sort((a, b) => a - b)
      .find((value) => value > highest);
    return [
      { label: "View series", run: () => navigate("library", entries[0]?.id) },
      {
        label: next ? `Download Season ${next}` : "Find missing episodes",
        run: () => navigate("discover", item.id, next ? { season: next } : undefined),
      },
      {
        label: watched ? "Mark unwatched" : "Mark watched",
        run: () => markEntries(entries, !watched),
      },
      {
        label: "Mark watched and move files to Trash…",
        run: () => requestRemoval(entries, item.title, true, true),
        danger: true,
      },
      {
        label: "Remove from Library",
        run: () => requestRemoval(entries, item.title, false),
        danger: true,
      },
    ];
  };

  return (
    <>
      {entry && media?.kind === "series" ? (
        <section key={entry.id} className="page library-season-page">
          <Header
            title={media.title}
            subtitle={`Series in your library · ${seriesEntries.reduce((count, file) => count + file.episodes.length, 0)} episodes`}
          >
            <ActionGroup>
              {nextSeason && (
                <Button onClick={() => navigate("discover", media.id, { season: nextSeason })}>
                  Download Season {nextSeason}
                </Button>
              )}
              <Button
                onClick={() =>
                  native
                    ? fileAction("reveal", seasonEntries[0]?.id)
                    : demoHandoff("Open series folder")
                }
              >
                <Folder size={16} />
                Show series folder
              </Button>
            </ActionGroup>
          </Header>
          <ActionGroup align="start">
            <Button variant="ghost" onClick={() => navigate("library")}>
              <ArrowLeft size={14} />
              Back to Library
            </Button>
          </ActionGroup>
          <div className="toolbar">
            <Choice
              label="Library season"
              value={season}
              options={availableSeasons.map((value) => `Season ${value}`)}
              onChange={(value) => setSeasonSelection({ entryId: entry.id, value })}
            />
            <span className="spacer" />
            <ActionGroup>
              <Button onClick={() => navigate("discover", media.id, { season: seasonNumber })}>
                Find missing episodes
              </Button>
              <Button
                variant="primary"
                disabled={!seasonEntries.some((file) => !file.missing)}
                onClick={() => {
                  const nextEpisode = episodeRows.find(
                    (episode) =>
                      episodeFiles.has(episode.episode) &&
                      !watchedStatus(media.id, seasonNumber, episode.episode),
                  );
                  const file = nextEpisode
                    ? episodeFiles.get(nextEpisode.episode)
                    : seasonEntries.find((candidate) => !candidate.missing);
                  if (native) fileAction("open", file?.id);
                  else demoHandoff("Open next episode");
                }}
              >
                <Play size={15} />
                Open next unwatched
              </Button>
            </ActionGroup>
          </div>
          <Banner title="Your local episodes">
            {native
              ? "Available episodes are verified against the files on disk. Right-click any episode for watch controls."
              : "These are demo entries; file actions do not access your disk."}
          </Banner>
          <div className="library-episodes">
            {episodeRows.map((episode) => {
              const episodeFile = native ? episodeFiles.get(episode.episode) : entry;
              const exists = native
                ? Boolean(episodeFile)
                : seasonNumber === entry.season && entry.episodes.includes(episode.episode);
              const watched = watchedStatus(media.id, seasonNumber, episode.episode);
              const row = (
                <div className={`library-episode-row ${watched ? "watched" : ""}`}>
                  <small>
                    S{String(seasonNumber).padStart(2, "0")}E
                    {String(episode.episode).padStart(2, "0")}
                  </small>
                  <span className="episode-name">{episode.title}</span>
                  <small>{exists ? episodeFile?.quality : "—"}</small>
                  <small className={watched ? "success" : exists ? "muted" : "warning"}>
                    {watched ? "Watched" : exists ? "In library" : "Missing"}
                  </small>
                  <ActionGroup>
                    {episodeFile && exists && (
                      <FindSubtitles target="library" id={episodeFile.id} label="Subtitles" />
                    )}
                    {episodeFile && exists && (
                      <IinaButton target="library" id={episodeFile.id} compact />
                    )}
                    <Button
                      variant="ghost"
                      disabled={!exists}
                      aria-label={`Open episode ${episode.episode}`}
                      onClick={() =>
                        native ? fileAction("open", episodeFile?.id) : demoHandoff("Open episode")
                      }
                    >
                      <Play size={15} />
                    </Button>
                  </ActionGroup>
                  {episodeFile && (
                    <div className="episode-subtitle-status">
                      <SubtitleStatus subtitles={episodeFile.subtitles} />
                    </div>
                  )}
                </div>
              );
              return (
                <ContextActions
                  key={`${seasonNumber}-${episode.episode}`}
                  items={[
                    {
                      label: watched ? "Mark episode unwatched" : "Mark episode watched",
                      run: () =>
                        setWatched({
                          mediaId: media.id,
                          season: seasonNumber,
                          episodes: [episode.episode],
                          watched: !watched,
                        }),
                    },
                    {
                      label: "Open episode",
                      disabled: !exists,
                      run: () =>
                        native ? fileAction("open", episodeFile?.id) : demoHandoff("Open episode"),
                    },
                  ]}
                >
                  {row}
                </ContextActions>
              );
            })}
          </div>
          <ActionGroup align="between">
            <Button
              disabled={!seasonEntries.length}
              onClick={() => {
                const watched = seasonEntries.every((file) => watchedEntry(file));
                markEntries(seasonEntries, !watched);
              }}
            >
              <Check size={15} />
              {seasonEntries.length > 0 && seasonEntries.every(watchedEntry)
                ? "Mark season unwatched"
                : "Mark season watched"}
            </Button>
            <ActionGroup>
              <Button
                disabled={!seasonEntries.length}
                onClick={() => requestRemoval(seasonEntries, `${media.title} · ${season}`, false)}
              >
                Remove season from Library
              </Button>
              <Button
                variant="ghost"
                disabled={!seasonEntries.length}
                onClick={() =>
                  requestRemoval(seasonEntries, `${media.title} · ${season}`, true, true)
                }
              >
                <Trash2 size={15} />
                Watched & move to Trash…
              </Button>
            </ActionGroup>
          </ActionGroup>
        </section>
      ) : (
        <section key="library" className="page">
          <Header title="Library" subtitle="Your downloaded movies and series.">
            <Button
              onClick={() =>
                native
                  ? void runBackend("library.folder").catch(() => {})
                  : demoHandoff("Open library folder")
              }
            >
              <Folder size={16} />
              Open library folder
            </Button>
          </Header>
          <div className="toolbar">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: "all", label: `All · ${movies.length + groupedSeries.size}` },
                { value: "movie", label: `Movies · ${movies.length}` },
                { value: "series", label: `Series · ${groupedSeries.size}` },
                { value: "watched", label: `Watched · ${watchedFiles.length}` },
              ]}
            />
            <span className="spacer" />
            <div className="search-control library-search">
              <Search size={16} />
              <Input
                aria-label="Search library"
                placeholder="Search library"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Choice
              label="Sort library"
              value={sort}
              options={["Recently added", "Title A–Z"]}
              onChange={setSort}
            />
          </div>
          {tab === "watched" && watchedFiles.length > 0 && (
            <Banner title={`${reclaimableSize.toFixed(1)} GB ready to clean up`} tone="success">
              Watched files remain playable until you move them to the system Trash. Their history
              stays in Movie Box.
              <ActionGroup align="start">
                <Button
                  onClick={() => requestRemoval(watchedFiles, "all watched files", true, true)}
                >
                  <Trash2 size={15} />
                  Move watched files to Trash…
                </Button>
              </ActionGroup>
            </Banner>
          )}
          {!visibleCount ? (
            <Empty
              title={tab === "watched" ? "No watched downloads" : "Your library is waiting"}
              description={
                tab === "watched"
                  ? "Mark a movie or every episode in a downloaded file as watched to manage it here."
                  : "Downloaded movies and series will appear here."
              }
            >
              <Button variant="primary" onClick={() => navigate("discover")}>
                Discover titles
              </Button>
            </Empty>
          ) : (
            <>
              {visibleMovies.length > 0 && (
                <div className="catalog-grid">
                  {visibleMovies.map((file) => {
                    const item = mediaMap.get(file.mediaId)!;
                    const watched = watchedEntry(file);
                    return (
                      <ContextActions
                        key={file.id}
                        items={[
                          { label: "View details", run: () => navigate("library", file.id) },
                          {
                            label: "Open file",
                            run: () =>
                              native ? fileAction("open", file.id) : demoHandoff("Open file"),
                          },
                          {
                            label: watched ? "Mark unwatched" : "Mark watched",
                            run: () => markEntries([file], !watched),
                          },
                          {
                            label: "Mark watched and move to Trash…",
                            run: () => requestRemoval([file], item.title, true, true),
                            danger: true,
                          },
                          {
                            label: "Remove from Library",
                            run: () => requestRemoval([file], item.title, false),
                            danger: true,
                          },
                        ]}
                      >
                        <PosterCard
                          media={item}
                          selected={file.id === detail}
                          subtitle={`${file.quality} · ${file.size} GB${watched ? " · Watched" : ""}`}
                          onClick={() => navigate("library", file.id)}
                        />
                      </ContextActions>
                    );
                  })}
                </div>
              )}
              {visibleSeries.length > 0 && (
                <div className="library-series">
                  <h3>Series</h3>
                  {visibleSeries.map(([mediaId, entries]) => {
                    const item = mediaMap.get(mediaId)!;
                    const watched = entries.every(watchedEntry);
                    const actions = seriesActions(item, entries);
                    const row = (
                      <div className={`series-row ${watched ? "watched" : ""}`}>
                        <img src={item.poster} alt="" loading="lazy" decoding="async" />
                        <div>
                          <button
                            className="row-title"
                            onClick={() => navigate("library", entries[0]?.id)}
                          >
                            {item.title}
                          </button>
                          <p>
                            {entries.reduce((count, file) => count + file.episodes.length, 0)}{" "}
                            episodes downloaded{watched ? " · Watched" : ""}
                          </p>
                        </div>
                        <small>{new Set(entries.map((file) => file.season)).size} seasons</small>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            native
                              ? fileAction("reveal", entries[0]?.id)
                              : demoHandoff("Open series folder")
                          }
                        >
                          Open folder
                        </Button>
                        <Actions label={`Library actions for ${item.title}`} items={actions} />
                      </div>
                    );
                    return (
                      <ContextActions key={mediaId} items={actions}>
                        {row}
                      </ContextActions>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}
      <Presence>
        {entry && media && media.kind === "movie" && (
          <Drawer
            key="Drawer"
            inspector
            title={media.title}
            description={`Downloaded movie · ${entry.quality}`}
            onClose={() => navigate("library")}
          >
            <div className="drawer-content">
              <img
                className="library-backdrop"
                src={
                  media.id === "interstellar" ? "/moviebox/interstellar-backdrop.jpg" : media.poster
                }
                alt={media.title}
                decoding="async"
              />
              <ActionGroup>
                <Button variant="primary" onClick={open}>
                  <Play size={16} />
                  Open file
                </Button>
                <Button
                  onClick={() => (native ? fileAction("reveal") : demoHandoff("Reveal in folder"))}
                >
                  <Folder size={16} />
                  Reveal file
                </Button>
              </ActionGroup>
              <Button onClick={() => markEntries([entry], !watchedStatus(media.id))}>
                <Check size={15} />
                {watchedStatus(media.id) ? "Mark unwatched" : "Mark watched"}
              </Button>
              {!missing && (
                <ActionGroup align="start">
                  <FindSubtitles target="library" id={entry.id} />
                  <IinaButton target="library" id={entry.id} />
                </ActionGroup>
              )}
              <SubtitleStatus subtitles={entry.subtitles} />
              {missing && (
                <Banner title="File not found" tone="warning">
                  Reconnect the drive or locate the file. Your library entry is safe.
                </Banner>
              )}
              <dl className="detail-list">
                <div>
                  <dt>Filename</dt>
                  <dd>
                    {native
                      ? entry.path.split(/[\\/]/).pop()
                      : `${media.title} (${media.year}).mkv`}
                  </dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{entry.size} GB</dd>
                </div>
                <div>
                  <dt>Video</dt>
                  <dd>{entry.quality}</dd>
                </div>
                <div>
                  <dt>Folder</dt>
                  <dd>{entry.path}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {missing
                      ? "File missing"
                      : watchedStatus(media.id)
                        ? "Watched"
                        : native
                          ? "Ready to watch"
                          : "Demo entry · file not verified"}
                  </dd>
                </div>
              </dl>
              {missing && (
                <Button
                  onClick={async () => {
                    if (native) {
                      const { open } = await import("@tauri-apps/plugin-dialog");
                      const path = await open({ directory: false, multiple: false });
                      if (typeof path === "string")
                        void runBackend("library.relink", { id: entry.id, path }).catch(() => {});
                      return;
                    }
                    updateDemo((current) => ({
                      ...current,
                      scenario: "normal",
                      library: current.library.map((file) =>
                        file.id === entry.id ? { ...file, missing: false } : file,
                      ),
                    }));
                    notify("Demo file relinked. No filesystem scan was performed.");
                  }}
                >
                  Locate file…
                </Button>
              )}
              <ActionGroup>
                <Actions
                  label="Manage library entry"
                  items={[
                    {
                      label: "Mark watched and move to Trash…",
                      run: () => requestRemoval([entry], media.title, true, true),
                      danger: true,
                    },
                    {
                      label: "Move file to Trash…",
                      run: () => requestRemoval([entry], media.title, true),
                      danger: true,
                    },
                    {
                      label: "Remove from Library",
                      run: () => requestRemoval([entry], media.title, false),
                      danger: true,
                    },
                  ]}
                >
                  Manage library entry
                </Actions>
              </ActionGroup>
            </div>
          </Drawer>
        )}
      </Presence>
      <Presence>
        {remove && (
          <Confirm
            key="Confirm"
            title={remove.trash ? "Move files to Trash?" : "Remove from Library?"}
            description={
              remove.trash
                ? `${remove.entries.length} file${remove.entries.length === 1 ? "" : "s"} for ${remove.label} will move to the system Trash. Download history stays available.${remove.markWatched ? " Monitoring will skip the watched content." : " Active monitoring may download it again."}`
                : "This removes the Library record. The downloaded file stays exactly where it is."
            }
            confirm={remove.trash ? "Move to Trash" : "Remove entry"}
            onClose={() => setRemove(null)}
            onConfirm={async () => {
              if (native) {
                try {
                  await runBackend("library.removeMany", {
                    ids: remove.entries.map((file) => file.id),
                    trashFile: remove.trash,
                    markWatched: remove.markWatched,
                  });
                  setRemove(null);
                  navigate("library");
                } catch {
                  /* The backend error is already visible. */
                }
                return;
              }
              if (remove.markWatched) markEntries(remove.entries, true);
              const ids = new Set(remove.entries.map((file) => file.id));
              updateDemo((current) => ({
                ...current,
                library: current.library.filter((file) => !ids.has(file.id)),
              }));
              setRemove(null);
              navigate("library");
              notify(
                remove.trash
                  ? "Demo entries removed. No real files were touched."
                  : "Library entries removed. Local files kept.",
              );
            }}
          />
        )}
      </Presence>
    </>
  );
}
