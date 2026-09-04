import { openUrl } from "@/lib/window";

const LOGIN_URL = "https://www.stremio.com/login";
const TIMEOUT_MS = 300000;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function canStremioWebAuth(): boolean {
  return isTauri();
}

export async function startStremioWebAuth(): Promise<string> {
  if (!isTauri()) throw new Error("Signing in through Stremio needs the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const port = await invoke<number>("stremio_auth_start");
  const callback = `http://127.0.0.1:${port}/cb`;
  const url = `${LOGIN_URL}?appName=${encodeURIComponent("MoviBox")}&appCallback=${encodeURIComponent(callback)}`;

  let settled = false;
  let timer = 0;
  let unlisten: (() => void) | null = null;
  let resolveKey: (key: string) => void = () => undefined;
  let rejectKey: (error: Error) => void = () => undefined;
  const pending = new Promise<string>((resolve, reject) => {
    resolveKey = resolve;
    rejectKey = reject;
  });
  const finish = () => {
    settled = true;
    if (timer) window.clearTimeout(timer);
    unlisten?.();
  };
  const stop = await listen<string>("stremio-auth", (event) => {
    if (settled) return;
    const key = typeof event.payload === "string" ? event.payload : "";
    if (!key) return;
    finish();
    resolveKey(key);
  });
  unlisten = stop;
  timer = window.setTimeout(() => {
    if (settled) return;
    finish();
    rejectKey(new Error("Timed out waiting for the browser. Try again."));
  }, TIMEOUT_MS);
  openUrl(url);
  return pending;
}
