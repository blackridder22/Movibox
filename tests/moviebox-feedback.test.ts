/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { canEmbedFeedback, feedbackEvent, feedbackUrl } from "../src/moviebox/feedback-config.ts";

test("feedback URLs contain only explicit app context, even when extra sensitive properties are supplied", () => {
  const context = {
    appVersion: "0.9.22 & beta",
    os: "macos",
    apiKey: "do-not-send",
    downloadUrl: "https://private.example/movie",
  };
  const publicUrl = new URL(feedbackUrl(context));
  assert.equal(publicUrl.origin, "https://tally.so");
  assert.equal(publicUrl.pathname, "/r/Pdxdlx");
  assert.deepEqual(
    [...publicUrl.searchParams],
    [
      ["app_version", "0.9.22 & beta"],
      ["os", "macos"],
    ],
  );
  const embedded = new URL(feedbackUrl(context, true));
  assert.equal(embedded.pathname, "/embed/Pdxdlx");
  assert.deepEqual(
    [...embedded.searchParams.keys()],
    ["app_version", "os", "alignLeft", "hideTitle"],
  );
  assert.ok(!embedded.href.includes("do-not-send"));
});

test("native platforms without reliable iframe isolation use the browser fallback", () => {
  for (const os of ["linux", "android", "ios", "unknown", ""])
    assert.equal(canEmbedFeedback(true, os), false);
  for (const os of ["macos", "windows"]) assert.equal(canEmbedFeedback(true, os), true);
  assert.equal(canEmbedFeedback(false, "browser-preview"), true);
});

test("only lifecycle events from this form's actual frame can change the feedback UI", () => {
  const frame = {};
  const message = (data: unknown, source: unknown = frame, origin = "https://tally.so") => ({
    data,
    source,
    origin,
  });
  const submitted = {
    event: "Tally.FormSubmitted",
    payload: { formId: "Pdxdlx", id: "test-submission", fields: [{ answer: "private feedback" }] },
  };
  assert.equal(feedbackEvent(message(JSON.stringify(submitted)), frame), "submitted");
  assert.equal(feedbackEvent(message(submitted), frame), "submitted");
  assert.equal(
    feedbackEvent(message(submitted, frame, "https://tally.so.attacker.example"), frame),
    null,
  );
  assert.equal(feedbackEvent(message(submitted, {}), frame), null);
  assert.equal(feedbackEvent(message(submitted, null), null), null);
  assert.equal(
    feedbackEvent(
      message({ ...submitted, payload: { formId: "another-form", id: "test" } }),
      frame,
    ),
    null,
  );
  assert.equal(
    feedbackEvent(message({ ...submitted, payload: { formId: "Pdxdlx" } }), frame),
    null,
  );
  for (const event of ["Tally.FormLoaded", "Tally.FormPageView"]) {
    assert.equal(feedbackEvent(message({ event, payload: { formId: "Pdxdlx" } }), frame), "ready");
  }
  for (const data of [
    null,
    4,
    [],
    "invalid JSON",
    { event: "Tally.FormSubmitted", payload: null },
    { event: "load", payload: { formId: "Pdxdlx" } },
  ]) {
    assert.equal(feedbackEvent(message(data), frame), null);
  }
});
