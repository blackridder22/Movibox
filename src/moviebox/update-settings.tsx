import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { backend, native } from "./backend";
import { preference, useDemo } from "./store";
import { Presence } from "./motion";
import { Banner, Button, Modal, SettingRow, Toggle } from "./ui";

type UpdateStatus = {
  state: string;
  message: string;
  version?: string;
  notes?: string;
  received?: number;
  total?: number;
};
export function UpdateSettings() {
  const { preferences } = useDemo();
  const [status, setStatus] = useState<UpdateStatus>({
    state: native ? "loading" : "preview",
    message: native ? "Reading update status…" : "Update checks are available in the desktop app.",
  });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!native) return;
    let canceled = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<UpdateStatus>("movibox://update", ({ payload }) => {
        if (!canceled) setStatus(payload);
      });
      if (canceled) {
        unlisten();
        return;
      }
      cleanup = unlisten;
      const current = await backend<UpdateStatus>("updates.status");
      if (!canceled) setStatus(current);
    })().catch(() => {
      if (!canceled) setError("Could not read update status.");
    });
    return () => {
      canceled = true;
      cleanup?.();
    };
  }, []);
  const check = async () => {
    setError("");
    setBusy(true);
    try {
      setStatus(await backend<UpdateStatus>("updates.check"));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const working = busy || ["checking", "downloading", "installing"].includes(status.state);
  return (
    <>
      <SettingRow title="App updates" description="Signed updates are checked before installation.">
        <Button
          disabled={
            !native ||
            working ||
            ["unconfigured", "unsupported"].includes(status.state) ||
            status.state === "loading"
          }
          onClick={() => void check()}
        >
          <RefreshCw size={15} />
          {status.state === "checking" ? "Checking…" : "Check for updates"}
        </Button>
      </SettingRow>
      <SettingRow
        title="Check automatically"
        description="Check at launch and once a day. Installation always asks you first."
      >
        <Toggle
          label="Check automatically for updates"
          checked={preferences.autoCheckUpdates !== false}
          disabled={!native || ["unconfigured", "unsupported"].includes(status.state)}
          onChange={(enabled) => preference("autoCheckUpdates", enabled)}
        />
      </SettingRow>
      <Banner
        title={
          status.state === "available" ? `Version ${status.version} is available` : "Update status"
        }
      >
        <span role="status">{status.message}</span>
        {status.total && status.received != null ? (
          <p>{Math.min(100, Math.round((status.received / status.total) * 100))}% downloaded</p>
        ) : null}
      </Banner>
      {status.state === "available" && (
        <Button variant="primary" onClick={() => setConfirm(true)}>
          <Download size={15} />
          Review update
        </Button>
      )}
      {error && !confirm && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <Presence>
        {confirm && (
          <Modal
            size="form"
            title={`Install Movie Box ${status.version}?`}
            description="Pause downloads and monitoring rules first. Movie Box will save a recovery backup, verify the update signature, install, and restart."
            onClose={() => {
              if (!working) setConfirm(false);
            }}
            footer={
              <>
                <Button disabled={working} onClick={() => setConfirm(false)}>
                  Not now
                </Button>
                <Button
                  variant="primary"
                  disabled={working}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void backend("updates.install", { version: status.version })
                      .catch((cause: Error) => setError(cause.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  {working ? "Installing…" : "Install and restart"}
                </Button>
              </>
            }
          >
            {status.notes && <p className="update-release-notes">{status.notes}</p>}
            <p role="status">{status.message}</p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </Modal>
        )}
      </Presence>
    </>
  );
}
