import { Fragment, useState } from "react";
import { ExternalLink, FolderOpen, Trash2 } from "lucide-react";
import { native } from "./backend";
import { mediaById } from "./model";
import { Presence } from "./motion";
import { navigate } from "./routing";
import { demoHandoff, notify, runBackend, updateDemo, useDemo } from "./store";
import {
  Actions,
  ActionGroup,
  Banner,
  Button,
  CheckBox,
  Confirm,
  Drawer,
  Empty,
  Header,
  Tabs,
} from "./ui";
import type { DownloadHistoryEntry } from "./types";

const statusLabel = {
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
} as const;

function finishedLabel(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function dayLabel(value: number) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const key = date.toDateString();
  if (key === today.toDateString()) return "Today";
  if (key === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(date);
}

function sourceLabel(entry: DownloadHistoryEntry) {
  return entry.trigger === "monitoring" ? "Monitoring rule" : "Manual download";
}

export function HistoryPage({ detail }: { detail?: string }) {
  const state = useDemo();
  const [tab, setTab] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [removeIds, setRemoveIds] = useState<string[] | null>(null);
  const [clear, setClear] = useState(false);
  const history = [...state.history]
    .filter((entry) => tab === "all" || entry.status === tab)
    .sort((a, b) => b.finishedAt - a.finishedAt);
  const entry = state.history.find((item) => item.id === detail);
  const selectedVisible = selected.filter((id) => history.some((item) => item.id === id));

  const remove = async (ids: string[]) => {
    if (native) await runBackend("history.remove", { ids });
    else {
      updateDemo((current) => ({
        ...current,
        history: current.history.filter((item) => !ids.includes(item.id)),
      }));
      notify("History records removed. Downloaded files were kept.");
    }
    setSelected([]);
    setRemoveIds(null);
    if (detail && ids.includes(detail)) navigate("history");
  };

  const fileAction = (item: DownloadHistoryEntry, action: "open" | "reveal") => {
    if (native) void runBackend(`history.${action}`, { id: item.id }).catch(() => {});
    else demoHandoff(action === "open" ? "Open downloaded file" : "Reveal downloaded file");
  };

  return (
    <>
      <section className="page history-page">
        <Header
          title="History"
          subtitle="A record of completed, failed, and canceled download attempts."
        >
          {!!state.history.length && (
            <Button variant="ghost" onClick={() => setClear(true)}>
              <Trash2 size={15} /> Clear history
            </Button>
          )}
        </Header>
        <div className="toolbar">
          <CheckBox
            label="Select all visible history records"
            checked={!!history.length && selectedVisible.length === history.length}
            indeterminate={selectedVisible.length > 0 && selectedVisible.length !== history.length}
            onChange={(checked) => setSelected(checked ? history.map((item) => item.id) : [])}
          />
          <Tabs
            value={tab}
            onChange={(value) => {
              setTab(value);
              setSelected([]);
            }}
            items={[
              { value: "all", label: `All · ${state.history.length}` },
              ...(["completed", "failed", "canceled"] as const)
                .filter((status) => state.history.some((item) => item.status === status))
                .map((status) => ({
                  value: status,
                  label: `${statusLabel[status]} · ${state.history.filter((item) => item.status === status).length}`,
                })),
            ]}
          />
          <span className="spacer" />
          {!!selectedVisible.length && (
            <>
              <strong>{selectedVisible.length} selected</strong>
              <Button onClick={() => setRemoveIds(selectedVisible)}>Remove selected</Button>
              <Button variant="ghost" onClick={() => setSelected([])}>
                Clear selection
              </Button>
            </>
          )}
        </div>
        {!history.length ? (
          <Empty
            title={state.history.length ? "No matching history" : "No download history yet"}
            description={
              state.history.length
                ? "Choose another result filter."
                : "Completed, failed, and canceled attempts will appear here automatically."
            }
          />
        ) : (
          <table
            className={`table queue-table history-table ${selected.length ? "selecting" : ""}`}
          >
            <thead>
              <tr>
                <th className="title-column">TITLE</th>
                <th className="status-column">RESULT</th>
                <th className="history-date-column">FINISHED</th>
                <th className="size-column">SIZE</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((item, index) => {
                const day = dayLabel(item.finishedAt);
                const showDay = index === 0 || dayLabel(history[index - 1]!.finishedAt) !== day;
                const media = mediaById(item.mediaId);
                return (
                  <Fragment key={item.id}>
                    {showDay && (
                      <tr className="history-day">
                        <td colSpan={5}>{day}</td>
                      </tr>
                    )}
                    <tr>
                      <td>
                        <div className="title-cell">
                          <span className="table-select">
                            <CheckBox
                              label={`Select ${item.label}`}
                              checked={selected.includes(item.id)}
                              onChange={(checked) =>
                                setSelected((current) =>
                                  checked
                                    ? [...new Set([...current, item.id])]
                                    : current.filter((id) => id !== item.id),
                                )
                              }
                            />
                          </span>
                          {media.poster && <img src={media.poster} alt="" />}
                          <button
                            className="row-title"
                            onClick={() => navigate("history", item.id)}
                          >
                            {item.label}
                            <p>
                              {item.quality || "Source details unavailable"} · Attempt{" "}
                              {item.attempt}
                            </p>
                          </button>
                        </div>
                      </td>
                      <td>
                        <span
                          className={
                            item.status === "completed"
                              ? "success"
                              : item.status === "failed"
                                ? "error"
                                : "muted"
                          }
                        >
                          {statusLabel[item.status]}
                        </span>
                        <p className="table-secondary">{sourceLabel(item)}</p>
                      </td>
                      <td className="muted history-finished">{finishedLabel(item.finishedAt)}</td>
                      <td className="muted">{item.size ? `${item.size} GB` : "—"}</td>
                      <td>
                        <Actions
                          label={`Actions for ${item.label}`}
                          items={[
                            { label: "View details", run: () => navigate("history", item.id) },
                            {
                              label: "Open file",
                              disabled: !item.fileExists,
                              run: () => fileAction(item, "open"),
                            },
                            {
                              label: "Reveal in folder",
                              disabled: !item.fileExists,
                              run: () => fileAction(item, "reveal"),
                            },
                            {
                              label: "Remove record",
                              danger: true,
                              run: () => setRemoveIds([item.id]),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <Presence>
        {entry && (
          <Drawer
            key="HistoryDrawer"
            inspector
            title={entry.label}
            description={`${statusLabel[entry.status]} · ${finishedLabel(entry.finishedAt)}`}
            onClose={() => navigate("history")}
          >
            <div className="drawer-content">
              {entry.status === "failed" && (
                <Banner title="Download failed" tone="error">
                  {entry.error || "The transfer ended before the file was completed."}
                </Banner>
              )}
              {!entry.fileExists && entry.status === "completed" && (
                <Banner title="File unavailable" tone="warning">
                  The history record remains, but the downloaded file is no longer at its saved
                  path.
                </Banner>
              )}
              <ActionGroup align="start">
                <Button disabled={!entry.fileExists} onClick={() => fileAction(entry, "open")}>
                  <ExternalLink size={15} /> Open file
                </Button>
                <Button disabled={!entry.fileExists} onClick={() => fileAction(entry, "reveal")}>
                  <FolderOpen size={15} /> Reveal
                </Button>
                {entry.ruleId && state.rules.some((rule) => rule.id === entry.ruleId) && (
                  <Button onClick={() => navigate("monitoring", entry.ruleId)}>View rule</Button>
                )}
              </ActionGroup>
              <dl className="detail-list">
                <div>
                  <dt>Result</dt>
                  <dd>{statusLabel[entry.status]}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{finishedLabel(entry.startedAt)}</dd>
                </div>
                <div>
                  <dt>Finished</dt>
                  <dd>{finishedLabel(entry.finishedAt)}</dd>
                </div>
                <div>
                  <dt>Attempt</dt>
                  <dd>{entry.attempt}</dd>
                </div>
                <div>
                  <dt>Started by</dt>
                  <dd>{sourceLabel(entry)}</dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>{entry.provider || "Direct"}</dd>
                </div>
                <div>
                  <dt>Save to</dt>
                  <dd>{entry.destination}</dd>
                </div>
              </dl>
              <h3>Activity</h3>
              <div className="activity">
                {entry.events.length ? (
                  entry.events.map((event, index) => (
                    <div key={`${index}-${event}`}>
                      <span className="dot" />
                      {event}
                    </div>
                  ))
                ) : (
                  <p className="muted">No detailed activity was retained for this attempt.</p>
                )}
              </div>
              <Button variant="ghost" onClick={() => setRemoveIds([entry.id])}>
                Remove this record
              </Button>
            </div>
          </Drawer>
        )}
      </Presence>
      <Presence>
        {removeIds && (
          <Confirm
            key="RemoveHistory"
            title={`Remove ${removeIds.length === 1 ? "history record" : `${removeIds.length} history records`}?`}
            description="Only the activity records will be removed. Downloaded files, Library entries, and monitoring rules will stay."
            confirm="Remove records"
            onClose={() => setRemoveIds(null)}
            onConfirm={() => void remove(removeIds).catch(() => {})}
          />
        )}
      </Presence>
      <Presence>
        {clear && (
          <Confirm
            key="ClearHistory"
            title="Clear all download history?"
            description="This removes activity records only. Downloaded files, Library entries, and monitoring rules will stay."
            confirm="Clear history"
            onClose={() => setClear(false)}
            onConfirm={async () => {
              if (native) await runBackend("history.clear");
              else {
                updateDemo((current) => ({ ...current, history: [] }));
                notify("Download history cleared. Downloaded files were kept.");
              }
              setSelected([]);
              setClear(false);
              navigate("history");
            }}
          />
        )}
      </Presence>
    </>
  );
}
