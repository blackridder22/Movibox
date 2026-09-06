# MoviBox landing page

Plain HTML, CSS, and JavaScript. All fonts, icons, artwork, and preview images are local. No framework, analytics, form service, or build step is required to serve the page.

## Preview

From the MoviBox repository:

```sh
python3 -m http.server 4174 --bind 127.0.0.1 --directory landing-page
```

Open <http://127.0.0.1:4174>.

For a single HTML file that also opens directly from disk:

```sh
node landing-page/export.mjs
```

Output: `release-output/movibox-landing/MoviBox.html`. It embeds styles, JavaScript, fonts, icons, and images. Edit the source files here, then export again.

## Content and design

- Product: MoviBox, the download-only desktop app. No playback or included-content promise.
- Audience: film and TV collectors using Stremio-compatible sources and debrid services.
- Value proposition: less manual searching and queue management, with ordinary local files and your preferred player.
- Conversion: free download, accurate requirements, explicit platform and architecture choices. No invented prices, testimonials, counters, or scarcity.
- Money-strategy: Value Equation applied to the outcome, lower setup effort, concrete workflow proof, and a direct CTA.
- Taste skill: `design-taste-frontend` from `Leonxlnx/taste-skill`, installed in `/private/tmp/movibox-taste-skill`. DESIGN_VARIANCE 7, MOTION_INTENSITY 4, VISUAL_DENSITY 3. Native CSS with an asymmetric hero, generous spacing, one coral accent, and short entrance transitions.
- Theme: follows the system by default; the manual toggle persists where local storage is available. All sections use the same theme. Containers use 14px corners, artwork 10px, controls 8px, inset controls 6px. Page layers: content, hero composition, navigation 20, skip link 30.

Copy structure was informed by the feature clarity and installation focus of [Prowlarr](https://prowlarr.com/), [Sonarr](https://sonarr.tv/), and [Radarr](https://radarr.video/). The text is original and the claims are grounded in this repository's README and source-selection implementation.

## Assets and links

- Download URLs are the actual public assets for [MoviBox 0.9.22](https://github.com/blackridder22/Movibox/releases/tag/v0.9.22), read back from the GitHub API on September 5, 2026. No installer is bundled with the page.
- Update the version and installer filenames in both `index.html` and `script.js` for a later release.
- Preview images are existing browser captures from `design/movie-box-v1/implementation/`. They contain demonstration data and the earlier “Movie Box” wordmark. The caption explicitly identifies sample data. They are not evidence of a live provider session.
- Movie and series artwork comes from the existing `public/moviebox/` assets. Titles are illustrative, not an included catalog or content offer. Original artwork remains owned by its rights holders.
- The MoviBox mark comes from `src/assets/brand/movibox-mark-ui.png`.
- Icons are exported from the project's existing Lucide React dependency, under ISC; see `assets/lucide-LICENSE.txt`.
- Manrope is self-hosted and subset to Latin plus general punctuation, under the SIL Open Font License; see `assets/manrope-OFL.txt`.

## Publishing

The website is served at <https://blackridder22.github.io/Movibox/>.

`.github/workflows/pages.yml` deploys changes to this directory from `main`. It can also be run manually through GitHub Actions. The workflow publishes only `index.html`, `styles.css`, `script.js`, and `assets/`; application source, exporter scripts, and local QA output are not part of the website. GitHub Pages manages HTTPS and delivery caching.

The canonical and Open Graph URLs in `index.html` point to this Pages address. Update them if the site moves to another domain.

## Verification

Local QA reports and screenshots are kept in the gitignored `qa/` directory. The initial mobile Lighthouse audit scored 98 for performance and 100 for accessibility, best practices, and SEO. Browser verification covers this landing page only; it does not test media acquisition or installer execution.
