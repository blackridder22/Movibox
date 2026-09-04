/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDemoState,
  enqueue,
  changeJob,
  saveRule,
  validateCron,
  upcomingChecks,
} from "../src/moviebox/model.ts";
const request = {
  mediaId: "her",
  quality: "1080p · Blu-ray · English",
  size: 8.4,
  destination: "Movies",
  episodes: [],
  season: 1,
};
test("repeated submissions reconcile with the queue instead of creating another job", () => {
  const first = enqueue(createDemoState(), request);
  assert.equal(first.added, true);
  const second = enqueue(first.state, request);
  assert.equal(second.added, false);
  assert.equal(second.state.jobs.length, first.state.jobs.length);
});
test("partial episode overlaps skip both local files and all existing jobs", () => {
  const state = createDemoState();
  const result = enqueue(state, {
    ...request,
    mediaId: "severance",
    episodes: [1, 2, 3, 4, 10, 10],
    quality: "1080p · WEB-DL · English",
  });
  assert.equal(result.added, true);
  assert.deepEqual(result.state.jobs.at(-1)?.episodes, [10]);
  assert.equal(state.jobs.length, 6);
});
test("turning off local duplicate checks does not disable submission idempotency", () => {
  const state = createDemoState();
  state.preferences.duplicates = false;
  const first = enqueue(state, request);
  assert.equal(enqueue(first.state, request).added, false);
});
test("already downloaded movie quality does not queue a duplicate", () => {
  const result = enqueue(createDemoState(), {
    ...request,
    mediaId: "interstellar",
    quality: "4K · WEB-DL · English",
  });
  assert.equal(result.added, false);
});
test("provider, network, storage and source recovery block submission before state changes", () => {
  for (const scenario of ["provider-error", "offline", "storage-error", "no-source"] as const) {
    const state = createDemoState();
    state.scenario = scenario;
    const result = enqueue(state, request);
    assert.equal(result.added, false);
    assert.equal(result.state, state);
  }
  const state = createDemoState();
  state.preferences.addons = [];
  assert.equal(enqueue(state, request).added, false);
});
test("preparation and transfer-window waiting are separate states", () => {
  const state = createDemoState();
  state.preferences.transferWindow = "Overnight · 00:00–07:00";
  assert.equal(enqueue(state, request).state.jobs.at(-1)?.status, "scheduled");
  assert.equal(
    enqueue(state, { ...request, uncached: true }).state.jobs.at(-1)?.status,
    "preparing",
  );
});
test("pause preserves partial progress and resumes without replacing the job", () => {
  const state = createDemoState();
  const id = state.jobs[0]!.id;
  const paused = changeJob(state, id, "paused");
  assert.equal(paused.jobs[0]!.progress, 68);
  assert.equal(paused.jobs[0]!.speed, 0);
  assert.equal(changeJob(paused, id, "active").jobs[0]!.id, id);
});
test("editing a rule does not alter jobs or library and preserves rule identity", () => {
  const state = createDemoState();
  const rule = { ...state.rules[0]!, quality: "1080p", status: "paused" as const };
  const changed = saveRule(state, rule);
  assert.equal(changed.rules.length, state.rules.length);
  assert.equal(changed.jobs, state.jobs);
  assert.equal(changed.library, state.library);
  assert.equal(changed.rules[0]!.quality, "1080p");
});
test("cron rejects out-of-range fields, reverse ranges, zero steps and wrong field counts", () => {
  for (const value of [
    "90 * * * *",
    "* 24 * * *",
    "0 0 0 * *",
    "0 0 * 13 *",
    "0 0 * * 8",
    "*/0 * * * *",
    "5-2 * * * *",
    "0 0 * *",
  ]) {
    assert.equal(validateCron(value), false, value);
  }
  for (const value of ["0 */6 * * *", "15 8 * * 1-5", "0,30 9-17 * * *"]) {
    assert.equal(validateCron(value), true, value);
  }
});
test("schedule preview computes future local times across a timezone boundary", () => {
  const times = upcomingChecks(
    "0 */6 * * *",
    "America/Anchorage",
    new Date("2026-08-30T03:01:00Z"),
  );
  assert.equal(times.length, 3);
  assert.match(times[0]!, /Aug 30, 2026.*12:00 AM/);
  assert.match(times[1]!, /6:00 AM/);
});
test("empty series selection is never treated as a movie download", () => {
  const result = enqueue(createDemoState(), { ...request, mediaId: "severance" });
  assert.equal(result.added, false);
});
