import { ArrowDownToLine, CalendarClock, Languages, ShieldCheck } from "lucide-react";

export const ACQUISITION_LANGUAGES = [
  "English",
  "Japanese",
  "French",
  "Spanish",
  "German",
  "Italian",
  "Portuguese",
  "Korean",
  "Chinese",
  "Hindi",
  "Arabic",
  "Russian",
] as const;

export function dateTimeInputToMs(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function msToDateTimeInput(value?: number | null): string {
  if (!value || value <= Date.now()) return "";
  const local = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function defaultLaterTime(): string {
  const next = new Date(Date.now() + 60 * 60_000);
  next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15, 0, 0);
  return msToDateTimeInput(next.getTime());
}

export function AcquisitionPreferences({
  quality,
  onQuality,
  audioLanguage,
  onAudioLanguage,
  subtitleLanguage,
  onSubtitleLanguage,
  scheduledFor,
  onScheduledFor,
  compact = false,
}: {
  quality: string;
  onQuality: (value: string) => void;
  audioLanguage: string;
  onAudioLanguage: (value: string) => void;
  subtitleLanguage: string;
  onSubtitleLanguage: (value: string) => void;
  scheduledFor: string;
  onScheduledFor: (value: string) => void;
  compact?: boolean;
}) {
  const fieldClass =
    "h-11 rounded-xl border border-edge bg-canvas px-3 text-[13px] text-ink outline-none transition-colors focus:border-[#ff704f]";

  return (
    <section className="rounded-2xl border border-edge-soft bg-elevated/55 p-4">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#ff704f]/12 text-[#ff8060]">
          <ShieldCheck size={17} />
        </span>
        <div>
          <h3 className="text-[13.5px] font-semibold text-ink">Download guardrails</h3>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-subtle">
            When an audio language is selected, MoviBox refuses unknown or mismatched sources. It
            will never silently fall back to another language.
          </p>
        </div>
      </div>
      <div className={`grid gap-3 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-4"}`}>
        <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Quality
          <select
            value={quality}
            onChange={(event) => onQuality(event.target.value)}
            className={fieldClass}
          >
            <option value="best">Best available</option>
            <option value="balanced">Balanced · 1080p</option>
            <option value="4k">Prefer 4K</option>
            <option value="1080p">1080p only</option>
            <option value="efficient">Space saver</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          <span className="flex items-center gap-1.5">
            <Languages size={12} /> Audio
          </span>
          <select
            value={audioLanguage}
            onChange={(event) => onAudioLanguage(event.target.value)}
            className={fieldClass}
          >
            <option value="">Any identified audio</option>
            {ACQUISITION_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {language}
                {language === "English" ? " · dub for anime" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Subtitle sidecar
          <select
            value={subtitleLanguage}
            onChange={(event) => onSubtitleLanguage(event.target.value)}
            className={fieldClass}
          >
            <option value="">None</option>
            {ACQUISITION_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          <span className="flex items-center gap-1.5">
            <CalendarClock size={12} /> Start
          </span>
          <div
            role="group"
            aria-label="Download start time"
            className="grid h-11 grid-cols-2 gap-1 rounded-xl border border-edge bg-canvas p-1 normal-case tracking-normal"
          >
            <button
              type="button"
              aria-pressed={!scheduledFor}
              onClick={() => onScheduledFor("")}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-2 text-[11.5px] transition-colors ${
                !scheduledFor
                  ? "bg-[#ff704f] font-bold text-white"
                  : "font-semibold text-ink-muted hover:bg-elevated hover:text-ink"
              }`}
            >
              <ArrowDownToLine size={13} /> Download now
            </button>
            <button
              type="button"
              aria-pressed={!!scheduledFor}
              onClick={() => onScheduledFor(scheduledFor || defaultLaterTime())}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-2 text-[11.5px] transition-colors ${
                scheduledFor
                  ? "bg-[#ff704f] font-bold text-white"
                  : "font-semibold text-ink-muted hover:bg-elevated hover:text-ink"
              }`}
            >
              <CalendarClock size={13} /> Download later
            </button>
          </div>
          {scheduledFor && (
            <input
              aria-label="Download later date and time"
              type="datetime-local"
              value={scheduledFor}
              min={msToDateTimeInput(Date.now() + 60_000)}
              onChange={(event) => onScheduledFor(event.target.value)}
              className={fieldClass}
            />
          )}
        </div>
      </div>
    </section>
  );
}
