import { useEffect, useState } from "react";
import { Download, FolderOpen, Upload } from "lucide-react";
import { backend, native } from "./backend";
import { notify, refreshBackend } from "./store";
import { Presence } from "./motion";
import { Banner, Button, CheckBox, Field, Input, Modal, SettingRow } from "./ui";

type Preview = {
  checksum: string;
  createdAt: number;
  appVersion: string;
  platform: string;
  rules: number;
  library: number;
  titles: number;
  missingFiles: number;
  differentPlatform: boolean;
};

export function BackupSettings() {
  const [latest, setLatest] = useState<(Preview & { path: string }) | null>(null);
  useEffect(() => {
    if (!native) return;
    let canceled = false;
    void backend<(Preview & { path: string }) | null>("backup.latest")
      .then((result) => {
        if (!canceled) setLatest(result);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<(Preview & { path: string }) | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [restored, setRestored] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [backupPath, setBackupPath] = useState("");
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="settings-intro">
        <h2>Backup & restore</h2>
        <p>Keep a recovery copy of your settings, monitoring rules, and library records.</p>
      </div>
      {!native && (
        <Banner title="Desktop feature">
          Open the desktop app to save or restore native data.
        </Banner>
      )}
      <SettingRow
        title="Create a backup"
        description="Save in Movie Box’s recovery folder. Copy it to another disk to protect against device failure."
      >
        <Button
          disabled={!native || busy}
          onClick={() =>
            void perform(async () => {
              const result = await backend<Preview & { path: string }>("backup.create");
              setLatest(result);
              notify(
                "Backup saved in Recovery copies. Copy it to another disk for device recovery.",
              );
            })
          }
        >
          <Download size={15} />
          Back up now
        </Button>
      </SettingRow>
      {latest && (
        <SettingRow
          title="Latest recovery copy"
          description={`Saved ${new Date(latest.createdAt).toLocaleString()} · ${latest.rules} rules · ${latest.library} library records`}
        >
          <Button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const result = await backend<Preview>("backup.preview", { path: latest.path });
                setConfirmed(false);
                setRestored(false);
                setPreview({ ...result, path: latest.path });
              })
            }
          >
            <Upload size={15} />
            Review latest backup
          </Button>
        </SettingRow>
      )}
      <SettingRow
        title="Restore a backup"
        description="Review a backup before replacing settings, rules, and library records."
      >
        <Button
          disabled={!native || busy}
          onClick={() => {
            setError("");
            setChoosing(true);
          }}
        >
          <Upload size={15} />
          Review backup
        </Button>
      </SettingRow>
      <Banner title="What stays on this device">
        Provider credentials, add-on and indexer connections, login registration, and download tasks
        are not exported or replaced. Backups contain personal library information and are not
        encrypted.
      </Banner>
      <SettingRow
        title="Recovery copies"
        description="A safety backup is saved automatically before every restore."
      >
        <Button
          disabled={!native || busy}
          onClick={() =>
            void perform(async () => {
              await backend("backup.folder");
            })
          }
        >
          <FolderOpen size={15} />
          Open recovery folder
        </Button>
      </SettingRow>
      {error && !preview && !choosing && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {restored && (
        <Banner title="Backup restored">
          Your monitoring rules are paused. Review destinations and connections before resuming
          them. Existing video files and download tasks were left untouched.
        </Banner>
      )}
      <Presence>
        {choosing && (
          <Modal
            key="choose-backup"
            title="Open a backup"
            description="Choose your backup file or paste its full path. Nothing changes until you review and confirm."
            size="form"
            onClose={() => {
              if (!busy) setChoosing(false);
            }}
            footer={
              <>
                <Button disabled={busy} onClick={() => setChoosing(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !backupPath.trim()}
                  onClick={() =>
                    void perform(async () => {
                      const path = backupPath.trim();
                      const result = await backend<Preview>("backup.preview", { path });
                      setConfirmed(false);
                      setRestored(false);
                      setChoosing(false);
                      setPreview({ ...result, path });
                    })
                  }
                >
                  Review backup
                </Button>
              </>
            }
          >
            <Field
              label="Backup file"
              hint="Only import your own trusted .movibox-backup files."
              error={error || undefined}
            >
              <Input
                value={backupPath}
                onChange={(event) => setBackupPath(event.target.value)}
                placeholder="Full path to your backup file"
                disabled={busy}
              />
            </Field>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const { open } = await import("@tauri-apps/plugin-dialog");
                  const path = await open({
                    title: "Choose Movie Box backup",
                    multiple: false,
                    directory: false,
                    filters: [{ name: "Movie Box backup", extensions: ["movibox-backup"] }],
                  });
                  if (typeof path === "string") setBackupPath(path);
                })
              }
            >
              <FolderOpen size={15} />
              Choose file
            </Button>
          </Modal>
        )}
        {preview && (
          <Modal
            key="review-backup"
            title="Restore this backup?"
            description="This replaces your backed-up settings, monitoring rules, and library records."
            size="form"
            onClose={() => {
              if (!busy) setPreview(null);
            }}
            footer={
              <>
                <Button disabled={busy} onClick={() => setPreview(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !confirmed}
                  onClick={() =>
                    void perform(async () => {
                      await backend("backup.restore", {
                        path: preview.path,
                        checksum: preview.checksum,
                      });
                      await refreshBackend(true);
                      setPreview(null);
                      setRestored(true);
                      notify("Backup restored. Monitoring rules are paused.");
                    })
                  }
                >
                  {busy ? "Restoring…" : "Restore backup"}
                </Button>
              </>
            }
          >
            <dl className="health-list">
              <div>
                <dt>Created</dt>
                <dd>{new Date(preview.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>App version</dt>
                <dd>{preview.appVersion}</dd>
              </div>
              <div>
                <dt>Monitoring rules</dt>
                <dd>{preview.rules}</dd>
              </div>
              <div>
                <dt>Library records</dt>
                <dd>{preview.library}</dd>
              </div>
              <div>
                <dt>Files not found here</dt>
                <dd>{preview.missingFiles}</dd>
              </div>
            </dl>
            <Banner title="Restore safely">
              A safety copy is saved first. All restored rules start paused. Videos, subtitles,
              credentials, and current downloads are unchanged.
            </Banner>
            {preview.differentPlatform && (
              <Banner title="Different operating system">
                The default download folder stays unchanged. Review restored rule destinations; file
                paths are not translated between systems.
              </Banner>
            )}
            <label className="backup-confirmation">
              <CheckBox
                checked={confirmed}
                onChange={setConfirmed}
                label="I understand that my current rules and library records will be replaced."
              />
              <span>Replace my current rules and library records.</span>
            </label>
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
