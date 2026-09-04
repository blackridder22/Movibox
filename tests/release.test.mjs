import test from "node:test";
import assert from "node:assert/strict";
import { releaseConfig, manifest } from "../scripts/release.mjs";

const key = Buffer.from("untrusted comment: test\n" + Buffer.alloc(42).toString("base64")).toString(
  "base64",
);
const env = {
  MOVIBOX_UPDATE_ENDPOINT: "https://updates.example/latest.json",
  MOVIBOX_UPDATE_PUBLIC_KEY: key,
  TAURI_SIGNING_PRIVATE_KEY: "test-only",
};
test("release preflight refuses incomplete or insecure distribution configuration", () => {
  assert.equal(releaseConfig("local", "darwin", {}).bundle.createUpdaterArtifacts, false);
  assert.throws(() => releaseConfig("signed", "linux", {}), /Missing/);
  assert.throws(
    () =>
      releaseConfig("signed", "linux", {
        ...env,
        MOVIBOX_UPDATE_ENDPOINT: "http://updates.example",
      }),
    /HTTPS/,
  );
  assert.throws(
    () => releaseConfig("signed", "linux", { ...env, MOVIBOX_UPDATE_PUBLIC_KEY: "invalid" }),
    /public|pub/i,
  );
  assert.throws(() => releaseConfig("signed", "darwin", env), /APPLE_SIGNING_IDENTITY/);
  assert.throws(
    () => releaseConfig("signed", "darwin", { ...env, APPLE_SIGNING_IDENTITY: "-" }),
    /Developer ID/,
  );
  assert.throws(
    () =>
      releaseConfig("signed", "darwin", {
        ...env,
        APPLE_SIGNING_IDENTITY: "Developer ID Application: Test",
      }),
    /notarization/,
  );
  assert.equal(releaseConfig("signed", "linux", env).bundle.createUpdaterArtifacts, true);
});
test("feed generation requires a detached signature, correct artifact and unique platforms", () => {
  const read = (path) =>
    path.endsWith(".sig")
      ? Buffer.from("untrusted comment: fixture\ntest").toString("base64")
      : Buffer.from("owned artifact");
  assert.throws(() => manifest("0.9.22", "http://updates.example", [], read), /HTTPS/);
  assert.throws(
    () => manifest("0.9.22", "https://updates.example", [["darwin-aarch64", "MoviBox.dmg"]], read),
    /artifact/,
  );
  assert.throws(
    () =>
      manifest(
        "0.9.22",
        "https://updates.example",
        [["darwin-aarch64", "MoviBox.app.tar.gz"]],
        () => "",
      ),
    /signature/,
  );
  assert.throws(
    () =>
      manifest(
        "0.9.22",
        "https://updates.example",
        [
          ["linux-x86_64", "a.AppImage"],
          ["linux-x86_64", "b.AppImage"],
        ],
        read,
      ),
    /duplicate/,
  );
  const result = manifest(
    "0.9.22",
    "https://updates.example/v0.9.22/",
    [["darwin-aarch64", "MoviBox arm.app.tar.gz"]],
    read,
  );
  assert.equal(
    result.feed.platforms["darwin-aarch64"].url,
    "https://updates.example/v0.9.22/MoviBox%20arm.app.tar.gz",
  );
  assert.match(result.checksums, /^[a-f0-9]{64}  MoviBox arm.app.tar.gz\n$/);
});
