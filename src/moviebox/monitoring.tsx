import { viewSubtitleTasks } from "./subtitle-activity";
import { RuleSubtitles } from "./subtitles";
import { native, useCatalog } from "./backend";
import { runBackend } from "./store";
import { Presence } from "./motion";
import { useRef, useState } from "react";
import { ArrowLeft, History, Plus, RefreshCw, Trash2 } from "lucide-react";
import { catalog, mediaById, saveRule } from "./model";
import { createScheduleDraft, describeSchedule, scheduleError, saveRuleSchedule } from "./schedule";
import { ScheduleEditor } from "./schedule-editor";
import { navigate } from "./routing";
import { notify, updateDemo, useDemo } from "./store";
import {
  Actions,
  ActionGroup,
  Banner,
  Button,
  Choice,
  Confirm,
  Drawer,
  Empty,
  Field,
  FolderChoice,
  Header,
  Input,
  Modal,
  SettingRow,
  Tabs,
  Toggle,
} from "./ui";
import type { Rule } from "./types";
export function RuleForm({
  mediaId,
  rule,
  targetEpisodes,
  targetSeason,
  onClose,
}: {
  mediaId: string;
  rule?: Rule;
  targetEpisodes?: number[];
  targetSeason?: number;
  onClose: () => void;
}) {
  const { preferences } = useDemo();
  const media = mediaById(mediaId);
  const [form, setForm] = useState<Rule>(() =>
    rule
      ? structuredClone(rule)
      : {
          id: crypto.randomUUID(),
          mediaId,
          name: `${media.title} · ${preferences.quality}`,
          quality: preferences.quality,
          language: preferences.language,
          scheduleMode: "manual",
          frequency: preferences.frequency,
          cron: preferences.cron,
          timezone: preferences.timezone,
          window: preferences.transferWindow,
          destination: preferences.folder,
          skipExisting: true,
          future: false,
          episodes: targetEpisodes ?? [],
          season: targetSeason ?? 1,
          status: "active",
          result: "Waiting for first check",
          history: [],
        },
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const [schedule, setSchedule] = useState(() => createScheduleDraft(form));
  const [discard, setDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const field = <K extends keyof Rule>(key: K, value: Rule[K]) => {
    setForm((s) => ({ ...s, [key]: value }));
    setDirty(true);
    setError("");
  };
  const close = () => {
    if (!savePending.current) {
      if (dirty) setDiscard(true);
      else onClose();
    }
  };
  const save = async () => {
    if (!form.name.trim()) {
      setError("Give this rule a name.");
      return;
    }
    if (form.scheduleMode !== "manual" && scheduleError(schedule)) return;
    const savedForm = { ...form, ...saveRuleSchedule(form, schedule) };
    if (native) {
      if (savePending.current) return;
      savePending.current = true;
      setSaving(true);
      try {
        const saved = (await runBackend("rule.save", {
          ...savedForm,
          repairExistingNow: !!savedForm.subtitleExisting,
        })) as Rule;
        const repair = saved.subtitleRepair;
        notify(
          `${rule ? "Monitoring rule updated." : "Monitoring rule created."}${savedForm.subtitleExisting && repair ? ` ${repair.queued} subtitle tasks queued; ${repair.missing} missing videos skipped.` : ""}`,
          savedForm.subtitleExisting
            ? { label: "View subtitles", run: () => viewSubtitleTasks("rule", savedForm.id) }
            : undefined,
        );
        onClose();
      } catch (error) {
        setError((error as Error).message);
      } finally {
        savePending.current = false;
        setSaving(false);
      }
      return;
    }
    updateDemo((s) => saveRule(s, savedForm));
    notify(rule ? "Monitoring rule updated." : "Monitoring rule created in demo workspace.", {
      label: "View rules",
      run: () => navigate("monitoring"),
    });
    onClose();
  };
  return (
    <>
      <Modal
        size="form"
        title={rule ? "Edit monitoring rule" : `Monitor ${media.title}`}
        description="Save your download preferences. Run checks manually or enable a schedule."
        onClose={close}
        footer={
          <>
            <Button disabled={saving} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={saving}
              disabled={
                saving || (form.scheduleMode !== "manual" && Boolean(scheduleError(schedule)))
              }
              onClick={save}
            >
              {rule ? "Save changes" : "Create monitoring rule"}
            </Button>
          </>
        }
      >
        {Boolean(form.episodes?.length) && (
          <Banner title={`Monitor ${form.episodes!.length} unmatched episodes`}>
            Season {form.season} · Episodes {form.episodes!.join(", ")}. Only these missing episodes
            are included.
          </Banner>
        )}
        <Field label="Rule name" error={error}>
          <Input
            value={form.name}
            onChange={(e) => field("name", e.target.value)}
            aria-invalid={!!error}
          />
        </Field>
        <div className="field-pair">
          <Field label="Quality">
            <Choice
              label="Rule quality"
              value={form.quality}
              options={[
                ...new Set([
                  form.quality,
                  "4K or better",
                  "1080p or better",
                  "720p or better",
                  "Any quality",
                ]),
              ]}
              onChange={(v) => field("quality", v)}
            />
          </Field>
          <Field label="Audio language">
            <Choice
              label="Rule audio language"
              value={form.language}
              options={["English", "French", "Spanish", "German", "Any language"]}
              onChange={(v) => field("language", v)}
            />
          </Field>
        </div>
        <SettingRow
          title="Automatic checks"
          description="Off means Manual only. Run now still works; downloads and subtitle tasks already started continue in the background."
        >
          <Toggle
            checked={form.scheduleMode !== "manual"}
            label="Automatic checks"
            onChange={(enabled) => field("scheduleMode", enabled ? "scheduled" : "manual")}
          />
        </SettingRow>
        {form.scheduleMode !== "manual" && (
          <ScheduleEditor
            value={schedule}
            onChange={(value) => {
              setSchedule(value);
              setDirty(true);
              setError("");
            }}
          />
        )}
        <Field
          label="Download window"
          hint={`Transfer times use ${form.timezone}. This does not schedule source checks.`}
        >
          <Choice
            label="Rule download window"
            value={form.window}
            options={["Any time", "Overnight · 00:00–07:00", "Evening · 18:00–23:00"]}
            onChange={(v) => field("window", v)}
          />
        </Field>
        {media.kind === "series" && (
          <>
            <Field label="Seasons">
              <Choice
                label="Monitored season"
                value={form.season === 0 ? "All seasons" : `Season ${form.season}`}
                options={
                  native
                    ? ["All seasons", ...new Set(media.episodes.map((e) => `Season ${e.season}`))]
                    : ["All seasons", "Season 1", "Season 2"]
                }
                onChange={(v) =>
                  field("season", v === "All seasons" ? 0 : Number(v.replace("Season ", "")))
                }
              />
            </Field>
            <SettingRow title="Include future episodes">
              <Toggle
                checked={form.future}
                label="Include future episodes"
                onChange={(v) => field("future", v)}
              />
            </SettingRow>
          </>
        )}
        <RuleSubtitles
          rule={form}
          change={(patch) => {
            setForm((s) => ({ ...s, ...patch }));
            setDirty(true);
            setError("");
          }}
        />
        <Field label="Save to">
          <FolderChoice value={form.destination} onChange={(v) => field("destination", v)} />
        </Field>
        <SettingRow
          title="Skip files already downloaded"
          description="Keeps this rule from adding duplicates."
        >
          <Toggle
            checked={form.skipExisting}
            label="Skip files already downloaded"
            onChange={(v) => field("skipExisting", v)}
          />
        </SettingRow>
        <Banner title="Runs while Movie Box is running">
          {native
            ? "Keep Movie Box running for background work. Quitting or sleeping stops work. Only scheduled rules can catch up on missed checks."
            : "Sleeping computers cannot check. This preview does not run background checks."}
        </Banner>
      </Modal>
      <Presence>
        {discard && (
          <Confirm
            key="Confirm"
            title="Discard your changes?"
            description="Your unsaved rule changes will be lost. The saved rule stays unchanged."
            confirm="Discard changes"
            onConfirm={onClose}
            onClose={() => setDiscard(false)}
          />
        )}
      </Presence>
    </>
  );
}
export function Monitoring({
  detail,
  onNew,
  onEdit,
}: {
  detail?: string;
  onNew: () => void;
  onEdit: (r: Rule) => void;
}) {
  const state = useDemo();
  const [tab, setTab] = useState("all");
  const [remove, setRemove] = useState<Rule | null>(null);
  const [history, setHistory] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("All events");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const rule = state.rules.find((r) => r.id === detail);
  const rules =
    state.scenario === "empty" ? [] : state.rules.filter((r) => tab === "all" || r.status === tab);
  const historyEvents = (rule?.history ?? []).filter(
    (e) =>
      historyFilter === "All events" ||
      (historyFilter === "Errors" && /unavailable|error|failed|could not/i.test(e)) ||
      (historyFilter === "No match" && /match|skipped|waiting for a source/i.test(e)) ||
      (historyFilter === "Matches" && /Added|[1-9]\d* queued/.test(e)),
  );
  const toggle = (r: Rule) => {
    updateDemo((s) =>
      saveRule(s, {
        ...r,
        status: r.status === "paused" ? "active" : "paused",
        result: r.status === "paused" ? "Waiting for next check" : "Paused by you",
      }),
    );
    notify(r.status === "paused" ? "Rule resumed." : "Rule paused. No checks will run.");
  };
  const run = (r: Rule) => {
    if (checking || r.running) return;
    setChecking(r.id);
    if (native) {
      void runBackend("rule.run", { id: r.id })
        .catch(() => {})
        .finally(() => setChecking(null));
      return;
    }
    window.setTimeout(() => {
      updateDemo((s) => {
        const latest = s.rules.find((x) => x.id === r.id);
        if (!latest) return s;
        const error = s.scenario === "provider-error" || !s.preferences.provider;
        return saveRule(s, {
          ...latest,
          status: error ? "error" : latest.status,
          result: error ? "Provider needs reconnecting" : "Demo check complete · no new matches",
          history: [
            `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${error ? "Provider unavailable" : "Demo check: 3 sources reviewed, 0 new matches"}`,
            ...latest.history,
          ],
        });
      });
      setChecking(null);
      notify("Demo check finished. No provider request was sent.");
    }, 650);
  };
  return (
    <>
      {history && rule ? (
        <section key="history" className="page">
          <Header title="Check history" subtitle={`${rule.name} · ${describeSchedule(rule)}`}>
            <Button
              variant="primary"
              busy={checking === rule.id || rule.running}
              onClick={() => run(rule)}
            >
              <RefreshCw size={15} />
              Run now
            </Button>
          </Header>
          <ActionGroup align="start">
            <Button
              variant="ghost"
              onClick={() => {
                setHistory(false);
                navigate("monitoring");
              }}
            >
              <ArrowLeft size={14} />
              Back to Monitoring
            </Button>
          </ActionGroup>
          <div className="toolbar">
            <Tabs
              value={historyFilter}
              onChange={setHistoryFilter}
              items={[
                { value: "All events", label: "All checks" },
                { value: "Matches", label: "Matches" },
                { value: "No match", label: "No match" },
                { value: "Errors", label: "Errors" },
              ]}
            />
          </div>
          <Banner title={rule.result}>
            {native
              ? "Native check history. Source URLs and credentials are excluded."
              : "Demo check history. Source URLs and credentials are excluded."}
          </Banner>
          <div className="history-events">
            {!historyEvents.length && (
              <Empty
                title="No checks in this view"
                description="Choose another filter to see this rule's recorded checks."
              />
            )}
            {historyEvents.map((event) => (
              <div key={event} className="history-event">
                <button
                  className="row-title"
                  onClick={() => setExpanded(expanded === event ? null : event)}
                >
                  {event}
                </button>
                {expanded === event && (
                  <Banner title="Execution summary">
                    {native ? event : "Fixture sources reviewed. No live transfer was started."}
                  </Banner>
                )}
              </div>
            ))}
          </div>

          <small>
            {native
              ? "Each entry is recorded by the native scheduler."
              : "No background checks run in the preview."}
          </small>
        </section>
      ) : (
        <section key="monitoring" className="page">
          <Header title="Monitoring" subtitle="Rules that check for releases and matching sources.">
            <Button onClick={onNew}>
              <Plus size={16} />
              New rule
            </Button>
          </Header>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: "all", label: `All · ${state.rules.length}` },
              {
                value: "active",
                label: `Active · ${state.rules.filter((r) => r.status === "active").length}`,
              },
              {
                value: "paused",
                label: `Paused · ${state.rules.filter((r) => r.status === "paused").length}`,
              },
              {
                value: "error",
                label: `Needs attention · ${state.rules.filter((r) => r.status === "error").length}`,
              },
              {
                value: "complete",
                label: `Complete · ${state.rules.filter((r) => r.status === "complete").length}`,
              },
            ]}
          />
          <Banner title="Checks run while Movie Box is running">
            {native
              ? "Keep Movie Box running for background work. Manual-only rules run only when you choose Run now; scheduled rules may catch up after startup."
              : "Demo schedules are saved locally. Background execution is not connected yet."}
          </Banner>
          {!rules.length ? (
            <Empty
              title="Nothing to monitor here"
              description="Create a rule for a title, season, or upcoming episode."
            >
              <Button variant="primary" onClick={onNew}>
                Create a rule
              </Button>
            </Empty>
          ) : (
            <table className="table rule-table">
              <thead>
                <tr>
                  <th>RULE</th>
                  <th>PREFERENCES</th>
                  <th>LAST RESULT</th>
                  <th>NEXT CHECK</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        className="row-title"
                        onClick={() => {
                          setHistory(false);
                          navigate("monitoring", r.id);
                        }}
                      >
                        {r.name}
                        <p>
                          {mediaById(r.mediaId).kind === "movie"
                            ? `Movie · ${describeSchedule(r)}`
                            : r.future
                              ? `Future episodes · ${describeSchedule(r)}`
                              : `Missing episodes · ${describeSchedule(r)}`}
                        </p>
                      </button>
                    </td>
                    <td className="muted">
                      {r.quality} · {r.language}
                    </td>
                    <td className={r.status === "error" ? "error" : "muted"}>
                      {checking === r.id ? "Checking sources…" : r.result}
                    </td>
                    <td>
                      <small>
                        {r.scheduleMode === "manual"
                          ? "Manual only"
                          : r.status === "paused"
                            ? "—"
                            : r.status === "error"
                              ? "Action needed"
                              : r.status === "complete"
                                ? "Rule complete"
                                : native && r.nextCheckAt
                                  ? new Date(r.nextCheckAt).toLocaleString([], {
                                      month: "short",
                                      day: "numeric",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : "Demo schedule"}
                      </small>
                    </td>
                    <td>
                      <Actions
                        label={`Actions for ${r.name}`}
                        items={[
                          { label: "View details", run: () => navigate("monitoring", r.id) },
                          { label: "Edit rule", run: () => onEdit(r) },
                          {
                            label: r.status === "paused" ? "Resume" : "Pause",
                            run: () => toggle(r),
                          },
                          { label: "Run now", run: () => run(r), disabled: !!checking },
                          { label: "Delete rule", run: () => setRemove(r), danger: true },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <Presence>
        {rule && !history && (
          <Drawer
            key="Drawer"
            inspector
            title={history ? "Rule history" : `${rule.name} rule`}
            description={`${mediaById(rule.mediaId).kind === "movie" ? "Movie" : "Series"} · ${rule.quality} · ${rule.language}`}
            onClose={() => navigate("monitoring")}
          >
            <div className="drawer-content">
              <>
                <SettingRow
                  title="Rule enabled"
                  description={`${describeSchedule(rule)} while Movie Box is running.`}
                >
                  <Toggle
                    label="Rule enabled"
                    checked={rule.status === "active"}
                    onChange={() => toggle(rule)}
                  />
                </SettingRow>
                <Banner title={rule.result} tone={rule.status === "error" ? "error" : "info"} />
                <Button onClick={() => viewSubtitleTasks("rule", rule.id)}>
                  View rule subtitle tasks
                </Button>
                <ActionGroup>
                  <Button
                    variant="primary"
                    busy={checking === rule.id || rule.running}
                    onClick={() => run(rule)}
                  >
                    <RefreshCw size={15} />
                    Run now
                  </Button>
                  <Button onClick={() => onEdit(rule)}>Edit rule</Button>
                </ActionGroup>
                <dl className="detail-list">
                  {[
                    ["Quality", rule.quality],
                    ["Language", rule.language],
                    ["Schedule", describeSchedule(rule)],
                    ["Timezone", rule.timezone],
                    ["Download window", rule.window],
                    ["Save to", rule.destination],
                  ].map(([a, b]) => (
                    <div key={a}>
                      <dt>{a}</dt>
                      <dd>{b}</dd>
                    </div>
                  ))}
                </dl>
                <h3>Recent activity</h3>
                <div className="activity">
                  {rule.history.slice(0, 2).map((e) => (
                    <div key={e}>
                      <span className="dot" />
                      {e}
                    </div>
                  ))}
                </div>
                <ActionGroup>
                  <Button onClick={() => setHistory(true)}>
                    <History size={15} />
                    View full history
                  </Button>
                  <Button variant="ghost" onClick={() => setRemove(rule)}>
                    <Trash2 size={15} />
                    Delete rule
                  </Button>
                </ActionGroup>
              </>
            </div>
          </Drawer>
        )}
      </Presence>
      <Presence>
        {remove && (
          <Confirm
            key="Confirm"
            title="Delete monitoring rule?"
            description={`Movie Box will stop checking for ${remove.name}. Existing downloads and local files will be kept.`}
            confirm="Delete rule"
            onClose={() => setRemove(null)}
            onConfirm={() => {
              updateDemo((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== remove.id) }));
              if (detail === remove.id) navigate("monitoring");
              notify("Rule deleted. Downloads and local files were kept.");
            }}
          />
        )}
      </Presence>
    </>
  );
}
export function NewRulePicker({
  onSelect,
  onClose,
}: {
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const movies = useCatalog("movie", query);
  const series = useCatalog("series", query);
  const choices = native ? [...movies.items, ...series.items] : catalog;
  return (
    <Modal
      title="Create a monitoring rule"
      description="Choose a movie or series to watch for."
      onClose={onClose}
    >
      <Input
        aria-label="Find a title to monitor"
        placeholder="Search titles"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="title-picker">
        {native && (movies.loading || series.loading) && <small>Searching titles…</small>}
        {native && (movies.error || series.error) && (
          <Banner title="Search unavailable">{movies.error || series.error}</Banner>
        )}
        {choices
          .filter((m) => m.title.toLowerCase().includes(query.toLowerCase()))
          .map((m) => (
            <button className="picker-row" key={m.id} onClick={() => onSelect(m.id)}>
              <img src={m.poster} alt="" />
              <span>
                {m.title}
                <small>
                  {m.year} · {m.kind}
                </small>
              </span>
              <Plus size={16} />
            </button>
          ))}
      </div>
    </Modal>
  );
}
