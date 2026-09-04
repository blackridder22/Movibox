import type { Preferences } from "./types";

export type PreferenceWrite = { id: number; patch: Partial<Preferences> };

const appearanceKeys = [
  "theme",
  "accent",
  "density",
  "radius",
  "glass",
  "shadows",
  "motion",
  "customCursor",
  "sidebarCollapsed",
] as const satisfies readonly (keyof Preferences)[];

// Keep appearance choices visible while native writes and background snapshots finish.
// Provider, download and library state still waits for native confirmation.
export class PreferenceWrites {
  private saved: Preferences;
  private pending = new Map<number, PreferenceWrite>();
  revision = 0;

  constructor(initial: Preferences) {
    this.saved = initial;
  }

  read(): Preferences {
    const result = { ...this.saved };
    for (const { patch } of this.pending.values()) {
      for (const key of appearanceKeys) {
        if (key in patch) Object.assign(result, { [key]: patch[key] });
      }
    }
    return result;
  }

  stage(next: Preferences): PreferenceWrite | undefined {
    const current = this.read();
    const patch = Object.fromEntries(
      Object.entries(next).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(current[key as keyof Preferences]),
      ),
    );
    if (!Object.keys(patch).length) return;
    const write = { id: ++this.revision, patch };
    this.pending.set(write.id, write);
    return write;
  }

  settle(write: PreferenceWrite, saved: boolean) {
    if (!this.pending.delete(write.id)) return;
    if (saved) this.saved = { ...this.saved, ...write.patch };
    this.revision++;
  }

  receive(snapshot: Preferences, revision: number): Preferences {
    // A snapshot started before a click or save must not put the old choice back.
    if (revision === this.revision) this.saved = snapshot;
    return this.read();
  }
}
