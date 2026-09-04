import { HarborMark } from "@/components/icons/harbor-mark";
import { useT } from "@/lib/i18n";

export function WelcomeStep() {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-ink">
          <HarborMark className="h-12 w-12 shrink-0" />
          <span
            className="font-display text-[44px] font-medium leading-none tracking-tight"
            style={{ transform: "translateY(2px)" }}
          >
            MoviBox
          </span>
        </div>
        <p className="text-[15.5px] leading-relaxed text-ink-muted">
          {t(
            "A fast, download-only Stremio companion. Connect your sources once, then let MoviBox acquire movies and new episodes in the background.",
          )}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3 pt-2">
        <Bullet title={t("Automatic")}>
          {t("Whole seasons and future episodes, queued for you.")}
        </Bullet>
        <Bullet title={t("Connected")}>{t("Your Stremio library and addons stay intact.")}</Bullet>
        <Bullet title={t("Local")}>
          {t("Ordinary files. Open them in VLC, IINA, or anything else.")}
        </Bullet>
      </div>
    </div>
  );
}

function Bullet({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-edge-soft bg-canvas/60 p-4">
      <span className="text-[12.5px] font-semibold uppercase tracking-[0.14em] text-ink">
        {title}
      </span>
      <span className="text-[12.5px] leading-snug text-ink-muted">{children}</span>
    </div>
  );
}
