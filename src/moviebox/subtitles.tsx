import { viewSubtitleTasks } from "./subtitle-activity";
import { useState } from "react";
import { native } from "./backend";
import { notify, runBackend, useDemo } from "./store";
import {
  ActionGroup,
  Banner,
  Button,
  CheckBox,
  Choice,
  Field,
  Modal,
  SettingRow,
  Toggle,
} from "./ui";
import type { Bundle, Job, Rule } from "./types";

export const subtitleLanguages = [
  "English",
  "French",
  "Spanish",
  "Portuguese",
  "German",
  "Italian",
  "Japanese",
  "Korean",
];
const codes = ["en", "fr", "es", "pt", "de", "it", "ja", "ko"];
export const languageName = (code: string) => subtitleLanguages[codes.indexOf(code)] ?? code;

export function RuleSubtitles({
  rule,
  change,
}: {
  rule: Rule;
  change: (value: Partial<Rule>) => void;
}) {
  const { preferences } = useDemo();
  return (
    <div className="stack">
      <Field
        label="Subtitles"
        hint="Downloaded separately when the preferred full subtitle track is missing. Video downloads are never rejected."
      >
        <Choice
          label="Rule subtitles"
          value={
            rule.subtitleMode === "custom"
              ? "Custom languages"
              : rule.subtitleMode === "off"
                ? "Off"
                : "Use global settings"
          }
          options={["Use global settings", "Off", "Custom languages"]}
          onChange={(v) =>
            change({
              subtitleMode: v === "Off" ? "off" : v === "Custom languages" ? "custom" : "global",
              subtitleLanguages: rule.subtitleLanguages?.length
                ? rule.subtitleLanguages
                : ["French"],
            })
          }
        />
      </Field>
      {(!rule.subtitleMode || rule.subtitleMode === "global") && !preferences.subtitlesEnabled && (
        <Banner title="Global subtitles are off">
          Choose Custom languages for this rule, or enable subtitles in Settings.
        </Banner>
      )}
      {rule.subtitleMode === "custom" && (
        <Field
          label="Find missing subtitles in"
          hint="Choose up to four languages for downloads from this rule."
        >
          <div className="subtitle-language-options">
            {subtitleLanguages.map((language) => (
              <label className="row" key={language}>
                <CheckBox
                  label={language}
                  checked={(rule.subtitleLanguages ?? []).includes(language)}
                  disabled={
                    !rule.subtitleLanguages?.includes(language) &&
                    (rule.subtitleLanguages?.length ?? 0) >= 4
                  }
                  onChange={(checked) =>
                    change({
                      subtitleLanguages: checked
                        ? [...(rule.subtitleLanguages ?? []), language]
                        : (rule.subtitleLanguages ?? []).filter((v) => v !== language),
                    })
                  }
                />
                {language}
              </label>
            ))}
          </div>
        </Field>
      )}
      {rule.subtitleMode !== "off" && (
        <SettingRow
          title="Also find missing subtitles for existing files"
          description="Queue a subtitle check when you save and when this rule runs. Only this title and the selected seasons or episodes are included; videos are never downloaded again by this option."
        >
          <Toggle
            label="Also find missing subtitles for existing files"
            checked={!!rule.subtitleExisting}
            onChange={(value) => change({ subtitleExisting: value })}
          />
        </SettingRow>
      )}
    </div>
  );
}

export function FindSubtitles({
  target,
  id,
  label = "Find subtitles",
}: {
  target: "job" | "bundle" | "library";
  id: string;
  label?: string;
}) {
  const { preferences } = useDemo();
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState(preferences.subtitleLanguage ?? "French");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
          setError("");
        }}
      >
        {label}
      </Button>
      {open && (
        <Modal
          title="Find missing subtitles"
          description="Repair subtitles without downloading the video again."
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                busy={busy}
                disabled={busy || !native}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const result = (await runBackend("subtitles.find", {
                      target,
                      id,
                      languages: [language],
                    })) as { queued: number };
                    notify(
                      result.queued
                        ? `${result.queued} subtitle tasks queued.`
                        : "No new tasks needed. Check existing subtitle status or quota cooldown.",
                      { label: "View tasks", run: () => viewSubtitleTasks(target, id) },
                    );
                    setOpen(false);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Find {language} subtitles
              </Button>
            </>
          }
        >
          <Field label="Language">
            <Choice
              label="Repair subtitle language"
              value={language}
              options={subtitleLanguages}
              onChange={setLanguage}
            />
          </Field>
          <Banner title="Existing files stay unchanged">
            Available subtitles are kept. Missing subtitles are saved beside each video. Matching
            does not guarantee playback timing.
          </Banner>
          {!native && <p className="muted">Open the desktop app to search subtitle providers.</p>}
          {error && (
            <Banner tone="error" title="Subtitles need attention">
              {error}
            </Banner>
          )}
        </Modal>
      )}
    </>
  );
}

export function SubtitleStatus({ subtitles }: { subtitles?: Job["subtitles"] }) {
  return (
    <>
      {subtitles?.map((s) => (
        <Button
          key={s.id}
          variant="ghost"
          onClick={() => viewSubtitleTasks("job", s.jobId ?? s.id.slice(0, s.id.lastIndexOf(":")))}
          aria-label={`View ${languageName(s.language)} subtitle task`}
        >
          {languageName(s.language)} ·{" "}
          {s.state === "done" ? "Available" : s.state.replaceAll("_", " ")}
        </Button>
      ))}
    </>
  );
}

export function BundleHealth({ bundle }: { bundle: Bundle }) {
  if (!bundle.health) return null;
  return (
    <div className="bundle-health">
      <span>
        Videos {bundle.health.videos}/{bundle.health.total}
      </span>
      {bundle.health.subtitles.map((s) => (
        <span key={s.language} className={s.ready === s.total ? "success" : "warning"}>
          {languageName(s.language)} subtitles {s.ready}/{s.total}
          {s.failed
            ? ` · ${s.failed} need attention`
            : s.waiting
              ? ` · ${s.waiting} searching`
              : ""}
        </span>
      ))}
      <ActionGroup>
        <Button onClick={() => viewSubtitleTasks("bundle", bundle.id)}>
          View subtitle progress
        </Button>
        <FindSubtitles target="bundle" id={bundle.id} />
      </ActionGroup>
    </div>
  );
}
