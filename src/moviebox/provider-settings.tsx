import { useState } from "react";
import { native } from "./backend";
import { notify, preference, runBackend, useDemo } from "./store";
import { Presence } from "./motion";
import { ActionGroup, Banner, Button, Choice, Field, Input, Modal, SettingRow, Toggle } from "./ui";

const providers = [
  { id: "torbox", name: "TorBox", mark: "TB" },
  { id: "realdebrid", name: "Real-Debrid", mark: "RD" },
];
export function ProviderAccounts() {
  const { preferences: p } = useDemo();
  const [connecting, setConnecting] = useState<string>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const action = async (type: string, provider: string) => {
    if (!native) {
      notify("Provider connections are available in the desktop app.");
      return;
    }
    setBusy(provider);
    setError("");
    setMessage("");
    try {
      await runBackend(type, { provider, key });
      setMessage(
        type === "provider.test"
          ? "Connection verified."
          : type === "provider.connect"
            ? "Provider connected."
            : "Provider disconnected. Cloud files were kept.",
      );
      setConnecting(undefined);
      setKey("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="stack">
      <div className="settings-intro">
        <h2>Providers</h2>
        <p>Choose who prepares torrents and supplies download links.</p>
      </div>
      {providers.map((provider) => {
        const connected =
          p.providerAccounts?.[provider.id]?.connected ?? (provider.id === "torbox" && p.provider);
        return (
          <div className="settings-card" key={provider.id}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <span className="provider-logo">{provider.mark}</span>
              <div className="spacer" style={{ minWidth: 140 }}>
                <strong>{provider.name}</strong>
                <p className={connected ? "success" : "muted"}>
                  {connected ? "Connected" : "Not connected"}
                </p>
              </div>
              <ActionGroup>
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    setConnecting(provider.id);
                    setError("");
                    setKey("");
                  }}
                >
                  {connected ? "Replace token" : "Connect"}
                </Button>
                {connected && (
                  <>
                    <Button
                      disabled={!!busy}
                      busy={busy === provider.id}
                      onClick={() => void action("provider.test", provider.id)}
                    >
                      Test connection
                    </Button>
                    <Button
                      disabled={!!busy}
                      onClick={() => void action("provider.disconnect", provider.id)}
                    >
                      Disconnect
                    </Button>
                  </>
                )}
              </ActionGroup>
            </div>
          </div>
        );
      })}
      <SettingRow
        title="Default provider"
        description="New downloads use this provider. Existing jobs keep their original account."
      >
        <Choice
          label="Default provider"
          value={p.defaultProvider === "realdebrid" ? "Real-Debrid" : "TorBox"}
          options={providers.map((v) => v.name)}
          onChange={(v) =>
            preference("defaultProvider", v === "Real-Debrid" ? "realdebrid" : "torbox")
          }
        />
      </SettingRow>
      <SettingRow
        title="Source preference"
        description="Real-Debrid availability is checked after submission; Cached only can exclude its torrent candidates."
      >
        <Choice
          label="Source preference"
          value={p.sourcePreference}
          options={["Cached first", "Cached only", "Best quality"]}
          onChange={(v) => preference("sourcePreference", v)}
        />
      </SettingRow>
      <Banner title="Cloud preparation is separate from local downloads">
        Preparing a torrent can download the full release in the provider cloud. MoviBox saves only
        the verified, selected video files locally. Disconnecting does not delete cloud files.
      </Banner>
      {message && (
        <Banner title="Provider status" tone="success">
          {message}
        </Banner>
      )}
      {error && !connecting && (
        <Banner title="Provider needs attention" tone="error">
          {error}
        </Banner>
      )}
      <Presence>
        {connecting && (
          <Modal
            key="provider-connect"
            title={`Connect ${providers.find((v) => v.id === connecting)?.name}`}
            onClose={() => {
              if (!busy) {
                setConnecting(undefined);
                setKey("");
              }
            }}
            footer={
              <>
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    setConnecting(undefined);
                    setKey("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!key.trim() || !!busy}
                  busy={!!busy}
                  onClick={() => void action("provider.connect", connecting)}
                >
                  Verify and connect
                </Button>
              </>
            }
          >
            <div className="stack">
              <Field
                label={connecting === "realdebrid" ? "Private API token" : "API key"}
                hint="Stored in your OS credential store. Never included in logs or exports."
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </Field>
              {connecting === "realdebrid" && (
                <p className="muted">
                  Use your personal token from Real-Debrid’s API token page. This does not change
                  your existing TorBox downloads.
                </p>
              )}
              {error && (
                <Banner title="Connection failed" tone="error">
                  {error}
                </Banner>
              )}
            </div>
          </Modal>
        )}
      </Presence>
    </div>
  );
}

export function SubtitleSettings() {
  const { preferences: p } = useDemo();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clear = () => {
    setOpen(false);
    setKey("");
    setPassword("");
    setUsername("");
  };
  return (
    <div className="stack">
      <div className="settings-intro">
        <h2>Subtitles</h2>
        <p>Optional subtitle files saved beside completed videos.</p>
      </div>
      <SettingRow
        title="Find subtitles automatically"
        description="Applies to new completed downloads. Existing subtitle files are never overwritten."
      >
        <Toggle
          label="Find subtitles automatically"
          checked={!!p.subtitlesEnabled}
          onChange={(v) => preference("subtitlesEnabled", v)}
        />
      </SettingRow>
      <SettingRow title="Preferred language">
        <Choice
          label="Subtitle language"
          value={p.subtitleLanguage ?? "English"}
          options={[
            "English",
            "French",
            "Spanish",
            "Portuguese",
            "German",
            "Italian",
            "Japanese",
            "Korean",
          ]}
          onChange={(v) => preference("subtitleLanguage", v)}
        />
      </SettingRow>
      <SettingRow
        title="Use subtitle add-ons"
        description="Search installed Stremio add-ons that advertise subtitle support."
      >
        <Toggle
          label="Use subtitle add-ons"
          checked={p.subtitleAddons !== false}
          onChange={(v) => preference("subtitleAddons", v)}
        />
      </SettingRow>
      <SettingRow
        title="Require an exact hash or release match"
        description="Safer matching through OpenSubtitles. Add-on results without match evidence are excluded."
      >
        <Toggle
          label="Require exact subtitle match"
          checked={!!p.subtitleExactOnly}
          onChange={(v) => preference("subtitleExactOnly", v)}
        />
      </SettingRow>
      <div className="settings-card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div className="spacer" style={{ minWidth: 140 }}>
            <h3>OpenSubtitles</h3>
            <p>{p.subtitlesAccount?.connected ? "Connected" : "Optional native API connection"}</p>
          </div>
          <ActionGroup>
            <Button onClick={() => setOpen(true)}>
              {p.subtitlesAccount?.connected ? "Reconnect" : "Connect"}
            </Button>
            {p.subtitlesAccount?.connected && (
              <Button onClick={() => void runBackend("subtitles.disconnect").catch(() => {})}>
                Disconnect
              </Button>
            )}
          </ActionGroup>
        </div>
      </div>
      <Banner title="Video downloads stay independent">
        Subtitle availability and account quotas are shown in download details. Embedded tracks are
        inspected when ffprobe is available. Otherwise MoviBox searches for external subtitles;
        timing is not guaranteed.
      </Banner>
      <Presence>
        {open && (
          <Modal
            key="subtitles-connect"
            title="Connect OpenSubtitles"
            onClose={() => {
              if (!busy) clear();
            }}
            footer={
              <>
                <Button disabled={busy} onClick={clear}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !key.trim() || !native}
                  busy={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await runBackend("subtitles.connect", { key, username, password });
                      clear();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Verify and connect
                </Button>
              </>
            }
          >
            <div className="stack">
              <Field label="OpenSubtitles API key">
                <Input
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </Field>
              <Field label="Username (optional)">
                <Input
                  autoComplete="off"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
              <Field
                label="Password (optional)"
                hint="Sign in to use your account’s download quota. Your password is not saved."
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {error && (
                <Banner title="Connection failed" tone="error">
                  {error}
                </Banner>
              )}
            </div>
          </Modal>
        )}
      </Presence>
    </div>
  );
}
