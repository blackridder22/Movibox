import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CustomLayoutSafetyNet } from "@/chrome/custom-layout-safety-net";
import { FloatingBack } from "@/chrome/floating-back";
import { WindowControls } from "@/chrome/window-controls";
import { WindowResizeEdges } from "@/chrome/window-resize-edges";
import { MinUIDock } from "@/chrome/minui-dock";
import { Sidebar } from "@/chrome/sidebar";
import { DraculaSidebar } from "@/chrome/dracula-sidebar";
import { NordSidebar } from "@/chrome/nord-sidebar";
import { ForestSidebar } from "@/chrome/forest-sidebar";
import { RoyalTopbar } from "@/chrome/royal-topbar";
import { SideRail } from "@/chrome/siderail";
import { StremioRail } from "@/chrome/stremio-rail";
import { TopDock } from "@/chrome/topdock";
import { CinematicOverlay } from "@/chrome/cinematic-overlay";
import { Topbar } from "@/chrome/topbar";
import { startMaintenance, subscribeMemoryPressure } from "@/lib/maintenance";
import { MiddleClickScroll } from "@/lib/use-middle-click-scroll";
import { toggleWindowFullscreen } from "@/lib/fullscreen-state";
import { useOverlayPinned } from "@/lib/overlay-pin";
import { isMobileDevice, isWeb } from "@/lib/platform";
import { activeLayout } from "@/lib/theme";
import { useThemePreview } from "@/lib/theme-preview";
import { DevErrorTrigger } from "@/components/dev-error-trigger";
import { ErrorView } from "@/components/error-view";
import { HarborErrorBoundary } from "@/components/error-boundary";
import { ContextMenu } from "@/components/context-menu";
import { CurfewGuard } from "@/components/curfew-guard";
import { HoverPreview } from "@/components/hover-preview";
import { CustomHoverCssMount } from "@/components/custom-hover-css-mount";
import { EmbedViewportRoot } from "@/components/embed-viewport";
import { InstallerViewportRoot } from "@/components/installer-viewport";
import { CustomCodeMount } from "@/components/custom-code-mount";
import { MemoryHud } from "@/components/memory-hud";
import { OfflineBanner } from "@/chrome/offline-banner";
import { MobileNotice } from "@/components/mobile-notice";
import { WebhookLoopMount } from "@/components/webhook-loop-mount";
import { ListToastHost } from "@/components/lists/list-toast";
import { AnilistSyncToast } from "@/components/anilist/anilist-sync-toast";
import { AnilistAvatarSync } from "@/components/anilist/anilist-avatar-sync";
import { MalAvatarSync } from "@/components/mal/mal-avatar-sync";
import { MalSyncToast } from "@/components/mal/mal-sync-toast";
import { ThemeBackdrop } from "@/components/theme-backdrop";
import { TopRankModal } from "@/components/top-rank-modal";
import { AuthProvider } from "@/lib/auth";
import { ProfilesProvider, useProfiles } from "@/lib/profiles";
import { ProfileIdentitySync } from "@/lib/profile-identity-sync";
import { SettingsProfileBridge } from "@/lib/settings-profile-bridge";
import { TrackerProfileBridge } from "@/lib/tracker-profile-bridge";
import { ProfilePickerModal } from "@/components/profile-picker/picker-modal";
import { WatchlistSync } from "@/lib/watchlist-sync";
import { ContextMenuProvider } from "@/lib/context-menu";
import { TopRankModalProvider } from "@/lib/top-rank-modal";
import { OnboardingProvider } from "@/lib/onboarding";
import { RankingsProvider } from "@/lib/rankings";
import { SettingsProvider } from "@/lib/settings";
import { SearchProvider, useSearch } from "@/lib/search-context";
import { SearchOverlay } from "@/components/search/search-overlay";
import { SearchHotkey } from "@/components/search/search-hotkey";
import { TogetherProvider } from "@/lib/together/provider";
import { MediaFavoritesProvider } from "@/lib/media-favorites";
import { LocalWatchlistProvider } from "@/lib/local-watchlist";
import { useSettings } from "@/lib/settings";
import { effectiveBinding, eventToBinding, shouldHandleGlobalKeyboardEvent } from "@/lib/hotkeys";
import { ViewProvider, useView, type Frame, type MetaFilter, type View } from "@/lib/view";
import type { MetaType } from "@/lib/cinemeta";
import { Home } from "@/views/home";
import { ParentalProvider } from "@/lib/parental";
import { TraktProvider } from "@/lib/trakt/provider";
import { AnilistProvider } from "@/lib/anilist/provider";
import { MalProvider } from "@/lib/mal/provider";
import { SimklProvider } from "@/lib/simkl/provider";
import { LetterboxdProvider } from "@/lib/stremboxd/provider";
import { focusTvPageDefault, useKeyboardNavigation } from "@/lib/keyboard-navigation";
import { SFX } from "@/lib/sfx";
import { onDeepLinkInstall, onDeepLinkOpen, startDeepLinkBridge } from "@/lib/deep-link";
import { HarborQueryProvider, useIdlePagePrefetch } from "@/lib/query";
import { HarborRouterProvider, ViewRouterSync } from "@/router";
import { AutomationRunner } from "@/lib/acquisition/automation-runner";

