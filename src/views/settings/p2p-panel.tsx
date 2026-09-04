import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  torrentEngineRestart,
  torrentEngineSelfTest,
  torrentEngineStatus,
  type EngineStatus,
  type SelfTestResult,
} from "@/lib/torrent/local-engine";

export function P2PPanel() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [test, setTest] = useState<SelfTestResult | null>(null);
  const [busy, setBusy] = useState<"refresh" | "restart" | "test" | null>(null);

  const refresh = useCallback(async () => {
    setBusy("refresh");
    setStatus(await torrentEngineStatus());
    setBusy(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restart = async () => {
    setBusy("restart");
    setStatus(await torrentEngineRestart());
    setBusy(null);
  };

  const runTest = async () => {
    setBusy("test");
    setTest(await torrentEngineSelfTest());
    setStatus(await torrentEngineStatus());
    setBusy(null);
  };

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h2 className="text-[18px] font-semibold text-ink">Built-in torrent downloader</h2>
        <p className="mt-1 max-w-[68ch] text-[13.5px] leading-relaxed text-ink-muted">
          Used only to acquire files from magnet sources. MoviBox never hands this data to an
          internal video player.
        </p>
      </div>

      <div className="rounded-2xl border border-edge-soft bg-elevated/45 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-xl ${
              status?.ready ? "bg-success/15 text-success" : "bg-danger/12 text-danger"
            }`}
          >
            {status?.ready ? <CheckCircle2 size={19} /> : <XCircle size={19} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">
              {status?.ready ? "Downloader ready" : "Downloader unavailable"}
            </div>
            <div className="text-[12.5px] text-ink-muted">
              {status?.last_error ??
                `Port ${status?.port ?? "—"} · ${status?.active_torrents ?? 0} active jobs · ${status?.dht_nodes ?? 0} DHT nodes`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy != null}
            className="flex h-10 items-center gap-2 rounded-xl border border-edge bg-canvas/55 px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-canvas disabled:opacity-50"
          >
            {busy === "refresh" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void restart()}
            disabled={busy != null}
            className="flex h-10 items-center gap-2 rounded-xl bg-ink px-3.5 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === "restart" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Restart
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-edge-soft bg-elevated/45 p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck size={19} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">Connection self-test</div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
              Checks the local engine, storage, network listeners, and peer discovery without
              opening a player.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={busy != null}
            className="flex h-10 items-center gap-2 rounded-xl border border-edge bg-canvas/55 px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-canvas disabled:opacity-50"
          >
            {busy === "test" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ShieldCheck size={14} />
            )}
            Run test
          </button>
        </div>
        {test && (
          <div className="mt-4 grid gap-2">
            {test.steps.map((step) => (
              <div
                key={step.label}
                className="flex items-start gap-2 rounded-xl border border-edge-soft bg-canvas/35 px-3 py-2.5"
              >
                {step.ok ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-danger" />
                )}
                <div>
                  <div className="text-[12.5px] font-semibold text-ink">{step.label}</div>
                  <div className="text-[11.5px] text-ink-muted">{step.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
