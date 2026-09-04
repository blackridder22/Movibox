import { useEffect, useState } from "react";
import {
  fetchInstalledAddons,
  fetchManifestAt,
  filterEnabled,
  loadInstalled,
} from "@/lib/addon-store";
import { torboxAddonFor, userAddons, withDebridKeys, type Addon } from "@/lib/addons";
import { applyOrderToItems, loadDisplayOrder } from "@/lib/addons-store/reorder";
import { withTimeout } from "@/lib/progressive-rows";
import type { Settings } from "@/lib/settings";

const ADDON_DISCOVERY_TIMEOUT_MS = 10_000;

function savedAddons(): Addon[] {
  return filterEnabled(loadInstalled()).flatMap((entry) =>
    entry.manifest ? [{ manifest: entry.manifest, transportUrl: entry.transportUrl }] : [],
  );
}

function hasAnyResources(a: Addon): boolean {
  return (a.manifest.resources ?? []).length > 0;
}

function declaresStream(a: Addon): boolean {
  return (a.manifest.resources ?? []).some((r) =>
    typeof r === "string" ? r === "stream" : r.name === "stream",
  );
}

async function resolveManifests(addons: Addon[]): Promise<Addon[]> {
  return Promise.all(
    addons.map(async (a) => {
      if (hasAnyResources(a)) return a;
      const manifest = await withTimeout(
        fetchManifestAt(a.transportUrl),
        ADDON_DISCOVERY_TIMEOUT_MS,
      ).catch(() => null);
      return manifest ? { ...a, manifest } : a;
    }),
  );
}

export async function discoverAddons(
  authKey: string | null,
  settings: Settings,
): Promise<{ addons: Addon[]; userHasStreamAddons: boolean }> {
  const debridKeys = {
    rdKey: settings.rdKey,
    tbKey: settings.tbKey,
    adKey: settings.adKey,
    pmKey: settings.pmKey,
    dlKey: settings.dlKey,
  };
  const torbox = torboxAddonFor(settings.tbKey);
  const [stremioResult, installedResult] = await Promise.all([
    authKey
      ? withTimeout(userAddons(authKey), ADDON_DISCOVERY_TIMEOUT_MS).catch(() => [] as Addon[])
      : Promise.resolve([] as Addon[]),
    withTimeout(fetchInstalledAddons(), ADDON_DISCOVERY_TIMEOUT_MS).catch(() => []),
  ]);
  const stremioAddons = filterEnabled(stremioResult);
  const installed = filterEnabled([...savedAddons(), ...installedResult]);
  const merged: Addon[] = [];
  const idxByUrl = new Map<string, number>();
  for (const addon of [...stremioAddons, ...installed]) {
    const existingIdx = idxByUrl.get(addon.transportUrl);
    if (existingIdx === undefined) {
      idxByUrl.set(addon.transportUrl, merged.length);
      merged.push(addon);
    } else if (!hasAnyResources(merged[existingIdx]) && hasAnyResources(addon)) {
      merged[existingIdx] = addon;
    }
  }
  const resolved = await resolveManifests(merged);
  const ordered = loadDisplayOrder();
  const base = ordered.length > 0 ? applyOrderToItems(resolved, ordered) : resolved;
  const userHasStreamAddons = base.some(declaresStream);
  const list = withDebridKeys(base, debridKeys);
  const existingTorboxIdx = list.findIndex(
    (addon) =>
      addon.manifest.id === "app.torbox.stremio" ||
      addon.transportUrl?.includes("stremio.torbox.app"),
  );
  if (torbox) {
    if (existingTorboxIdx >= 0) list[existingTorboxIdx] = torbox;
    else list.push(torbox);
  }
  return { addons: list, userHasStreamAddons };
}

export function useAddons(
  authKey: string | null,
  settings: Settings,
): {
  addons: Addon[];
  discovering: boolean;
  userHasStreamAddons: boolean;
} {
  const [addons, setAddons] = useState<Addon[]>(() => savedAddons());
  const [discovering, setDiscovering] = useState(true);
  const [userHasStreamAddons, setUserHasStreamAddons] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setDiscovering(true);
    });
    (async () => {
      const discovered = await discoverAddons(authKey, settings);
      if (cancelled) return;
      setUserHasStreamAddons(discovered.userHasStreamAddons);
      setAddons(discovered.addons);
    })().finally(() => {
      if (!cancelled) setDiscovering(false);
    });
    return () => {
      cancelled = true;
    };
  }, [authKey, settings.rdKey, settings.tbKey, settings.adKey, settings.pmKey, settings.dlKey]);

  return { addons, discovering, userHasStreamAddons };
}
