import { useMemo, useState } from "react";
import { native } from "./backend";
import { type SubtitleTask } from "./types";
import { notify, runBackend, useDemo } from "./store";
import { navigate, routeParam, useRoute } from "./routing";
import { selectSubtitleTasks, subtitleProgress, subtitleActions } from "./subtitle-tasks";
import { ActionGroup, Banner, Button, Drawer, Empty } from "./ui";

export function viewSubtitleTasks(target?: string, id?: string) {
  navigate("downloads", "subtitles", target && id ? { target, id } : undefined);
}

export function SubtitleActivity() {
  const { subtitleTasks = [] } = useDemo();
  const route = useRoute();
  const [limit, setLimit] = useState(50);
  const target = routeParam("target");
  const id = routeParam("id");
  const tasks = useMemo(
    () => selectSubtitleTasks(subtitleTasks, target, id),
    [subtitleTasks, target, id],
  );
  return (
    <>
      {route.detail === "subtitles" && (
        <Drawer inspector title="Subtitle tasks" onClose={() => navigate("downloads")}>
          <div className="drawer-content">
            <p className="muted">
              Searches continue when you leave this view. Keep Movie Box running; unfinished tasks
              resume when you reopen it.
            </p>
            {id && (
              <ActionGroup>
                <Button onClick={() => viewSubtitleTasks()}>View all subtitle tasks</Button>
              </ActionGroup>
            )}
            <div className="stack">
              {!tasks.length && (
                <Empty
                  title="No subtitle tasks"
                  description="Choose Find subtitles on a downloaded video or season to start a search."
                />
              )}
              {tasks.slice(0, limit).map((task) => (
                <SubtitleTaskRow key={task.id} task={task} />
              ))}
              {tasks.length > limit && (
                <Button onClick={() => setLimit((value) => value + 50)}>Show more tasks</Button>
              )}
            </div>
          </div>
        </Drawer>
      )}
    </>
  );
}

export function SubtitleOverview() {
  const { subtitleTasks = [] } = useDemo();
  const counts = useMemo(() => subtitleProgress(subtitleTasks), [subtitleTasks]);
  return (
    <>
      {subtitleTasks.length > 0 && (
        <Banner title="Subtitles">
          <p role="status">
            {counts.ready} ready · {counts.pending} in progress · {counts.attention} need attention
          </p>
          <Button onClick={() => viewSubtitleTasks()}>View subtitle tasks</Button>
        </Banner>
      )}
    </>
  );
}

function SubtitleTaskRow({ task }: { task: SubtitleTask }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actions = subtitleActions(task);
  const perform = async (action: "retry" | "import") => {
    setBusy(true);
    setError("");
    try {
      let path: string | undefined;
      if (action === "import") {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const chosen = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "Subtitles", extensions: ["srt", "vtt", "ass"] }],
        });
        if (typeof chosen !== "string") return;
        path = chosen;
      }
      await runBackend(`subtitles.${action}`, { id: task.id, path });
      notify(
        action === "retry"
          ? "Subtitle retry queued in the background."
          : "Subtitle imported. Check its timing in your player.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      title={`${task.label ?? "Downloaded video"}${task.episodes?.length ? ` · S${task.season ?? 1} E${task.episodes.join(", ")}` : ""} · ${task.language.toUpperCase()}`}
      tone={task.state === "done" ? "success" : "warning"}
    >
      <strong>
        {{
          done: "Available",
          queued: "Queued",
          running: "Searching",
          retrying: "Retry scheduled",
          needs_attention: "Needs your attention",
          canceled: "Canceled",
        }[task.state] ?? task.state}
      </strong>
      <p>{task.message}</p>
      {(actions.cooldown || task.state === "retrying") && (
        <p className="muted">
          {actions.cooldown ? "Provider cooldown until" : "Next attempt"}:{" "}
          {new Date(actions.cooldown ?? task.nextCheckAt).toLocaleString()}
        </p>
      )}
      {task.state === "needs_attention" && !task.reason && (
        <p className="muted">
          This older task has no detailed reason. Retry to get an updated diagnosis, or choose a
          subtitle file.
        </p>
      )}
      {task.state !== "done" && (
        <ActionGroup align="start">
          {!["queued", "running"].includes(task.state) && (
            <Button
              disabled={!native || busy || !actions.retry}
              busy={busy}
              onClick={() => void perform("retry")}
            >
              Retry search
            </Button>
          )}
          {actions.settings && (
            <Button
              onClick={() =>
                navigate(
                  "settings",
                  task.reason === "provider_unavailable" ? "Sources & add-ons" : "Subtitles",
                )
              }
            >
              Open settings
            </Button>
          )}
          {actions.library && (
            <Button onClick={() => navigate("library", task.jobId)}>Locate video</Button>
          )}
          {actions.import && (
            <Button disabled={!native || busy} onClick={() => void perform("import")}>
              Import subtitle…
            </Button>
          )}
        </ActionGroup>
      )}
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
    </Banner>
  );
}
