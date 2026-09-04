import { useSyncExternalStore } from "react";
import type { Page } from "./types";
export function navigate(page: Page, detail?: string, params?: Record<string, string | number>) {
  const query = params
    ? new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))
    : null;
  window.location.hash = `/${page}${detail ? `/${encodeURIComponent(detail)}` : ""}${query?.size ? `?${query}` : ""}`;
}
const subscribe = (callback: () => void) => {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
};
export function useRoute() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const [path] = hash.replace(/^#\/?/, "").split("?");
  const [raw, detail] = path.split("/");
  const page: Page = (
    ["discover", "downloads", "history", "monitoring", "library", "settings", "setup"] as string[]
  ).includes(raw ?? "")
    ? (raw as Page)
    : "discover";
  return { page, detail: detail ? decodeURIComponent(detail) : undefined };
}
export function routeParam(name: string) {
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "").get(name);
}
