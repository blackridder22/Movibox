export const FEEDBACK_ORIGIN = "https://tally.so";
export const FEEDBACK_FORM_ID = "Pdxdlx";

export type FeedbackContext = { appVersion: string; os: string };

export function feedbackUrl(context: FeedbackContext, embedded = false): string {
  const url = new URL(`/${embedded ? "embed" : "r"}/${FEEDBACK_FORM_ID}`, FEEDBACK_ORIGIN);
  url.searchParams.set("app_version", context.appVersion);
  url.searchParams.set("os", context.os);
  if (embedded) {
    url.searchParams.set("alignLeft", "1");
    url.searchParams.set("hideTitle", "1");
  }
  return url.href;
}

export function canEmbedFeedback(native: boolean, os: string): boolean {
  // Tauri cannot distinguish iframe IPC from the host on Linux and Android.
  // https://v2.tauri.app/security/capabilities/#remote-api-access
  return !native || os === "macos" || os === "windows";
}

export function feedbackEvent(
  event: { origin: string; source: unknown; data: unknown },
  frameWindow: unknown,
): "ready" | "submitted" | null {
  if (!frameWindow || event.origin !== FEEDBACK_ORIGIN || event.source !== frameWindow) return null;
  let data: unknown = event.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || !("event" in data) || !("payload" in data)) return null;
  const payload = data.payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    !("formId" in payload) ||
    payload.formId !== FEEDBACK_FORM_ID
  )
    return null;
  if (data.event === "Tally.FormLoaded" || data.event === "Tally.FormPageView") return "ready";
  if (
    data.event === "Tally.FormSubmitted" &&
    "id" in payload &&
    typeof payload.id === "string" &&
    payload.id
  )
    return "submitted";
  return null;
}
