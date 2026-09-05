import { createContext, useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import { BookOpen } from "lucide-react";
import privacy from "../../PRIVACY.md?raw";
import useNotice from "../../USE_NOTICE.md?raw";
import license from "../../LICENSE?raw";
import thirdParty from "../../THIRD_PARTY_NOTICES.md?raw";
import { native } from "./backend";
import { Presence } from "./motion";
import { policyLink, type PolicyId } from "./policy-links";
import { notify } from "./store";
import { Button, Modal, SettingRow } from "./ui";
import "./policies.css";

const policies = {
  privacy: {
    title: "Privacy policy",
    description: "Local data, connected services, feedback, and your privacy choices.",
    text: privacy,
  },
  use: {
    title: "Use & liability notice",
    description: "Lawful use, provider rules, account risks, and warranty limitations.",
    text: useNotice,
  },
  license: {
    title: "MoviBox license",
    description: "The software license and copyright notices for MoviBox and Harbor.",
    text: license,
  },
  "third-party": {
    title: "Third-party notices",
    description: "Upstream software, fonts, service names, and third-party content.",
    text: thirdParty,
  },
} satisfies Record<PolicyId, { title: string; description: string; text: string }>;

const PolicyNavigation = createContext<(document: PolicyId) => void>(() => {});

function PolicyAnchor({ href, children }: ComponentProps<"a">) {
  const onNavigate = useContext(PolicyNavigation);
  const target = policyLink(href ?? "");
  if (!target) return <span>{children}</span>;
  if ("document" in target)
    return (
      <button className="policy-link" onClick={() => onNavigate(target.document)}>
        {children}
      </button>
    );
  return (
    <a
      href={target.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!native) return;
        event.preventDefault();
        void import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(target.url))
          .catch(() => notify("The link could not open. Please try again."));
      }}
    >
      {children}
    </a>
  );
}

const policyComponents = { a: PolicyAnchor };

export function PolicySettings() {
  const [document, setDocument] = useState<PolicyId | null>(null);
  return (
    <>
      <div className="settings-intro">
        <h2>Privacy & legal</h2>
        <p>Read the policies included with MoviBox {__APP_VERSION__}. Available offline.</p>
      </div>
      {(Object.keys(policies) as PolicyId[]).map((id) => (
        <SettingRow key={id} title={policies[id].title} description={policies[id].description}>
          <Button aria-label={`Read ${policies[id].title}`} onClick={() => setDocument(id)}>
            <BookOpen size={15} /> Read
          </Button>
        </SettingRow>
      ))}
      <Presence>
        {document && (
          <PolicyDialog
            key="policy"
            document={document}
            onNavigate={setDocument}
            onClose={() => setDocument(null)}
          />
        )}
      </Presence>
    </>
  );
}

function PolicyDialog({
  document,
  onNavigate,
  onClose,
}: {
  document: PolicyId;
  onNavigate: (document: PolicyId) => void;
  onClose: () => void;
}) {
  const policy = policies[document];
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    article.current?.parentElement?.scrollTo(0, 0);
    article.current?.focus({ preventScroll: true });
  }, [document]);
  return (
    <Modal
      title={policy.title}
      description="Included with this version of MoviBox."
      size="policy"
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <article ref={article} className="policy-document" aria-label={policy.title} tabIndex={-1}>
        <PolicyNavigation.Provider value={onNavigate}>
          <Markdown skipHtml components={policyComponents}>
            {policy.text.replace(/^# [^\n]+\n+/, "")}
          </Markdown>
        </PolicyNavigation.Provider>
      </article>
    </Modal>
  );
}
