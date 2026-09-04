// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

const sourceSelection = readFileSync(
  new URL("../src/lib/acquisition/source-selection.ts", import.meta.url),
  "utf8",
);
const automationRunner = readFileSync(
  new URL("../src/lib/acquisition/automation-runner.tsx", import.meta.url),
  "utf8",
);
const seriesPanel = readFileSync(
  new URL("../src/views/detail/series-download-panel.tsx", import.meta.url),
  "utf8",
);
const nativeQueue = readFileSync(
  new URL("../src-tauri/src/acquisition.rs", import.meta.url),
  "utf8",
);
const acquisitionPreferences = readFileSync(
  new URL("../src/components/acquisition-preferences.tsx", import.meta.url),
  "utf8",
);

test("automatic acquisition fails closed for requested audio, quality, and subtitles", () => {
  assert.match(sourceSelection, /filterStreamsForAudio\(pipeline\.picker\.all/);
  assert.match(sourceSelection, /No source explicitly identifies/);
  assert.match(sourceSelection, /qualityProfile !== "best" && qualitySafe\.length === 0/);
  assert.match(sourceSelection, /No .* subtitle was found\. Nothing was queued/);
});

test("unwatched monitoring includes Stremio watched state and explicit episode selection", () => {
  assert.match(automationRunner, /libraryGetOne\(authKey, rule\.metaId\)/);
  assert.match(automationRunner, /decodeWatchedEpisodes/);
  assert.match(seriesPanel, /"unwatched".*"Only unwatched"/s);
  assert.match(seriesPanel, /"manual".*"Pick manually"/s);
  assert.match(seriesPanel, /episodes: picked/);
  assert.match(seriesPanel, /runAutomationRule\(rule\)/);
  assert.match(seriesPanel, /Start downloads now/);
});

test("native queue supports scheduled and global paused downloads", () => {
  assert.match(nativeQueue, /"scheduled"\.to_string\(\)/);
  assert.match(nativeQueue, /pub fn acquisition_pause_all/);
  assert.match(nativeQueue, /"queued" \| "scheduled" \| "downloading"/);
  assert.match(nativeQueue, /fn worker_can_update/);
  assert.match(nativeQueue, /"paused" \| "canceled" \| "canceling" \| "done"/);
});

test("downloads start now by default and expose scheduling as an explicit choice", () => {
  assert.match(acquisitionPreferences, /aria-pressed={!scheduledFor}/);
  assert.match(acquisitionPreferences, /> Download now/);
  assert.match(acquisitionPreferences, /> Download later/);
  assert.match(acquisitionPreferences, /{scheduledFor && \(/);
});
