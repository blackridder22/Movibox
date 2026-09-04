# Backup and restore

Settings → Backup & restore → Back up now saves a `.movibox-backup` file containing portable preferences, title metadata, monitoring rules, and library records. Videos and subtitle files are not copied. The file is written directly into the recovery folder, without depending on the operating system save dialog. Use Open recovery folder to copy it to another disk or device. Review latest backup opens the most recent valid recovery copy; Review backup imports an older file.

Backups are unencrypted. They contain titles, local file paths and rule names; keep them private. Provider tokens, account connections, indexer/add-on URLs, logs, active download intents, and OS login registration are excluded. Restoring leaves those existing device settings untouched; reconnect services separately on a new device.

## Restore

1. Pause downloads and finish/cancel background searches, preparation, subtitle tasks, and running monitoring checks.
2. Choose **Review latest backup**, or **Review backup** to select a file or paste its full path. Review its date, counts, and missing files.
3. Confirm replacement of portable preferences, rules, and library records.
4. Resume rules individually after checking destinations and connections.

The app checks the format/version, SHA-256 integrity, record types, references, duplicates, and size limits before writing. It checks again against the preview checksum when restoring. SHA-256 detects accidental changes; it does not authenticate the author of a backup. Import only your own trusted backups.

A safety copy is written into the app data `recovery` folder first. Replacement uses one SQLite transaction; failure rolls it back. Every restored rule is paused with a new revision. Media files and existing download tasks are never deleted or resumed by restoration. Paths are not translated across operating systems; on a different OS the current default download folder is retained. **Open recovery folder** exposes safety copies for the same preview/restore flow.
