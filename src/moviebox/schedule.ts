import { validateCron } from "./model.ts";

export const scheduleFrequencies = [
  "Every 30 minutes",
  "Every hour",
  "Every 6 hours",
  "Every 12 hours",
  "Daily",
  "Weekly",
  "Monthly",
  "Advanced (cron)",
] as const;

export const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export type ScheduleValue = {
  frequency: string;
  cron: string;
  timezone: string;
  scheduleMode?: "manual" | "scheduled";
};
export type ScheduleDraft = {
  frequency: (typeof scheduleFrequencies)[number];
  time: string;
  weekday: number;
  monthDay: number;
  cron: string;
  timezone: string;
};

const intervals = [
  { label: "Every 30 minutes", frequency: "30 minutes", cron: "*/30 * * * *" },
  { label: "Every hour", frequency: "1 hour", cron: "0 * * * *" },
  { label: "Every 6 hours", frequency: "6 hours", cron: "0 */6 * * *" },
  { label: "Every 12 hours", frequency: "12 hours", cron: "0 */12 * * *" },
] as const;

export function createScheduleDraft(value: ScheduleValue): ScheduleDraft {
  const interval = intervals.find((item) => item.frequency === value.frequency);
  const draft: ScheduleDraft = {
    frequency: interval?.label ?? "Advanced (cron)",
    time: "09:00",
    weekday: 1,
    monthDay: 1,
    cron: interval?.cron ?? (value.frequency === "Daily" ? "0 0 * * *" : value.cron),
    timezone: value.timezone,
  };
  if (interval || !validateCron(draft.cron)) return draft;

  const [minute, hour, day, month, weekday] = draft.cron.trim().split(/\s+/);
  // Infer only simple calendar schedules; never simplify cron's combined day/week rules.
  if (!/^\d+$/.test(minute!) || !/^\d+$/.test(hour!) || month !== "*") return draft;
  draft.time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
  if (day === "*" && weekday === "*") draft.frequency = "Daily";
  else if (day === "*" && /^\d+$/.test(weekday!)) {
    draft.frequency = "Weekly";
    draft.weekday = Number(weekday) % 7;
  } else if (/^\d+$/.test(day!) && weekday === "*") {
    draft.frequency = "Monthly";
    draft.monthDay = Number(day);
  }
  return draft;
}

export function scheduleError(draft: ScheduleDraft): string | undefined {
  try {
    new Intl.DateTimeFormat("en", { timeZone: draft.timezone }).format();
  } catch {
    return "Choose a valid time zone.";
  }
  if (draft.frequency === "Advanced (cron)")
    return validateCron(draft.cron) ? undefined : "Enter a valid five-field cron expression.";
  if (["Daily", "Weekly", "Monthly"].includes(draft.frequency)) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return "Choose a check time.";
    if (
      draft.frequency === "Weekly" &&
      (!Number.isInteger(draft.weekday) || draft.weekday < 0 || draft.weekday > 6)
    )
      return "Choose a day of the week.";
    if (
      draft.frequency === "Monthly" &&
      (!Number.isInteger(draft.monthDay) || draft.monthDay < 1 || draft.monthDay > 31)
    )
      return "Choose a day from 1 to 31.";
  }
  return undefined;
}

export function serializeSchedule(draft: ScheduleDraft): ScheduleValue {
  const error = scheduleError(draft);
  if (error) throw new Error(error);
  const interval = intervals.find((item) => item.label === draft.frequency);
  if (interval)
    return { frequency: interval.frequency, cron: interval.cron, timezone: draft.timezone };
  let cron = draft.cron;
  if (draft.frequency !== "Advanced (cron)") {
    const [hour, minute] = draft.time.split(":").map(Number);
    const day = draft.frequency === "Monthly" ? draft.monthDay : "*";
    const weekday = draft.frequency === "Weekly" ? draft.weekday : "*";
    cron = `${minute} ${hour} ${day} * ${weekday}`;
  }
  return { frequency: "Custom schedule", cron, timezone: draft.timezone };
}

export function describeScheduleDraft(draft: ScheduleDraft): string {
  if (draft.frequency === "Daily") return `Every day at ${draft.time}`;
  if (draft.frequency === "Weekly") return `Every ${weekdays[draft.weekday]} at ${draft.time}`;
  if (draft.frequency === "Monthly") return `Day ${draft.monthDay} of every month at ${draft.time}`;
  return draft.frequency === "Advanced (cron)" ? "Advanced cron schedule" : draft.frequency;
}

export function describeSchedule(value: ScheduleValue): string {
  if (value.scheduleMode === "manual") return "Manual only";
  return describeScheduleDraft(createScheduleDraft(value));
}

export function saveRuleSchedule(value: ScheduleValue, draft: ScheduleDraft): ScheduleValue {
  return value.scheduleMode === "manual" ? value : { ...value, ...serializeSchedule(draft) };
}