const importAnime = () => import("@/views/anime");
const importCalendar = () => import("@/views/calendar");
const importWrapped = () => import("@/views/wrapped");
const importDetail = () => import("@/views/detail");
const importAddons = () => import("@/views/addons");
const importDiscover = () => import("@/views/discover");
const importCatalogs = () => import("@/views/catalogs");
const importAward = () => import("@/views/award");
const importAnimeAward = () => import("@/views/anime-award");
const importFilter = () => import("@/views/filter");
const importGrid = () => import("@/views/grid");
const importPerson = () => import("@/views/person");
const importCollection = () => import("@/views/collection");
const importEpisodeDetail = () => import("@/views/episode-detail");
const importPlayPicker = () => import("@/views/play-picker");
const importMovies = () => import("@/views/movies");
const importKids = () => import("@/views/kids");
const importQueue = () => import("@/views/queue");
const importService = () => import("@/views/service");
const importSettings = () => import("@/views/settings");
const importShows = () => import("@/views/shows");
const importLibrary = () => import("@/views/library");
const importDownloads = () => import("@/views/downloads");
const importOnboarding = () => import("@/components/onboarding");

const AnimeView = lazy(() => importAnime().then((m) => ({ default: m.AnimeView })));
const CalendarView = lazy(() => importCalendar().then((m) => ({ default: m.CalendarView })));
const WrappedView = lazy(() => importWrapped().then((m) => ({ default: m.WrappedView })));
const DetailView = lazy(() => importDetail().then((m) => ({ default: m.DetailView })));
const AddonsView = lazy(() => importAddons().then((m) => ({ default: m.AddonsView })));
const Discover = lazy(() => importDiscover().then((m) => ({ default: m.Discover })));
const Catalogs = lazy(() => importCatalogs().then((m) => ({ default: m.Catalogs })));
const AwardView = lazy(() => importAward().then((m) => ({ default: m.AwardView })));
const AnimeAwardView = lazy(() => importAnimeAward().then((m) => ({ default: m.AnimeAwardView })));
const FilterView = lazy(() => importFilter().then((m) => ({ default: m.FilterView })));
const GridView = lazy(() => importGrid().then((m) => ({ default: m.GridView })));
const PersonView = lazy(() => importPerson().then((m) => ({ default: m.PersonView })));
const CollectionView = lazy(() => importCollection().then((m) => ({ default: m.CollectionView })));
const EpisodeDetailView = lazy(() =>
  importEpisodeDetail().then((m) => ({ default: m.EpisodeDetailView })),
);
const CollectionsView = lazy(() =>
  import("@/views/collections").then((m) => ({ default: m.CollectionsView })),
);
const PlayPicker = lazy(() => importPlayPicker().then((m) => ({ default: m.PlayPicker })));
const Movies = lazy(() => importMovies().then((m) => ({ default: m.Movies })));
const Kids = lazy(() => importKids().then((m) => ({ default: m.Kids })));
const KidsDetailView = lazy(() =>
  import("@/views/kids-detail").then((m) => ({ default: m.KidsDetailView })),
);
const QueueView = lazy(() => importQueue().then((m) => ({ default: m.QueueView })));
const ServiceView = lazy(() => importService().then((m) => ({ default: m.ServiceView })));
const Settings = lazy(() => importSettings().then((m) => ({ default: m.Settings })));
const Shows = lazy(() => importShows().then((m) => ({ default: m.Shows })));
const LibraryView = lazy(() => importLibrary().then((m) => ({ default: m.LibraryView })));
const DownloadsView = lazy(() => importDownloads().then((m) => ({ default: m.DownloadsView })));
const OnboardingModal = lazy(() =>
  importOnboarding().then((m) => ({ default: m.OnboardingModal })),
);

