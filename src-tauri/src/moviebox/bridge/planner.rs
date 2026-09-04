use super::super::{flag, now, number, strv, Runtime};
use super::{matching, BundlePlan, BundleRequest, BundleRow, Pick, StoredPlan};
use crate::acquisition::{AcquisitionJob, AcquisitionState};
use futures_util::future::join_all;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

pub(crate) fn job_episodes(job: &AcquisitionJob) -> Vec<i32> {
    job.source_context["episodes"]
        .as_array()
        .map(|es| {
            es.iter()
                .filter_map(|e| e.as_i64().map(|e| e as i32))
                .collect()
        })
        .unwrap_or_else(|| job.episode.into_iter().collect())
}

pub(super) fn choices(source: &Value, season: i32, selected: &[i32], max_size: u64) -> Vec<Pick> {
    let hash = strv(&source["raw"], "infoHash").to_lowercase();
    let source_key = if hash.is_empty() {
        format!("direct:{}", strv(&source["raw"], "url"))
    } else {
        hash
    };
    let files = source["files"].as_array().filter(|f| !f.is_empty());
    let mut picks = Vec::new();
    if strv(&source["raw"], "infoHash").is_empty() && !strv(&source["raw"], "url").is_empty() {
        if let Some(episode) = source["episode"]
            .as_i64()
            .map(|e| e as i32)
            .filter(|e| selected.contains(e))
        {
            // Direct Stremio links are episode-scoped claims, not inspected torrent manifests.
            picks.push(Pick {
                key: source_key,
                source: source.clone(),
                filename: None,
                episodes: vec![episode],
                size: source["raw"]["behaviorHints"]["videoSize"].as_u64(),
                verified: true,
            });
        }
        return picks;
    }
    if let Some(files) = files {
        for file in files {
            let name = file["name"]
                .as_str()
                .or_else(|| file["short_name"].as_str())
                .unwrap_or("");
            if !matching::video(name) {
                continue;
            }
            let Some((s, episodes)) = matching::episode_numbers(name) else {
                continue;
            };
            if s != season || file["size"].as_u64().is_some_and(|s| s > max_size) {
                continue;
            }
            let episodes = episodes
                .into_iter()
                .filter(|e| selected.contains(e))
                .collect::<Vec<_>>();
            if episodes.is_empty() {
                continue;
            }
            picks.push(Pick {
                key: format!("{source_key}:{name}"),
                source: source.clone(),
                filename: Some(name.into()),
                episodes,
                size: file["size"].as_u64(),
                verified: true,
            });
        }
        // Two encodes of an episode are ambiguous. Never select by file ordering.
        let mut counts = BTreeMap::new();
        for pick in &picks {
            for e in &pick.episodes {
                *counts.entry(*e).or_insert(0) += 1;
            }
        }
        picks.retain(|p| p.episodes.iter().all(|e| counts[e] == 1));
    } else {
        let title = source["raw"]["behaviorHints"]["filename"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(strv(&source["raw"], "title"));
        let explicit = matching::episode_numbers(title);
        let episodes = if let Some((s, episodes)) = explicit {
            if s != season {
                return picks;
            }
            episodes
                .into_iter()
                .filter(|e| selected.contains(e))
                .collect::<Vec<_>>()
        } else if flag(&source["display"], "pack")
            && matching::release_season(title).is_none_or(|s| s == season)
        {
            selected.to_vec()
        } else {
            source["episode"]
                .as_i64()
                .map(|e| vec![e as i32])
                .unwrap_or_default()
                .into_iter()
                .filter(|e| selected.contains(e))
                .collect()
        };
        for episode in episodes {
            picks.push(Pick {
                key: format!("{source_key}:pending:{episode}"),
                source: source.clone(),
                filename: None,
                episodes: vec![episode],
                size: None,
                verified: false,
            });
        }
    }
    picks
}

pub(super) fn select_picks(mut candidates: Vec<Pick>, selected: &[i32], method: &str) -> Vec<Pick> {
    candidates.retain(|p| method != "Individual episodes" || !flag(&p.source["display"], "pack"));
    let mut seen = HashSet::new();
    candidates.retain(|p| seen.insert(p.key.clone()));
    let mut result = Vec::new();
    let mut uncovered = selected.iter().copied().collect::<HashSet<_>>();
    while !uncovered.is_empty() {
        // Coverage is scored across every file in a release, not only the current episode.
        let coverage = |pick: &Pick| {
            let hash = strv(&pick.source["raw"], "infoHash");
            candidates
                .iter()
                .filter(|p| {
                    p.verified == pick.verified
                        && !hash.is_empty()
                        && strv(&p.source["raw"], "infoHash") == hash
                })
                .flat_map(|p| p.episodes.iter())
                .filter(|e| uncovered.contains(e))
                .collect::<HashSet<_>>()
                .len()
        };
        let best = candidates
            .iter()
            .filter(|p| p.episodes.iter().any(|e| uncovered.contains(e)))
            .max_by_key(|p| {
                (
                    p.verified,
                    if method == "Season pack" {
                        coverage(p)
                    } else {
                        0
                    },
                    flag(&p.source["display"], "cached"),
                    p.source["display"]["height"].as_i64().unwrap_or(0),
                    std::cmp::Reverse(p.size.unwrap_or(u64::MAX)),
                    std::cmp::Reverse(p.key.clone()),
                )
            })
            .cloned();
        let Some(mut best) = best else {
            break;
        };
        best.episodes.retain(|e| uncovered.remove(e));
        result.push(best);
    }
    result
}

impl Runtime {
    pub(in crate::moviebox) async fn plan_bundle(
        &self,
        mut request: BundleRequest,
        acquisition: &AcquisitionState,
    ) -> Result<BundlePlan, String> {
        let media = self
            .get("media", &request.id)?
            .ok_or("Open the series before finding sources")?;
        if strv(&media, "kind") != "series" || request.season < 0 {
            return Err("Choose a valid series season".into());
        }
        request.episodes.sort_unstable();
        request.episodes.dedup();
        if request.episodes.is_empty() || request.episodes.len() > 100 {
            return Err("Select between 1 and 100 episodes".into());
        }
        if !["Season pack", "Individual episodes"].contains(&request.method.as_str()) {
            return Err("Unknown download method".into());
        }
        let metadata = media["episodes"]
            .as_array()
            .ok_or("Episode metadata unavailable")?;
        if request.episodes.iter().any(|e| {
            !metadata
                .iter()
                .any(|m| m["season"] == request.season && m["episode"] == *e)
        }) {
            return Err("Selected episode is not in this season's metadata".into());
        }
        let prefs = self.prefs()?;
        if request.quality.is_empty() {
            request.quality = strv(&prefs, "quality").into();
        }
        if request.language.is_empty() {
            request.language = strv(&prefs, "language").into();
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.log(
            "info",
            "bridge",
            &format!(
                "Planning season {}: {} selected episodes",
                request.season,
                request.episodes.len()
            ),
            Some(&id),
        )?;
        let jobs = acquisition.list_jobs()?;
        let library = self.list("library")?;
        let waiting = self
            .list("bundle-wait")?
            .into_iter()
            .filter(|w| {
                w["mediaId"] == request.id
                    && w["season"] == request.season
                    && !matches!(strv(w, "state"), "canceled" | "queued")
            })
            .filter_map(|w| self.get("bundle-plan", strv(&w, "id")).ok().flatten())
            .flat_map(|p| p["plan"]["rows"].as_array().cloned().unwrap_or_default())
            .filter(|r| matches!(strv(r, "status"), "ready" | "pending"))
            .filter_map(|r| r["episode"].as_i64().map(|e| e as i32))
            .collect::<HashSet<_>>();
        let existing = request
            .episodes
            .iter()
            .copied()
            .filter(|e| {
                waiting.contains(e)
                    || jobs.iter().any(|j| {
                        j.media_id == request.id
                            && j.season == Some(request.season)
                            && job_episodes(j).contains(e)
                            && !matches!(j.status.as_str(), "error" | "canceled")
                            && (j.status != "done" || std::path::Path::new(&j.path).is_file())
                    })
                    || library.iter().any(|f| {
                        f["mediaId"] == request.id
                            && f["season"] == request.season
                            && f["episodes"]
                                .as_array()
                                .is_some_and(|es| es.contains(&json!(e)))
                            && std::path::Path::new(strv(f, "path")).is_file()
                    })
            })
            .collect::<HashSet<_>>();
        let targets = request
            .episodes
            .iter()
            .copied()
            .filter(|e| !existing.contains(e))
            .collect::<Vec<_>>();
        let mut reports = Vec::new();
        let mut candidates = Vec::new();
        let mut sources_seen = HashSet::new();
        if !targets.is_empty() {
            let report = self
                .search_sources(
                    &request.id,
                    "series",
                    Some(request.season),
                    None,
                    &request.quality,
                    &request.language,
                )
                .await?;
            self.collect_choices(
                &report,
                &request,
                &targets,
                &mut sources_seen,
                &mut candidates,
            )?;
            reports.push(report);
            // Stremio has no standard season-search resource. Only probe episodes still uncovered by verified manifests.
            'batches: for batch in targets.chunks(3) {
                let needed = batch
                    .iter()
                    .filter(|episode| {
                        !candidates.iter().any(|p| {
                            p.verified
                                && p.episodes.contains(episode)
                                && (request.method != "Individual episodes"
                                    || !flag(&p.source["display"], "pack"))
                        })
                    })
                    .copied()
                    .collect::<Vec<_>>();
                let batch_reports = join_all(needed.into_iter().map(|episode| {
                    self.search_sources(
                        &request.id,
                        "series",
                        Some(request.season),
                        Some(episode),
                        &request.quality,
                        &request.language,
                    )
                }))
                .await;
                for report in batch_reports {
                    let report = report?;
                    self.collect_choices(
                        &report,
                        &request,
                        &targets,
                        &mut sources_seen,
                        &mut candidates,
                    )?;
                    let unavailable = strv(&report, "state") == "missing_provider";
                    reports.push(report);
                    if unavailable {
                        break 'batches;
                    }
                }
            }
        }
        let picks = select_picks(candidates, &targets, &request.method);
        let mut rows = Vec::new();
        for episode in &request.episodes {
            let pick = picks.iter().find(|p| p.episodes.contains(episode));
            let status = if existing.contains(episode) {
                "existing"
            } else if pick.is_some_and(|p| p.verified) {
                "ready"
            } else if pick.is_some() {
                "pending"
            } else {
                "missing"
            };
            rows.push(BundleRow {
                episode: *episode,
                title: metadata
                    .iter()
                    .find(|m| m["season"] == request.season && m["episode"] == *episode)
                    .map(|m| strv(m, "title").to_string())
                    .unwrap_or_default(),
                status: status.into(),
                reason: match status {
                    "existing" => "Already downloaded or queued",
                    "ready" if pick.is_some_and(|p| p.filename.is_none()) => {
                        "Episode-scoped add-on link; file contents not inspected"
                    }
                    "ready" => "Episode mapped from the source file list",
                    "pending" => {
                        "Candidate found; file coverage must be checked during preparation"
                    }
                    _ => "No unambiguous source satisfying the preferences",
                }
                .into(),
                source_id: pick.map(|p| strv(&p.source["display"], "id").into()),
                source_name: pick.map(|p| strv(&p.source["display"], "name").into()),
                filename: pick.and_then(|p| p.filename.clone()),
                size: pick.and_then(|p| p.size),
                quality: pick.map(|p| strv(&p.source["display"], "quality").into()),
                language_evidence: if pick.is_some() {
                    "Advertised audio; tracks not inspected"
                } else {
                    "Unknown audio"
                }
                .into(),
                pack: pick.is_some_and(|p| flag(&p.source["display"], "pack")),
            });
        }
        let source_count = picks
            .iter()
            .map(|p| {
                let hash = strv(&p.source["raw"], "infoHash");
                if hash.is_empty() {
                    p.key.clone()
                } else {
                    hash.into()
                }
            })
            .collect::<HashSet<_>>()
            .len();
        let mut warnings = Vec::new();
        if picks.iter().any(|p| {
            !strv(&p.source["raw"], "infoHash").is_empty() && !flag(&p.source["display"], "cached")
        }) {
            warnings.push("Preparing uncached torrents may download the entire torrent in the selected provider cloud. Only selected files are saved locally. Missing file metadata is not proof of coverage.".into());
        }
        if rows.iter().any(|r| r.status == "missing") {
            warnings
                .push("Unmatched episodes stay missing; nothing is substituted silently.".into());
        }
        let plan = BundlePlan {
            id: id.clone(),
            media_id: request.id.clone(),
            title: strv(&media, "title").into(),
            season: request.season,
            created_at: now(),
            state: "planned".into(),
            method: request.method.clone(),
            rows,
            reports,
            warnings,
            source_count,
            total_bytes: picks.iter().filter_map(|p| p.size).sum(),
        };
        self.put(
            "bundle-plan",
            &id,
            &serde_json::to_value(StoredPlan {
                subtitle_policy: None,
                rule_id: None,
                binding: self.binding()?,
                request,
                plan: plan.clone(),
                picks,
            })
            .map_err(|e| e.to_string())?,
        )?;
        for row in &plan.rows {
            self.log(
                "info",
                "bridge",
                &format!("Episode {}: {}", row.episode, row.reason),
                Some(&id),
            )?;
        }
        Ok(plan)
    }

    pub(super) fn collect_choices(
        &self,
        report: &Value,
        request: &BundleRequest,
        targets: &[i32],
        seen: &mut HashSet<String>,
        out: &mut Vec<Pick>,
    ) -> Result<(), String> {
        let max = (number(&self.prefs()?, "maxSize", 40.0) * 1e9) as u64;
        for display in report["sources"].as_array().into_iter().flatten() {
            if flag(display, "blocked") {
                continue;
            }
            let Some(source) = self.get("source", strv(display, "id"))? else {
                continue;
            };
            let hash = strv(&source["raw"], "infoHash");
            let identity = if hash.is_empty() {
                format!("direct:{}", strv(&source["raw"], "url"))
            } else {
                hash.to_lowercase()
            };
            // Keep episode-scoped direct links and one manifest per torrent.
            let identity = if source["files"].as_array().is_some_and(|f| !f.is_empty()) {
                identity
            } else {
                format!("{identity}:{}", source["episode"])
            };
            if seen.insert(identity) {
                out.extend(choices(&source, request.season, targets, max));
            }
        }
        Ok(())
    }
}
