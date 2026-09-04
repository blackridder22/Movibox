import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requireValue(env, key) {
  if (!env[key]?.trim()) throw new Error(`Missing release prerequisite: ${key}`);
  return env[key].trim();
}
function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Release URLs must use HTTPS without credentials or fragments");
  }
  return url;
}
export function releaseConfig(mode, platform, env) {
  if (!["local", "signed"].includes(mode)) throw new Error("Choose local or signed release mode");
  const config = { bundle: { createUpdaterArtifacts: false } };
  if (mode === "local") {
    if (platform === "darwin") config.bundle.macOS = { signingIdentity: "-" };
    return config;
  }
  httpsUrl(requireValue(env, "MOVIBOX_UPDATE_ENDPOINT"));
  const pubkey = requireValue(env, "MOVIBOX_UPDATE_PUBLIC_KEY");
  const decoded = Buffer.from(pubkey, "base64").toString("utf8").trim().split(/\r?\n/);
  if (
    decoded.length !== 2 ||
    !decoded[0].startsWith("untrusted comment:") ||
    Buffer.from(decoded[1], "base64").length !== 42
  ) {
    throw new Error(
      "MOVIBOX_UPDATE_PUBLIC_KEY must be the base64 encoded Tauri .pub file contents",
    );
  }
  requireValue(env, "TAURI_SIGNING_PRIVATE_KEY");
  config.bundle.createUpdaterArtifacts = true;
  config.plugins = { updater: { pubkey } };
  if (platform === "darwin") {
    const identity = requireValue(env, "APPLE_SIGNING_IDENTITY");
    if (!identity.startsWith("Developer ID Application:"))
      throw new Error("Distribution requires a Developer ID Application identity");
    const appleId = env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID;
    const apiKey = env.APPLE_API_ISSUER && env.APPLE_API_KEY && env.APPLE_API_KEY_PATH;
    if (!appleId && !apiKey)
      throw new Error("Apple notarization credentials are required for a signed macOS release");
    config.bundle.macOS = { signingIdentity: identity, hardenedRuntime: true };
  }
  return config;
}
export function manifest(version, baseUrl, entries, read = readFileSync) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Invalid release version");
  const root = httpsUrl(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  const platforms = {};
  const sums = [];
  const names = new Set();
  for (const [platform, path] of entries) {
    if (!/^(darwin|linux|windows)-(aarch64|x86_64)$/.test(platform) || platforms[platform])
      throw new Error("Invalid or duplicate updater platform");
    const name = basename(path);
    if (names.has(name)) throw new Error("Updater filenames must be unique across platforms");
    names.add(name);
    const extension = platform.startsWith("darwin")
      ? /\.app\.tar\.gz$/
      : platform.startsWith("linux")
        ? /\.AppImage$/
        : /\.(exe|msi)$/;
    if (!extension.test(name)) throw new Error("Wrong updater artifact type for platform");
    const signature = read(path + ".sig", "utf8").trim();
    if (
      !signature ||
      !Buffer.from(signature, "base64").toString("utf8").startsWith("untrusted comment:")
    )
      throw new Error("Missing or invalid updater signature");
    const bytes = read(path);
    sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    platforms[platform] = { signature, url: new URL(encodeURIComponent(name), root).href };
  }
  if (!entries.length) throw new Error("At least one signed artifact is required");
  return {
    feed: { version, pub_date: new Date().toISOString(), platforms },
    checksums: sums.join("\n") + "\n",
  };
}
function main(args) {
  if (args[0] === "config") {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf8").match(
      /^version\s*=\s*"([^"]+)"/m,
    )?.[1];
    if (pkg.version !== tauri.version || pkg.version !== cargo)
      throw new Error("Package, Tauri and Cargo versions must match");
    const config = releaseConfig(args[1], process.platform, process.env);
    const output = "src-tauri/tauri.release.generated.json";
    writeFileSync(output, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    console.log(`Release preflight passed (${args[1]}); wrote ${output}`);
  } else if (args[0] === "manifest") {
    const [, version, baseUrl, output, ...paths] = args;
    if (!output)
      throw new Error(
        "Usage: release.mjs manifest VERSION HTTPS_BASE_URL OUTPUT_DIR PLATFORM=ARTIFACT ...",
      );
    const entries = paths.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) throw new Error("Expected PLATFORM=ARTIFACT");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    });
    const { feed, checksums } = manifest(version, baseUrl, entries);
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, "latest.json"), JSON.stringify(feed, null, 2) + "\n");
    writeFileSync(resolve(output, "SHA256SUMS"), checksums);
    console.log("Wrote signed-artifact update feed and checksums. Nothing was published.");
  } else throw new Error("Usage: release.mjs config local|signed, or release.mjs manifest …");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
