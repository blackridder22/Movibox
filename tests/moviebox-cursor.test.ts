/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCursorController, createCursorStyles } from "../src/moviebox/cursors.ts";
import { PreferenceWrites } from "../src/moviebox/preference-writes.ts";
import type { Preferences } from "../src/moviebox/types.ts";

const initial = { customCursor: false, theme: "System", accent: "#F08B64" } as Preferences;

test("rapid toggles use the latest choice before the native save completes", () => {
  const writes = new PreferenceWrites(initial);
  const first = writes.stage({ ...writes.read(), customCursor: true })!;
  assert.equal(writes.read().customCursor, true);
  const second = writes.stage({ ...writes.read(), customCursor: false })!;
  assert.equal(writes.read().customCursor, false);
  assert.deepEqual(first.patch, { customCursor: true });
  assert.deepEqual(second.patch, { customCursor: false });
  writes.settle(first, true);
  assert.equal(writes.read().customCursor, false);
  writes.settle(second, true);
  assert.equal(writes.read().customCursor, false);
});

test("a background snapshot cannot reverse a click or a completed save", () => {
  const writes = new PreferenceWrites(initial);
  const revision = writes.revision;
  const write = writes.stage({ ...writes.read(), customCursor: true })!;
  assert.equal(writes.receive(initial, revision).customCursor, true);
  const duringSave = writes.revision;
  writes.settle(write, true);
  assert.equal(writes.receive(initial, duringSave).customCursor, true);
  const restored = { ...initial, accent: "#83AFF0", customCursor: true };
  assert.deepEqual(writes.receive(restored, writes.revision), restored);
});

test("failed saves roll back only their own pending choice", () => {
  const writes = new PreferenceWrites(initial);
  const first = writes.stage({ ...writes.read(), customCursor: true })!;
  const second = writes.stage({ ...writes.read(), customCursor: false })!;
  const theme = writes.stage({ ...writes.read(), theme: "Dark" })!;
  writes.settle(first, true);
  writes.settle(second, false);
  assert.equal(writes.read().customCursor, true);
  assert.equal(writes.read().theme, "Dark");
  writes.settle(theme, false);
  assert.equal(writes.read().theme, "System");
  // A later error in the same native operation cannot roll back a successful preference save.
  writes.settle(first, false);
  assert.equal(writes.read().customCursor, true);
});

test("failed earlier writes do not erase newer choices for the same preference", () => {
  const writes = new PreferenceWrites(initial);
  const first = writes.stage({ ...writes.read(), theme: "Dark" })!;
  const second = writes.stage({ ...writes.read(), theme: "Light" })!;
  writes.settle(first, false);
  assert.equal(writes.read().theme, "Light");
  writes.settle(second, true);
  assert.equal(writes.read().theme, "Light");
  assert.equal(writes.stage(writes.read()), undefined);
});

test("connection preferences still wait for native confirmation", () => {
  const writes = new PreferenceWrites({ ...initial, provider: false });
  const write = writes.stage({ ...writes.read(), provider: true })!;
  assert.equal(writes.read().provider, false);
  writes.settle(write, true);
  assert.equal(writes.read().provider, true);
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function surface() {
  const properties = new Map<string, string>();
  const root = {
    dataset: { cursor: "system" },
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
  };
  return { root: root as unknown as HTMLElement, properties };
}

test("custom cursors activate together only after their images decode", async () => {
  const { root, properties } = surface();
  const load = deferred();
  const cursor = createCursorController(root, () => load.promise);
  const request = cursor.set(true, "light");
  assert.equal(root.dataset.cursor, "system");
  assert.equal(properties.size, 0);
  load.resolve();
  assert.equal(await request, true);
  assert.equal(root.dataset.cursor, "movibox");
  assert.deepEqual(Object.fromEntries(properties), createCursorStyles("light"));
  await cursor.set(false, "light");
  assert.equal(root.dataset.cursor, "system");
  assert.equal(properties.size, 0);
});

test("Off and unmount cancel unfinished cursor activation", async () => {
  for (const dispose of [false, true]) {
    const { root, properties } = surface();
    const load = deferred();
    const cursor = createCursorController(root, () => load.promise);
    const request = cursor.set(true, "dark");
    if (dispose) cursor.dispose();
    else await cursor.set(false, "dark");
    load.resolve();
    await request;
    assert.equal(root.dataset.cursor, "system");
    assert.equal(properties.size, 0);
  }
});

test("late theme loads cannot overwrite the newest theme", async () => {
  const { root, properties } = surface();
  const dark = deferred();
  const light = deferred();
  const cursor = createCursorController(root, (theme) =>
    theme === "dark" ? dark.promise : light.promise,
  );
  const first = cursor.set(true, "dark");
  const latest = cursor.set(true, "light");
  light.resolve();
  await latest;
  dark.resolve();
  await first;
  assert.deepEqual(Object.fromEntries(properties), createCursorStyles("light"));
});

test("decode failures leave a usable system cursor and allow a retry", async () => {
  const { root, properties } = surface();
  const load = deferred();
  let failed = true;
  const cursor = createCursorController(root, () => (failed ? load.promise : Promise.resolve()));
  const request = cursor.set(true, "dark");
  load.reject(new Error("decode failed"));
  assert.equal(await request, false);
  assert.equal(root.dataset.cursor, "system");
  assert.equal(properties.size, 0);
  failed = false;
  assert.equal(await cursor.set(true, "dark"), true);
  assert.equal(root.dataset.cursor, "movibox");
});

test("filled arrow and hand remain contrasting and keep the approved sizes and hotspots", () => {
  for (const theme of ["light", "dark"] as const) {
    const styles = createCursorStyles(theme);
    for (const [kind, hotspot] of [
      ["default", "2 2"],
      ["pointer", "7 1"],
      ["text", "8 8"],
    ]) {
      const value = styles[`--movibox-cursor-${kind}`]!;
      const svg = decodeURIComponent(value.match(/data:image\/svg\+xml,([^"]+)/)![1]!);
      assert.ok(value.endsWith(`${hotspot}, ${kind}`));
      assert.ok(svg.includes(`width="${kind === "text" ? 16 : 18}"`));
      assert.ok(
        svg.includes(
          `${kind === "text" ? "stroke" : "fill"}="${theme === "light" ? "#17181a" : "#ffffff"}"`,
        ),
      );
    }
  }
});
