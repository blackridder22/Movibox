import { useState } from "react";
import { native } from "./backend";
import { runBackend } from "./store";
import { Button } from "./ui";

export function IinaButton({
  target,
  id,
  compact = false,
}: {
  target: "job" | "library";
  id: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (!navigator.userAgent.includes("Mac")) return null;
  return (
    <Button
      busy={busy}
      disabled={!native || busy}
      title="Open this video in the installed IINA app"
      onClick={async () => {
        setBusy(true);
        try {
          await runBackend("player.iina", { target, id });
        } catch {
          /* runBackend displays the error. */
        } finally {
          setBusy(false);
        }
      }}
    >
      {compact ? "IINA" : "Open in IINA"}
    </Button>
  );
}
