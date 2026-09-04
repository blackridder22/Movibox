import {
  Presence,
  MotionProvider,
  useMotionPolicy,
  useMotionTransition,
  usePageMotion,
} from "./motion";
import { motion } from "motion/react";
import { native } from "./backend";
import { startBackend } from "./store";
import { Button, Empty } from "./ui";
import { Sidebar } from "./sidebar";
import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { Discover } from "./discover";
import { Downloads } from "./downloads";
import { HistoryPage } from "./history";
import { Monitoring, NewRulePicker, RuleForm } from "./monitoring";
import { Library } from "./library";
import { Settings } from "./settings";
import { Setup } from "./setup";
import { navigate, useRoute } from "./routing";
import { notify, updateDemo, useDemo } from "./store";
import { Confirm, Notices } from "./ui";
import type { Page, Rule } from "./types";
import { createCursorController } from "./cursors";
import { WindowChrome } from "./window-chrome";
import { invoke } from "@tauri-apps/api/core";
export function MovieBox() {
  const [ready, setReady] = useState(!native);
  const [error, setError] = useState("");
  const start = () => {
    setError("");
    void startBackend()
      .then(() => setReady(true))
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => {
    void startBackend()
      .then(() => setReady(true))
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <MotionProvider>
      <div className={native ? "desktop-window" : "browser-window"}>
        <WindowChrome />
        <div className="window-body">
          {ready ? (
            <MovieBoxContent />
          ) : (
            <Empty
              title={error ? "Backend unavailable" : "Opening Movie Box…"}
              description={error || "Loading your saved workspace."}
            >
              {error && <Button onClick={start}>Retry</Button>}
            </Empty>
          )}
        </div>
      </div>
    </MotionProvider>
  );
}
function MovieBoxContent() {
  const { page, detail } = useRoute();
  const state = useDemo();
  const p = state.preferences;
  const mainRef = useRef<HTMLElement>(null);
  const { instant, reduced } = useMotionPolicy();
  const transition = useMotionTransition("surface", true);
  usePageMotion(mainRef, `${page}/${detail ?? ""}`);
  const [form, setForm] = useState<{
    mediaId: string;
    rule?: Rule;
    episodes?: number[];
    season?: number;
  } | null>(null);
  const [pick, setPick] = useState(false);
  const [quit, setQuit] = useState(false);
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const light = p.theme === "Light" || (p.theme === "System" && media.matches);
      const root = document.documentElement;
      root.dataset.theme = light ? "light" : "dark";
      root.dataset.density = p.density;
      root.dataset.motion = p.motion;
      root.dataset.glass = String(p.glass);
      root.style.setProperty("--radius", `${p.radius}px`);
      root.style.setProperty("--shadow", p.shadows ? "0 16px 60px #0005" : "none");
      const accent = light && p.accent.toUpperCase() === "#F08B64" ? "#AD4927" : p.accent;
      root.style.setProperty("--primary", accent);
      const rgb = accent.match(/[a-f\d]{2}/gi)?.map((h) => parseInt(h, 16) / 255) ?? [1, 1, 1];
      const luminance = rgb
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      const onPrimary = luminance > 0.179 ? "#21160F" : "#FFFFFF";
      root.style.setProperty("--on-primary", onPrimary);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [p.theme, p.accent, p.density, p.radius, p.glass, p.shadows, p.motion]);
  useEffect(() => {
    if (!native) return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const light = p.theme === "Light" || (p.theme === "System" && media.matches);
      void invoke("moviebox_set_icon_theme", { theme: light ? "light" : "dark" }).catch(() =>
        notify("The Dock icon could not update. The default app icon is still available."),
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [p.theme]);
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const cursor = createCursorController(document.documentElement);
    const apply = () => {
      const light = p.theme === "Light" || (p.theme === "System" && media.matches);
      void cursor.set(Boolean(p.customCursor), light ? "light" : "dark").then((loaded) => {
        if (!loaded) notify("Custom cursors could not load. Using the system cursor.");
      });
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      cursor.dispose();
    };
  }, [p.theme, p.customCursor]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target as HTMLElement).closest("[role=dialog],input,textarea,[role=textbox]")
      )
        return;
      const combo = [
        event.metaKey ? "⌘" : event.ctrlKey ? "Ctrl" : "",
        event.altKey ? "Alt" : "",
        event.shiftKey ? "Shift" : "",
        event.key.length === 1 ? event.key.toUpperCase() : event.key,
      ]
        .filter(Boolean)
        .join(" ");
      const action = Object.entries(p.shortcuts).find(([, value]) => value === combo)?.[0];
      if (!action) return;
      event.preventDefault();
      if (action === "Search") {
        navigate("discover");
        window.setTimeout(() => {
          const input = document.getElementById("moviebox-search");
          input?.focus();
          input?.click();
        }, 0);
      } else {
        const target = action.toLowerCase() as Page;
        if (["discover", "downloads", "monitoring", "library", "settings"].includes(target))
          navigate(target);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [p.shortcuts]);
  const monitor = (mediaId: string, episodes?: number[], season?: number) =>
    setForm({ mediaId, episodes, season });
  return (
    <>
      {page === "setup" || (native && !p.setupComplete) ? (
        <Setup />
      ) : (
        <div className="app">
          <Sidebar page={page} />
          <motion.main
            ref={mainRef}
            layout={instant || reduced ? false : "position"}
            layoutDependency={p.sidebarCollapsed}
            transition={transition}
            className={`main ${detail && page !== "settings" ? "with-drawer" : ""}`}
          >
            {page === "discover" ? (
              <Discover detail={detail} onMonitor={monitor} />
            ) : page === "downloads" ? (
              <Downloads detail={detail} />
            ) : page === "history" ? (
              <HistoryPage detail={detail} />
            ) : page === "monitoring" ? (
              <Monitoring
                detail={detail}
                onNew={() => setPick(true)}
                onEdit={(rule) => setForm({ mediaId: rule.mediaId, rule })}
              />
            ) : page === "library" ? (
              <Library detail={detail} />
            ) : (
              <Settings section={detail} />
            )}
          </motion.main>
        </div>
      )}
      <Presence>
        {form && (
          <RuleForm
            key={form.rule?.id ?? form.mediaId}
            mediaId={form.mediaId}
            rule={form.rule}
            targetEpisodes={form.episodes}
            targetSeason={form.season}
            onClose={() => setForm(null)}
          />
        )}
      </Presence>{" "}
      <Presence>
        {pick && (
          <NewRulePicker
            key="NewRulePicker"
            onClose={() => setPick(false)}
            onSelect={(mediaId) => {
              setPick(false);
              monitor(mediaId);
            }}
          />
        )}
      </Presence>
      <Presence>
        {quit && (
          <Confirm
            key="Confirm"
            title="Quit Movie Box?"
            description="In the desktop app, quitting stops downloads and scheduled checks. Your library and rules remain saved."
            confirm="Simulate quit"
            onClose={() => setQuit(false)}
            onConfirm={() => {
              updateDemo((s) => ({
                ...s,
                jobs: s.jobs.map((j) =>
                  j.status === "active" ? { ...j, status: "paused", speed: 0 } : j,
                ),
              }));
              notify("Quit simulated. Demo transfers paused; this browser remains open.");
            }}
          />
        )}
      </Presence>
      <Notices />
    </>
  );
}
