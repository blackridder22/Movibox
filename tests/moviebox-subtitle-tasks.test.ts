/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectSubtitleTasks,
  subtitleProgress,
  subtitleActions,
} from "../src/moviebox/subtitle-tasks.ts";

test("subtitle progress and deep links retain completed and hidden download tasks", () => {
  const tasks = ["done", "running", "retrying", "needs_attention", "canceled"].map((state, i) => ({
    id: `${i}:fr`,
    jobId: String(i),
    bundleId: i < 3 ? "season" : "other",
    language: "fr",
    message: "Fixture",
    state,
    nextCheckAt: 0,
  }));
  assert.deepEqual(subtitleProgress(tasks), { ready: 1, pending: 2, attention: 1 });
  assert.equal(selectSubtitleTasks(tasks, "bundle", "season").length, 3);
  assert.equal(selectSubtitleTasks(tasks, "library", "0")[0]?.state, "done");
  assert.deepEqual(selectSubtitleTasks(tasks, "job", "missing"), []);
  assert.equal(selectSubtitleTasks(tasks), tasks);
});

test("subtitle actions respect active tasks and provider cooldowns", () => {
  const task = {
    id: "1:fr",
    language: "fr",
    state: "needs_attention",
    message: "",
    nextCheckAt: 2000,
  };
  assert.equal(subtitleActions({ ...task, reason: "quota" }, 1000).retry, false);
  assert.equal(subtitleActions({ ...task, reason: "rate_limited" }, 1000).cooldown, 2000);
  assert.equal(subtitleActions({ ...task, reason: "quota" }, 3000).retry, true);
  assert.equal(subtitleActions({ ...task, state: "running" }).import, false);
  assert.equal(subtitleActions({ ...task, state: "done" }).retry, false);
  assert.equal(subtitleActions({ ...task, reason: "authentication" }).settings, true);
  assert.equal(subtitleActions({ ...task, reason: "file_missing" }).library, true);
});
