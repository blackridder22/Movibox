import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import stremioLogo from "@/assets/stremio-wordmark.png";
import { StremioWebButton } from "@/components/auth-modal/stremio-web-button";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { openUrl } from "@/lib/window";

export function StremioStep({ onConnected }: { onConnected?: () => void }) {
  const { user, signIn } = useAuth();
  const t = useT();
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      onConnected?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Sign-in failed"));
    } finally {
      setBusy(false);
    }
  };

  if (user) {
    return (
      <div className="flex flex-col gap-6">
        <span className="text-[12.5px] font-medium uppercase tracking-[0.16em] text-ink-subtle">
          {t("Step 2 · Stremio")}
        </span>
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-[36px] font-medium leading-[1.08] tracking-tight text-ink">
            {t("You're in")}
          </h1>
          <p className="text-[15px] leading-relaxed text-ink-muted">
            {t("Library and addons will sync in once you're past setup.")}
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-edge-soft bg-canvas px-5 py-4">
          <StremioAvatar
            src={user.avatar}
            initial={(user.fullname || user.email || "?").trim()[0]?.toUpperCase() ?? "?"}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-medium text-ink">
              {user.fullname || user.email.split("@")[0]}
            </div>
            <div className="truncate text-[12.5px] text-ink-subtle">{user.email}</div>
          </div>
          <Check size={18} strokeWidth={2.4} className="text-accent" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <span className="text-[12.5px] font-medium uppercase tracking-[0.16em] text-ink-subtle">
        {t("Step 2 · Stremio")}
      </span>
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-[36px] font-medium leading-[1.08] tracking-tight text-ink">
          {t("Connect your Stremio account")}
        </h1>
        <p className="text-[15px] leading-relaxed text-ink-muted">
          {t(
            "This connects your collections, watched state, and installed addons before MoviBox starts choosing downloads.",
          )}
        </p>
      </div>
      <div className="flex justify-center py-1">
        <img
          src={stremioLogo}
          alt="Stremio"
          className="h-8 opacity-90"
          style={{ filter: "grayscale(1) invert(1)" }}
        />
      </div>
      <StremioWebButton onDone={() => onConnected?.()} disabled={busy} />
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-edge-soft" />
        <button
          type="button"
          onClick={() => setShowEmail((value) => !value)}
          className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-subtle hover:text-ink"
        >
          {showEmail ? t("Hide email sign-in") : t("Use email and password")}
        </button>
        <span className="h-px flex-1 bg-edge-soft" />
      </div>
      {showEmail ? (
        <form onSubmit={submit} className="animate-step-in flex flex-col gap-3">
          <FormField
            label={t("Email")}
            type="email"
            value={email}
            onChange={setEmail}
            autoFocus
            disabled={busy}
          />
          <FormField
            label={t("Password")}
            type="password"
            value={password}
            onChange={setPassword}
            disabled={busy}
          />
          {error ? (
            <p className="rounded-lg bg-danger/15 px-3 py-2 text-[13px] text-danger">{error}</p>
          ) : null}
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-ink text-[14px] font-semibold text-canvas disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {busy ? t("Signing in…") : t("Sign in with email")}
          </button>
        </form>
      ) : null}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => openUrl("https://www.stremio.com/register")}
          className="flex items-center justify-center gap-1.5 text-center text-[12.5px] text-ink-subtle transition-colors hover:text-ink-muted"
        >
          {t("Don't have an account? Create one")}
          <ExternalLink size={11} />
        </button>
      </div>
    </div>
  );
}

function FormField({
  label,
  type,
  value,
  onChange,
  autoFocus,
  disabled,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-subtle">
        {label}
      </span>
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete={type === "password" ? "current-password" : "email"}
        className="h-12 rounded-xl border border-edge bg-canvas px-4 text-[14px] text-ink outline-none transition-colors focus:border-[#8b5cff]/60 disabled:opacity-50"
      />
    </label>
  );
}

function StremioAvatar({ src, initial }: { src?: string; initial: string }) {
  const [failed, setFailed] = useState(false);
  const url = !failed ? src || "https://web.stremio.com/images/default_avatar.png" : null;
  if (url) {
    return (
      <img
        src={url}
        alt=""
        onError={() => setFailed(true)}
        className="h-10 w-10 rounded-full bg-canvas object-cover"
      />
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-[15px] font-medium text-canvas">
      {initial}
    </div>
  );
}
