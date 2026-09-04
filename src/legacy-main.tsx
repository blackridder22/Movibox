import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { StartupLoader } from "@/components/startup-loader";
import { isLinuxDesktop, isMacDesktop, isWindowsDesktop } from "@/lib/platform";
import "@/index.css";

const legacyResources = document.getElementById("legacy-resources");
if (legacyResources instanceof HTMLTemplateElement) {
  document.head.appendChild(legacyResources.content.cloneNode(true));
}

document.documentElement.dataset.os = isLinuxDesktop()
  ? "linux"
  : isMacDesktop()
    ? "macos"
    : isWindowsDesktop()
      ? "windows"
      : "web";
if (import.meta.env.DEV)
  console.log(
    "[movibox] entry",
    "label =",
    (() => {
      try {
        return getCurrentWindow().label;
      } catch {
        return "?";
      }
    })(),
  );
if (import.meta.env.DEV) {
  void import("./lib/streams/__fixtures__/verify").then((m) => m.logVerificationReport());
}

function MainRoot() {
  const [appReady, setAppReady] = useState(false);
  const [startupVisible, setStartupVisible] = useState(true);
  const markAppReady = useCallback(() => setAppReady(true), []);
  const revealApplication = useCallback(() => {
    setStartupVisible(false);
    document.getElementById("movibox-boot")?.remove();
    const root = document.getElementById("root");
    if (root instanceof HTMLElement) {
      root.removeAttribute("data-startup-hidden");
      root.inert = false;
    }
    if ("__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("movibox_startup_ready").catch(() => {}),
      );
    }
  }, []);

  // Fail-open: never strand the window on the boot loader when the ready
  // signal hangs (stalled network, dead query) — reveal the UI anyway.
  useEffect(() => {
    if (!startupVisible) return;
    const t = window.setTimeout(revealApplication, 6000);
    return () => window.clearTimeout(t);
  }, [startupVisible, revealApplication]);

  return (
    <>
      <App onReady={markAppReady} />
      {startupVisible && <StartupLoader ready={appReady} onComplete={revealApplication} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MainRoot />
  </StrictMode>,
);
