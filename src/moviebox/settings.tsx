import { CatalogSettings, TmdbAttribution } from "./catalog-settings";
import { BackupSettings } from "./backup-settings";
import { UpdateSettings } from "./update-settings";
import { FeedbackSettings } from "./feedback";
import { PolicySettings } from "./policies";
import { ProviderAccounts, SubtitleSettings } from "./provider-settings";
import { IndexerSettings } from "./bridge";
import { backend, native } from "./backend";
import { LogsDialog } from "./activity";
import { runBackend } from "./store";
import { Presence } from "./motion";
import licenseTexts from "./licenses.json";
import { useEffect, useState, type ReactNode } from "react";
import { Copy, Download, ExternalLink, Plus } from "lucide-react";
import { BrandMark } from "./brand";
import { defaultPreferences } from "./model";
import { navigate } from "./routing";
import { demoHandoff, notify, preference, resetDemo, updateDemo, useDemo } from "./store";
import { ScheduleModal } from "./schedule-editor";
import { describeSchedule } from "./schedule";
import {
  Actions,
  ActionGroup,
  Banner,
  Button,
  CheckBox,
  Choice,
  Confirm,
  Field,
  FolderChoice,
  Header,
  Input,
  Modal,
  SettingRow,
  Toggle,
} from "./ui";
import type { Preferences, Scenario } from "./types";
export const settingsSections = [
  "Providers",
  "Sources & add-ons",
  "Subtitles",
  "Catalog",
  "Storage",
  "Backup & restore",
  "Downloads",
  "Scheduling",
  "Appearance",
  "Shortcuts",
  "Notifications",
  "Feedback",
  "Updates",
  "Privacy & legal",
  "About & diagnostics",
];
export function Settings({ section, onFeedback }: { section?: string; onFeedback: () => void }) {
  const active = settingsSections.includes(section ?? "") ? section! : "Providers";
  return (
    <section className="page settings-page">
      <Header title="Settings" subtitle="Make Movie Box work your way." />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {settingsSections.map((s) => (
            <button
              key={s}
              className={active === s ? "selected" : ""}
              aria-current={active === s ? "page" : undefined}
              onClick={() => navigate("settings", s)}
            >
              {s}
            </button>
          ))}
        </nav>
        <div
          key={active}
          role="region"
          aria-label={`${active} settings`}
          tabIndex={0}
          className={`settings-content ${["Appearance", "Shortcuts", "Notifications"].includes(active) ? "settings-content-compact" : ""}`}
        >
          {active === "Providers" ? (
            <ProviderAccounts />
          ) : active === "Sources & add-ons" ? (
            <SourcesSettings />
          ) : active === "Subtitles" ? (
            <SubtitleSettings />
          ) : active === "Catalog" ? (
            <CatalogSettings />
          ) : active === "Storage" ? (
            <StorageSettings />
          ) : active === "Backup & restore" ? (
            <BackupSettings />
          ) : active === "Downloads" ? (
            <DownloadSettings />
          ) : active === "Scheduling" ? (
            <SchedulingSettings />
          ) : active === "Appearance" ? (
            <AppearanceSettings />
          ) : active === "Shortcuts" ? (
            <ShortcutSettings />
          ) : active === "Notifications" ? (
            <NotificationSettings />
          ) : active === "Feedback" ? (
            <FeedbackSettings onFeedback={onFeedback} />
          ) : active === "Updates" ? (
            <>
              <Intro
                title="Updates"
                description={`MoviBox ${__APP_VERSION__} · Check automatically and review before installing.`}
              />
              <UpdateSettings />
            </>
          ) : active === "Privacy & legal" ? (
            <PolicySettings />
          ) : (
            <AboutSettings />
          )}
        </div>
      </div>
    </section>
  );
}
function Intro({ title, description }: { title: string; description: string }) {
  return (
    <div className="settings-intro">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}
function SelectPreference({
  name,
  title,
  description,
  options,
}: {
  name: keyof Preferences;
  title: string;
  description?: string;
  options: string[];
}) {
  const { preferences: p } = useDemo();
  return (
    <SettingRow title={title} description={description}>
      <Choice
        label={title}
        value={String(p[name])}
        options={options}
        onChange={(v) => preference(name, v as never)}
      />
    </SettingRow>
  );
}
function TogglePreference({
  name,
  title,
  description,
}: {
  name: keyof Preferences;
  title: string;
  description?: string;
}) {
  const { preferences: p } = useDemo();
  return (
    <SettingRow title={title} description={description}>
      <Toggle
        checked={Boolean(p[name])}
        label={title}
        onChange={(v) => preference(name, v as never)}
      />
    </SettingRow>
  );
}
function TextPreference({
  name,
  title,
  description,
}: {
  name: "movieFolder" | "seriesFolder";
  title: string;
  description: string;
}) {
  const { preferences } = useDemo();
  return (
    <SettingRow title={title} description={description}>
      <Input
        aria-label={title}
        value={preferences[name]}
        onChange={(e) => preference(name, e.target.value)}
      />
    </SettingRow>
  );
}
function NumberPreference({
  name,
  title,
  description,
  min = 0,
  max = 9999,
}: {
  name: "maxSize" | "reserve" | "concurrency" | "retries";
  title: string;
  description?: string;
  min?: number;
  max?: number;
}) {
  const { preferences: p } = useDemo();
  const [draft, setDraft] = useState(p[name]);
  const [error, setError] = useState(false);
  return (
    <>
      <SettingRow title={title} description={description}>
        <Input
          type="number"
          aria-label={title}
          min={min}
          max={max}
          value={draft}
          aria-invalid={error}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(false);
          }}
          onBlur={() => {
            if (!draft.trim() || !Number.isFinite(+draft) || +draft < min || +draft > max) {
              setError(true);
              return;
            }
            preference(name, draft);
          }}
        />
      </SettingRow>
      {error && (
        <small className="error" role="alert">
          Enter a number between {min} and {max}.
        </small>
      )}
    </>
  );
}
export function ProviderConnect({
  onDone,
  secondaryActions,
}: {
  onDone: () => void;
  secondaryActions?: ReactNode;
}) {
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <Field
        label="API key"
        hint={
          native
            ? "Stored in your operating system credential store."
            : "Preview only. Use demo-key; do not enter a real API key."
        }
        error={status}
      >
        <div className="row">
          <Input
            type={visible ? "text" : "password"}
            autoComplete="off"
            aria-label={native ? "TorBox API key" : "Demo TorBox API key"}
            placeholder={native ? "Enter your TorBox API key" : "Enter demo-key"}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setStatus("");
            }}
          />
          <Button variant="ghost" onClick={() => setVisible(!visible)}>
            {visible ? "Hide" : "Show"}
          </Button>
        </div>
      </Field>
      <Banner
        title={native ? "Your credentials stay private" : "Your real credentials stay untouched"}
      >
        {native
          ? "The native backend verifies the key with TorBox and saves it in the OS credential store. It is excluded from logs and exports."
          : "The preview never sends or stores this key."}
      </Banner>
      <ActionGroup>
        {secondaryActions}
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            if (native) {
              setBusy(true);
              setStatus("");
              try {
                await runBackend("provider.connect", { key });
                setKey("");
                onDone();
                notify("TorBox connected.");
              } catch (error) {
                setStatus((error as Error).message);
              } finally {
                setBusy(false);
              }
              return;
            }
            if (key !== "demo-key") {
              setStatus(
                "Use demo-key to verify the preview. Other values simulate an invalid key.",
              );
              return;
            }
            setBusy(true);
            window.setTimeout(() => {
              preference("provider", true);
              setKey("");
              setBusy(false);
              onDone();
              notify("Demo provider verified. No live connection was made.");
            }, 450);
          }}
        >
          Verify and continue
        </Button>
      </ActionGroup>
    </div>
  );
}
export function AddSource({
  onDone,
  secondaryActions,
}: {
  onDone: () => void;
  secondaryActions?: ReactNode;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <Field
        label="Add-on manifest URL"
        hint={
          native
            ? "Paste the manifest URL from your Stremio add-on."
            : "Use https://example.com/manifest.json for the demo."
        }
        error={error}
      >
        <Input
          value={url}
          placeholder="https://example.com/manifest.json"
          onChange={(e) => {
            setUrl(e.target.value);
            setError("");
          }}
        />
      </Field>
      <Banner title={native ? "Validated before installation" : "Manifest validation preview"}>
        {native
          ? "Movie Box fetches the manifest and checks its catalog, metadata, and stream capabilities."
          : "URL format is checked without installing a third-party add-on."}
      </Banner>
      <ActionGroup>
        {secondaryActions}
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            if (native) {
              setBusy(true);
              setError("");
              try {
                await runBackend("addon.add", { url });
                setUrl("");
                onDone();
                notify("Add-on installed. Its capabilities are shown in Sources & add-ons.");
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
              return;
            }
            let parsed: URL;
            try {
              parsed = new URL(url);
              if (
                parsed.protocol !== "https:" ||
                !parsed.pathname.endsWith("manifest.json") ||
                parsed.username ||
                parsed.password
              )
                throw Error();
            } catch {
              setError("Enter an HTTPS manifest.json URL without embedded credentials.");
              return;
            }
            setBusy(true);
            window.setTimeout(() => {
              updateDemo((s) => ({
                ...s,
                preferences: {
                  ...s.preferences,
                  addons: [
                    ...s.preferences.addons,
                    {
                      id: crypto.randomUUID(),
                      name: `Demo add-on · ${parsed.hostname}`,
                      url: parsed.origin,
                      enabled: true,
                    },
                  ],
                },
              }));
              setUrl("");
              setBusy(false);
              onDone();
              notify("Demo source added. No URL tokens were stored.");
            }, 400);
          }}
        >
          <Plus size={15} />
          Validate and add source
        </Button>
      </ActionGroup>
    </div>
  );
}
function SourcesSettings() {
  const { preferences: p, indexers = [] } = useDemo();
  const [add, setAdd] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState(false);
  return (
    <>
      <Intro
        title="Sources & add-ons"
        description="Choose where Movie Box finds titles, metadata, and downloadable sources."
      />
      {native &&
        !indexers.some((i) => i.enabled) &&
        !p.addons.some((a) => a.enabled && a.capabilities?.includes("stream")) && (
          <Banner
            title={
              p.addons.some((a) => a.enabled && !a.capabilities)
                ? "Download-source capabilities not checked yet"
                : "Download sources not configured"
            }
            tone="warning"
          >
            Cinemeta supplies titles and episodes. TorBox prepares files, but it does not search
            these add-ons for you. Connect a native indexer below or add a Stremio add-on with
            stream capability.
          </Banner>
        )}
      {native && <IndexerSettings />}
      <div className="source-cards">
        {p.addons.map((addon, i) => (
          <div className="settings-card" key={addon.id}>
            <div className="row">
              <div className="spacer">
                <strong>{addon.name}</strong>
                <p>
                  {addon.id === "cinemeta"
                    ? "Default catalog and title information"
                    : "Compatible Stremio source add-on"}
                </p>
              </div>
              <small className={addon.id === "cinemeta" ? "muted" : "success"}>
                {addon.id === "cinemeta" ? "Built-in" : native ? "Installed" : "Demo connected"}
              </small>
            </div>
            <div className="source-card-footer">
              <small>
                {native
                  ? addon.capabilities?.join(" · ") || "Capabilities not checked yet"
                  : addon.id === "cinemeta"
                    ? "Catalog · Metadata"
                    : "Streams · Movies · Series"}
              </small>
              <ActionGroup>
                {addon.id !== "cinemeta" && (
                  <Button
                    onClick={() =>
                      native
                        ? void runBackend("addon.configure", { id: addon.id }).catch(() => {})
                        : demoHandoff("Open add-on configuration")
                    }
                  >
                    Configure
                  </Button>
                )}
                <Toggle
                  label={`Enable ${addon.name}`}
                  checked={addon.enabled}
                  onChange={(v) =>
                    preference(
                      "addons",
                      p.addons.map((a) => (a.id === addon.id ? { ...a, enabled: v } : a)),
                    )
                  }
                />
                <Actions
                  label={`Manage ${addon.name}`}
                  items={[
                    {
                      label: "Configure externally",
                      run: () =>
                        native
                          ? void runBackend("addon.configure", { id: addon.id }).catch(() => {})
                          : demoHandoff("Open add-on configuration"),
                    },
                    {
                      label: "Move up",
                      disabled: i === 0,
                      run: () => {
                        const next = [...p.addons];
                        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                        preference("addons", next);
                      },
                    },
                    { label: "Remove source", run: () => setRemove(addon.id), danger: true },
                  ]}
                />
              </ActionGroup>
            </div>
          </div>
        ))}
      </div>
      <Button variant="primary" onClick={() => setAdd(true)}>
        <Plus size={15} />
        Add source add-on
      </Button>
      <SelectPreference
        name="sourceTimeout"
        title="Source timeout"
        description="Slow add-ons can be retried without blocking all results."
        options={["10 seconds", "20 seconds", "30 seconds", "60 seconds"]}
      />
      <SettingRow title="Catalog order" description="Arrange the catalogs shown in Discover.">
        <Button onClick={() => setCatalogs(true)}>Manage catalogs</Button>
      </SettingRow>
      <Presence>
        {catalogs && (
          <Modal
            key="Modal"
            title="Catalog order"
            description="Use the arrows to arrange your enabled catalogs."
            onClose={() => setCatalogs(false)}
          >
            <div className="catalog-order-list">
              {p.addons.map((addon, i) => (
                <div className="source-card-footer" key={addon.id}>
                  <span>{addon.name}</span>
                  <ActionGroup>
                    <Button
                      disabled={i === 0}
                      aria-label={`Move ${addon.name} up`}
                      onClick={() => {
                        const next = [...p.addons];
                        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                        preference("addons", next);
                      }}
                    >
                      Move up
                    </Button>
                    <Button
                      disabled={i === p.addons.length - 1}
                      aria-label={`Move ${addon.name} down`}
                      onClick={() => {
                        const next = [...p.addons];
                        [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                        preference("addons", next);
                      }}
                    >
                      Move down
                    </Button>
                  </ActionGroup>
                </div>
              ))}
            </div>
          </Modal>
        )}
      </Presence>
      <Presence>
        {add && (
          <Modal key="Modal" title="Add a source" onClose={() => setAdd(false)}>
            <AddSource
              onDone={() => setAdd(false)}
              secondaryActions={<Button onClick={() => setAdd(false)}>Cancel</Button>}
            />
          </Modal>
        )}
      </Presence>
      <Presence>
        {remove && (
          <Confirm
            key="Confirm"
            title="Remove source?"
            description="This add-on will stop supplying titles and source matches. Existing downloads will be kept."
            confirm="Remove source"
            onClose={() => setRemove(null)}
            onConfirm={() =>
              preference(
                "addons",
                p.addons.filter((a) => a.id !== remove),
              )
            }
          />
        )}
      </Presence>
    </>
  );
}
function StorageSettings() {
  const { preferences: p, scenario } = useDemo();
  const [disk, setDisk] = useState<{ free: number; total: number }>();
  const [storageError, setStorageError] = useState("");
  const checkStorage = () => {
    void backend<{ free: number; total: number }>("storage")
      .then((v) => {
        setDisk(v);
        setStorageError("");
      })
      .catch((e: Error) => setStorageError(e.message));
  };
  useEffect(() => {
    if (native) checkStorage();
  }, [p.folder]);
  return (
    <>
      <Intro
        title="Storage"
        description="Choose where files live and how Movie Box organizes them."
      />
      <SettingRow title="Library location" description={`Current location: ${p.folder}`}>
        <FolderChoice
          actionText="Change folder"
          value={p.folder}
          onChange={(v) => {
            preference("folder", v);
            if (!native) notify("Demo destination changed. No folder was created.");
          }}
        />
      </SettingRow>
      <div className="storage-usage">
        <small>
          {native
            ? storageError ||
              (disk
                ? `${((disk.total - disk.free) / 1e9).toFixed(1)} GB used · ${(disk.free / 1e9).toFixed(1)} GB available`
                : "Checking storage…")
            : "142.6 GB used · 357.4 GB available · demo volume"}
        </small>
        <div className="progress primary-text">
          <span
            style={{
              width: native ? (disk ? `${100 * (1 - disk.free / disk.total)}%` : "0%") : "29%",
            }}
          />
        </div>
      </div>
      {(native
        ? Boolean(storageError)
        : scenario === "storage-error" || p.folder.includes("External")) && (
        <Banner title="Destination unavailable" tone="error">
          Reconnect the drive or choose a local folder before downloading.
        </Banner>
      )}
      <TextPreference
        name="movieFolder"
        title="Movie folder"
        description="New movies are saved below the library location."
      />
      <TextPreference
        name="seriesFolder"
        title="Series folder"
        description="Episodes are grouped into series and season folders."
      />
      <SelectPreference
        name="naming"
        title="Filename format"
        description="Used for new downloads; existing files are never renamed."
        options={["Title (Year)", "Title / Quality", "Original file names"]}
      />
      <NumberPreference
        name="reserve"
        title="Keep free space (GB)"
        description="Stop new transfers before the disk gets too full."
        min={1}
        max={1000}
      />
      <TogglePreference
        name="cleanup"
        title="Clean up temporary files"
        description="Remove temporary files after a successful transfer."
      />
      <ActionGroup>
        <Button onClick={() => (native ? checkStorage() : demoHandoff("Check folder permissions"))}>
          Check folder permissions
        </Button>
      </ActionGroup>
    </>
  );
}
function DownloadSettings() {
  return (
    <>
      <Intro
        title="Downloads"
        description="Defaults apply to new downloads. Existing jobs keep their current choices."
      />
      <SelectPreference
        name="quality"
        title="Preferred quality"
        description="Rank source quality before file size."
        options={["4K or better", "1080p or better", "720p or better", "Any quality"]}
      />
      <SelectPreference
        name="language"
        title="Audio language"
        description="Prefer matching audio when source metadata is available."
        options={["English", "French", "Spanish", "German", "Any language"]}
      />
      <NumberPreference
        name="maxSize"
        title="Maximum file size (GB)"
        description="Set a size ceiling for each file."
        min={1}
        max={500}
      />
      <NumberPreference
        name="concurrency"
        title="Concurrent transfers"
        description="How many files can download at the same time."
        min={1}
        max={10}
      />
      <SelectPreference
        name="bandwidth"
        title="Download speed limit"
        description="Applies across all active file transfers."
        options={["Unlimited", "5 MB/s", "10 MB/s", "25 MB/s", "50 MB/s"]}
      />
      <NumberPreference
        name="retries"
        title="Automatic retries"
        description="Retry temporary errors before asking for attention."
        min={0}
        max={10}
      />
      <TogglePreference
        name="duplicates"
        title="Skip duplicate files"
        description="Check queued jobs and existing files before adding a download."
      />
    </>
  );
}
function SchedulingSettings() {
  const { preferences: p } = useDemo();
  const [custom, setCustom] = useState(false);
  return (
    <>
      <Intro
        title="Scheduling"
        description="Control when monitoring runs and when files can transfer."
      />
      <SettingRow
        title="Default monitoring schedule"
        description={`${describeSchedule(p)} · ${p.timezone}. New rules use this schedule; existing rules keep their settings.`}
      >
        <Button onClick={() => setCustom(true)}>Edit schedule</Button>
      </SettingRow>
      <SelectPreference
        name="transferWindow"
        title="Default download window"
        description="Checks can still run outside this window."
        options={["Any time", "Overnight · 00:00–07:00", "Evening · 18:00–23:00"]}
      />
      <TogglePreference
        name="autoStart"
        title="Start Movie Box at sign-in"
        description="Resume scheduled checks after you sign in to this device."
      />
      <TogglePreference
        name="background"
        title="Keep running when the window closes"
        description="Downloads and scheduled checks continue in the background. Reopen the app from the Dock or taskbar."
      />
      <TogglePreference
        name="catchUp"
        title="Run missed checks when the app starts"
        description="Run one catch-up check per rule, without replaying every missed time."
      />
      <Banner title="Sleeping or quit applications cannot check">
        {native
          ? "The native scheduler keeps running while the app is open, even with its window hidden. Enable launch at sign-in to restart it when you log in. Quit apps and sleeping devices cannot run checks."
          : "These preferences are saved for the future desktop adapter. No background tasks run in this preview."}
      </Banner>
      <Presence>
        {custom && (
          <ScheduleModal
            key="ScheduleModal"
            value={p}
            onClose={() => setCustom(false)}
            onSave={async (schedule) => {
              if (native) await runBackend("preferences", schedule);
              else
                updateDemo((state) => ({
                  ...state,
                  preferences: { ...state.preferences, ...schedule },
                }));
              setCustom(false);
            }}
          />
        )}
      </Presence>
    </>
  );
}
function AppearanceSettings() {
  const { preferences: p } = useDemo();
  return (
    <>
      <Intro title="Appearance" description="Your color, with the same compact Movie Box layout." />
      <SelectPreference
        name="theme"
        title="Theme"
        description="Use a fixed theme or follow your system appearance."
        options={["Dark", "Light", "System"]}
      />
      <SettingRow title="Accent color" description="Used for actions and selection.">
        <div className="accent-choice">
          {["#F08B64", "#83AFF0", "#B69BDC", "#76C792"].map((color) => (
            <button
              key={color}
              type="button"
              className="accent-swatch"
              style={{ backgroundColor: color }}
              aria-label={`Use accent ${color}`}
              aria-pressed={p.accent.toUpperCase() === color}
              onClick={() => preference("accent", color)}
            />
          ))}
          <label className="accent-custom">
            <input
              type="color"
              aria-label="Accent color"
              value={p.accent}
              onChange={(e) => preference("accent", e.target.value)}
            />
            <span>{p.accent.toUpperCase()}</span>
          </label>
        </div>
      </SettingRow>
      <SelectPreference
        name="density"
        title="Density"
        description="Control the space around lists and interface controls."
        options={["Compact", "Comfortable"]}
      />
      <SelectPreference
        name="radius"
        title="Corner radius"
        description="Adjust component corners without changing the layout."
        options={["6", "10", "14"]}
      />
      <TogglePreference
        name="glass"
        title="Translucent surfaces"
        description="Use glass on eligible menus and overlays."
      />
      <TogglePreference
        name="shadows"
        title="Interface shadows"
        description="Add subtle depth to popovers and dialogs."
      />
      <TogglePreference
        name="customCursor"
        title="Movie Box cursor"
        description="Use filled cursors that follow your theme. Resize cursors stay standard."
      />
      <SelectPreference
        name="motion"
        title="Motion"
        description="Follow your system preference for reduced motion."
        options={["Use system setting", "Reduce"]}
      />
      <ActionGroup>
        <Button
          onClick={() => {
            updateDemo((s) => ({
              ...s,
              preferences: {
                ...s.preferences,
                ...Object.fromEntries(
                  [
                    "theme",
                    "accent",
                    "density",
                    "radius",
                    "glass",
                    "shadows",
                    "motion",
                    "customCursor",
                  ].map((k) => [k, defaultPreferences[k as keyof Preferences]]),
                ),
              },
            }));
            notify("Appearance reset.");
          }}
        >
          Reset appearance
        </Button>
      </ActionGroup>
    </>
  );
}
function ShortcutSettings() {
  const { preferences: p } = useDemo();
  const [capture, setCapture] = useState<string | null>(null);
  const [binding, setBinding] = useState("");
  const [conflict, setConflict] = useState("");
  return (
    <>
      <Intro
        title="Shortcuts"
        description="Use your own key bindings. Focusing a control does not activate it."
      />
      {Object.entries(p.shortcuts).map(([name, key]) => (
        <SettingRow
          key={name}
          title={name}
          description={
            {
              Search: "Find a movie or series.",
              Discover: "Browse movies and series.",
              Downloads: "Open the download queue.",
              Monitoring: "Review your monitoring rules.",
              Library: "Browse files in your library.",
              Settings: "Open app preferences.",
              "Close panel": "Close the topmost menu, panel or dialog.",
              "Select all": "Select items in the current list.",
              "Pause or resume": "Applies to the focused download row.",
            }[name]
          }
        >
          <Button
            className="shortcut-key"
            onClick={() => {
              setCapture(name);
              setBinding("");
              setConflict("");
            }}
          >
            <kbd>{key}</kbd>
          </Button>
        </SettingRow>
      ))}
      <Banner title="Focus first, activate second">
        Tab moves focus. Enter activates an input. Escape leaves editing before closing its parent.
      </Banner>
      <ActionGroup>
        <Button
          onClick={() => {
            preference("shortcuts", { ...defaultPreferences.shortcuts });
            notify("Shortcuts restored.");
          }}
        >
          Reset shortcuts
        </Button>
      </ActionGroup>
      <Presence>
        {capture && (
          <Modal
            key="Modal"
            title={`Shortcut for ${capture}`}
            description="Press a key combination, then save it."
            onClose={() => setCapture(null)}
            footer={
              <>
                <Button onClick={() => setCapture(null)}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={!binding || !!conflict}
                  onClick={() => {
                    preference("shortcuts", { ...p.shortcuts, [capture]: binding });
                    setCapture(null);
                    notify("Shortcut saved.");
                  }}
                >
                  Save shortcut
                </Button>
              </>
            }
          >
            <div
              tabIndex={0}
              role="textbox"
              aria-label="Record shortcut"
              className="shortcut-capture"
              onKeyDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
                const combo = [
                  e.metaKey ? "⌘" : e.ctrlKey ? "Ctrl" : "",
                  e.altKey ? "Alt" : "",
                  e.shiftKey ? "Shift" : "",
                  e.key.length === 1 ? e.key.toUpperCase() : e.key,
                ]
                  .filter(Boolean)
                  .join(" ");
                setBinding(combo);
                setConflict(
                  Object.entries(p.shortcuts).find(
                    ([name, value]) => name !== capture && value === combo,
                  )?.[0] ?? "",
                );
              }}
            >
              {binding || "Click here, then press your shortcut"}
            </div>
            {conflict && (
              <Banner title={`Already assigned to ${conflict}`} tone="warning">
                <Button
                  onClick={() => {
                    const next = { ...p.shortcuts };
                    delete next[conflict];
                    next[capture] = binding;
                    preference("shortcuts", next);
                    setCapture(null);
                  }}
                >
                  Replace existing shortcut
                </Button>
              </Banner>
            )}
          </Modal>
        )}
      </Presence>
    </>
  );
}
function NotificationSettings() {
  return (
    <>
      <Intro title="Notifications" description="Choose what deserves your attention." />
      <TogglePreference
        name="notifications"
        title="Enable notifications"
        description="The preview uses in-app announcements only."
      />
      <TogglePreference
        name="notifyComplete"
        title="Download completed"
        description="Tell me when a movie or series finishes downloading."
      />
      <TogglePreference
        name="notifyError"
        title="Download or provider error"
        description="Notify me when a job needs action after retrying."
      />
      <TogglePreference
        name="notifyMatch"
        title="Monitoring found a match"
        description="Notify me when a rule adds a new download."
      />
      <TogglePreference
        name="notifyTitles"
        title="Show title names"
        description="Include movie and series names in system notifications."
      />
      <TogglePreference
        name="notifySound"
        title="Play a sound"
        description="Use a short sound with important notifications."
      />
      <SelectPreference
        name="quietHours"
        title="Quiet hours"
        description="Keep notifications silent during this window."
        options={["Off", "22:00–08:00", "23:00–07:00"]}
      />
      <ActionGroup>
        <Button variant="ghost" onClick={() => demoHandoff("Open system notification settings")}>
          System notification settings
        </Button>
        <Button
          onClick={() =>
            native
              ? void runBackend("notification.test").catch(() => {})
              : notify("Test notification · your demo download is complete.")
          }
        >
          Send test notification
        </Button>
      </ActionGroup>
    </>
  );
}
async function exportReport(includePaths: boolean) {
  if (native) {
    try {
      const report = await backend("diagnostics");
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: "moviebox-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_text_file", { path, contents: JSON.stringify(report, null, 2) });
      notify("Diagnostics exported locally.");
    } catch (error) {
      notify((error as Error).message);
    }
    return;
  }
  const report = {
    product: "Movie Box",
    version: `${__APP_VERSION__}-ui-preview`,
    mode: "demo",
    timestamp: new Date().toISOString(),
    health: {
      ui: "available",
      provider: "demo adapter",
      filesystem: "not connected",
      scheduler: "not connected",
    },
    ...(includePaths ? { examplePath: "Movies / Example title (2024)" } : {}),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "moviebox-diagnostics.json";
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("Report exported locally. Nothing was sent.");
}
function AboutSettings() {
  const { scenario, preferences } = useDemo();
  const [modal, setModal] = useState<"logs" | "export" | "licenses" | "tray" | null>(null);
  const [quit, setQuit] = useState(false);
  const [paths, setPaths] = useState(false);
  const [license, setLicense] = useState("");
  return (
    <>
      <Intro
        title="About & diagnostics"
        description="App information and tools for resolving problems."
      />
      <div className="about-identity">
        <BrandMark />
        <div>
          <h3>Movie Box</h3>
          <p>
            Desktop app · {__APP_VERSION__}
            {!native && " UI preview"}
          </p>
        </div>
      </div>
      <TmdbAttribution />
      <UpdateSettings />
      <dl className="health-list">
        <div>
          <dt>
            {preferences.defaultProvider === "realdebrid" ? "Real-Debrid" : "TorBox"} connection
          </dt>
          <dd>
            {native ? (preferences.provider ? "Configured" : "Not connected") : "Demo adapter"}
          </dd>
        </div>
        <div>
          <dt>Download engine</dt>
          <dd>{native ? "Native service running" : "Not connected to preview"}</dd>
        </div>
        <div>
          <dt>Scheduler</dt>
          <dd>{native ? "Native service running" : "Not connected to preview"}</dd>
        </div>
        <div>
          <dt>Library folder</dt>
          <dd>{native ? preferences.folder : "Demo destination · not verified"}</dd>
        </div>
      </dl>
      <ActionGroup>
        <Button
          onClick={async () => {
            try {
              if (native) {
                await navigator.clipboard.writeText(
                  JSON.stringify(await backend("diagnostics"), null, 2),
                );
                notify("Diagnostics copied.");
                return;
              }
              await navigator.clipboard.writeText(
                `Movie Box ${__APP_VERSION__} UI preview\nProvider: demo adapter\nDownload engine and scheduler: not connected\nLibrary folder: not verified\nCredentials and paths excluded.`,
              );
              notify("Diagnostics copied. Credentials and paths excluded.");
            } catch {
              notify("Clipboard unavailable. Use Export diagnostics to save a report.");
            }
          }}
        >
          <Copy size={15} />
          Copy diagnostics
        </Button>
        <Button onClick={() => setModal("export")}>
          <Download size={15} />
          Export diagnostics
        </Button>
        <Button onClick={() => setModal("logs")}>
          <ExternalLink size={15} />
          Open logs
        </Button>
      </ActionGroup>
      <Banner title="Safe diagnostic exports">
        Credentials and private source URLs are excluded. Review logs before sharing.
      </Banner>
      <ActionGroup>
        <Button onClick={() => navigate("settings", "Privacy & legal")}>Privacy & legal</Button>
        <Button onClick={() => setModal("licenses")}>Open-source licenses</Button>
        <Button onClick={() => (native ? setModal("export") : demoHandoff("Report a problem"))}>
          <ExternalLink size={15} />
          Report a problem
        </Button>
      </ActionGroup>
      {!native && (
        <section className="preview-tools" aria-label="UI preview tools">
          <h3>UI preview tools</h3>
          <SettingRow
            title="Preview scenario"
            description="Exercise loading, error and recovery states without real services."
          >
            <Choice
              label="Preview scenario"
              value={scenario}
              options={[
                "normal",
                "empty",
                "offline",
                "no-source",
                "provider-error",
                "storage-error",
                "loading",
              ]}
              onChange={(v) => {
                updateDemo((s) => ({ ...s, scenario: v as Scenario }));
                notify(`Preview scenario: ${v}`);
              }}
            />
          </SettingRow>
          <ActionGroup align="start">
            <Button onClick={() => navigate("setup")}>Preview first-run setup</Button>
            <Button onClick={() => setModal("tray")}>Preview menu bar controls</Button>
            <Button
              variant="ghost"
              onClick={() => {
                resetDemo();
                notify("Demo workspace restored. Legacy app data was not changed.");
              }}
            >
              Reset demo workspace
            </Button>
          </ActionGroup>
        </section>
      )}
      <Presence>
        {modal === "logs" && <LogsDialog key="logs" onClose={() => setModal(null)} />}
        {modal && modal !== "logs" && (
          <Modal
            key="Modal"
            title={
              modal === "export"
                ? "Export diagnostics"
                : modal === "tray"
                  ? "Movie Box menu bar"
                  : "Open-source licenses"
            }
            onClose={() => setModal(null)}
            footer={
              modal === "export" ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    exportReport(paths);
                    setModal(null);
                  }}
                >
                  Export report
                </Button>
              ) : undefined
            }
          >
            {modal === "tray" ? (
              <div className="stack">
                <Button
                  onClick={() => {
                    setModal(null);
                    navigate("discover");
                  }}
                >
                  Open Movie Box
                </Button>
                <Button
                  onClick={() => {
                    updateDemo((s) => ({
                      ...s,
                      jobs: s.jobs.map((j) =>
                        j.status === "active" ? { ...j, status: "paused", speed: 0 } : j,
                      ),
                    }));
                    notify("All demo transfers paused.");
                  }}
                >
                  Pause all downloads
                </Button>
                <Button
                  onClick={() => {
                    setModal(null);
                    navigate("settings");
                  }}
                >
                  Settings
                </Button>
                <Button onClick={() => setQuit(true)}>Quit Movie Box…</Button>
              </div>
            ) : modal === "export" ? (
              <>
                <Banner title="Private by default">
                  Keys, add-on URLs, and personal data are excluded. This report is downloaded
                  locally and is never sent.
                </Banner>
                {!native && (
                  <label className="row">
                    <CheckBox
                      checked={paths}
                      onChange={setPaths}
                      label="Include example file paths"
                    />
                    Include demo file paths
                  </label>
                )}
              </>
            ) : (
              <>
                <div className="stack">
                  {[
                    "React · MIT",
                    "Base UI · MIT",
                    "Lucide · ISC",
                    "blackridder22UI · owned component source",
                  ].map((l) => (
                    <Button key={l} onClick={() => setLicense(l)}>
                      {l}
                    </Button>
                  ))}
                </div>
                {license && (
                  <Banner title={license}>
                    <pre className="license-text">
                      {licenseTexts[license.split(" · ")[0] as keyof typeof licenseTexts] ??
                        "Movie Box adapts the owned blackridder22UI component patterns, distributed from your local source library. Base UI supplies interaction behavior; Paper supplies Movie Box styles."}
                    </pre>
                  </Banner>
                )}
              </>
            )}
          </Modal>
        )}
      </Presence>
      <Presence>
        {quit && (
          <Confirm
            key="Confirm"
            title="Quit Movie Box?"
            description="The desktop app stops downloads and scheduled checks when it quits. This preview pauses demo transfers and leaves the browser open."
            confirm="Simulate quit"
            onClose={() => setQuit(false)}
            onConfirm={() => {
              updateDemo((s) => ({
                ...s,
                jobs: s.jobs.map((j) =>
                  j.status === "active" ? { ...j, status: "paused", speed: 0 } : j,
                ),
              }));
              setModal(null);
              notify("Quit simulated. Demo transfers paused.");
            }}
          />
        )}
      </Presence>
    </>
  );
}
