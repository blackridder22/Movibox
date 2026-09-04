import { native } from "./backend";
import { Presence } from "./motion";
import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { ProviderConnect, AddSource } from "./settings";
import { navigate } from "./routing";
import { preference, useDemo } from "./store";
import { ActionGroup, Banner, Button, Confirm, Field, FolderChoice } from "./ui";
import { BrandMark } from "./brand";
export function Brand() {
  return (
    <div className="brand">
      <BrandMark />
      <span>Movie Box</span>
    </div>
  );
}
export function Setup() {
  const { preferences: p } = useDemo();
  const [step, setStep] = useState(0);
  const [skip, setSkip] = useState(false);
  const titles = ["Connect provider", "Connect sources", "Choose storage", "Ready to go"];
  const secondaryActions = (
    <>
      {step > 0 && (
        <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
          Back
        </Button>
      )}
      <Button variant="ghost" onClick={() => setSkip(true)}>
        Set up later
      </Button>
    </>
  );
  return (
    <div className="setup">
      <aside className="setup-sidebar">
        <Brand />
        <h2 className="setup-headline">
          Your next download,
          <br />
          already taken care of.
        </h2>
        <div className="setup-steps">
          {titles.map((title, i) => (
            <div key={title} className={`setup-step ${step === i ? "current" : ""}`}>
              <span>{step > i ? <Check size={14} /> : i + 1}</span>
              <strong>{title}</strong>
            </div>
          ))}
        </div>
        <small className="setup-ownership">
          Movie Box downloads to your device.
          <br />
          Your files stay under your control.
        </small>
      </aside>
      <main className="setup-main">
        <div className="setup-content" key={step}>
          <small>
            STEP {step + 1} OF 4{!native && " · DEMO SETUP"}
          </small>
          <h1>
            {
              [
                "Connect TorBox",
                "Connect a source add-on",
                "Choose your download folder",
                "You're ready",
              ][step]
            }
          </h1>
          <p>
            {
              [
                "Connect your account to prepare sources and download files.",
                "Add catalogs and source providers for movies and series.",
                "Choose where Movie Box should save your files.",
                "Find a title, download it, or let a monitoring rule watch for it.",
              ][step]
            }
          </p>
          {step === 0 ? (
            <ProviderConnect onDone={() => setStep(1)} secondaryActions={secondaryActions} />
          ) : step === 1 ? (
            <>
              <AddSource onDone={() => setStep(2)} secondaryActions={secondaryActions} />
              <ActionGroup>
                <Button variant="ghost" onClick={() => setStep(2)}>
                  {native ? "Continue with installed sources" : "Use existing demo sources"}
                </Button>
              </ActionGroup>
            </>
          ) : step === 2 ? (
            <>
              <Field label="Download folder">
                <FolderChoice value={p.folder} onChange={(v) => preference("folder", v)} />
              </Field>
              <Banner title="Choose a folder you control">
                {native
                  ? "Downloads are saved in this folder. You can change it later in Storage settings."
                  : "This preview only saves the folder label."}
              </Banner>
              <ActionGroup>
                {secondaryActions}
                <Button variant="primary" onClick={() => setStep(3)}>
                  Continue
                  <ChevronRight size={15} />
                </Button>
              </ActionGroup>
            </>
          ) : (
            <>
              <dl className="health-list">
                <div>
                  <dt>Provider</dt>
                  <dd>{p.provider ? "TorBox connected" : "Not connected"}</dd>
                </div>
                <div>
                  <dt>Sources</dt>
                  <dd>
                    {p.addons.length} {native ? "installed" : "demo"} sources
                  </dd>
                </div>
                <div>
                  <dt>Download folder</dt>
                  <dd>{p.folder}</dd>
                </div>
              </dl>
              <Banner title={native ? "Your workspace is ready" : "Your preview is ready"}>
                {native
                  ? "Search for a title, choose a source, or create a monitoring rule."
                  : "No live service was activated."}
              </Banner>
              <ActionGroup>
                {secondaryActions}
                <Button
                  variant="primary"
                  onClick={() => {
                    preference("setupComplete", true);
                    navigate("discover");
                  }}
                >
                  Start discovering
                  <ChevronRight size={15} />
                </Button>
              </ActionGroup>
            </>
          )}
        </div>
      </main>
      <Presence>
        {skip && (
          <Confirm
            key="Confirm"
            title="Continue in browse-only mode?"
            description="You can explore the catalog now and return to setup from Settings. A provider and destination are required for real downloads."
            danger={false}
            confirm="Continue browsing"
            onClose={() => setSkip(false)}
            onConfirm={() => {
              preference("setupComplete", native);
              preference("provider", false);
              navigate("discover");
            }}
          />
        )}
      </Presence>
    </div>
  );
}
