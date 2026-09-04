/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createScheduleDraft,
  describeSchedule,
  scheduleError,
  serializeSchedule,
} from "../src/moviebox/schedule.ts";

const base = { frequency: "6 hours", cron: "0 */6 * * *", timezone: "America/Anchorage" };

test("editing legacy intervals and daily rules preserves their schedule", () => {
  for (const frequency of ["30 minutes", "1 hour", "6 hours", "12 hours"]) {
    const value = { ...base, frequency };
    const saved = serializeSchedule(createScheduleDraft(value));
    assert.equal(saved.frequency, frequency);
    assert.equal(saved.timezone, base.timezone);
  }
  const daily = createScheduleDraft({ ...base, frequency: "Daily" });
  assert.equal(daily.time, "00:00");
  assert.equal(serializeSchedule(daily).cron, "0 0 * * *");
});

test("weekly choices save the selected local time and reopen without cron knowledge", () => {
  const draft = {
    ...createScheduleDraft(base),
    frequency: "Weekly" as const,
    time: "18:30",
    weekday: 2,
    timezone: "Europe/Paris",
  };
  const saved = serializeSchedule(draft);
  assert.deepEqual(saved, {
    frequency: "Custom schedule",
    cron: "30 18 * * 2",
    timezone: "Europe/Paris",
  });
  const reopened = createScheduleDraft(saved);
  assert.equal(reopened.frequency, "Weekly");
  assert.equal(reopened.weekday, 2);
  assert.equal(reopened.time, "18:30");
  assert.equal(describeSchedule(saved), "Every Tuesday at 18:30");
});

test("monthly choices use a calendar date, not a fixed 30-day interval", () => {
  const draft = {
    ...createScheduleDraft(base),
    frequency: "Monthly" as const,
    time: "09:15",
    monthDay: 31,
  };
  const saved = serializeSchedule(draft);
  assert.equal(saved.cron, "15 9 31 * *");
  const reopened = createScheduleDraft(saved);
  assert.equal(reopened.frequency, "Monthly");
  assert.equal(reopened.monthDay, 31);
  assert.equal(reopened.time, "09:15");
});

test("complex existing cron schedules remain advanced and are not silently simplified", () => {
  for (const cron of ["0 8 1 * 1", "15 8 * * 1-5", "0,30 9-17 * * *", "0 9 1 1 *"]) {
    const saved = { ...base, frequency: "Custom schedule", cron };
    const draft = createScheduleDraft(saved);
    assert.equal(draft.frequency, "Advanced (cron)");
    assert.deepEqual(serializeSchedule(draft), saved);
  }
});

test("both supported Sunday representations reopen as Sunday", () => {
  for (const weekday of [0, 7]) {
    const draft = createScheduleDraft({
      ...base,
      frequency: "Custom schedule",
      cron: `0 9 * * ${weekday}`,
    });
    assert.equal(draft.frequency, "Weekly");
    assert.equal(draft.weekday, 0);
    assert.equal(serializeSchedule(draft).cron, "0 9 * * 0");
  }
});

test("invalid local times, calendar dates and time zones cannot be saved", () => {
  const daily = { ...createScheduleDraft(base), frequency: "Daily" as const };
  for (const time of ["", "24:00", "09:60"])
    assert.throws(() => serializeSchedule({ ...daily, time }));
  assert.ok(scheduleError({ ...daily, timezone: "Not/A_Timezone" }));
  assert.throws(() => serializeSchedule({ ...daily, frequency: "Monthly", monthDay: 32 }));
  assert.throws(() => serializeSchedule({ ...daily, frequency: "Weekly", weekday: -1 }));
  assert.throws(() => serializeSchedule({ ...daily, frequency: "Advanced (cron)", cron: "bad" }));
});

test("manual rules keep their saved schedule without requiring cron or becoming scheduled", async () => {
  const { saveRuleSchedule } = await import("../src/moviebox/schedule.ts");
  const value = { ...base, scheduleMode: "manual" as const };
  const invalid = {
    ...createScheduleDraft(base),
    frequency: "Advanced (cron)" as const,
    cron: "invalid",
  };
  assert.deepEqual(saveRuleSchedule(value, invalid), value);
  assert.equal(describeSchedule(value), "Manual only");
  assert.throws(() => saveRuleSchedule({ ...value, scheduleMode: "scheduled" }, invalid));
  assert.deepEqual(saveRuleSchedule(base, createScheduleDraft(base)), base);
});