function useViewPreloader() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const schedule = (cb: () => void, timeout: number) =>
      typeof win.requestIdleCallback === "function"
        ? win.requestIdleCallback(cb, { timeout })
        : window.setTimeout(cb, Math.min(timeout, 800));

    // Priority: Movies/Shows chunks first — they were lazy and felt slower than Anime.
    const priorityId = schedule(() => {
      if (cancelled) return;
      void importMovies();
      void importShows();
      void importAnime();
      void importDiscover();
      void importDetail();
      void importPlayPicker();
    }, 1200);

    const restId = schedule(() => {
      if (cancelled) return;
      void importSettings();
      void importAddons();
      void importPerson();
      void importFilter();
      void importCalendar();
      void importQueue();
      void importAward();
      void importAnimeAward();
      void importService();
      void importOnboarding();
      void importLibrary();
      void importCatalogs();
      void importKids();
      void importDownloads();
    }, 2800);

    return () => {
      cancelled = true;
      if (typeof win.cancelIdleCallback === "function") {
        win.cancelIdleCallback(priorityId as number);
        win.cancelIdleCallback(restId as number);
      } else {
        window.clearTimeout(priorityId);
        window.clearTimeout(restId);
      }
    };
  }, []);
}

function IdlePagePrefetch() {
  useIdlePagePrefetch();
  return null;
}

const KEEP_ALIVE_MS = 1500;
const IDLE_EVICT_MS = 10 * 1000;
const PRESSURE_EVICT_MS = 1500;
const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 1.6;
const UI_SCALE_STEP = 0.05;
const UI_SCALE_ACTIVITY_EVENT = "harbor:ui-scale-activity";

function clampUiScale(scale: number): number {
  return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(scale * 100) / 100));
}

function useKeepAlive(active: boolean, requested: boolean, pin = false): boolean {
  const [mounted, setMounted] = useState(active && requested);
  useEffect(() => {
    if (!requested) {
      setMounted(false);
      return;
    }
    if (active || pin) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), KEEP_ALIVE_MS);
    return () => clearTimeout(t);
  }, [active, requested, pin]);
  return requested && (mounted || active || pin);
}

function useIdleEvict(active: boolean, pin = false): boolean {
  const [alive, setAlive] = useState(active);
  const [pressure, setPressure] = useState(false);
  useEffect(() => subscribeMemoryPressure(setPressure), []);
  useEffect(() => {
    if (active || pin) {
      setAlive(true);
      return;
    }
    if (!alive) return;
    const t = setTimeout(() => setAlive(false), pressure ? PRESSURE_EVICT_MS : IDLE_EVICT_MS);
    return () => clearTimeout(t);
  }, [active, alive, pressure, pin]);
  return alive || active || pin;
}

export function App({ onReady }: { onReady?: () => void }) {
  if (isWeb() && isMobileDevice()) return <MobileNotice />;
  return (
    <HarborQueryProvider>
      <HarborRouterProvider>
        <SettingsProvider>
          <ProfilesProvider>
            <ParentalProvider>
              <TraktProvider>
                <AnilistProvider>
                  <MalProvider>
                    <SimklProvider>
                      <LetterboxdProvider>
                        <RankingsProvider>
                          <AuthProvider>
                            <OnboardingProvider>
                              <TogetherProvider>
                                <ViewProvider>
                                  <ViewRouterSync />
                                  <IdlePagePrefetch />
                                  <SearchProvider>
                                    <MediaFavoritesProvider>
                                      <LocalWatchlistProvider>
                                        <ContextMenuProvider>
                                          <TopRankModalProvider>
                                            <HarborErrorBoundary>
                                              <AutomationRunner />
                                              <ProfileIdentitySync />
                                              <SettingsProfileBridge />
                                              <TrackerProfileBridge />
                                              <AnilistAvatarSync />
                                              <MalAvatarSync />
                                              <MiddleClickScroll />
                                              <ThemeBackdrop />
                                              <WatchlistSync />
                                              <Shell onReady={onReady} />
                                              <Suspense fallback={null}>
                                                <OnboardingModal />
                                              </Suspense>
                                              <AnilistSyncToast />
                                              <MalSyncToast />
                                              <ListToastHost />
                                              <ContextMenu />
                                              <HoverPreview />
                                              <CustomHoverCssMount />
                                              <TopRankModal />
                                              <ProfilePickerModal />
                                              <CurfewGuard />
                                              <SearchOverlay />
                                              <SearchHotkey />
                                              <EmbedViewportRoot />
                                              <InstallerViewportRoot />
                                            </HarborErrorBoundary>
                                            <ErrorView />
                                            <DevErrorTrigger />
                                          </TopRankModalProvider>
                                        </ContextMenuProvider>
                                      </LocalWatchlistProvider>
                                    </MediaFavoritesProvider>
                                  </SearchProvider>
                                </ViewProvider>
                              </TogetherProvider>
                            </OnboardingProvider>
                          </AuthProvider>
                        </RankingsProvider>
                      </LetterboxdProvider>
                    </SimklProvider>
                  </MalProvider>
                </AnilistProvider>
              </TraktProvider>
            </ParentalProvider>
          </ProfilesProvider>
        </SettingsProvider>
      </HarborRouterProvider>
    </HarborQueryProvider>
  );
}

