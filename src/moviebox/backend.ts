import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { catalog, registerMedia } from "./model";
import type { DemoState, Media, SearchTask } from "./types";

export const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export type Source = {
  id: string;
  name: string;
  quality: string;
  size: number | null;
  cached: boolean;
  availability: string;
  pack?: boolean;
  verification: "unverified" | "file_matched" | "mismatch";
  blocked?: boolean;
  file?: { name: string; size?: number };
};
export type SourceSearchReport = {
  requestId: string;
  startedAt: number;
  finishedAt: number;
  state: "missing_provider" | "error" | "empty" | "matches";
  summary: string;
  sources: Source[];
  providers: {
    name: string;
    status: "skipped" | "searched" | "failed";
    received: number;
    accepted: number;
    rejected: Record<string, number>;
    message: string;
  }[];
  warnings: string[];
};
export type LogEntry = { at: number; level: string; area: string; message: string };
export type Snapshot = DemoState & { media: Media[]; logs: LogEntry[] };
export async function backend<T = unknown>(action: string, input: unknown = {}): Promise<T> {
  if (!native)
    throw new Error(
      "Open the desktop app to use the native backend. This browser is the UI preview.",
    );
  try {
    return await invoke<T>("moviebox_request", { action, input });
  } catch (error) {
    throw new Error(
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "Backend request failed",
    );
  }
}
export async function subscribeBackend(refresh: () => void) {
  await listen<string>("movibox://navigate", ({ payload }) => {
    if (payload === "settings") window.location.hash = "/settings/Providers";
  });
  return listen("movibox://backend-changed", refresh);
}
export function useCatalog(kind: string, query: string, catalogSettings = "") {
  const [revision, setRevision] = useState(0);
  const base = JSON.stringify([kind, query, revision, catalogSettings]);
  const [page, setPage] = useState({ base: "", skip: 0 });
  const skip = page.base === base ? page.skip : 0;
  const [result, setResult] = useState({
    base: "",
    skip: -1,
    items: native ? ([] as Media[]) : catalog,
    error: "",
    warning: "",
    hasMore: false,
    nextSkip: 0,
  });
  useEffect(() => {
    if (!native) return;
    let canceled = false;
    const timer = setTimeout(
      () => {
        void backend<{ items: Media[]; hasMore?: boolean; nextSkip?: number; warning?: string }>(
          "catalog",
          { kind, query, skip },
        )
          .then((response) => {
            if (canceled) return;
            registerMedia(response.items);
            setResult((old) => ({
              base,
              skip,
              items: [
                ...new Map(
                  [...(skip && old.base === base ? old.items : []), ...response.items].map((m) => [
                    m.id,
                    m,
                  ]),
                ).values(),
              ],
              error: "",
              warning: response.warning ?? "",
              hasMore: !!response.hasMore,
              nextSkip: response.nextSkip ?? skip + response.items.length,
            }));
          })
          .catch((e: Error) => {
            if (!canceled)
              setResult((old) => ({
                ...old,
                base,
                skip,
                error: e.message,
                items: skip && old.base === base ? old.items : [],
                hasMore: false,
              }));
          });
      },
      query ? 250 : 0,
    );
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [base, kind, query, skip]);
  return {
    items: !native || result.base === base ? result.items : [],
    loading: native && result.base !== base,
    loadingMore: native && result.base === base && result.skip !== skip,
    error: result.base === base ? result.error : "",
    warning: result.base === base ? result.warning : "",
    hasMore: result.base === base && result.hasMore,
    loadMore: () => setPage({ base, skip: result.nextSkip }),
    retry: () => setRevision((v) => v + 1),
  };
}
export function useBackgroundSearch<T>(
  kind: "bundle" | "sources",
  request: object,
  destination?: string,
  searchId?: string,
) {
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify(request);
  const identity = JSON.stringify([kind, key, destination, searchId, revision]);
  const [result, setResult] = useState<{
    identity: string;
    task?: SearchTask & { result?: T };
    error: string;
  }>({ identity: "", error: "" });
  const task = result.identity === identity ? result.task : undefined;
  const error = result.identity === identity ? result.error : "";
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const receive = (next: SearchTask & { result?: T }) => {
      if (disposed) return;
      setResult({
        identity,
        task: next,
        error: next.state === "error" || next.state === "canceled" ? next.message : "",
      });
      if (next.state === "queued" || next.state === "running") {
        timer = setTimeout(
          () =>
            void backend<SearchTask & { result?: T }>("search.get", { id: next.id })
              .then(receive)
              .catch(fail),
          1000,
        );
      }
    };
    const fail = (e: Error) => {
      if (!disposed)
        setResult((old) => ({
          identity,
          task: old.identity === identity ? old.task : undefined,
          error: e.message,
        }));
    };
    void (
      searchId && revision === 0
        ? backend<SearchTask & { result?: T }>("search.get", { id: searchId })
        : backend<SearchTask & { result?: T }>("search.start", {
            kind,
            request: JSON.parse(key),
            destination,
            force: revision > 0,
          })
    )
      .then(receive)
      .catch(fail);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [identity, kind, key, destination, searchId, revision]);
  return {
    task,
    error,
    loading: native && !error && (!task || task.state === "queued" || task.state === "running"),
    retry: () => setRevision((v) => v + 1),
    cancel: async () => {
      if (task) {
        await backend("search.cancel", { id: task.id });
        setResult({
          identity,
          task: { ...task, state: "canceled", message: "Canceled by you" },
          error: "Search canceled",
        });
      }
    },
  };
}
export function useSources(media: Media, season?: number, episode?: number) {
  const search = useBackgroundSearch<SourceSearchReport>("sources", {
    id: media.id,
    kind: media.kind,
    season,
    episode,
    quality: "Any quality",
    language: "Any language",
  });
  return {
    sources: search.task?.result?.sources ?? [],
    report: search.task?.result,
    loading: search.loading,
    error: search.error,
    retry: search.retry,
    cancel: search.cancel,
  };
}
