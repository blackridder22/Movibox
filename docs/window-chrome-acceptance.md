# Window controls and branding — 2026-08-30

Current 0.9.21 behavior:

- Native-only, reserved 40px title row with a draggable region and top-right
  minimize, enter/exit fullscreen, and close buttons. Button colors inherit the
  current theme; dialogs stay within the area below the title row.
- Close uses Tauri's existing `CloseRequested` handler and background preference.
- The macOS status-bar icon and its dropdown are disabled through
  `tray::STATUS_MENU_ENABLED`. The implementation remains in source, and the
  Windows/Linux tray is unchanged. System menu-bar settings are untouched.
- The previous File/Edit/View/Window/Help heading treatment is unchanged, with
  native keyboard equivalents retained. No custom editing interception is needed.
- macOS `RunEvent::Reopen` restores the window when reopened from the Dock.
- Settings content scrolls independently of its section navigation and header.
  On short windows the navigation has its own scroll area. Changing sections
  resets the content pane to the top.
- `public/brand/movibox.svg` is byte-for-byte identical to the supplied Affinity
  SVG. Its alpha mask uses the theme's text color in sidebar/setup/About.
- Generated Dock variants use the SVG on a contrasting tile. The running macOS
  app changes its Dock icon with the resolved app theme. Finder and the installer
  use the packaged dark variant. Earlier PNG references are retained.

Verified:

- Scoped `pnpm run check`, `pnpm run typecheck`, all 100 existing tests,
  and `cargo check --manifest-path src-tauri/Cargo.toml` passed.
- `pnpm tauri:build:linux-system` ran on macOS, producing a macOS ARM64 binary.
  This does **not** constitute Linux testing.
- Local app and DMG rebuilt. `codesign --verify --deep --strict` passed with the
  local ad-hoc signature. Bundled ICNS hash matches the generated source icon.
- Browser visual checks: dark/system SVG is `rgb(242,243,244)`; light SVG is
  `rgb(32,33,36)`. Both themes rendered correctly.
- Actual pointer scrolling moved Appearance content from 0 to 299px while the
  navigation stayed at scrollTop 0 and top 118px, and page scrollTop stayed 0.
  Switching to Providers reset content scroll to 0. No horizontal overflow.
- The final native bundle launched from the project bundle path. App and DMG
  rebuilt successfully after ejecting old build images.

Not yet verified:

- The native UI driver timed out after clicking Enter full screen. A process
  sample showed the application main thread running its normal event loop, but
  this does not establish whether the fullscreen transition completed correctly.
- Dock icon theme changes and Dock-click reopening need interactive confirmation:
  the native UI driver timed out when inspecting the Dock.
- Earlier fullscreen/minimize/close interaction verification remains incomplete.
- Windows and Linux desktop behavior were not exercised.

Existing build warnings remain: large frontend chunks and missing production
Apple signing/notarization credentials. No release was published or installed
over `/Applications/MoviBox.app`.
