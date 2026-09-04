import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoviboxLoader } from "@/components/movibox-loader";

export function StartupLoader({ ready, onComplete }: { ready: boolean; onComplete: () => void }) {
  const [animationReady, setAnimationReady] = useState(false);
  const handleAnimationReady = useCallback(() => setAnimationReady(true), []);
  const host = document.getElementById("movibox-boot");

  useEffect(() => {
    if (!host || !ready || !animationReady) return;
    const frame = requestAnimationFrame(onComplete);
    return () => cancelAnimationFrame(frame);
  }, [animationReady, host, onComplete, ready]);

  if (!host) return null;
  return createPortal(<MoviboxLoader size="lg" onReady={handleAnimationReady} />, host);
}
