import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { native } from "./backend";
import { IconButton } from "./ui";

export function WindowChrome() {
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);

  useEffect(() => {
    if (!native) return;
    const window = getCurrentWindow();
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const sync = async () => {
      try {
        const next = await window.isFullscreen();
        if (!disposed) setFullscreen(next);
      } catch {
        // A window being closed can disappear before its final resize query resolves.
      }
    };
    void sync();
    for (const listener of [window.onResized(sync), window.onFocusChanged(sync)]) {
      void listener
        .then((unlisten) => (disposed ? unlisten() : unlisteners.push(unlisten)))
        .catch(() => {
          if (!disposed) setError("Window state unavailable. Reopen MoviBox to retry.");
        });
    }
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  if (!native) return null;

  const run = async (action: "minimize" | "fullscreen" | "close") => {
    if (busy.current) return;
    busy.current = true;
    setError("");
    try {
      const window = getCurrentWindow();
      if (action === "fullscreen") {
        await window.setFullscreen(!(await window.isFullscreen()));
        setFullscreen(await window.isFullscreen());
      } else if (action === "minimize") {
        await window.minimize();
      } else {
        // close() emits CloseRequested, preserving the native close-to-tray policy.
        await window.close();
      }
    } catch {
      setError("Window action failed. Please try again.");
    } finally {
      busy.current = false;
    }
  };

  return (
    <header className="window-chrome" aria-label="Window controls">
      <div className="window-drag-region" data-tauri-drag-region>
        {error && <span role="status">{error}</span>}
      </div>
      <div className="window-actions">
        <IconButton label="Minimize window" onClick={() => void run("minimize")}>
          <Minus size={16} />
        </IconButton>
        <IconButton
          label={fullscreen ? "Exit full screen" : "Enter full screen"}
          onClick={() => void run("fullscreen")}
        >
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </IconButton>
        <IconButton label="Close window" className="window-close" onClick={() => void run("close")}>
          <X size={17} />
        </IconButton>
      </div>
    </header>
  );
}
