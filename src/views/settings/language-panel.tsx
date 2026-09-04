import { Github } from "@/components/icons/github-icon";
import { Dropdown, type DropdownOption } from "@/components/dropdown";
import { useSettings } from "@/lib/settings";
import { useT } from "@/lib/i18n";
import { openUrl } from "@/lib/window";
import { Section, ToggleRow } from "./shared";
import { LanguagesPicker } from "./streaming-panel";
import { DisplayLanguageSection } from "./language-panel/display-language-section";
import { ALL_LANGUAGE_NAMES } from "@/lib/subtitles/language";

const IMAGE_LANG_OPTIONS = ["Original", ...ALL_LANGUAGE_NAMES];

const TMDB_LANGUAGES: DropdownOption[] = [
  { value: "es-ES", label: "Español (España)" },
  { value: "es-MX", label: "Español (Latinoamérica)" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "it-IT", label: "Italiano" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "pt-PT", label: "Português (Portugal)" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "zh-CN", label: "中文 (简体)" },
  { value: "ar-SA", label: "العربية" },
  { value: "tr-TR", label: "Türkçe" },
  { value: "ru-RU", label: "Русский" },
  { value: "hi-IN", label: "हिन्दी" },
  { value: "pl-PL", label: "Polski" },
  { value: "nl-NL", label: "Nederlands" },
  { value: "uk-UA", label: "Українська" },
];

export function LanguagePanel() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <>
      <DisplayLanguageSection />
      <Section
        title={t("Metadata language")}
        subtitle={t(
          "Titles, overviews, and taglines from TMDB display in this language when a translation exists. Needs a TMDB key.",
        )}
      >
        <Dropdown
          value={settings.tmdbLanguage}
          onChange={(v) => update({ tmdbLanguage: v })}
          options={[{ value: "", label: t("English (default)") }, ...TMDB_LANGUAGES]}
          className="w-full max-w-[340px]"
        />
        <ToggleRow
          label={t("Translate titles")}
          sub={t(
            "On shows titles in your metadata language (English by default). Off keeps each title's original language, so anime and foreign films show their native names.",
          )}
          value={settings.translateTitles}
          onChange={(v) => update({ translateTitles: v })}
        />
        {settings.tmdbLanguage !== "" && (
          <ToggleRow
            label={t("Translate overviews")}
            sub={t(
              "Translate plot descriptions and taglines into the language above. Turn off to keep English overviews.",
            )}
            value={settings.translateDescriptions}
            onChange={(v) => update({ translateDescriptions: v })}
          />
        )}
      </Section>

      <Section
        title={t("Image languages")}
        subtitle={t(
          'Posters, logos, and title art load in the first available language from this list, falling back down the order. "Original" uses the title\'s own language. Put your main language first. Needs a TMDB key.',
        )}
      >
        <LanguagesPicker
          value={settings.tmdbImageLangs}
          onChange={(langs) => update({ tmdbImageLangs: langs })}
          options={IMAGE_LANG_OPTIONS}
          placeholder={t("Search languages")}
        />
      </Section>

      <Section
        title={t("Audio languages")}
        subtitle={t(
          "MoviBox uses this order when ranking releases that advertise multiple audio languages.",
        )}
      >
        <LanguagesPicker
          value={settings.preferredAudioLangs}
          onChange={(langs) => update({ preferredAudioLangs: langs })}
        />
      </Section>

      <Section
        title={t("Preferred languages")}
        subtitle={t("Streams in these languages rank first. Toggle below to drop everything else.")}
      >
        <LanguagesPicker
          value={settings.preferredLanguages}
          onChange={(langs) => update({ preferredLanguages: langs })}
        />
        <ToggleRow
          label={t("Only show streams in my languages")}
          sub={t(
            "Hides streams with no detected preferred language. Multi-audio releases count as a match.",
          )}
          value={settings.requirePreferredLanguage}
          onChange={(v) => update({ requirePreferredLanguage: v })}
        />
        <div className="mt-2 flex flex-col gap-3 rounded-xl border border-edge-soft bg-canvas/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-relaxed text-ink-muted sm:max-w-[480px]">
            {t(
              "MoviBox's interface is primarily English. Addons still return localized sources, and these preferences control how those sources rank.",
            )}
          </p>
          <button
            onClick={() => openUrl("https://github.com/harborstremio/harbor")}
            className="flex shrink-0 items-center gap-2 self-start rounded-full border border-edge-soft px-4 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-edge sm:self-auto"
          >
            <Github size={13} strokeWidth={2.2} />
            {t("Contribute on GitHub")}
          </button>
        </div>
      </Section>
    </>
  );
}
