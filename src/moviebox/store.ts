import { useSyncExternalStore } from "react";
import { createDemoState, defaultPreferences, registerMedia } from "./model";
import { backend, native, subscribeBackend, type Snapshot } from "./backend";
import type { DemoState, Preferences, RecentSearch, WatchState } from "./types";
import { PreferenceWrites, type PreferenceWrite } from "./preference-writes";
const key = "moviebox-ui-demo-v1";
function read(): DemoState {
  if (native)
    return {
      version: 1,
      jobs: [],
      history: [],
      recentSearches: [],
      watchStates: [],
      rules: [],
      library: [],
      scenario: "normal",
      preferences: { ...defaultPreferences, provider: false, addons: [], setupComplete: false },
    };
  const initial = createDemoState();
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as DemoState | null;
    if (
      saved?.version === 1 &&
      Array.isArray(saved.jobs) &&
      Array.isArray(saved.rules) &&
      Array.isArray(saved.library)
    )
      return {
        ...saved,
        history: saved.history ?? initial.history,
        recentSearches: saved.recentSearches ?? initial.recentSearches,
        watchStates: saved.watchStates ?? initial.watchStates,
        preferences: { ...initial.preferences, ...saved.preferences },
        scenario: "normal",
      };
  } catch {
    /* A damaged preview never reads or resets the legacy application's storage. */
  }
  return initial;
}
let state = read();
const preferenceWrites = new PreferenceWrites(state.preferences);
const listeners = new Set<() => void>();
function publishPreferences() {
  state = { ...state, preferences: preferenceWrites.read() };
  listeners.forEach((fn) => fn());
}
export function updateDemo(updater: (current: DemoState) => DemoState) {
  if (native) {
    const before = state;
    const next = updater(before);
    const write = preferenceWrites.stage(next.preferences);
    if (write) publishPreferences();
    void mutateNative(before, next, write);
    return;
  }
  state = updater(state);
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    notify("Changes are temporary: browser storage is unavailable.");
  }
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const useDemo = () => useSyncExternalStore(subscribe, () => state);
export function preference<K extends keyof Preferences>(name: K, value: Preferences[K]) {
  updateDemo((s) => ({ ...s, preferences: { ...s.preferences, [name]: value } }));
}
export function resetDemo() {
  if (native) return;
  updateDemo(() => createDemoState());
}
export type Notice = { id: number; text: string; action?: { label: string; run: () => void } };
let notices: Notice[] = [];
const noticeListeners = new Set<() => void>();
let sequence = 0;
const subscribeNotices = (fn: () => void) => {
  noticeListeners.add(fn);
  return () => noticeListeners.delete(fn);
};
export const useNotices = () => useSyncExternalStore(subscribeNotices, () => notices);
export function dismissNotice(id: number) {
  notices = notices.filter((n) => n.id !== id);
  noticeListeners.forEach((fn) => fn());
}
export function notify(text: string, action?: Notice["action"]) {
  const id = ++sequence;
  notices = [...notices.slice(-2), { id, text, action }];
  noticeListeners.forEach((fn) => fn());
  window.setTimeout(() => dismissNotice(id), 7000);
}
export const demoHandoff = (action: string) =>
  notify(
    native
      ? `${action} is not configured in this build.`
      : `${action} is a desktop handoff. Preview only — no file or external application was changed.`,
  );

let started = false;
let refreshPending: Promise<void> | null = null;
export async function refreshBackend(fresh = false) {
  if (!native) return;
  if (refreshPending) {
    if (!fresh) return refreshPending;
    await refreshPending;
  }
  const preferenceRevision = preferenceWrites.revision;
  refreshPending = backend<Snapshot>("snapshot")
    .then((snapshot) => {
      registerMedia(snapshot.media);
      const prior = new Map(state.jobs.map((j) => [j.id, j]));
      const jobs = snapshot.jobs.map((job) => {
        const old = prior.get(job.id);
        const elapsed = (job.updatedAt ?? 0) - (old?.updatedAt ?? 0);
        const speed =
          job.status === "active" && elapsed > 0
            ? Math.max(
                0,
                ((job.receivedBytes ?? 0) - (old?.receivedBytes ?? job.receivedBytes ?? 0)) /
                  elapsed /
                  1000,
              )
            : job.status === "active"
              ? (old?.speed ?? 0)
              : 0;
        return { ...job, speed: Math.round(speed * 10) / 10 };
      });
      state = {
        ...snapshot,
        jobs,
        preferences: preferenceWrites.receive(
          { ...defaultPreferences, ...snapshot.preferences },
          preferenceRevision,
        ),
        scenario: "normal",
      };
      listeners.forEach((fn) => fn());
    })
    .finally(() => {
      refreshPending = null;
    });
  return refreshPending;
}
export async function startBackend() {
  if (!native || started) return;
  await refreshBackend();
  started = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await subscribeBackend(() => {
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        void refreshBackend().catch(() => {});
      }, 200);
  });
  // Resync missed events after webview suspension; SQLite remains authoritative.
  window.setInterval(() => void refreshBackend().catch(() => {}), 2500);
}
export async function runBackend(action: string, input: unknown = {}) {
  try {
    const result = await backend(action, input);
    await refreshBackend(true);
    return result;
  } catch (error) {
    notify((error as Error).message);
    throw error;
  }
}