function filterReactKey(f: MetaFilter): string {
  if (f.kind === "year" || f.kind === "runtime")
    return `filter-${f.kind}-${f.mediaType}-${f.value}`;
  if (f.kind === "country" || f.kind === "language")
    return `filter-${f.kind}-${f.mediaType}-${f.iso}`;
  return `filter-${f.kind}-${f.mediaType}-${f.id}`;
}

function parseDeepLinkEpisode(videoId?: string): { season: number; episode: number } | undefined {
  if (!videoId) return undefined;
  const parts = videoId.split(":");
  if (parts.length < 3) return undefined;
  const season = Number(parts[parts.length - 2]);
  const episode = Number(parts[parts.length - 1]);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return undefined;
  return { season, episode };
}

function Shell({ onReady }: { onReady?: () => void }) {
  const {
    topKind,
    service,
    meta,
    metaLiveContext,
    metaEpisodeHint,
    episodeDetail,
    personId,
    collectionId,
    filter,
    grid,
    awardType,
    animeAwardSource,
    picker,
    player,
    setView,
    canGoBack,
    goBack,
    canGoForward,
    goForward,
    openMeta,
    exitPlayback,
    exitPickerToDetail,
    stackKinds,
    chromeHidden,
  } = useView();
  const { settings, update } = useSettings();
  const { setOpen: setSearchOpen, open: searchOpen } = useSearch();
  const uiScaleRef = useRef(settings.uiScale);
  const { activeProfile } = useProfiles();
  const kid = activeProfile?.kid ?? null;
  const preview = useThemePreview();
  const baseLayout = useMemo(
    () => (preview ? preview.layout : activeLayout(settings.theme)),
    [preview, settings.theme],
  );
  const layout = kid ? "sidebar" : baseLayout;
  const themeHasTopbar =
    layout === "sidebar" ||
    layout === "dracula" ||
    layout === "nord" ||
    layout === "forest" ||
    layout === "stremio";
  useViewPreloader();

  useEffect(() => {
    if (topKind === "home") return;
    onReady?.();
  }, [onReady, topKind]);

  const handleTvBack = useCallback(() => {
    if (searchOpen) {
      setSearchOpen(false);
      return true;
    }
    // Player/picker stacks can be nested (next episode pushes picker+player).
    // Always leave playback entirely — never step back to a prior episode or
    // re-enter the loading picker for the current one.
    if (topKind === "player") {
      const localBack = new Event("harbor:local-back", { cancelable: true });
      if (!window.dispatchEvent(localBack)) return true;
      exitPlayback();
      return true;
    }
    if (topKind === "picker") {
      if (picker) exitPickerToDetail(picker.meta);
      else exitPlayback();
      return true;
    }
    if (canGoBack) {
      goBack();
      return true;
    }
    return false;
  }, [
    searchOpen,
    setSearchOpen,
    topKind,
    exitPlayback,
    exitPickerToDetail,
    picker,
    canGoBack,
    goBack,
  ]);

  const handleTvBackToNav = useCallback(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    const nav = document.querySelector<HTMLElement>(
      "[data-harbor-nav][data-active], [data-harbor-nav], [data-tv-nav-zone] button, [data-harbor-sidebar] button",
    );
    nav?.focus({ preventScroll: true });
  }, []);

  useKeyboardNavigation({
    enabled: settings.tvNavigation && !player,
    wrap: false,
    onBack: handleTvBack,
    onBackToNav: handleTvBackToNav,
  });
  useEffect(() => {
    if (!settings.tvNavigation || searchOpen || topKind === "player") return;
    const id = window.requestAnimationFrame(() => focusTvPageDefault());
    return () => window.cancelAnimationFrame(id);
  }, [settings.tvNavigation, topKind, meta?.id, searchOpen]);
  useEffect(() => {
    if (settings.soundTheme) {
      SFX.setTheme(settings.soundTheme);
    }

    const volume = settings.sfxVolume ?? 50;

    SFX.setVolume(volume / 100);
  }, [settings.soundTheme, settings.sfxVolume]);

  useEffect(() => {
    const initAudio = () => SFX.init();

    window.addEventListener("pointerdown", initAudio, { once: true });
    window.addEventListener("keydown", initAudio, { once: true });

    const onMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const interactive = target.closest(
        'a[href], button, [data-focusable="true"], [role="button"]',
      ) as HTMLElement | null;

      if (!interactive) return;

      const related = e.relatedTarget as Node | null;
      if (related && interactive.contains(related)) return;

      SFX.hover();
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const btn = target.closest(
        'button, a[href], [data-focusable="true"], [role="button"]',
      ) as HTMLElement | null;

      if (!btn) return;

      const isCloseAction =
        btn.matches(
          "[data-harbor-back], [data-back], [data-close], [data-tv-modal-close], .close-btn, .back-btn",
        ) ||
        !!btn.closest(
          "[data-harbor-back], [data-back], [data-close], [data-tv-modal-close], .close-btn, .back-btn",
        );

      const isMovieCard =
        btn.hasAttribute("data-media-card") ||
        btn.hasAttribute("data-movie-card") ||
        btn.classList.contains("media-card") ||
        !!btn.querySelector("img") ||
        !!btn.closest("[data-tv-hero-zone]");

      const isMenuOrSettings = !!btn.closest(
        '.settings-panel, [role="menu"], [role="dialog"], [data-settings-root], [data-settings-panel]',
      );

      if (isCloseAction) {
        SFX.close();
        return;
      }

      if (isMovieCard || isMenuOrSettings) {
        SFX.open();
        return;
      }

      SFX.click();
    };

    window.addEventListener("mouseover", onMouseOver);
    window.addEventListener("click", onClick, true);

    return () => {
      window.removeEventListener("pointerdown", initAudio);
      window.removeEventListener("keydown", initAudio);
      window.removeEventListener("mouseover", onMouseOver);
      window.removeEventListener("click", onClick, true);
    };
  }, [handleTvBack]);

  useEffect(() => startMaintenance(), []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3) {
        const localBack = new Event("harbor:local-back", { cancelable: true });
        if (!window.dispatchEvent(localBack)) {
          e.preventDefault();
          return;
        }
        if (topKind === "player" || topKind === "picker") {
          e.preventDefault();
          exitPlayback();
          return;
        }
        if (canGoBack) {
          e.preventDefault();
          goBack();
        }
      } else if (e.button === 4 && canGoForward) {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [canGoBack, goBack, canGoForward, goForward, topKind, exitPlayback]);

  useEffect(() => {
    uiScaleRef.current = settings.uiScale;
  }, [settings.uiScale]);

  useEffect(() => {
    const setUiScale = (next: number) => {
      const uiScale = clampUiScale(next);
      if (uiScale !== uiScaleRef.current) {
        uiScaleRef.current = uiScale;
        update({ uiScale });
      }
    };
    const stepUiScale = (direction: 1 | -1) => {
      setUiScale(uiScaleRef.current + direction * UI_SCALE_STEP);
    };
    const usesZoomModifier = (e: KeyboardEvent | WheelEvent) => e.ctrlKey || e.metaKey;
    const isDefaultUiScaleUp = (e: KeyboardEvent) =>
      usesZoomModifier(e) && (e.key === "+" || e.key === "=");
    const isDefaultUiScaleDown = (e: KeyboardEvent) =>
      usesZoomModifier(e) && (e.key === "-" || e.key === "_");
    const isDefaultUiScaleReset = (e: KeyboardEvent) => usesZoomModifier(e) && e.key === "0";
    const onKey = (e: KeyboardEvent) => {
      if (!shouldHandleGlobalKeyboardEvent(e)) return;
      const binding = eventToBinding(e);
      const overrides = settings.hotkeys ?? {};
      const uiScaleUpCustom = "globalUiScaleUp" in overrides;
      const uiScaleDownCustom = "globalUiScaleDown" in overrides;
      const uiScaleResetCustom = "globalUiScaleReset" in overrides;
      const matchesUp =
        effectiveBinding("globalUiScaleUp", overrides) === binding ||
        (!uiScaleUpCustom && isDefaultUiScaleUp(e));
      const matchesDown =
        effectiveBinding("globalUiScaleDown", overrides) === binding ||
        (!uiScaleDownCustom && isDefaultUiScaleDown(e));
      const matchesReset =
        effectiveBinding("globalUiScaleReset", overrides) === binding ||
        (!uiScaleResetCustom && isDefaultUiScaleReset(e));
      if (!matchesUp && !matchesDown && !matchesReset) return;
      if (player && matchesReset) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      window.dispatchEvent(new Event(UI_SCALE_ACTIVITY_EVENT));
      if (matchesReset) {
        setUiScale(1);
      } else if (matchesUp) {
        stepUiScale(1);
      } else if (matchesDown) {
        stepUiScale(-1);
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!usesZoomModifier(e)) return;
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new Event(UI_SCALE_ACTIVITY_EVENT));
      stepUiScale(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, [player, settings.hotkeys, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldHandleGlobalKeyboardEvent(e)) return;
      if (e.repeat) return;
      if (e.key === "F11") {
        e.preventDefault();
        void toggleWindowFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const w = window as unknown as { harbor?: Record<string, unknown> };
    w.harbor = {
      ...(w.harbor ?? {}),
      navigate: (v: string) => setView(v as View),
      back: () => goBack(),
      search: () => setSearchOpen(true),
    };
  }, [setView, goBack, setSearchOpen]);

  useEffect(() => {
    void import("@/lib/addon-store").then(({ seedDefaultAddonsIfFirstRun }) =>
      seedDefaultAddonsIfFirstRun(),
    );
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void startDeepLinkBridge().then((stopBridge) => {
      const stopListener = onDeepLinkInstall(() => {
        if (window.__harborInstallerOpen) return;
        setView("addons");
      });
      const stopOpen = onDeepLinkOpen(({ type, id, videoId }) => {
        const hint = parseDeepLinkEpisode(videoId);
        openMeta(
          { id, type: type as MetaType, name: "" },
          hint ? { episodeHint: hint } : undefined,
        );
      });
      dispose = () => {
        stopBridge();
        stopListener();
        stopOpen();
      };
    });
    return () => {
      dispose?.();
    };
  }, [setView, openMeta]);

  useEffect(() => {
    if (topKind === "anime" && settings.hideContent.anime) setView("home");
  }, [topKind, settings.hideContent.anime, setView]);

  useEffect(() => {
    if (!kid || player) return;
    const allowed =
      topKind === "kids" ||
      topKind === "meta" ||
      topKind === "picker" ||
      topKind === "grid" ||
      topKind === "collection";
    if (!allowed) setView("kids");
  }, [kid, player, topKind, setView]);

  useEffect(() => {
    if (!activeProfile) return;
    if (activeProfile.kid) {
      // Reset to the Kids home so a page already open (e.g. an adult title and
      // its related titles) cannot persist across the switch into a kid profile;
      // setView("kids") clears the whole navigation stack, back history included.
      setView("kids");
    } else if (topKind === "kids") {
      setView("home");
    }
  }, [activeProfile?.id]);

  const playerActive = false;
  const pickerTop = topKind === "picker";
  const personTop = topKind === "person";
  const collectionTop = topKind === "collection";
  const episodeDetailTop = topKind === "episode-detail";
  const collectionsIndexTop = topKind === "collections";
  const collectionsIndexAlive = useKeepAlive(
    collectionsIndexTop,
    true,
    stackKinds.includes("collections"),
  );
  const detailTop = topKind === "meta";
  const filterTop = topKind === "filter";
  const gridTop = topKind === "grid";
  const awardTop = topKind === "award";
  const animeAwardTop = topKind === "anime-award";
  const settingsTop = topKind === "settings";
  const animeTop = topKind === "anime";
  const discoverTop = topKind === "discover";
  const catalogsTop = topKind === "catalogs";
  const addonsTop = topKind === "addons" || topKind === "addon-detail";
  const calendarTop = topKind === "calendar";
  const wrappedTop = topKind === "wrapped";
  const queueTop = topKind === "queue";
  const serviceTop = topKind === "service";
  const homeTop = topKind === "home";
  const moviesTop = topKind === "movies";
  const kidsTop = topKind === "kids";
  const showsTop = topKind === "shows";
  const libraryTop = topKind === "library";
  const downloadsTop = topKind === "downloads";
  const immersive = false;

  useEffect(() => {
    const root = document.documentElement;
    if (playerActive || pickerTop || immersive || settingsTop || chromeHidden)
      root.dataset.chromeHidden = "true";
    else delete root.dataset.chromeHidden;
  }, [playerActive, pickerTop, immersive, settingsTop, chromeHidden]);

  useEffect(() => {
    document.querySelectorAll("[data-harbor-nav]").forEach((el) => {
      el.toggleAttribute("data-active", el.getAttribute("data-harbor-nav") === topKind);
    });
  }, [topKind]);

  const layer = (top: boolean) => (top ? "contents" : "hidden");

  const overlayPinned = useOverlayPinned();
  const settingsAlive = useIdleEvict(settingsTop, overlayPinned);
  const animeAlive = useIdleEvict(animeTop);
  const discoverAlive = useIdleEvict(discoverTop);
  const catalogsAlive = useIdleEvict(catalogsTop);
  const addonsAlive = useIdleEvict(addonsTop);
  const calendarAlive = useIdleEvict(calendarTop);
  const wrappedAlive = useIdleEvict(wrappedTop);
  const queueAlive = useKeepAlive(queueTop, queueTop);
  const serviceAlive = useKeepAlive(serviceTop, serviceTop && !!service);
  const detailAlive = useKeepAlive(detailTop, !!meta);
  const personAlive = useKeepAlive(personTop, personId !== null);
  const collectionAlive = useKeepAlive(
    collectionTop,
    collectionId !== null,
    stackKinds.includes("collection"),
  );
  const episodeDetailAlive = useKeepAlive(
    episodeDetailTop,
    !!episodeDetail,
    stackKinds.includes("episode-detail"),
  );
  const filterAlive = useKeepAlive(filterTop, !!filter);
  const gridAlive = useKeepAlive(gridTop, !!grid, stackKinds.includes("grid"));
  const awardAlive = useKeepAlive(awardTop, awardTop);
  const animeAwardAlive = useKeepAlive(animeAwardTop, animeAwardTop && !!animeAwardSource);
  const pickerAlive = useKeepAlive(pickerTop, !!picker);
  const moviesAlive = useIdleEvict(moviesTop);
  const kidsAlive = useIdleEvict(kidsTop);
  const showsAlive = useIdleEvict(showsTop);
  const libraryAlive = useIdleEvict(libraryTop);
  const downloadsAlive = useIdleEvict(downloadsTop);

  return (
    <div data-kids={kidsTop || kid ? "on" : undefined} className="relative flex h-full">
      {!settingsTop && !playerActive && !pickerTop && layout === "sidebar" && <Sidebar />}
      {!settingsTop && !playerActive && !pickerTop && layout === "dracula" && <DraculaSidebar />}
      {!settingsTop && !playerActive && !pickerTop && layout === "nord" && <NordSidebar />}
      {!settingsTop && !playerActive && !pickerTop && layout === "forest" && <ForestSidebar />}
      {!settingsTop && !playerActive && !pickerTop && layout === "stremio" && <StremioRail />}
      {!settingsTop && !playerActive && !pickerTop && layout === "topdock" && <TopDock />}
      {!settingsTop && !playerActive && !pickerTop && layout === "cinematic" && (
        <CinematicOverlay />
      )}
      {!settingsTop && !playerActive && !pickerTop && layout === "royal" && <RoyalTopbar />}
      {!settingsTop && !playerActive && !pickerTop && layout === "rail" && <SideRail />}
      {!playerActive && !pickerTop && layout === "minui" && <MinUIDock />}
      {!playerActive && !pickerTop && layout === "topdock" && <FloatingBack offsetTop={92} />}
      {!playerActive && !pickerTop && layout === "cinematic" && <FloatingBack offsetTop={92} />}
      {!playerActive && !pickerTop && layout === "royal" && <FloatingBack offsetTop={92} />}
      {!playerActive && !pickerTop && layout === "rail" && (
        <FloatingBack offsetLeft={settings.sidebarCollapsed ? 88 : 220} offsetTop={28} />
      )}
      {!playerActive && !pickerTop && layout === "custom" && (
        <FloatingBack offsetLeft={20} offsetTop={20} />
      )}
      {!playerActive && !pickerTop && layout === "custom" && (
        <div className="fixed end-3 top-3 z-[120]">
          <WindowControls />
        </div>
      )}
      {!settingsTop && !playerActive && !pickerTop && layout === "custom" && (
        <CustomLayoutSafetyNet />
      )}
      {!playerActive && <WindowResizeEdges />}
      <div
        className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${playerActive ? "invisible" : ""}`}
      >
        <div className={layer(homeTop)}>
          <Home active={homeTop} onReady={onReady} />
        </div>
        {settingsAlive && (
          <div className={layer(settingsTop)}>
            <Suspense fallback={null}>
              <Settings />
            </Suspense>
          </div>
        )}
        {animeAlive && (
          <div className={layer(animeTop)}>
            <Suspense fallback={null}>
              <AnimeView active={animeTop} />
            </Suspense>
          </div>
        )}
        {discoverAlive && (
          <div className={layer(discoverTop)}>
            <Suspense fallback={null}>
              <Discover active={discoverTop} />
            </Suspense>
          </div>
        )}
        {catalogsAlive && (
          <div className={layer(catalogsTop)}>
            <Suspense fallback={null}>
              <Catalogs active={catalogsTop} />
            </Suspense>
          </div>
        )}
        {addonsAlive && (
          <div className={layer(addonsTop)}>
            <Suspense fallback={null}>
              <AddonsView />
            </Suspense>
          </div>
        )}
        {calendarAlive && (
          <div className={layer(calendarTop)}>
            <Suspense fallback={null}>
              <CalendarView />
            </Suspense>
          </div>
        )}
        {wrappedAlive && (
          <div className={layer(wrappedTop)}>
            <Suspense fallback={null}>
              <WrappedView active={wrappedTop} />
            </Suspense>
          </div>
        )}
        {moviesAlive && (
          <div className={layer(moviesTop)}>
            <Suspense fallback={null}>
              <Movies active={moviesTop} />
            </Suspense>
          </div>
        )}
        {kidsAlive && (
          <div className={layer(kidsTop)}>
            <Suspense fallback={null}>
              <Kids active={kidsTop} />
            </Suspense>
          </div>
        )}
        {showsAlive && (
          <div className={layer(showsTop)}>
            <Suspense fallback={null}>
              <Shows active={showsTop} />
            </Suspense>
          </div>
        )}
        {libraryAlive && (
          <div className={layer(libraryTop)}>
            <Suspense fallback={null}>
              <LibraryView active={libraryTop} />
            </Suspense>
          </div>
        )}
        {downloadsAlive && (
          <div className={layer(downloadsTop)}>
            <Suspense fallback={null}>
              <DownloadsView />
            </Suspense>
          </div>
        )}
        {queueAlive && (
          <div className={layer(queueTop)}>
            <Suspense fallback={null}>
              <QueueView />
            </Suspense>
          </div>
        )}
        {serviceAlive && service && (
          <div className={layer(serviceTop)}>
            <Suspense fallback={null}>
              <ServiceView key={service} service={service} />
            </Suspense>
          </div>
        )}
        {detailAlive && meta && (
          <div className={layer(detailTop)}>
            <Suspense fallback={null}>
              {kid ? (
                <KidsDetailView
                  key={`kid-meta-${meta.id}`}
                  meta={meta}
                  episodeHint={metaEpisodeHint ?? undefined}
                />
              ) : (
                <DetailView
                  key={`meta-${meta.id}`}
                  meta={meta}
                  liveContext={metaLiveContext}
                  episodeHint={metaEpisodeHint ?? undefined}
                />
              )}
            </Suspense>
          </div>
        )}
        {personAlive && personId !== null && (
          <div className={layer(personTop)}>
            <Suspense fallback={null}>
              <PersonView key={`person-${personId}`} personId={personId} />
            </Suspense>
          </div>
        )}
        {collectionAlive && collectionId !== null && (
          <div className={layer(collectionTop)}>
            <Suspense fallback={null}>
              <CollectionView key={`collection-${collectionId}`} collectionId={collectionId} />
            </Suspense>
          </div>
        )}
        {episodeDetailAlive && episodeDetail && (
          <div className={layer(episodeDetailTop)}>
            <Suspense fallback={null}>
              <EpisodeDetailView
                key={`episode-${episodeDetail.seriesId}-${episodeDetail.season}-${episodeDetail.episode}`}
                seriesId={episodeDetail.seriesId}
                season={episodeDetail.season}
                episode={episodeDetail.episode}
                seriesMeta={episodeDetail.seriesMeta}
              />
            </Suspense>
          </div>
        )}
        {filterAlive && filter && (
          <div className={layer(filterTop)}>
            <Suspense fallback={null}>
              <FilterView key={filterReactKey(filter)} filter={filter} />
            </Suspense>
          </div>
        )}
        {gridAlive && grid && (
          <div className={layer(gridTop)}>
            <Suspense fallback={null}>
              <GridView key={`grid-${grid.title}`} grid={grid} />
            </Suspense>
          </div>
        )}
        {collectionsIndexAlive && (
          <div className={layer(collectionsIndexTop)}>
            <Suspense fallback={null}>
              <CollectionsView />
            </Suspense>
          </div>
        )}
        {awardAlive && awardType && (
          <div className={layer(awardTop)}>
            <Suspense fallback={null}>
              <AwardView key={`award-${awardType}`} awardType={awardType} />
            </Suspense>
          </div>
        )}
        {animeAwardAlive && animeAwardSource && (
          <div className={layer(animeAwardTop)}>
            <Suspense fallback={null}>
              <AnimeAwardView key={`anime-award-${animeAwardSource}`} sourceId={animeAwardSource} />
            </Suspense>
          </div>
        )}
        {pickerAlive && picker && (
          <div className={layer(pickerTop)}>
            <Suspense fallback={null}>
              <PlayPicker
                key={`picker-${picker.meta.id}-${picker.episode?.season ?? ""}-${picker.episode?.episode ?? ""}-${picker.attempt ?? 0}-${picker.intent ?? "play"}`}
                meta={picker.meta}
                episode={picker.episode}
                autoPlay={false}
                attempt={picker.attempt}
                intent="download"
                resume={picker.resume}
              />
            </Suspense>
          </div>
        )}
        {pickerTop && !themeHasTopbar && (
          <div className="fixed end-3 top-3 z-[120]">
            <WindowControls />
          </div>
        )}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-30 h-24 bg-gradient-to-b from-canvas/85 via-canvas/40 to-transparent"
        />
        {!immersive &&
          (themeHasTopbar || (settingsTop && layout !== "minui" && layout !== "custom")) && (
            <Topbar />
          )}
        {!immersive && layout === "rail" && !settingsTop && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-canvas/90 via-canvas/40 to-transparent"
          />
        )}
      </div>
      <CustomCodeMount />
      <WebhookLoopMount />
      <MemoryHud />
      <OfflineBanner />
    </div>
  );
}

export type { Frame };
