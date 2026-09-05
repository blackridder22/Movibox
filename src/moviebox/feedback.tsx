import { useEffect, useRef, useState } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { CheckCircle2, ExternalLink, LoaderCircle, MessageSquare, RefreshCw } from "lucide-react";
import { native } from "./backend";
import { Button, Modal, SettingRow } from "./ui";
import {
  canEmbedFeedback,
  feedbackEvent,
  feedbackUrl,
  type FeedbackContext,
} from "./feedback-config";
import "./feedback.css";

function feedbackContext(): FeedbackContext {
  let os = "browser-preview";
  if (native) {
    try {
      os = platform();
    } catch {
      os = "unknown";
    }
  }
  return { appVersion: __APP_VERSION__, os };
}

export function FeedbackSettings({ onFeedback }: { onFeedback: () => void }) {
  return (
    <>
      <div className="settings-intro">
        <h2>Help improve MoviBox</h2>
        <p>Tell us what worked, what got in your way, or what would make MoviBox better.</p>
      </div>
      <SettingRow
        title="Share your experience"
        description="No account needed. Your email is optional."
      >
        <Button variant="primary" onClick={onFeedback}>
          <MessageSquare size={16} /> Give feedback
        </Button>
      </SettingRow>
      <div className="feedback-privacy">
        <h3>What is shared</h3>
        <p>
          Your answers go to the MoviBox team through Tally and Airtable. App version and operating
          system are included to help us understand your feedback.
        </p>
        <p>
          API keys, download history, and logs are not attached. Please remove private information
          from any screenshot you choose to share.
        </p>
      </div>
    </>
  );
}

export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [context] = useState(feedbackContext);
  const [attempt, setAttempt] = useState(0);
  const [openError, setOpenError] = useState(false);
  const [opening, setOpening] = useState(false);
  const embedded = canEmbedFeedback(native, context.os);
  const openInBrowser = async () => {
    setOpenError(false);
    setOpening(true);
    try {
      const url = feedbackUrl(context);
      if (native) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.click();
      }
    } catch {
      setOpenError(true);
    } finally {
      setOpening(false);
    }
  };
  return (
    <Modal
      title="Help improve MoviBox"
      description="Share a problem, an idea, or something that worked well."
      size={embedded ? "feedback" : "form"}
      onClose={onClose}
      footer={
        <div className="feedback-footer">
          <p>App version and OS are included. Email is optional.</p>
          <Button variant="ghost" busy={opening} onClick={() => void openInBrowser()}>
            <ExternalLink size={15} /> Open in browser
          </Button>
        </div>
      }
    >
      {openError && (
        <p role="alert" className="form-error">
          Your browser could not open. Try again.
        </p>
      )}
      {embedded ? (
        <FeedbackForm
          key={attempt}
          context={context}
          onRetry={() => setAttempt((value) => value + 1)}
          onClose={onClose}
        />
      ) : (
        <div className="feedback-state">
          <MessageSquare size={28} aria-hidden="true" />
          <h3>We’d like to hear from you</h3>
          <p>
            Open the feedback form in your browser. No account is needed, and you can return to
            MoviBox when you’re done.
          </p>
          <Button variant="primary" busy={opening} onClick={() => void openInBrowser()}>
            <ExternalLink size={16} /> Give feedback
          </Button>
        </div>
      )}
    </Modal>
  );
}

function FeedbackForm({
  context,
  onRetry,
  onClose,
}: {
  context: FeedbackContext;
  onRetry: () => void;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable" | "submitted">(
    "loading",
  );
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    const receive = (event: MessageEvent) => {
      const next = feedbackEvent(event, frame.current?.contentWindow);
      // Ignore response contents; only the trusted form's lifecycle changes our UI.
      if (next) setStatus((current) => (current === "submitted" ? current : next));
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("message", receive);
    };
  }, []);
  useEffect(() => {
    if (!online || status !== "loading") return;
    const timer = window.setTimeout(() => setStatus("unavailable"), 15000);
    return () => window.clearTimeout(timer);
  }, [online, status]);

  if (status === "submitted") {
    return (
      <div className="feedback-state feedback-success" role="status">
        <CheckCircle2 size={32} aria-hidden="true" />
        <h3>Thanks for your feedback</h3>
        <p>Your response was received. It will help us improve MoviBox.</p>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }
  return (
    <div className="feedback-form">
      {!online && (
        <p className="feedback-offline" role="status">
          You’re offline. Reconnect to send your feedback.
        </p>
      )}
      <div className="feedback-frame-container" aria-busy={status === "loading" && online}>
        <iframe
          ref={frame}
          className="feedback-frame"
          data-ready={status === "ready"}
          tabIndex={status === "ready" ? 0 : -1}
          aria-hidden={status !== "ready"}
          title="MoviBox feedback form"
          src={feedbackUrl(context, true)}
          sandbox="allow-scripts allow-forms allow-same-origin"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'"
          onError={() => setStatus("unavailable")}
        />
        {status === "loading" && online && (
          <div className="feedback-state feedback-loading" role="status">
            <LoaderCircle className="spin" size={24} aria-hidden="true" />
            <p>Loading feedback form…</p>
          </div>
        )}
        {(status === "unavailable" || (!online && status === "loading")) && (
          <div className="feedback-state feedback-unavailable" role="status">
            <MessageSquare size={28} aria-hidden="true" />
            <h3>{online ? "The form couldn’t load" : "You’re offline"}</h3>
            <p>
              {online
                ? "Try again, or use Open in browser below."
                : "Reconnect to the internet, then try again."}
            </p>
            <Button onClick={onRetry} disabled={!online}>
              <RefreshCw size={15} /> Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