function publishState(next: DemoState) {
  state = next;
  if (!native) {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      notify("Changes are temporary: browser storage is unavailable.");
    }
  }
  listeners.forEach((fn) => fn());
}

let quietMutationChain = Promise.resolve();
function quietNativeMutation(action: string, input: unknown) {
  if (!native) return;
  quietMutationChain = quietMutationChain
    .then(() => backend(action, input))
    .then(() => undefined)
    .catch((error: Error) => {
      notify(error.message);
      void refreshBackend(true).catch(() => {});
    });
}

export function recordRecentSearch(input: {
  query?: string;
  mediaId?: string;
  title?: string;
  kind?: "movie" | "series";
}) {
  const query = (input.query ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  const mediaId = input.mediaId?.slice(0, 180);
  if (!query && !mediaId) return;
  const item: RecentSearch = {
    id: mediaId ? `title:${mediaId}` : `query:${query.toLowerCase()}`,
    query,
    mediaId,
    title: input.title?.slice(0, 160),
    kind: input.kind,
    searchedAt: Date.now(),
  };
  publishState({
    ...state,
    recentSearches: [item, ...state.recentSearches.filter((old) => old.id !== item.id)].slice(
      0,
      20,
    ),
  });
  quietNativeMutation("activity.search.record", item);
}

export function removeRecentSearch(id: string) {
  publishState({ ...state, recentSearches: state.recentSearches.filter((item) => item.id !== id) });
  quietNativeMutation("activity.search.remove", { id });
}

export function clearRecentSearches() {
  publishState({ ...state, recentSearches: [] });
  quietNativeMutation("activity.search.clear", {});
}

export type WatchTarget = {
  mediaId: string;
  watched: boolean;
  season?: number;
  episodes?: number[];
};

export function setWatched(target: WatchTarget) {
  const timestamp = Date.now();
  const prior = state.watchStates.find((item) => item.mediaId === target.mediaId);
  const next: WatchState = prior
    ? { ...prior, episodes: [...prior.episodes], updatedAt: timestamp }
    : { mediaId: target.mediaId, episodes: [], updatedAt: timestamp };
  if (target.season === undefined && !target.episodes?.length) {
    next.movieWatchedAt = target.watched ? timestamp : undefined;
  } else {
    const selected = new Set(target.episodes ?? []);
    next.episodes = next.episodes.filter(
      (item) => item.season !== target.season || !selected.has(item.episode),
    );
    if (target.watched)
      next.episodes.push(
        ...(target.episodes ?? []).map((episode) => ({
          season: target.season ?? 1,
          episode,
          watchedAt: timestamp,
        })),
      );
  }
  const empty = !next.movieWatchedAt && next.episodes.length === 0;
  publishState({
    ...state,
    watchStates: empty
      ? state.watchStates.filter((item) => item.mediaId !== target.mediaId)
      : [next, ...state.watchStates.filter((item) => item.mediaId !== target.mediaId)],
  });
  quietNativeMutation("watch.set", target);
}

export function isWatched(
  watchStates: WatchState[],
  mediaId: string,
  season?: number,
  episode?: number,
) {
  const state = watchStates.find((item) => item.mediaId === mediaId);
  if (!state) return false;
  if (episode === undefined) return Boolean(state.movieWatchedAt);
  return state.episodes.some((item) => item.season === season && item.episode === episode);
}
let mutationChain = Promise.resolve();
function mutateNative(before: DemoState, next: DemoState, write?: PreferenceWrite) {
  mutationChain = mutationChain
    .then(async () => {
      if (write) {
        await backend("preferences", write.patch);
        preferenceWrites.settle(write, true);
        publishPreferences();
      }
      for (const job of before.jobs) {
        const changed = next.jobs.find((j) => j.id === job.id);
        if (!changed) await backend("job.remove", { id: job.id });
        else if (changed.status !== job.status) {
          const action =
            changed.status === "paused"
              ? "job.pause"
              : ["queued", "active"].includes(changed.status)
                ? "job.resume"
                : changed.status === "canceled"
                  ? "job.cancel"
                  : "";
          if (!action) throw new Error("Only the native worker can complete or fail a transfer.");
          await backend(action, { id: job.id });
        }
      }
      for (const rule of next.rules)
        if (JSON.stringify(rule) !== JSON.stringify(before.rules.find((r) => r.id === rule.id)))
          await backend("rule.save", rule);
      for (const rule of before.rules)
        if (!next.rules.some((r) => r.id === rule.id))
          await backend("rule.remove", { id: rule.id });
      for (const file of before.library)
        if (!next.library.some((f) => f.id === file.id))
          await backend("library.remove", { id: file.id });
      await refreshBackend(true);
    })
    .catch((error: Error) => {
      if (write) {
        preferenceWrites.settle(write, false);
        publishPreferences();
      }
      notify(error.message);
      void refreshBackend();
    });
  return mutationChain;
}
