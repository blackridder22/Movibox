import { Presence } from "./motion";
import { useState } from "react";
import { backend, useBackgroundSearch, type SourceSearchReport } from "./backend";
import { notify, runBackend, useDemo } from "./store";
import { navigate } from "./routing";
import { ActionGroup, Banner, Button, CheckBox, Confirm, Field, Input, Modal, Toggle } from "./ui";
import type { BundleRow, Media } from "./types";

type Plan = {
  id: string;
  rows: BundleRow[];
  sourceCount: number;
  totalBytes: number;
  warnings: string[];
  reports: SourceSearchReport[];
};
export function BundleReview({
  media,
  season,
  episodes,
  method,
  destination,
  onClose,
  onMonitor,
  searchId,
}: {
  searchId?: string;
  media: Media;
  season: number;
  episodes: number[];
  method: string;
  destination: string;
  onClose: () => void;
  onMonitor: (id: string, episodes: number[], season: number) => void;
}) {
  const { preferences } = useDemo();
  const [preparedPlan, setPlan] = useState<Plan>();
  const [actionError, setError] = useState("");
  const [actionBusy, setBusy] = useState("");
  const [monitor, setMonitor] = useState(true);
  const search = useBackgroundSearch<Plan>(
    "bundle",
    {
      id: media.id,
      season,
      episodes,
      method,
      quality: preferences.quality,
      language: preferences.language,
    },
    destination,
    searchId,
  );
  const plan = preparedPlan?.id === search.task?.result?.id ? preparedPlan : search.task?.result;
  const error = actionError || search.error;
  const busy = search.loading ? "search" : actionBusy;
  const close = () => {
    if (search.loading)
      notify("Search continues in the background.", {
        label: "View searches",
        run: () => navigate("downloads"),
      });
    onClose();
  };
  const ready = plan?.rows.filter((r) => r.status === "ready") ?? [];
  const pending = plan?.rows.filter((r) => r.status === "pending") ?? [];
  const unresolved =
    plan?.rows
      .filter((r) => r.status === "missing" || r.status === "pending")
      .map((r) => r.episode) ?? [];
  const prepare = async () => {
    if (!plan || busy) return;
    setBusy("prepare");
    setError("");
    try {
      setPlan(await backend<Plan>("bundle.prepare", { id: plan.id }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const queue = async (wait = false) => {
    if (!plan || busy) return;
    setBusy("queue");
    setError("");
    try {
      await runBackend(wait ? "bundle.wait" : "bundle.enqueue", { id: plan.id, destination });
      notify(
        wait
          ? "Bundle queued for background preparation."
          : `${ready.length} episodes queued as one bundle.`,
        {
          label: "View downloads",
          run: () => navigate("downloads"),
        },
      );
      onClose();
      const remaining = wait
        ? plan.rows.filter((r) => r.status === "missing").map((r) => r.episode)
        : unresolved;
      if (monitor && remaining.length) onMonitor(media.id, remaining, season);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <Modal
      wide
      title="Review season bundle"
      description={`${media.title} · Season ${season} · ${episodes.length} selected`}
      onClose={() => {
        if (busy !== "queue" && busy !== "prepare") close();
      }}
      footer={
        <>
          <Button disabled={busy === "queue" || busy === "prepare"} onClick={close}>
            Back
          </Button>
          <Button
            disabled={!!busy}
            onClick={() => {
              setBusy("");
              setError("");
              setPlan(undefined);
              search.retry();
            }}
          >
            Find sources again
          </Button>
          {search.loading && search.task && (
            <Button onClick={() => void search.cancel().catch((e: Error) => setError(e.message))}>
              Cancel search
            </Button>
          )}
          {pending.length > 0 && (
            <Button busy={busy === "prepare"} disabled={!!busy} onClick={prepare}>
              Prepare / check {pending.length} candidates
            </Button>
          )}
          <Button
            variant="primary"
            busy={busy === "queue"}
            disabled={!!busy || (!ready.length && !pending.length)}
            onClick={() => void queue(pending.length > 0)}
          >
            {pending.length ? "Queue and wait" : `Queue ${ready.length} ready episodes`}
          </Button>
        </>
      }
    >
      <div className="stack" aria-busy={!!busy}>
        <Banner
          title={
            busy === "search"
              ? "Searching packs and missing episodes…"
              : `${ready.length} ready · ${pending.length} preparing · ${unresolved.length - pending.length} missing`
          }
        >
          {plan
            ? `${plan.sourceCount} distinct sources · ${plan.totalBytes ? `${(plan.totalBytes / 1e9).toFixed(2)} GB reported size` : "Size unknown"}. Each file is saved once. Audio language is advertised by the source; media tracks are not inspected.`
            : "Searching your configured native indexers and Stremio add-ons. You can leave this view; results stay in Downloads. Nothing is submitted to your provider by this search."}
        </Banner>
        {error && (
          <Banner title="Bundle needs attention" tone="error">
            {error}
          </Banner>
        )}
        {plan?.warnings.map((w, i) => (
          <Banner key={`${i}-${w}`} title="Before continuing" tone="warning">
            {w}
          </Banner>
        ))}
        {pending.length > 0 && (
          <p className="muted">
            Preparing may download the whole torrent in your selected provider’s cloud. Queue and
            wait continues in the background and survives restarts. Only verified selected files are
            saved locally.
          </p>
        )}
        <div className="episode-matches">
          {plan?.rows.map((row) => (
            <div className="episode-match bridge-match" key={row.episode}>
              <div className="row">
                <strong>
                  S{String(season).padStart(2, "0")}E{String(row.episode).padStart(2, "0")}
                </strong>
                <span className="spacer">{row.title}</span>
                <small
                  className={
                    row.status === "ready" || row.status === "existing" ? "success" : "muted"
                  }
                >
                  {row.status}
                </small>
              </div>
              <small>{row.reason}</small>
              {row.sourceName && (
                <small>
                  {row.pack ? "Pack" : "Individual source"} · {row.sourceName} · {row.quality}
                </small>
              )}
              {row.filename && <small title={row.filename}>{row.filename}</small>}
            </div>
          ))}
        </div>
        {!!unresolved.length && (
          <label className="row">
            <CheckBox label="Monitor unresolved episodes" checked={monitor} onChange={setMonitor} />
            Monitor unresolved episodes after queuing
          </label>
        )}
        {plan && (
          <details className="bridge-diagnostics">
            <summary>Search diagnostics · {plan.reports.length} requests</summary>
            <div className="stack">
              {plan.reports.map((r) => (
                <div key={r.requestId}>
                  <p>{r.summary}</p>
                  {r.providers.map((p, i) => (
                    <small className="bridge-diagnostic" key={`${p.name}-${i}`}>
                      {p.name}: {p.status} · {p.accepted}/{p.received} accepted. {p.message}{" "}
                      {Object.entries(p.rejected)
                        .map(([reason, count]) => `${reason}: ${count}`)
                        .join(" · ")}
                    </small>
                  ))}
                  {r.warnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </Modal>
  );
}

export function IndexerSettings() {
  const { indexers = [] } = useDemo();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [remove, setRemove] = useState<string>();
  const action = async (type: string, input: unknown, id: string) => {
    setBusy(id);
    setError("");
    try {
      await runBackend(type, input);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="stack bridge-indexers">
      <div className="row">
        <div className="spacer">
          <h3>Built-in search bridge</h3>
          <p>
            Torznab and optional Knaben public search. Public coverage varies; your existing add-ons
            remain available.
          </p>
        </div>
        <ActionGroup>
          {!indexers.some((i) => i.id === "knaben") && (
            <Button disabled={!!busy} onClick={() => void action("indexer.public", {}, "public")}>
              Enable public search
            </Button>
          )}
          <Button onClick={() => setOpen(true)}>Add indexer</Button>
        </ActionGroup>
      </div>
      {!indexers.length && (
        <Banner title="No native indexers connected">
          Add a Torznab API endpoint to search season packs independently of Stremio add-ons.
        </Banner>
      )}
      {error && !open && (
        <Banner title="Indexer needs attention" tone="error">
          {error}
        </Banner>
      )}
      {indexers.map((i) => (
        <div className="settings-card" key={i.id}>
          <div className="row">
            <div className="spacer">
              <strong>{i.name}</strong>
              <p>
                {i.origin} · {i.hasKey ? "Key in OS credential store" : "No API key"}
              </p>
            </div>
            <Toggle
              label={`Enable ${i.name}`}
              checked={i.enabled}
              onChange={(v) => {
                void action("indexer.toggle", { id: i.id, enabled: v }, i.id);
              }}
            />
          </div>
          <ActionGroup>
            <Button
              busy={busy === i.id}
              disabled={!!busy}
              onClick={async () => {
                if (await action("indexer.test", { id: i.id }, i.id))
                  notify("Indexer capabilities verified.");
              }}
            >
              Test connection
            </Button>
            <Button disabled={!!busy} onClick={() => setRemove(i.id)}>
              Remove
            </Button>
          </ActionGroup>
        </div>
      ))}
      <Presence>
        {open && (
          <Modal
            key="add-indexer"
            title="Add native indexer"
            description="Use the Torznab API URL supplied by your indexer or Prowlarr."
            onClose={() => {
              if (!busy) {
                setOpen(false);
                setKey("");
              }
            }}
            footer={
              <>
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    setOpen(false);
                    setKey("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  busy={busy === "save"}
                  disabled={!!busy || !name.trim() || !url.trim()}
                  onClick={async () => {
                    if (await action("indexer.save", { name, url, key }, "save")) {
                      setOpen(false);
                      setName("");
                      setUrl("");
                      setKey("");
                      notify("Native indexer connected.");
                    }
                  }}
                >
                  Validate and connect
                </Button>
              </>
            }
          >
            <div className="stack">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My indexer"
                />
              </Field>
              <Field
                label="Torznab API URL"
                hint="HTTPS, or HTTP on localhost for a local indexer. No API key in the URL."
              >
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://localhost:9696/1/api"
                />
              </Field>
              <Field label="API key">
                <Input
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </Field>
              {error && (
                <Banner title="Connection failed" tone="error">
                  {error}
                </Banner>
              )}
              <Banner title="Stored privately">
                API keys stay in the OS credential store and are excluded from diagnostics.
              </Banner>
            </div>
          </Modal>
        )}
      </Presence>
      <Presence>
        {remove && (
          <Confirm
            key="remove-indexer"
            title="Remove indexer?"
            description="Its saved API key will be removed. Existing downloads and Stremio add-ons are kept."
            confirm="Remove indexer"
            onClose={() => setRemove(undefined)}
            onConfirm={async () => {
              if (await action("indexer.remove", { id: remove }, remove)) setRemove(undefined);
            }}
          />
        )}
      </Presence>
    </div>
  );
}
