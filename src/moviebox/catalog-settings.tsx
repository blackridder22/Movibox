import { useState } from "react";
import { native } from "./backend";
import { preference, runBackend, useDemo } from "./store";
import { ActionGroup, Banner, Button, Choice, Field, Input, Modal, SettingRow } from "./ui";

const languages: Record<string, string> = {
  English: "en-US",
  French: "fr-FR",
  Spanish: "es-ES",
  Portuguese: "pt-BR",
  German: "de-DE",
  Italian: "it-IT",
  Japanese: "ja-JP",
  Korean: "ko-KR",
};
export function CatalogSettings() {
  const { preferences: p } = useDemo();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) {
      setOpen(false);
      setToken("");
      setError("");
    }
  };
  return (
    <div className="stack">
      <div className="settings-intro">
        <h2>Catalog</h2>
        <p>Choose how Movie Box discovers titles and episode metadata.</p>
      </div>
      <SettingRow
        title="Catalog provider"
        description="Your Stremio source add-ons stay enabled with either catalog."
      >
        <Choice
          label="Catalog provider"
          value={p.catalogProvider === "tmdb" ? "TMDB" : "Stremio add-ons"}
          options={p.tmdbConnected ? ["Stremio add-ons", "TMDB"] : ["Stremio add-ons"]}
          onChange={(v) => preference("catalogProvider", v === "TMDB" ? "tmdb" : "addons")}
        />
      </SettingRow>
      <SettingRow
        title="Metadata language"
        description="TMDB titles, descriptions, genres, and episode names."
      >
        <Choice
          label="Catalog language"
          value={
            Object.keys(languages).find((l) => languages[l] === p.catalogLanguage) ?? "English"
          }
          options={Object.keys(languages)}
          onChange={(v) => preference("catalogLanguage", languages[v]!)}
        />
      </SettingRow>
      <div className="settings-card">
        <div className="row">
          <div className="spacer">
            <h3>TMDB</h3>
            <p>{p.tmdbConnected ? "Connected" : "Optional built-in catalog"}</p>
          </div>
          <ActionGroup>
            <Button onClick={() => setOpen(true)}>
              {p.tmdbConnected ? "Reconnect" : "Connect"}
            </Button>
            {p.tmdbConnected && (
              <Button onClick={() => void runBackend("tmdb.disconnect").catch(() => {})}>
                Disconnect
              </Button>
            )}
          </ActionGroup>
        </div>
      </div>
      <Banner title="Catalog and downloads are separate">
        TMDB provides metadata and images. Availability still depends on your source providers. If
        TMDB cannot be reached, Movie Box tries your enabled add-on catalogs.
      </Banner>
      <TmdbAttribution />
      {open && (
        <Modal
          title="Connect TMDB"
          description="Use the API Read Access Token from your TMDB account settings."
          onClose={close}
          footer={
            <>
              <Button disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                busy={busy}
                disabled={busy || !token.trim() || !native}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await runBackend("tmdb.connect", { token });
                    setToken("");
                    setOpen(false);
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
          <Field
            label="API Read Access Token"
            hint="Stored in the OS credential store, never in browser settings."
          >
            <Input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          {error && (
            <Banner title="Connection failed" tone="error">
              {error}
            </Banner>
          )}
        </Modal>
      )}
    </div>
  );
}

export function TmdbAttribution() {
  return (
    <div className="stack tmdb-credit">
      <a
        href="https://www.themoviedb.org"
        target="_blank"
        rel="noreferrer"
        className="tmdb-attribution"
      >
        <img src="/moviebox/tmdb-logo.svg" alt="The Movie Database" />
      </a>
      <p className="muted">
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>
    </div>
  );
}
