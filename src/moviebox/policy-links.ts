export type PolicyId = "privacy" | "use" | "license" | "third-party";

const policyFiles: Record<string, PolicyId> = {
  "PRIVACY.md": "privacy",
  "USE_NOTICE.md": "use",
  LICENSE: "license",
  "THIRD_PARTY_NOTICES.md": "third-party",
};

export function policyLink(href: string): { document: PolicyId } | { url: string } | null {
  const file = href.replace(/^\.\//, "");
  if (Object.hasOwn(policyFiles, file)) return { document: policyFiles[file] };
  try {
    const url = new URL(href);
    if (url.protocol === "https:" && !url.username && !url.password) return { url: url.href };
    if (
      url.protocol === "mailto:" &&
      url.pathname === "br22.dev@gmail.com" &&
      !url.search &&
      !url.hash
    )
      return { url: url.href };
  } catch {
    // Unknown relative links must not replace the app's document or route.
  }
  return null;
}
