import { useMemo, useState } from "react";
import { upcomingChecks } from "./model";
import {
  createScheduleDraft,
  describeScheduleDraft,
  scheduleError,
  scheduleFrequencies,
  serializeSchedule,
  weekdays,
  type ScheduleDraft,
  type ScheduleValue,
} from "./schedule";
import { Banner, Button, Choice, Field, Input, Modal } from "./ui";

export function ScheduleEditor({
  value,
  onChange,
}: {
  value: ScheduleDraft;
  onChange: (value: ScheduleDraft) => void;
}) {
  const error = scheduleError(value);
  const advanced = value.frequency === "Advanced (cron)";
  const calendar = ["Daily", "Weekly", "Monthly"].includes(value.frequency);
  const upcoming = useMemo(
    () => (advanced && !error ? upcomingChecks(value.cron, value.timezone) : []),
    [advanced, error, value.cron, value.timezone],
  );
  const change = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <div className="field-pair">
        <Field label="Check frequency">
          <Choice
            label="Check frequency"
            value={value.frequency}
            options={[...scheduleFrequencies]}
            onChange={(frequency) =>
              change({
                frequency: frequency as ScheduleDraft["frequency"],
                cron:
                  frequency === "Advanced (cron)" && !error
                    ? serializeSchedule(value).cron
                    : value.cron,
              })
            }
          />
        </Field>
        <Field label="Time zone">
          <Choice
            label="Schedule timezone"
            value={value.timezone}
            options={[
              ...new Set([
                value.timezone,
                new Intl.DateTimeFormat().resolvedOptions().timeZone,
                "America/Anchorage",
                "America/New_York",
                "America/Los_Angeles",
                "Europe/London",
                "Europe/Paris",
                "UTC",
              ]),
            ]}
            onChange={(timezone) => change({ timezone })}
          />
        </Field>
      </div>
      {calendar && (
        <div className={value.frequency === "Daily" ? undefined : "field-pair"}>
          {value.frequency === "Weekly" && (
            <Field label="Day of week">
              <Choice
                label="Day of week"
                value={weekdays[value.weekday]!}
                options={[...weekdays.slice(1), weekdays[0]!]}
                onChange={(day) => change({ weekday: weekdays.indexOf(day) })}
              />
            </Field>
          )}
          {value.frequency === "Monthly" && (
            <Field label="Day of month">
              <Choice
                label="Day of month"
                value={String(value.monthDay)}
                options={Array.from({ length: 31 }, (_, i) => String(i + 1))}
                onChange={(day) => change({ monthDay: Number(day) })}
              />
            </Field>
          )}
          <Field label="Check time">
            <Input
              type="time"
              aria-label="Check time"
              value={value.time}
              onInput={(event) => change({ time: event.currentTarget.value })}
            />
          </Field>
        </div>
      )}
      {advanced && (
        <Field label="Cron expression" hint="minute · hour · day of month · month · day of week">
          <Input
            aria-label="Cron expression"
            value={value.cron}
            aria-invalid={Boolean(error)}
            onChange={(event) => change({ cron: event.target.value })}
          />
        </Field>
      )}
      {error ? (
        <small role="alert" className="error">
          {error}
        </small>
      ) : (
        <small>
          {describeScheduleDraft(value)} · {value.timezone}
        </small>
      )}
      {value.frequency === "Monthly" && value.monthDay > 28 && (
        <small className="warning">
          Months without day {value.monthDay} are skipped. Choose 1–28 to check every month.
        </small>
      )}
      {advanced && !error && (
        <div className="stack" style={{ gap: 8 }}>
          <strong>Next checks · {value.timezone}</strong>
          {upcoming.map((time) => (
            <small key={time}>{time}</small>
          ))}
          {!upcoming.length && (
            <small className="warning">No check occurs in the next 32 days.</small>
          )}
        </div>
      )}
    </div>
  );
}

export function ScheduleModal({
  value,
  onSave,
  onClose,
}: {
  value: ScheduleValue;
  onSave: (schedule: ScheduleValue) => Promise<void> | void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => createScheduleDraft(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(serializeSchedule(draft));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Default monitoring schedule"
      description="Choose when new rules check for sources. Existing rules keep their schedules."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={saving}
            disabled={Boolean(scheduleError(draft))}
            onClick={save}
          >
            Use schedule
          </Button>
        </>
      }
    >
      <ScheduleEditor value={draft} onChange={setDraft} />
      {error && (
        <Banner tone="error" title="Could not save schedule">
          {error}
        </Banner>
      )}
      <small>
        Times follow the selected time zone, including daylight-saving changes. The time zone also
        applies to download windows.
      </small>
    </Modal>
  );
}
