import { useState } from "react";
import { BundleReview } from "./bridge";
import { mediaById } from "./model";
import { RuleForm } from "./monitoring";
import { navigate } from "./routing";
import { runBackend, useDemo } from "./store";
import { ActionGroup, Button } from "./ui";
import type { SearchTask } from "./types";

export function SearchTasks() {
  const { searches = [], preferences } = useDemo();
  const [review, setReview] = useState<SearchTask>();
  const [monitor, setMonitor] = useState<{ id: string; episodes: number[]; season: number }>();
  if (!searches.length) return null;
  return (
    <>
      <details
        className="search-tasks"
        open={searches.some((s) => s.state === "running" || s.state === "queued")}
      >
        <summary>
          Source searches ·{" "}
          {searches.filter((s) => s.state === "running" || s.state === "queued").length} running ·{" "}
          {searches.filter((s) => s.state === "complete").length} ready
        </summary>
        <div className="stack">
          {searches.slice(0, 20).map((s) => (
            <div className="settings-card" key={s.id}>
              <div className="row search-task-row">
                <div className="spacer">
                  <strong>
                    {s.title}
                    {s.kind === "bundle" ? ` · Season ${s.request.season}` : ""}
                  </strong>
                  <p className={s.state === "error" ? "warning" : "muted"}>{s.message}</p>
                </div>
                <ActionGroup>
                  {s.state !== "canceled" && (
                    <Button
                      onClick={() =>
                        s.kind === "bundle" ? setReview(s) : navigate("discover", s.mediaId)
                      }
                    >
                      {s.state === "complete" ? "Review sources" : "View search"}
                    </Button>
                  )}
                  {(s.state === "running" || s.state === "queued") && (
                    <Button
                      onClick={() => void runBackend("search.cancel", { id: s.id }).catch(() => {})}
                    >
                      Cancel search
                    </Button>
                  )}
                </ActionGroup>
              </div>
            </div>
          ))}
        </div>
      </details>
      {review && (
        <BundleReview
          media={mediaById(review.mediaId)}
          searchId={review.id}
          season={review.request.season ?? 1}
          episodes={review.request.episodes ?? []}
          method={review.request.method ?? "Season pack"}
          destination={review.destination || preferences.folder}
          onClose={() => setReview(undefined)}
          onMonitor={(id, episodes, season) => setMonitor({ id, episodes, season })}
        />
      )}
      {monitor && (
        <RuleForm
          mediaId={monitor.id}
          targetEpisodes={monitor.episodes}
          targetSeason={monitor.season}
          onClose={() => setMonitor(undefined)}
        />
      )}
    </>
  );
}
