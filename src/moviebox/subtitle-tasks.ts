import type { SubtitleTask } from "./types.ts";

export function subtitleActions(task: SubtitleTask, now = Date.now()) {
  const active = ["queued", "running"].includes(task.state);
  const done = task.state === "done" || task.state === "canceled";
  const cooldown = Math.max(
    task.quotaUntil ?? 0,
    ["quota", "rate_limited"].includes(task.reason ?? "") ? task.nextCheckAt : 0,
  );
  return {
    retry: !active && !done && cooldown <= now,
    import: !active && !done && task.reason !== "file_missing",
    cooldown: cooldown > now ? cooldown : undefined,
    settings: [
      "not_configured",
      "authentication",
      "no_safe_match",
      "provider_unavailable",
    ].includes(task.reason ?? ""),
    library: task.reason === "file_missing" || task.reason === "file_unavailable",
  };
}

export function selectSubtitleTasks(
  tasks: SubtitleTask[],
  target?: string | null,
  id?: string | null,
) {
  if (!id) return tasks;
  return tasks.filter((task) =>
    target === "bundle"
      ? task.bundleId === id
      : target === "rule"
        ? task.ruleId === id
        : task.jobId === id,
  );
}

export function subtitleProgress(tasks: SubtitleTask[]) {
  return tasks.reduce(
    (counts, task) => {
      if (task.state === "done") counts.ready++;
      else if (["queued", "running", "retrying"].includes(task.state)) counts.pending++;
      else if (task.state === "needs_attention") counts.attention++;
      return counts;
    },
    { ready: 0, pending: 0, attention: 0 },
  );
}
