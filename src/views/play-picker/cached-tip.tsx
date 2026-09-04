import { HelpCircle } from "lucide-react";
import { useState } from "react";
import { useT } from "@/lib/i18n";

export function CachedTip() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 self-start">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 self-start text-[11.5px] font-medium text-ink-subtle/70 transition-colors hover:text-ink-muted"
      >
        <HelpCircle size={12} strokeWidth={2} />
        {t("Says “cached” but won’t download?")}
      </button>
      {open && (
        <p className="max-w-lg rounded-lg bg-elevated/60 px-3 py-2 text-[11.5px] leading-relaxed text-ink-subtle ring-1 ring-edge-soft/50">
          {t(
            "“Cached” means your addon thinks the file is already saved on your debrid and ready to download. That flag isn’t always right: sometimes the file is not actually there yet. If resolution fails, pick another source or give it a minute to finish caching and try again.",
          )}
        </p>
      )}
    </div>
  );
}
