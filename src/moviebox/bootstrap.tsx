import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MovieBox } from "./app";
import "./styles.css";
import "./features.css";
const root = document.getElementById("root");
if (root) {
  root.removeAttribute("data-startup-hidden");
  root.inert = false;
  document.getElementById("movibox-boot")?.remove();
  createRoot(root).render(
    <StrictMode>
      <MovieBox />
    </StrictMode>,
  );
}

// Preserve the native window's existing reveal handshake without mounting legacy providers.
if ("__TAURI_INTERNALS__" in window) {
  requestAnimationFrame(() => {
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("movibox_startup_ready").catch(() => {
        console.error("Movie Box could not complete the native window reveal handshake.");
      }),
    );
  });
}
