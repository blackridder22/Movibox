# Third-party notices

MoviBox is maintained by **blackridder22** and is derived from [Harbor](https://github.com/harborstremio/harbor). Harbor's copyright notice is retained in the [MIT License](LICENSE), alongside the credit for MoviBox modifications. The MIT notice must accompany copies or substantial portions of the licensed software.

## Dependencies

The root MIT license covers MoviBox's MIT-licensed code. Dependencies retain their own licenses, copyright notices, attribution requirements, and other applicable conditions. The JavaScript and Rust dependency versions are recorded in `pnpm-lock.yaml` and `src-tauri/Cargo.lock`; source-package license files remain authoritative for those components.

MoviBox includes or uses Tauri, React, Base UI, Lucide, Rust crates, and other dependencies. An installer must include the notices required by the components actually redistributed in that installer. This document is an attribution overview, not a substitute for each dependency's required license text.

The bundled Noto Sans JP font uses the SIL Open Font License. Its license is included at `src-tauri/fonts/LICENSE-OFL-NotoSansJP.txt`.

## Service names and content

Stremio, TorBox, Real-Debrid, TMDB, OpenSubtitles, Tally, Airtable, and other service names identify integrations. Their trademarks and content remain subject to their respective owners' rights. They do not endorse MoviBox merely because an integration is available.

TMDB-powered features must retain TMDB's required attribution: “This product uses the TMDB API but is not endorsed or certified by TMDB.”

Movie posters, screenshots, service logos, metadata, and other third-party assets are not automatically relicensed under MIT by inclusion in this repository. Redistribution rights and any required attribution must be checked for the assets shipped in a public build. A disclaimer does not grant missing rights.
