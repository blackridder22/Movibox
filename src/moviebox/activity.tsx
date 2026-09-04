import { useEffect, useState } from "react";
import { backend, native, type LogEntry, type SourceSearchReport } from "./backend";
import { Presence } from "./motion";
import { navigate } from "./routing";
import { notify } from "./store";
import { ActionGroup, Banner, Button, Modal } from "./ui";

export function LogsDialog({ onClose, subject }: { onClose: () => void; subject?: string }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!native) return;
    let canceled = false;
    let timer: number;
    const refresh = async () => {
      try {
        const logs = await backend<LogEntry[]>("logs", { subject });
        if (!canceled) {
          setEntries(logs);
          setError("");
          setLoaded(true);
        }
      } catch (e) {
        if (!canceled) setError((e as Error).message);
      } finally {
        if (!canceled) timer = window.setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [subject, revision]);
  const text = native
    ? entries
        .map((l) => `${new Date(l.at).toLocaleString()} [${l.level}] ${l.area}: ${l.message}`)
        .join("\n")
    : "[info] UI preview. Provider and filesystem actions are simulated.";
  return (
    <Modal
      title={subject ? "Source search logs" : "Application logs"}
      wide
      onClose={onClose}
      description="Refreshes every two seconds. Credentials and private source URLs are excluded."
      footer={
        <>
          <Button onClick={() => setRevision((n) => n + 1)}>Refresh logs</Button>
          <Button
            disabled={!text}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                notify("Logs copied.");
              } catch {
                notify("Clipboard unavailable. Export diagnostics from Settings.");
              }
            }}
          >
            Copy logs
          </Button>
        </>
      }
    >
      {error && (
        <Banner title="Couldn't refresh logs" tone="error">
          {error}
        </Banner>
      )}
      <small role="status">
        {native
          ? loaded
            ? `${entries.length} recent events`
            : error
              ? "Logs unavailable"
              : "Loading logs…"
          : "Demo logs"}
      </small>
      <pre className="log-output">
        {text || (loaded ? "No events recorded for this search." : "")}
      </pre>
    </Modal>
  );
}

export function SourceSearchDetails({ report }: { report: SourceSearchReport }) {
  const [logs, setLogs] = useState(false);
  return (
    <div className="source-diagnostics">
      <details>
        <summary>Search details · {report.providers.length} add-ons checked</summary>
        <div className="source-diagnostic-items">
          {report.providers.map((provider, i) => (
            <div key={i} className="source-diagnostic-item">
              <strong>
                {provider.name} ·{" "}
                {provider.status === "skipped"
                  ? "No stream capability"
                  : provider.status === "failed"
                    ? "Failed"
                    : `${provider.received} returned · ${provider.accepted} candidates`}
              </strong>
              <small>{provider.message}</small>
              {Object.entries(provider.rejected).map(([reason, count]) => (
                <small key={reason}>
                  {count} rejected: {reason}
                </small>
              ))}
            </div>
          ))}
          {report.warnings.map((warning, i) => (
            <small className="warning" key={i}>
              {warning}
            </small>
          ))}
          {report.sources
            .filter((source) => source.blocked)
            .map((source) => (
              <small className="warning" key={source.id}>
                {source.name}: {source.availability}
              </small>
            ))}
        </div>
      </details>
      <ActionGroup>
        {report.state === "missing_provider" && (
          <Button onClick={() => navigate("settings", "Sources & add-ons")}>
            Add download sources
          </Button>
        )}
        <Button variant="ghost" onClick={() => setLogs(true)}>
          View search logs
        </Button>
      </ActionGroup>
      <Presence>
        {logs && (
          <LogsDialog key="search-logs" subject={report.requestId} onClose={() => setLogs(false)} />
        )}
      </Presence>
    </div>
  );
}
