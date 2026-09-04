import { SubtitleActivity, SubtitleOverview } from "./subtitle-activity";
import { BundleHealth, FindSubtitles } from "./subtitles";
import { SearchTasks } from "./searches";
import { IinaButton } from "./player";
import { native } from "./backend";
import { runBackend } from "./store";
import { Presence } from "./motion";
import { Fragment, useState } from "react";
import { Folder, Pause, Play, RefreshCw } from "lucide-react";
import { changeJob, mediaById } from "./model";
import { navigate } from "./routing";
import { notify, updateDemo, useDemo } from "./store";
import {
  Actions,
  ActionGroup,
  Banner,
  Button,
  CheckBox,
  Confirm,
  Drawer,
  Empty,
  Field,
  FolderChoice,
  Header,
  IconButton,
  Modal,
  Tabs,
} from "./ui";
import type { Job, JobStatus } from "./types";
const label = (s: JobStatus) =>
  ({
    active: "Active",
    queued: "Queued",
    paused: "Paused",
    failed: "Failed",
    completed: "Completed",
    preparing: "Preparing",
    scheduled: "Scheduled",
    canceled: "Canceled",
  })[s];
function statusText(j: Job) {
  if (native) {
    if (j.status === "active") return `${j.progress.toFixed(1)}% · ${j.speed} MB/s`;
    if (j.status === "failed") return j.error || "Transfer failed";
    if (j.status === "preparing" && j.cloud)
      return `${j.cloud.provider}: ${j.cloud.message}${j.cloud.phase === "cloud_downloading" ? ` · ${j.cloud.progress.toFixed(1)}%` : ""}`;
    return {
      queued: "Waiting for a transfer slot",
      preparing: "Preparing source",
      scheduled: "Waiting for download window",
      paused: "Paused",
      completed: "Saved to disk",
      canceled: "Canceled",
    }[j.status];
  }
  if (j.status === "active")
    return j.episodes.length
      ? `Episode 3 of ${j.episodes.length} · ${j.speed} MB/s`
      : `${j.progress}% · ${j.speed} MB/s · 5 min left`;
  return {
    queued: "Queued · starts when a slot opens",
    paused: `Paused · ${j.progress}% downloaded`,
    failed: "Failed · source link expired",
    completed: "Completed · saved to Movies",
    preparing: "Preparing source · waiting for TorBox",
    scheduled: "Scheduled · waiting for download window",
    canceled: "Canceled",
  }[j.status];
}
export function Downloads({ detail }: { detail?: string }) {
  const state = useDemo();
  const [tab, setTab] = useState("all");
  const [collapsedBundles, setCollapsedBundles] = useState<string[]>([]);
  const [bundleBusy, setBundleBusy] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [cancel, setCancel] = useState<string[] | null>(null);
  const [deletePartial, setDeletePartial] = useState(false);
  const [retry, setRetry] = useState<Job | null>(null);
  const [destination, setDestination] = useState<Job | null>(null);
  const [folder, setFolder] = useState("Movies");
  const queueJobs = state.jobs.filter((j) => !["completed", "canceled"].includes(j.status));
  const job = queueJobs.find((j) => j.id === detail);
  const active = queueJobs.filter((j) => j.status === "active");
  const jobs =
    state.scenario === "empty" ? [] : queueJobs.filter((j) => tab === "all" || j.status === tab);
  const seenGroups = new Set<string>();
  const groupedJobs = jobs.flatMap((item) => {
    if (!item.bundleId) return [item];
    if (seenGroups.has(item.bundleId)) return [];
    seenGroups.add(item.bundleId);
    return jobs.filter((candidate) => candidate.bundleId === item.bundleId);
  });
  const bundleAction = async (id: string, action: string) => {
    setBundleBusy(id);
    try {
      await runBackend("bundle.control", { id, action });
    } catch {
      /* runBackend shows errors */
    } finally {
      setBundleBusy("");
    }
  };
  const change = (id: string, status: JobStatus) => updateDemo((s) => changeJob(s, id, status));
  const primaryAction = (j: Job) => {
    if (native) {
      const action =
        j.status === "active" || j.status === "preparing"
          ? "job.pause"
          : j.status === "failed"
            ? "job.retry"
            : "job.resume";
      void runBackend(action, { id: j.id }).catch(() => {});
      return;
    }
    if (j.status === "active") change(j.id, "paused");
    else if (j.status === "failed") setRetry(j);
    else if (j.status === "preparing")
      notify(
        "Demo source is still preparing. Use the row menu to simulate preparation completing.",
      );
    else change(j.id, "active");
  };
  const finish = (j: Job) => {
    updateDemo((s) => {
      const finishedAt =
        s.history.reduce((latest, entry) => Math.max(latest, entry.finishedAt), j.updatedAt ?? 1) +
        60_000;
      return {
        ...s,
        jobs: s.jobs.filter((x) => x.id !== j.id),
        history: [
          {
            id: `history-${j.id}-${finishedAt}`,
            jobId: j.id,
            mediaId: j.mediaId,
            label: j.label,
            status: "completed",
            quality: j.quality,
            provider: "TorBox",
            destination: j.destination,
            size: j.size,
            season: j.season,
            episodes: j.episodes,
            attempt: j.attempt ?? 1,
            startedAt: j.createdAt ?? finishedAt - 10 * 60 * 1000,
            finishedAt,
            trigger: j.trigger ?? "manual",
            ruleId: j.ruleId,
            bundleId: j.bundleId,
            fileExists: true,
            events: ["info · Demo transfer completed", ...j.events],
          },
          ...s.history,
        ],
        library: s.library.some((f) => f.mediaId === j.mediaId && f.quality === j.quality)
          ? s.library
          : [
              ...s.library,
              {
                id: `file-${j.id}`,
                mediaId: j.mediaId,
                quality: j.quality.split(" · ")[0]!,
                size: j.size,
                missing: false,
                episodes: j.episodes,
                season: j.season,
                path: j.destination,
              },
            ],
      };
    });
    notify("Demo transfer completed and added to Library.");
  };
  const items = (j: Job) => [
    { label: "View details", run: () => navigate("downloads", j.id) },
    {
      label:
        j.status === "active" ? "Pause" : j.status === "failed" ? "Find fresh source" : "Start now",
      run: () => primaryAction(j),
    },
    {
      label: "Move to top",
      disabled: j.status === "active",
      run: () =>
        native
          ? void runBackend("job.prioritize", { id: j.id }).catch(() => {})
          : updateDemo((s) => ({ ...s, jobs: [j, ...s.jobs.filter((x) => x.id !== j.id)] })),
    },
    {
      label: "Change destination",
      run: () => {
        setDestination(j);
        setFolder(j.destination);
      },
    },
    ...(!native
      ? [
          {
            label: j.status === "preparing" ? "Demo: source ready" : "Demo: complete transfer",
            run: () => (j.status === "preparing" ? change(j.id, "queued") : finish(j)),
          },
        ]
      : []),
    {
      label: j.status === "active" ? "Cancel and remove" : "Remove from Downloads",
      run: () => setCancel([j.id]),
      danger: true,
    },
  ];
  return (
    <>
      <section className="page">
        <Header
          title="Downloads"
          subtitle={`${active.length} transferring · ${active.reduce((n, j) => n + j.speed, 0).toFixed(1)} MB/s · ${queueJobs.filter((j) => j.status === "queued").length} queued`}
        >
          <div className="row">
            <span className="preview-pill">{native ? "Live activity" : "Demo activity"}</span>
            <Button
              onClick={() => {
                updateDemo((s) => ({
                  ...s,
                  jobs: s.jobs.map((j) =>
                    active.length && j.status === "active"
                      ? { ...j, status: "paused", speed: 0 }
                      : !active.length && j.status === "paused"
                        ? { ...j, status: "queued" }
                        : j,
                  ),
                }));
                notify(
                  active.length
                    ? native
                      ? "Transfers paused."
                      : "All demo transfers paused."
                    : "Paused transfers returned to the queue.",
                );
              }}
            >
              {active.length ? <Pause size={15} /> : <Play size={15} />}{" "}
              {active.length ? "Pause all" : "Resume all"}
            </Button>
          </div>
        </Header>
        <SearchTasks />
        <SubtitleOverview />
        {selected.length ? (
          <div className="toolbar">
            <CheckBox
              label="Select all visible downloads"
              checked={selected.length === jobs.length}
              indeterminate={selected.length !== jobs.length}
              onChange={(checked) => setSelected(checked ? jobs.map((j) => j.id) : [])}
            />
            <strong>{selected.length} selected</strong>
            <Button
              onClick={() => {
                updateDemo((s) => ({
                  ...s,
                  jobs: s.jobs.map((j) =>
                    selected.includes(j.id) && j.status !== "completed"
                      ? { ...j, status: "paused", speed: 0 }
                      : j,
                  ),
                }));
                setSelected([]);
              }}
            >
              Pause selected
            </Button>
            <Button onClick={() => setCancel(selected)}>Remove selected</Button>
            <Button variant="ghost" onClick={() => setSelected([])}>
              Clear selection
            </Button>
          </div>
        ) : (
          <div className="toolbar">
            <CheckBox
              label="Select all visible downloads"
              checked={false}
              onChange={(checked) => setSelected(checked ? jobs.map((j) => j.id) : [])}
            />
            <Tabs
              value={tab}
              onChange={(value) => {
                setTab(value);
                setSelected([]);
              }}
              items={[
                { value: "all", label: `All · ${queueJobs.length}` },
                ...(
                  ["active", "queued", "paused", "failed", "preparing", "scheduled"] as JobStatus[]
                )
                  .filter((s) => queueJobs.some((j) => j.status === s))
                  .map((s) => ({
                    value: s,
                    label: `${label(s)} · ${queueJobs.filter((j) => j.status === s).length}`,
                  })),
              ]}
            />
            <span className="spacer" />
          </div>
        )}
        <div className="stack">
          {state.preparations
            ?.filter((p) => !["queued", "canceled"].includes(p.state))
            .map((p) => (
              <div className="settings-card" key={p.id}>
                <div className="row">
                  <div className="spacer">
                    <strong>
                      {p.title} · Season {p.season}
                    </strong>
                    <p className={p.state === "needs_attention" ? "error" : "muted"}>{p.message}</p>
                  </div>
                  <ActionGroup>
                    <Button
                      onClick={() =>
                        void runBackend("bundle.wait.control", {
                          id: p.id,
                          action: p.state === "waiting" ? "pause" : "retry",
                        }).catch(() => {})
                      }
                    >
                      {p.state === "waiting" ? "Pause" : "Resume / retry"}
                    </Button>
                    <Button
                      onClick={() =>
                        void runBackend("bundle.wait.control", {
                          id: p.id,
                          action: "cancel",
                        }).catch(() => {})
                      }
                    >
                      Cancel preparation
                    </Button>
                  </ActionGroup>
                </div>
              </div>
            ))}
        </div>
        {!jobs.length ? (
          <Empty
            title={
              state.preparations?.some((p) => p.state === "waiting")
                ? "Waiting for source files"
                : "No downloads here"
            }
            description={
              state.preparations?.some((p) => p.state === "waiting")
                ? "Verified files will appear here after cloud metadata is ready."
                : "Find a movie or series and add it to your queue."
            }
          >
            <Button variant="primary" onClick={() => navigate("discover")}>
              Discover titles
            </Button>
          </Empty>
        ) : (
          <table className={`table queue-table ${selected.length ? "selecting" : ""}`}>
            <thead>
              <tr>
                <th className="title-column">TITLE</th>
                <th className="status-column">STATUS</th>
                <th className="size-column">SIZE</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groupedJobs.map((j) => {
                const bundle = state.bundles?.find((b) => b.id === j.bundleId);
                const groupJobs = bundle
                  ? state.jobs.filter((item) => item.bundleId === bundle.id)
                  : [];
                const first =
                  bundle && jobs.find((item) => item.bundleId === bundle.id)?.id === j.id;
                const collapsed = !!bundle && collapsedBundles.includes(bundle.id);
                return (
                  <Fragment key={j.id}>
                    {first && (
                      <tr className="bundle-heading">
                        <td colSpan={4}>
                          <div className="row">
                            <button
                              className="row-title spacer"
                              aria-expanded={!collapsed}
                              onClick={() =>
                                setCollapsedBundles((ids) =>
                                  collapsed
                                    ? ids.filter((id) => id !== bundle.id)
                                    : [...ids, bundle.id],
                                )
                              }
                            >
                              {collapsed ? "▸" : "▾"} {bundle.title} · Season {bundle.season}
                              <p>
                                {groupJobs.filter((item) => item.status === "completed").length}/
                                {groupJobs.length} files saved · {bundle.sourceCount} sources
                                {bundle.unresolved.length
                                  ? ` · ${bundle.unresolved.length} ${bundle.unresolved.length === 1 ? "episode" : "episodes"} not included`
                                  : ""}
                              </p>
                            </button>
                            <Actions
                              label={`Manage ${bundle.title} bundle`}
                              items={[
                                {
                                  label: "Pause bundle",
                                  disabled: !!bundleBusy,
                                  run: () => {
                                    void bundleAction(bundle.id, "pause");
                                  },
                                },
                                {
                                  label: "Resume bundle",
                                  disabled: !!bundleBusy,
                                  run: () => {
                                    void bundleAction(bundle.id, "resume");
                                  },
                                },
                                {
                                  label: "Retry failed files",
                                  disabled: !!bundleBusy,
                                  run: () => {
                                    void bundleAction(bundle.id, "retry");
                                  },
                                },
                                {
                                  label: "Cancel unfinished files",
                                  disabled:
                                    !!bundleBusy ||
                                    groupJobs.every((item) => item.status === "completed"),
                                  run: () =>
                                    setCancel(
                                      groupJobs
                                        .filter((item) => item.status !== "completed")
                                        .map((item) => item.id),
                                    ),
                                },
                              ]}
                            />
                          </div>
                          <BundleHealth bundle={bundle} />
                        </td>
                      </tr>
                    )}
                    {!collapsed && (
                      <tr>
                        <td>
                          <div className="title-cell">
                            <span className="table-select">
                              <CheckBox
                                label={`Select ${j.label}`}
                                checked={selected.includes(j.id)}
                                onChange={(v) =>
                                  setSelected((s) =>
                                    v ? [...s, j.id] : s.filter((id) => id !== j.id),
                                  )
                                }
                              />
                            </span>
                            <img src={mediaById(j.mediaId).poster} alt="" />
                            <button
                              className="row-title"
                              onClick={() => navigate("downloads", j.id)}
                            >
                              {j.label}
                              <p>{j.quality}</p>
                            </button>
                          </div>
                        </td>
                        <td>
                          <div
                            className={
                              j.status === "active"
                                ? "primary-text"
                                : j.status === "failed"
                                  ? "error"
                                  : j.status === "completed"
                                    ? "success"
                                    : "muted"
                            }
                          >
                            <div className="status-copy">{statusText(j)}</div>
                            {["active", "paused", "completed"].includes(j.status) && (
                              <div
                                className="progress"
                                role="progressbar"
                                aria-label={`${j.label} progress`}
                                aria-valuenow={j.progress}
                                aria-valuemin={0}
                                aria-valuemax={100}
                              >
                                <span style={{ width: `${j.progress}%` }} />
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="muted">{j.size} GB</td>
                        <td>
                          <div className="table-row-actions">
                            <IconButton
                              label={`${j.status === "active" ? "Pause" : j.status === "failed" ? "Retry" : j.status === "completed" ? "Reveal" : "Start"} ${j.label}`}
                              onClick={() => primaryAction(j)}
                            >
                              {j.status === "active" ? (
                                <Pause size={16} />
                              ) : j.status === "failed" ? (
                                <RefreshCw size={16} />
                              ) : j.status === "completed" ? (
                                <Folder size={16} />
                              ) : (
                                <Play size={16} />
                              )}
                            </IconButton>
                            <Actions label={`Actions for ${j.label}`} items={items(j)} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <SubtitleActivity />
      <Presence>
        {job && (
          <Drawer
            key="Drawer"
            inspector
            title={job.label}
            description={job.quality}
            onClose={() => navigate("downloads")}
          >
            <div className="drawer-content">
              <div className="download-progress">
                <h3>
                  {job.status === "active" || job.status === "paused" || job.status === "completed"
                    ? `${job.progress}% downloaded`
                    : label(job.status)}
                </h3>
                <div className="progress primary-text">
                  <span style={{ width: `${job.progress}%` }} />
                </div>
                <p>
                  {((job.size * job.progress) / 100).toFixed(1)} of {job.size} GB · {job.speed} MB/s
                  {!native && "· demo snapshot"}
                </p>
              </div>
              <ActionGroup>
                <Button onClick={() => primaryAction(job)}>
                  {job.status === "active"
                    ? "Pause download"
                    : job.status === "failed"
                      ? "Retry download"
                      : job.status === "completed"
                        ? "Reveal file"
                        : "Resume download"}
                </Button>
                {job.status !== "completed" && (
                  <Button onClick={() => setCancel([job.id])}>Cancel download</Button>
                )}
              </ActionGroup>
              {job.status === "failed" && (
                <Banner title={statusText(job) ?? "Download failed"} tone="error">
                  {native ? job.error : "Retry with a fresh source to continue this demo job."}
                </Banner>
              )}
              <dl className="detail-list">
                <div>
                  <dt>Provider</dt>
                  <dd>
                    {native ? job.provider || job.cloud?.provider || "Direct" : "TorBox · demo"}
                  </dd>
                </div>
                <div>
                  <dt>Format</dt>
                  <dd>{native ? job.destination.split(".").pop()?.toUpperCase() : "MKV"}</dd>
                </div>
                <div>
                  <dt>Save to</dt>
                  <dd>{job.destination}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{label(job.status)}</dd>
                </div>
              </dl>
              {job.cloud && (
                <Banner title={`${job.cloud.provider} preparation`}>
                  {job.cloud.message} · {job.cloud.progress.toFixed(1)}% in cloud
                  <p>
                    Last checked:{" "}
                    {job.cloud.lastCheckedAt
                      ? new Date(job.cloud.lastCheckedAt).toLocaleTimeString()
                      : "Not yet"}
                    . Next check:{" "}
                    {job.cloud.nextCheckAt
                      ? new Date(job.cloud.nextCheckAt).toLocaleTimeString()
                      : "When needed"}
                    .
                  </p>
                </Banner>
              )}
              {job.status === "completed" && (
                <ActionGroup align="start">
                  <FindSubtitles target="job" id={job.id} />
                  <IinaButton target="job" id={job.id} />
                </ActionGroup>
              )}
              {job.subtitles?.map((sub) => (
                <Banner
                  key={sub.id}
                  title={`Subtitles · ${sub.language}`}
                  tone={sub.state === "done" ? "success" : "warning"}
                >
                  <p>{sub.message}</p>
                  {sub.state !== "done" && (
                    <Button
                      onClick={() =>
                        void runBackend("subtitles.retry", { id: sub.id }).catch(() => {})
                      }
                    >
                      Retry subtitles
                    </Button>
                  )}
                </Banner>
              ))}
              <h3>Activity</h3>
              <div className="activity">
                {job.events.map((e, i) => (
                  <div key={`${i}-${e}`}>
                    <span className="dot" />
                    {e}
                  </div>
                ))}
              </div>
            </div>
          </Drawer>
        )}
      </Presence>
      <Presence>
        {cancel && (
          <Confirm
            key="Confirm"
            title={`Remove ${cancel.length === 1 ? "download" : "selected downloads"}?`}
            description={`${cancel.length} queue ${cancel.length === 1 ? "item will" : "items will"} be removed. Active work will be canceled; completed files and monitoring rules will be kept.`}
            confirm="Remove downloads"
            onClose={() => setCancel(null)}
            onConfirm={async () => {
              if (native) {
                try {
                  for (const id of cancel)
                    await runBackend("job.remove", { id, deleteFile: deletePartial });
                  setSelected([]);
                  navigate("downloads");
                } catch {
                  /* The error is already visible. */
                }
                return;
              }
              updateDemo((s) => {
                const finishedAt =
                  s.history.reduce((latest, entry) => Math.max(latest, entry.finishedAt), 1) +
                  60_000;
                const removed = s.jobs.filter((item) => cancel.includes(item.id));
                return {
                  ...s,
                  jobs: s.jobs.filter((item) => !cancel.includes(item.id)),
                  history: [
                    ...removed
                      .filter((item) => item.status !== "failed")
                      .map((item) => ({
                        id: `history-${item.id}-${finishedAt}`,
                        jobId: item.id,
                        mediaId: item.mediaId,
                        label: item.label,
                        status: "canceled" as const,
                        quality: item.quality,
                        provider: "TorBox",
                        destination: item.destination,
                        size: Number(((item.size * item.progress) / 100).toFixed(2)),
                        season: item.season,
                        episodes: item.episodes,
                        attempt: item.attempt ?? 1,
                        startedAt: item.createdAt ?? finishedAt - 10 * 60 * 1000,
                        finishedAt,
                        trigger: item.trigger ?? ("manual" as const),
                        ruleId: item.ruleId,
                        bundleId: item.bundleId,
                        fileExists: false,
                        events: ["info · Canceled and removed from Downloads", ...item.events],
                      })),
                    ...s.history,
                  ],
                };
              });
              setSelected([]);
              if (detail && cancel.includes(detail)) navigate("downloads");
              notify(
                deletePartial
                  ? "Demo jobs and partial-file references removed. No real files changed."
                  : "Demo jobs canceled. Partial-file references retained.",
              );
            }}
          >
            <label className="row">
              <CheckBox
                checked={deletePartial}
                onChange={setDeletePartial}
                label="Delete incomplete files"
              />
              Also delete incomplete files
            </label>
          </Confirm>
        )}
      </Presence>
      <Presence>
        {retry && (
          <Confirm
            key="Confirm"
            title="Use a fresh source?"
            description={
              native
                ? "Request a fresh link for the saved source and resume its partial file when possible."
                : "The original link expired. The demo found a replacement release."
            }
            confirm="Retry with fresh source"
            danger={false}
            onClose={() => setRetry(null)}
            onConfirm={() => {
              change(retry.id, "queued");
              notify("Replacement source queued in the demo.");
            }}
          />
        )}
      </Presence>
      <Presence>
        {destination && (
          <Modal
            key="Modal"
            title="Change destination"
            description="Choose where this download will be saved."
            onClose={() => setDestination(null)}
            footer={
              <>
                <Button onClick={() => setDestination(null)}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={async () => {
                    if (native) {
                      try {
                        await runBackend("job.destination", {
                          id: destination.id,
                          destination: folder,
                        });
                        setDestination(null);
                      } catch {
                        /* Keep the destination form open on failure. */
                      }
                      return;
                    }
                    updateDemo((s) => ({
                      ...s,
                      jobs: s.jobs.map((j) =>
                        j.id === destination.id ? { ...j, destination: folder } : j,
                      ),
                    }));
                    setDestination(null);
                    notify("Download destination updated.");
                  }}
                >
                  Save destination
                </Button>
              </>
            }
          >
            <Field label="Save to">
              <FolderChoice value={folder} onChange={setFolder} />
            </Field>
            <Banner title={native ? "Transfer pauses while moving" : "Preview folder chooser"}>
              {native
                ? "Partial data moves with this download. The job stays paused until you resume it."
                : "No operating-system folders are created or changed."}
            </Banner>
          </Modal>
        )}
      </Presence>
    </>
  );
}
