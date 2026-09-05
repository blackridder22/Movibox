// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const entrySource = readFileSync(new URL("../src/legacy-main.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const homeSource = readFileSync(new URL("../src/views/home.tsx", import.meta.url), "utf8");
const loaderSource = readFileSync(
  new URL("../src/components/movibox-loader.tsx", import.meta.url),
  "utf8",
);
let startupLoaderSource = "";
try {
  startupLoaderSource = readFileSync(
    new URL("../src/components/startup-loader.tsx", import.meta.url),
    "utf8",
  );
} catch {}
const nativeSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

test("legacy startup keeps the app inert behind the existing loader until the first view is ready", () => {
  assert.match(indexSource, /<div id="root" inert data-startup-hidden><\/div>/);
  assert.match(indexSource, /#root\[data-startup-hidden\][\s\S]*?visibility:\s*hidden/);
  assert.doesNotMatch(indexSource, /<div id="movibox-boot">[\s\S]*?<svg/);
  assert.match(entrySource, /import \{ StartupLoader \}/);
  assert.match(startupLoaderSource, /createPortal\([\s\S]*?<MoviboxLoader[\s\S]*?onReady=/);
  assert.match(startupLoaderSource, /document\.getElementById\("movibox-boot"\)/);
  assert.match(entrySource, /<App onReady=/);
  assert.doesNotMatch(entrySource, /\);\n\nrequestAnimationFrame\(\(\) => \{[\s\S]*?harbor-boot/);
  assert.match(appSource, /<Home active=\{homeTop\} onReady=\{onReady\}/);
  assert.match(homeSource, /if \(!active \|\| !heroReady\) return;[\s\S]*?onReady\?\.\(\)/);
  assert.match(loaderSource, /onReady\?\.\(\)/);
  assert.match(loaderSource, /requestAnimationFrame\(\(\) => onReady\?\.\(\)\)/);
  assert.doesNotMatch(startupLoaderSource, /classList\.add\("gone"\)|setTimeout/);
});

test("legacy native focus is delayed until the single startup surface is removed", () => {
  const pageLoadHandler = nativeSource.match(
    /\.on_page_load\([\s\S]*?\r?\n\s*\}\)\r?\n\s*\.setup/,
  )?.[0];

  assert.ok(pageLoadHandler, "main page-load handler must exist");
  assert.match(pageLoadHandler, /window\(\)\.show\(\)/);
  assert.doesNotMatch(pageLoadHandler, /set_focus/);
  assert.match(nativeSource, /fn movibox_startup_ready[\s\S]*?window\.set_focus\(\)/);
  assert.match(
    entrySource,
    /setStartupVisible\(false\);[\s\S]*?removeAttribute\("data-startup-hidden"\)[\s\S]*?movibox_startup_ready/,
  );
});

test("download acquisition resumes before the MoviBox window becomes interactive", () => {
  assert.match(nativeSource, /acquisition::AcquisitionState::new/);
  assert.match(nativeSource, /acquisition::resume_pending/);
  assert.match(nativeSource, /moviebox::start/);
  assert.doesNotMatch(nativeSource, /mpv|player_overlay|make_main_transparent/);
});
