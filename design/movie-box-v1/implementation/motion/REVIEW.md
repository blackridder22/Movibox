# Sidebar and subtle motion

The approved layout is preserved. Desktop navigation switches between its existing width and a 68 px icon rail; the choice is persisted with the other UI preferences. Narrow windows use a Base UI navigation dialog instead of shrinking page content. Icon navigation includes labels and tooltips.

## Motion rules

- Buttons and switches: 120 ms feedback.
- Popovers, menus, selects and notices: 180 ms.
- Modals, inspector panels and sidebar movement: 220 ms.
- Page and setup transitions: short opacity fades; rapid page changes continue from the current opacity.
- Strong easing curves are shared CSS tokens. Animated properties are opacity and transform; sidebar widths change as layout state, not through width animation.
- Keyboard shortcuts and Escape bypass transitions. Reduced motion retains 120 ms opacity changes without scaling or sliding.

Base UI owns dialog/menu accessibility and transition completion. Motion retains closing components until exit completion and handles panel/layout movement. Selecting another movie replaces inspector content immediately, preserving a single panel. The catalog and search field keep their panel layout until a closing inspector is removed.

## Browser verification

Reviewed desktop 1280 × 720, desktop minimum 960 × 600 and narrow 390 × 844. Checks covered collapse/expand, reload persistence, visible icon tooltips, narrow navigation and focus restoration; provider dialogs, repeated open/close, filters, movie details and title switching; nested discard confirmation, notices, rapid Settings changes, reduced-motion selection, configured keyboard navigation and Escape. No horizontal overflow was observed. Light theme and the existing system-motion preference were restored; no saved rules, live downloads or provider credentials were changed.

Evidence: [measurements](browser-measurements.json), [collapsed sidebar](collapsed-sidebar.jpeg), [expanded sidebar](expanded-sidebar.jpeg), [narrow expansion](narrow-expanded.jpeg).

The browser runner did not activate native buttons through Enter/Space, including unchanged buttons, so those native activation paths were not proven. Explicit keyboard handlers and zero-duration keyboard styling were verified. OS-level reduced motion was implemented but not changed on the user's computer. Screenshots show layout, not frame-by-frame motion timing.

## Validation

Scoped formatting/lint checks and TypeScript checks passed. Existing UI logic tests passed 11/11. The final macOS app and DMG build passed. The generated CSS was checked for the final inspector layout rule. Logs: [checks](checks.log), [final checks](final-checks.log), [TypeScript](typecheck.log), [tests](tests.log), [build](build.log). The build script is named `tauri:build:linux-system`, but on this Mac it produces the Apple Silicon macOS app and DMG; Linux was not verified. The existing large legacy TMDB chunk warning remains.

Implementation references: [Motion presence](https://motion.dev/docs/react-animate-presence), [Base UI tooltip](https://base-ui.com/react/components/tooltip), and installed Base UI type declarations.
