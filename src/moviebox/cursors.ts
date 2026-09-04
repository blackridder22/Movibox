type CursorTheme = "light" | "dark";

function createCursorAssets(theme: CursorTheme) {
  const color = theme === "light" ? "#17181a" : "#ffffff";
  const edge = theme === "light" ? "#ffffff" : "#17181a";
  const cursors = {
    default: {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"><path fill="${color}" stroke="${edge}" stroke-linejoin="round" stroke-width="1.25" d="m9.803 4.63l6.033 2.36c3.48 1.362 5.22 2.043 5.163 3.123c-.058 1.08-1.874 1.576-5.506 2.566c-1.081.295-1.622.442-1.997.817s-.522.916-.817 1.997c-.99 3.632-1.486 5.448-2.566 5.506s-1.76-1.683-3.122-5.163L4.63 9.803C3.204 6.159 2.49 4.338 3.414 3.414c.924-.923 2.745-.21 6.389 1.216Z"/></svg>`,
      hotspot: "2 2",
    },
    text: {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"/><path d="M7 22h1a4 4 0 0 0 4-4"/><path d="M7 2h1a4 4 0 0 1 4 4"/></svg>`,
      hotspot: "8 8",
    },
    pointer: {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16"><path fill="${color}" stroke="${edge}" stroke-width="0.75" stroke-linejoin="round" d="M6.5 1A1.5 1.5 0 0 1 8 2.5v2.499l4.633 1.545A2 2 0 0 1 14 8.44V11a4 4 0 0 1-4 4H5.952q-.025-.001-.05-.005a1.5 1.5 0 0 1-.963-.434l-3.5-3.5a1.5 1.5 0 1 1 2.122-2.122l1.481 1.482L5 10V2.5A1.5 1.5 0 0 1 6.5 1"/></svg>`,
      hotspot: "7 1",
    },
  };

  return Object.fromEntries(
    Object.entries(cursors).map(([name, { svg, hotspot }]) => [
      `--movibox-cursor-${name}`,
      {
        url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
        value: `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot}, ${name}`,
      },
    ]),
  );
}

const assets = { light: createCursorAssets("light"), dark: createCursorAssets("dark") };
const prepared: Partial<Record<CursorTheme, Promise<void>>> = {};

export function createCursorStyles(theme: CursorTheme): Record<string, string> {
  return Object.fromEntries(
    Object.entries(assets[theme]).map(([name, asset]) => [name, asset.value]),
  );
}

function prepareCursors(theme: CursorTheme): Promise<void> {
  return (prepared[theme] ??= Promise.all(
    Object.values(assets[theme]).map(async ({ url }) => {
      const image = new Image();
      image.src = url;
      await image.decode();
    }),
  )
    .then(() => {})
    .catch((error: unknown) => {
      delete prepared[theme];
      throw error;
    }));
}

export function createCursorController(
  root: HTMLElement,
  prepare: (theme: CursorTheme) => Promise<void> = prepareCursors,
) {
  let revision = 0;
  let activeTheme: CursorTheme | undefined;
  const reset = () => {
    activeTheme = undefined;
    root.dataset.cursor = "system";
    for (const property of Object.keys(assets.light)) root.style.removeProperty(property);
  };
  return {
    async set(enabled: boolean, theme: CursorTheme): Promise<boolean> {
      const request = ++revision;
      if (!enabled) {
        reset();
        return true;
      }
      if (activeTheme !== theme) reset();
      try {
        await prepare(theme);
      } catch {
        if (request !== revision) return true;
        reset();
        return false;
      }
      // An earlier decode must never re-enable cursors after Off, a theme change or unmount.
      if (request !== revision) return true;
      for (const [property, cursor] of Object.entries(createCursorStyles(theme))) {
        root.style.setProperty(property, cursor);
      }
      root.dataset.cursor = "movibox";
      activeTheme = theme;
      return true;
    },
    dispose() {
      revision++;
      reset();
    },
  };
}
