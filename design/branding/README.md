# MoviBox artwork

The current source is the owner's Affinity export at `public/brand/movibox.svg`.
The interface uses it as an alpha mask colored by the theme's text token.
The earlier textured PNG alternatives are retained here for reference only.

Regenerate the native icons:

1. `node scripts/generate-brand-icons.mjs`
2. `pnpm exec tauri icon src-tauri/icons/dock-dark.png --output src-tauri/icons`
3. Copy `src-tauri/icons/32x32.png` to `public/favicon.png`.

The generated light/dark Dock icons keep the original paths and opacity. A simple
contrasting tile keeps the mark readable against different desktop backgrounds.
The running macOS app switches its Dock icon with the resolved app theme. The
packaged Finder/installer icon uses the dark variant.
