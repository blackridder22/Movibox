import { BundleReview } from "./bridge";
import { Presence } from "./motion";
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Grid2X2,
  List,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { backend, native, useCatalog, useSources } from "./backend";
import { SourceSearchDetails } from "./activity";
import { clearRecentSearches, recordRecentSearch, removeRecentSearch, runBackend } from "./store";
import { catalog, enqueue, registerMedia } from "./model";
import { navigate, routeParam } from "./routing";
import { notify, updateDemo, useDemo } from "./store";
import {
  ActionGroup,
  Banner,
  Button,
  CheckBox,
  Choice,
  Confirm,
  Drawer,
  Empty,
  Field,
  FolderChoice,
  Header,
  IconButton,
  Input,
  Modal,
  Popover,
  Tabs,
} from "./ui";
import type { Media } from "./types";
export function PosterCard({
  media,
  onClick,
  selected = false,
  subtitle,
}: {
  media: Media;
  onClick: () => void;
  selected?: boolean;
  subtitle?: string;
}) {
  return (
    <button
      className={`poster-card ${selected ? "selected" : ""}`}
      onClick={onClick}
      aria-label={`View ${media.title}`}
    >
      <span className="poster-wrap">
        <img
          src={media.poster}
          alt={`${media.title} poster`}
          loading="lazy"
          decoding="async"
          onError={(e) => {
            e.currentTarget.style.opacity = "0";
          }}
        />
        <span className="poster-hover">View details</span>
      </span>
      <span className="poster-title">{media.title}</span>
      <small>{subtitle ?? `${media.year} · ${media.genre}`}</small>
    </button>
  );
}
export function Discover({
  detail,
  onMonitor,
}: {
  detail?: string;
  onMonitor: (id: string, episodes?: number[], season?: number) => void;
}) {
  const { scenario, preferences: catalogPreferences, recentSearches } = useDemo();
  const [kind, setKind] = useState("movie");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState(false);
  const [sort, setSort] = useState("Popular");
  const [list, setList] = useState(false);
  const [filters, setFilters] = useState(false);
  const [genre, setGenre] = useState("All genres");
  const [year, setYear] = useState("");
  const [untilYear, setUntilYear] = useState("");
  const [catalogFilter, setCatalogFilter] = useState("All catalogs");
  const [rating, setRating] = useState("Any rating");
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const deferredQuery = useDeferredValue(query);
  const remote = useCatalog(
    kind,
    deferredQuery,
    `${catalogPreferences.catalogProvider}/${catalogPreferences.catalogLanguage}`,
  );
  const [fullMedia, setFullMedia] = useState<Media | undefined>();
  const [detailError, setDetailError] = useState({ id: "", message: "" });
  const [detailRevision, setDetailRevision] = useState(0);
  const cachedMedia = detail ? catalog.find((m) => m.id === detail) : undefined;
  const media =
    fullMedia?.id === detail
      ? fullMedia
      : cachedMedia?.id.startsWith("tmdb:")
        ? undefined
        : cachedMedia;
  const detailKind = cachedMedia?.kind;
  useEffect(() => {
    if (!native || !detail || !detailKind) return;
    let canceled = false;
    void backend<Media>("detail", { id: detail, kind: detailKind })
      .then((item) => {
        if (!canceled) {
          registerMedia([item]);
          setFullMedia(item);
          if (item.id !== detail) navigate("discover", item.id);
        }
      })
      .catch((e: Error) => {
        if (!canceled) setDetailError({ id: detail, message: e.message });
      });
    return () => {
      canceled = true;
    };
  }, [detail, detailKind, detailRevision]);
  const all = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    return (native ? remote.items : catalog).filter(
      (item) =>
        (normalizedQuery ? true : item.kind === kind) &&
        (native || item.title.toLowerCase().includes(normalizedQuery)) &&
        (genre === "All genres" || item.genres.includes(genre)) &&
        (!year || +item.year.slice(0, 4) >= +year) &&
        (!untilYear || +item.year.slice(0, 4) <= +untilYear) &&
        (rating === "Any rating" || item.rating >= +rating.slice(0, 1)),
    );
  }, [deferredQuery, genre, kind, rating, remote.items, untilYear, year]);
  const sorted = useMemo(
    () =>
      [...all].sort((a, b) =>
        sort === "Title A–Z"
          ? a.title.localeCompare(b.title)
          : sort === "Newest"
            ? b.year.localeCompare(a.year)
            : sort === "Top rated"
              ? b.rating - a.rating
              : 0,
      ),
    [all, sort],
  );
  const pageSize = media?.kind === "movie" ? 8 : 12;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visible = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const activeFilters = [
    genre !== "All genres",
    Boolean(year || untilYear),
    rating !== "Any rating",
  ].filter(Boolean).length;
  const openMedia = (item: Media) => {
    recordRecentSearch({
      mediaId: item.id,
      title: item.title,
      kind: item.kind,
      query: query.trim(),
    });
    setSuggestions(false);
    navigate("discover", item.id);
  };
  const submitSearch = () => {
    const value = query.trim();
    if (value) recordRecentSearch({ query: value, kind: kind as Media["kind"] });
    setSuggestions(false);
    setList(Boolean(value));
  };
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".search-control")) setSuggestions(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const reset = () => {
    setGenre("All genres");
    setYear("");
    setUntilYear("");
    setCatalogFilter("All catalogs");
    setRating("Any rating");
    setPage(1);
    notify("Filters cleared.");
  };
  if (media?.kind === "series")
    return (
      <Season key={`${media.id}-${media.episodes.length}`} media={media} onMonitor={onMonitor} />
    );
  if (native && detail?.startsWith("tmdb:") && !media)
    return (
      <section className="page">
        <Header
          title={cachedMedia?.title ?? "Title details"}
          subtitle="Loading episode metadata from TMDB."
        />
        {detailError.id === detail ? (
          <Empty title="Couldn't load this title" description={detailError.message}>
            <ActionGroup>
              <Button onClick={() => navigate("discover")}>Back to Discover</Button>
              <Button
                onClick={() => {
                  setDetailError({ id: "", message: "" });
                  setDetailRevision((v) => v + 1);
                }}
              >
                Retry
              </Button>
            </ActionGroup>
          </Empty>
        ) : (
          <Banner title="Loading title…">
            Movie Box is matching title and episode IDs before searching sources.{" "}
            <Button onClick={() => navigate("discover")}>Back to Discover</Button>
          </Banner>
        )}
      </section>
    );
  return (
    <>
      <section className="page" ref={pageRef}>
        {remote.warning && (
          <Banner title="Catalog fallback" tone="warning">
            {remote.warning}
          </Banner>
        )}
        <Header title="Discover" subtitle="Find a title to download or monitor.">
          <div className="search-control">
            <Search size={17} />
            <Input
              ref={searchRef}
              id="moviebox-search"
              aria-label="Search movies and series"
              placeholder="Search movies and series"
              value={query}
              onFocus={() => setSuggestions(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
                setSuggestions(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  submitSearch();
                }
                if (e.key === "Escape") setSuggestions(false);
              }}
            />
            {query ? (
              <IconButton
                label="Clear search"
                onClick={() => {
                  setQuery("");
                  setPage(1);
                  setList(false);
                  notify("Search cleared.");
                }}
              >
                <X size={14} />
              </IconButton>
            ) : (
              <kbd>⌘ K</kbd>
            )}
            {suggestions && (
              <div className="search-suggestions" aria-label="Search suggestions">
                {query ? (
                  <>
                    {all.slice(0, 5).map((item) => (
                      <button key={item.id} onClick={() => openMedia(item)}>
                        <img src={item.poster} alt="" loading="lazy" decoding="async" />
                        <span>
                          {item.title}
                          <br />
                          <small>
                            {item.year} · {item.kind}
                          </small>
                        </span>
                      </button>
                    ))}
                    {!all.length && <p className="menu-item">No titles found</p>}
                    <button onClick={submitSearch}>
                      View all {all.length} results <ChevronRight size={14} />
                    </button>
                  </>
                ) : recentSearches.length ? (
                  <>
                    <div className="recent-search-heading">
                      <span>Recent</span>
                      <button onClick={clearRecentSearches}>Clear all</button>
                    </div>
                    {recentSearches.slice(0, 8).map((item) => (
                      <div className="recent-search-row" key={item.id}>
                        <button
                          onClick={() => {
                            if (item.mediaId) {
                              setSuggestions(false);
                              navigate("discover", item.mediaId);
                            } else {
                              setQuery(item.query);
                              if (item.kind) setKind(item.kind);
                              setList(true);
                            }
                          }}
                        >
                          <History size={15} />
                          <span>{item.title || item.query}</span>
                          {item.kind && <small>{item.kind}</small>}
                        </button>
                        <button
                          className="recent-search-remove"
                          aria-label={`Remove ${item.title || item.query} from recent searches`}
                          onClick={() => removeRecentSearch(item.id)}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </>
                ) : (
                  <p className="menu-item">Your recent searches will appear here.</p>
                )}
              </div>
            )}
          </div>
        </Header>
        <div className="toolbar">
          <Tabs
            segmented
            value={kind}
            onChange={(v) => {
              setKind(v);
              setPage(1);
              setQuery("");
            }}
            items={[
              { value: "movie", label: "Movies" },
              { value: "series", label: "Series" },
            ]}
          />
          <span className="spacer" />
          <Choice
            className="sort-choice"
            value={sort}
            label="Sort titles"
            options={["Popular", "Newest", "Top rated", "Title A–Z"]}
            onChange={(v) => {
              setSort(v);
              setPage(1);
            }}
          />
          <Popover
            title={kind === "movie" ? "Filter movies" : "Filter series"}
            sideOffset={12}
            alignOffset={-82}
            open={filters}
            onOpenChange={setFilters}
            trigger={
              <Button variant="ghost">
                <SlidersHorizontal size={15} />
                Filters{activeFilters > 0 && ` · ${activeFilters}`}
              </Button>
            }
            footer={
              <>
                <Button variant="ghost" onClick={reset}>
                  Reset filters
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setFilters(false);
                    notify(`${all.length} matching titles.`);
                  }}
                >
                  Show {all.length} titles
                </Button>
              </>
            }
          >
            <Field label="Genre">
              <Choice
                label="Genre"
                value={genre}
                options={
                  native
                    ? ["All genres", ...new Set(remote.items.flatMap((m) => m.genres))]
                    : [
                        "All genres",
                        "Action",
                        "Adventure",
                        "Comedy",
                        "Crime",
                        "Drama",
                        "Mystery",
                        "Romance",
                        "Sci-Fi",
                        "Thriller",
                      ]
                }
                onChange={(v) => {
                  setGenre(v);
                  setPage(1);
                }}
              />
            </Field>
            <div className="field-pair">
              <Field label="From">
                <Input
                  aria-label="From year"
                  inputMode="numeric"
                  placeholder="Any year"
                  value={year}
                  onChange={(e) => {
                    setYear(e.target.value.replace(/\D/g, "").slice(0, 4));
                    setPage(1);
                  }}
                />
              </Field>
              <Field label="To">
                <Input
                  aria-label="To year"
                  inputMode="numeric"
                  placeholder="Any year"
                  value={untilYear}
                  onChange={(e) => {
                    setUntilYear(e.target.value.replace(/\D/g, "").slice(0, 4));
                    setPage(1);
                  }}
                />
              </Field>
            </div>
            <Field label="Minimum rating">
              <Choice
                label="Minimum rating"
                value={rating}
                options={["Any rating", "8 or higher", "7 or higher"]}
                onChange={(v) => {
                  setRating(v);
                  setPage(1);
                }}
              />
            </Field>
            {!native && (
              <Field label="Catalog">
                <Choice
                  label="Catalog"
                  value={catalogFilter}
                  options={["All catalogs", "Cinemeta"]}
                  onChange={setCatalogFilter}
                />
              </Field>
            )}
          </Popover>
          <Tabs
            segmented
            value={list ? "list" : "grid"}
            onChange={(v) => setList(v === "list")}
            items={[
              { value: "grid", label: "Grid", icon: <Grid2X2 size={14} /> },
              { value: "list", label: "List", icon: <List size={14} /> },
            ]}
          />
        </div>
        {(native ? remote.loading : scenario === "loading") ? (
          <>
            <div className="catalog-grid" aria-label="Loading titles" aria-busy="true">
              {Array.from({ length: 12 }, (_, i) => (
                <div className="skeleton" key={i} />
              ))}
            </div>
            {!native && (
              <Button onClick={() => updateDemo((s) => ({ ...s, scenario: "normal" }))}>
                Finish demo loading
              </Button>
            )}
          </>
        ) : (native ? remote.error : scenario === "offline") ? (
          <Empty
            title="Couldn't load the catalog"
            description={
              remote.error || "You're offline. Your downloads and library are still here."
            }
          >
            <Button
              onClick={() =>
                native ? remote.retry() : updateDemo((s) => ({ ...s, scenario: "normal" }))
              }
            >
              Retry
            </Button>
          </Empty>
        ) : scenario === "empty" || !visible.length ? (
          <Empty
            title={query ? `No results for “${query}”` : "No titles found"}
            description="Try a different search or adjust your filters."
          >
            <Button
              onClick={() => {
                reset();
                setQuery("");
                updateDemo((s) => ({ ...s, scenario: "normal" }));
              }}
            >
              Reset search and filters
            </Button>
          </Empty>
        ) : (
          <>
            <div className={list ? "catalog-list" : "catalog-grid"}>
              {visible.map((m) => (
                <PosterCard
                  key={m.id}
                  media={m}
                  selected={m.id === detail}
                  onClick={() => openMedia(m)}
                />
              ))}
            </div>
            <footer className="pagination">
              <span aria-live="polite">
                Showing {(currentPage - 1) * pageSize + 1}–
                {Math.min(currentPage * pageSize, sorted.length)}
              </span>
              <div className="row">
                {currentPage > 1 && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPage((p) => p - 1);
                      pageRef.current?.scrollTo({ top: 0 });
                    }}
                  >
                    <ChevronLeft size={14} />
                    Previous
                  </Button>
                )}
                <span>Page {currentPage}</span>
                <Button
                  variant="ghost"
                  disabled={(currentPage >= pages && !remote.hasMore) || remote.loadingMore}
                  onClick={() => {
                    if (native && currentPage >= pages && remote.hasMore) remote.loadMore();
                    setPage((p) => p + 1);
                    pageRef.current?.scrollTo({ top: 0 });
                  }}
                >
                  Next
                  <ChevronRight size={14} />
                </Button>
              </div>
            </footer>
          </>
        )}
      </section>
      <Presence>
        {media && (
          <Fragment key="details">
            <MovieDetails key={media.id} media={media} onMonitor={onMonitor} />
          </Fragment>
        )}
      </Presence>
    </>
  );
}
const demoSources = [
  { name: "4K · Blu-ray · HDR10", quality: "4K · Blu-ray · English", size: 21.8, cached: true },
  { name: "1080p · Blu-ray", quality: "1080p · Blu-ray · English", size: 8.4, cached: true },
  { name: "4K · WEB-DL", quality: "4K · WEB-DL · English", size: 16.2, cached: false },
];
function MovieDetails({
  media,
  onMonitor,
}: {
  media: Media;
  onMonitor: (id: string, episodes?: number[], season?: number) => void;
}) {
  const { preferences, scenario } = useDemo();
  const sourceResult = useSources(media);
  const sources = native ? sourceResult.sources : demoSources;
  const [source, setSource] = useState(0);
  const [choose, setChoose] = useState(false);
  const [destination, setDestination] = useState(
    native ? preferences.folder : `${preferences.folder} / ${media.title} (${media.year})`,
  );
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectedSource = Math.min(source, Math.max(0, sources.length - 1));
  const release = sources[selectedSource] ?? {
    name: "No source selected",
    quality: "",
    size: 0,
    cached: false,
  };
  const blocked = native && sourceResult.sources[selectedSource]?.blocked;
  const unavailable = native ? !sources.length : scenario === "no-source";
  const download = async () => {
    if (busy) return;
    if (native) {
      const selected = sourceResult.sources[selectedSource];
      if (!selected || selected.blocked) return;
      setBusy(true);
      try {
        await runBackend("enqueue", { id: selected.id, destination });
        setConfirm(false);
        notify("Download queued.", { label: "View queue", run: () => navigate("downloads") });
      } catch {
        /* The backend error is shown by runBackend. */
      } finally {
        setBusy(false);
      }
      return;
    }
    if (scenario === "storage-error" || destination.includes("External")) {
      notify("Destination unavailable. Choose a folder on this device.");
      return;
    }
    if (!preferences.provider || scenario === "provider-error") {
      notify("Connect the demo provider in Settings first.", {
        label: "Settings",
        run: () => navigate("settings", "Providers"),
      });
      return;
    }
    setBusy(true);
    window.setTimeout(() => {
      updateDemo((state) => {
        const result = enqueue(state, {
          mediaId: media.id,
          quality: release.quality,
          size: release.size ?? 0,
          destination,
          episodes: [],
          season: 1,
          uncached: !release.cached,
        });
        notify(
          result.added ? "Added to demo Downloads. No live transfer started." : result.reason!,
          {
            label: result.added ? "View queue" : "View library",
            run: () => navigate(result.added ? "downloads" : "library"),
          },
        );
        return result.state;
      });
      setBusy(false);
    }, 350);
  };
  return (
    <>
      <Drawer title="Movie details" onClose={() => navigate("discover")}>
        {media.id === "interstellar" ? (
          <img
            className="drawer-backdrop"
            src="/moviebox/interstellar-backdrop.jpg"
            alt="Interstellar astronaut on an ocean planet"
          />
        ) : (
          <div className="title-art">
            <img src={media.poster} alt="" />
          </div>
        )}
        <div className="drawer-content">
          <div>
            <h1>{media.title}</h1>
            <p className="drawer-subtitle">
              {media.year} ·{" "}
              {media.id === "interstellar"
                ? "2h 49m · Adventure, Sci-fi"
                : `${media.runtime} · ${media.genres.slice(0, 2).join(", ")}`}
            </p>
          </div>
          <p className="drawer-description">
            {media.description ||
              (media.id === "interstellar"
                ? "A former pilot joins a mission beyond our galaxy to find a new home for humanity."
                : `${media.title}, a ${media.year.slice(0, 4)} ${media.genre.toLowerCase()} ${media.kind}. Choose your source and save it to your own library.`)}
          </p>
          <hr />
          <div className="drawer-source">
            <div className="row">
              <strong>Download source</strong>
              <small className="spacer" />
              <small>
                {sourceResult.loading ? "Searching…" : `${sources.length} sources found`}
              </small>
            </div>
            {unavailable ? (
              <Banner
                title={
                  sourceResult.loading
                    ? "Searching sources…"
                    : sourceResult.report?.state === "missing_provider"
                      ? "Download sources not configured"
                      : sourceResult.error || sourceResult.report?.state === "error"
                        ? "Source search failed"
                        : "No matching source yet"
                }
                tone="warning"
              >
                <p>
                  {sourceResult.loading
                    ? "Checking enabled add-ons and source preferences…"
                    : sourceResult.error ||
                      sourceResult.report?.summary ||
                      "Enable a source add-on in Settings, or create a rule to check again later."}
                </p>
                {native && !sourceResult.loading && (
                  <ActionGroup>
                    <Button onClick={sourceResult.retry}>Retry sources</Button>
                  </ActionGroup>
                )}
              </Banner>
            ) : (
              <>
                <Popover
                  title="Choose a source"
                  className="source-popover"
                  open={choose}
                  onOpenChange={setChoose}
                  trigger={
                    <button className="choice">
                      <span>
                        {release.name}
                        <br />
                        <small>
                          {native ? release.quality : "English · MKV"} ·{" "}
                          {release.size ? `${release.size.toFixed(2)} GB` : "Size unknown"}
                        </small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  }
                >
                  {sources.map((s, i) => (
                    <button
                      className={`source-option ${source === i ? "selected" : ""}`}
                      key={native ? sourceResult.sources[i]!.id : s.name}
                      aria-pressed={source === i}
                      onClick={() => {
                        setSource(i);
                        setChoose(false);
                      }}
                    >
                      <strong>
                        {s.name}
                        {source === i && <Check size={16} />}
                      </strong>
                      <small>
                        {native ? s.quality : "English · MKV"} ·{" "}
                        {s.size ? `${s.size.toFixed(2)} GB` : "Size unknown"}
                      </small>
                      <small
                        className={
                          native
                            ? sourceResult.sources[i]?.verification === "file_matched"
                              ? "success"
                              : sourceResult.sources[i]?.blocked
                                ? "warning"
                                : "muted"
                            : s.cached
                              ? "success"
                              : "warning"
                        }
                      >
                        {native
                          ? sourceResult.sources[i]!.availability
                          : s.cached
                            ? "Cached · demo source"
                            : "Uncached · needs preparation"}
                      </small>
                    </button>
                  ))}
                </Popover>
                <small
                  className={
                    native
                      ? sourceResult.sources[selectedSource]?.verification === "file_matched"
                        ? "success"
                        : blocked
                          ? "warning"
                          : "muted"
                      : release.cached
                        ? "success"
                        : "warning"
                  }
                >
                  {(
                    native
                      ? sourceResult.sources[selectedSource]?.verification === "file_matched"
                      : release.cached
                  ) ? (
                    <Check size={12} />
                  ) : null}{" "}
                  {native
                    ? sourceResult.sources[selectedSource]?.availability
                    : release.cached
                      ? "Cached on TorBox · demo source"
                      : "Uncached · preparation required"}
                </small>
              </>
            )}
          </div>
          {sourceResult.report && <SourceSearchDetails report={sourceResult.report} />}
          <div className="stack" style={{ gap: 10 }}>
            <strong>Save to</strong>
            <FolderChoice value={destination} onChange={setDestination} />
          </div>
          <div className="drawer-actions">
            <Button
              variant="primary"
              disabled={unavailable || sourceResult.loading || blocked}
              busy={busy}
              onClick={() => (release.cached ? download() : setConfirm(true))}
            >
              <Download size={16} />
              Download now
            </Button>
            <Button onClick={() => onMonitor(media.id)}>
              <History size={16} />
              Monitor availability
            </Button>
          </div>
          <small>
            Looking for a different quality? Set a rule and let Movie Box check for it on your
            schedule.
          </small>
        </div>
      </Drawer>

      <Presence>
        {confirm && (
          <Confirm
            key="Confirm"
            title="Prepare this source?"
            description={
              native
                ? "Your selected provider will prepare this source in the cloud. Movie Box waits until it is ready, then downloads the selected file."
                : "This preview creates a Preparing job without a transfer."
            }
            confirm="Prepare source"
            danger={false}
            onClose={() => setConfirm(false)}
            onConfirm={download}
          />
        )}
      </Presence>
    </>
  );
}
function Season({
  media,
  onMonitor,
}: {
  media: Media;
  onMonitor: (id: string, episodes?: number[], season?: number) => void;
}) {
  const state = useDemo();
  const requestedSeason = Number(routeParam("season"));
  const initialSeason =
    Number.isInteger(requestedSeason) && requestedSeason > 0 ? requestedSeason : 1;
  const [season, setSeason] = useState(`Season ${initialSeason}`);
  const number = Number(season.replace("Season ", ""));
  const existing = state.library
    .filter((f) => f.mediaId === media.id && f.season === number && !f.missing)
    .flatMap((f) => f.episodes);
  const episodes = native
    ? media.episodes.filter((e) => e.season === number)
    : media.episodes.length
      ? media.episodes
      : Array.from({ length: 8 }, (_, i) => ({
          title: `Episode ${i + 1}`,
          episode: i + 1,
          season: 1,
        }));
  const missing = episodes.map((e) => e.episode).filter((e) => !existing.includes(e));
  const [selected, setSelected] = useState<number[]>(missing);
  const [method, setMethod] = useState("Season pack");
  const [destination, setDestination] = useState(
    native ? state.preferences.folder : `Series / ${media.title} / ${season}`,
  );
  const [review, setReview] = useState(false);
  const [monitorMissing, setMonitorMissing] = useState(true);
  const ready = selected.filter((e) => e < 8);
  const unmatched = selected.filter((e) => !ready.includes(e));
  const closeReview = () => setReview(false);
  const reviewMatches = () => setReview(true);
  const queue = () => {
    updateDemo((s) => {
      const result = enqueue(s, {
        mediaId: media.id,
        quality: "1080p · WEB-DL · English",
        size: ready.length * 2.6,
        destination,
        episodes: ready,
        season: number,
      });
      notify(result.added ? `${ready.length} episodes added to demo Downloads.` : result.reason!, {
        label: "View queue",
        run: () => navigate("downloads"),
      });
      return result.state;
    });
    setReview(false);
    if (unmatched.length && monitorMissing) onMonitor(media.id, unmatched, number);
  };
  return (
    <section className="page">
      <Header
        title={media.title}
        subtitle={`Series · ${media.year.slice(0, 4)} · ${media.genres.slice(0, 2).join(", ")}`}
      >
        <Button onClick={() => onMonitor(media.id)}>
          <History size={16} />
          Monitor series
        </Button>
      </Header>
      <div className="season-layout">
        <div className="episode-list">
          <div className="toolbar">
            <Choice
              label="Season"
              value={season}
              options={
                native
                  ? [...new Set(media.episodes.map((e) => `Season ${e.season}`))]
                  : ["Season 1", "Season 2"]
              }
              onChange={(v) => {
                setSeason(v);
                const nextExisting = state.library
                  .filter(
                    (f) =>
                      f.mediaId === media.id &&
                      f.season === Number(v.replace("Season ", "")) &&
                      !f.missing,
                  )
                  .flatMap((f) => f.episodes);
                setSelected(
                  (native
                    ? media.episodes.filter((e) => e.season === Number(v.replace("Season ", "")))
                    : episodes
                  )
                    .map((e) => e.episode)
                    .filter((n) => !nextExisting.includes(n)),
                );
                if (!native) setDestination(`Series / ${media.title} / ${v}`);
              }}
            />
            <span className="spacer" />
            <Button
              aria-pressed={selected.length === missing.length && missing.length > 0}
              onClick={() => setSelected(selected.length === missing.length ? [] : missing)}
            >
              Select missing · {missing.length}
            </Button>
          </div>
          <small>
            {episodes.length} episodes · {existing.length} already in your library
          </small>
          {episodes.map((e) => (
            <div className="episode-row" key={e.episode}>
              {existing.includes(e.episode) ? (
                <Check size={16} className="success" />
              ) : (
                <CheckBox
                  label={`Select ${e.title}`}
                  checked={selected.includes(e.episode)}
                  onChange={(v) =>
                    setSelected((s) => (v ? [...s, e.episode] : s.filter((n) => n !== e.episode)))
                  }
                />
              )}
              <span className="episode-number">{String(e.episode).padStart(2, "0")}</span>
              <span className="episode-title">{e.title}</span>
              <small className={existing.includes(e.episode) ? "success" : "muted"}>
                {existing.includes(e.episode) ? "In library" : "Not downloaded"}
              </small>
            </div>
          ))}
        </div>
        <aside className="season-summary">
          <div className="season-summary-title">
            <img src={media.poster} alt="" />
            <div>
              <h2>
                {media.title} · {season}
              </h2>
              <p>{selected.length} episodes selected</p>
            </div>
          </div>
          <Field label="Download method">
            <Choice
              label="Download method"
              value={method}
              options={["Season pack", "Individual episodes"]}
              onChange={setMethod}
            />
          </Field>
          <Field label="Source">
            <Choice
              label="Episode source"
              value={native ? state.preferences.quality : "1080p · WEB-DL · English"}
              options={[native ? state.preferences.quality : "1080p · WEB-DL · English"]}
              onChange={() => {}}
            />
          </Field>
          <Banner title="Review before downloading" tone="success">
            {native
              ? "Episode names come from metadata. Search first to find pack or individual candidates; file checks happen separately."
              : "Existing files are skipped. Missing pack files are checked individually."}
          </Banner>
          <Field label="Save to">
            <FolderChoice value={destination} onChange={setDestination} />
          </Field>
          <div className="row">
            <small>Selected files</small>
            <span className="spacer" />
            <span>
              {native ? "Shown after matching" : `${(selected.length * 2.6).toFixed(1)} GB`}
            </span>
          </div>
          <Button variant="primary" disabled={!selected.length} onClick={reviewMatches}>
            <Download size={16} />
            {native ? "Find sources for" : "Download"} {selected.length} episodes
          </Button>
          <Button onClick={() => onMonitor(media.id, undefined, number)}>
            <History size={15} />
            Monitor this season
          </Button>
          <small>
            Source sizes and library status are shown before anything enters your queue.
          </small>
        </aside>
      </div>
      <Presence>
        {review &&
          (native ? (
            <BundleReview
              key="bundle"
              media={media}
              season={number}
              episodes={selected}
              method={method}
              destination={destination}
              onClose={closeReview}
              onMonitor={onMonitor}
            />
          ) : (
            <Modal
              key="demo-review"
              wide
              title="Review episode matches"
              description={`${media.title} · ${season}`}
              onClose={closeReview}
              footer={
                <>
                  <Button onClick={closeReview}>Back</Button>
                  <Button variant="primary" disabled={!ready.length} onClick={queue}>
                    Queue {ready.length} ready episodes
                  </Button>
                </>
              }
            >
              <Banner title={`${ready.length} ready · ${unmatched.length} need a source`}>
                Demo coverage; no files are downloaded.
              </Banner>
              <div className="episode-matches">
                {selected.map((n) => (
                  <div className="episode-match" key={n}>
                    <strong>Episode {n}</strong>
                    <small>{ready.includes(n) ? "Ready" : "No source"}</small>
                  </div>
                ))}
              </div>
              {unmatched.length > 0 && (
                <label className="row">
                  <CheckBox
                    label="Monitor unmatched episodes"
                    checked={monitorMissing}
                    onChange={setMonitorMissing}
                  />
                  Monitor unmatched episodes
                </label>
              )}
            </Modal>
          ))}
      </Presence>
    </section>
  );
}
