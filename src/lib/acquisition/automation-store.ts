import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { Meta } from "@/lib/cinemeta";

export type EpisodeSelection = { season: number; episode: number };
export type AutomationRule = {
  metaId: string;
  mediaType: string;
  title: string;
  poster: string | null;
  meta: Meta;
  seasons: number[];
  episodes: EpisodeSelection[];
  includeFuture: boolean;
  missingOnly: boolean;
  unwatchedOnly: boolean;
  qualityProfile: string;
  audioLanguage: string | null;
  subtitleLanguage: string | null;
  destination: string | null;
  enabled: boolean;
  checkIntervalMinutes: number;
  nextCheckAt: number;
  lastCheckedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type AutomationRuleInput = {
  metaId: string;
  mediaType: string;
  title: string;
  poster: string | null;
  meta: Meta;
  seasons: number[];
  episodes: EpisodeSelection[];
  includeFuture: boolean;
  missingOnly: boolean;
  unwatchedOnly: boolean;
  qualityProfile: string;
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  destination?: string | null;
  enabled?: boolean;
  checkIntervalMinutes?: number;
  nextCheckAt?: number | null;
};

const listeners = new Set<() => void>();
let rules: AutomationRule[] = [];
let bridge: Promise<void> | null = null;
let stop: UnlistenFn | null = null;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function merge(incoming: AutomationRule[]): void {
  const map = new Map(rules.map((rule) => [rule.metaId, rule]));
  for (const rule of incoming) map.set(rule.metaId, rule);
  rules = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  emit();
}

export async function startAutomationBridge(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (bridge) return bridge;
  bridge = (async () => {
    stop?.();
    stop = await listen<AutomationRule[]>("movibox://automation-due", ({ payload }) =>
      merge(payload),
    );
    rules = await invoke<AutomationRule[]>("automation_list");
    emit();
  })().catch((error) => {
    bridge = null;
    console.error("[movibox] automation bridge failed", error);
  });
  return bridge;
}

export async function listAutomationRules(): Promise<AutomationRule[]> {
  await startAutomationBridge();
  return rules;
}

export async function upsertAutomationRule(input: AutomationRuleInput): Promise<AutomationRule> {
  const rule = await invoke<AutomationRule>("automation_upsert", { input });
  merge([rule]);
  return rule;
}

export async function removeAutomationRule(metaId: string): Promise<void> {
  await invoke("automation_remove", { metaId });
  rules = rules.filter((rule) => rule.metaId !== metaId);
  emit();
}

export async function markAutomationChecked(metaId: string): Promise<void> {
  const rule = await invoke<AutomationRule>("automation_mark_checked", { metaId });
  merge([rule]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void startAutomationBridge();
  return () => listeners.delete(listener);
}

export function useAutomationRules(): AutomationRule[] {
  return useSyncExternalStore(
    subscribe,
    () => rules,
    () => rules,
  );
}
