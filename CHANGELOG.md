# Changelog

## 2026-06-24 - Job Poll Retry

### Changed

- Job-status polling now treats transient Worker/backend failures such as 503
  and non-JSON Service Unavailable responses as retryable progress-channel
  interruptions instead of immediately failing the analysis and showing a
  misleading zero-entry state.
- Job-status polling now treats backend job heartbeats as live activity, so a
  long stage with no new detailed progress sentence does not look idle.
- Public app asset was cache-busted to `app.js?v=20260624-job-heartbeat`.

## 2026-06-23 - Dropbox API Source Access

### Changed

- ToC Creator now points at the Dropbox API-enabled Worker for staff analysis, metadata, feedback, and preview routes.
- PDF preview now uses the Worker staff-only Dropbox API stream instead of minting a public-download-style proxy token.
- Public assets were cache-busted to `app.js?v=20260623-dropbox-api` and `styles.css?v=20260623-dropbox-api`.

## 2026-06-19 - Creator Role Automation

### Changed

- Metadata autofill now ignores translators, foreword/introduction/preface-style credits, organizations, unknown roles, and other non-author/editor creator labels.
- Compiler credits are kept only when the metadata scan found no author or editor.
- The contributor role dropdown now offers Author, Editor, and Compiler.
- Public assets were cache-busted to `app.js?v=20260619-creator-roles` and `styles.css?v=20260619-creator-roles`.

### Deployed

- UI commit: `c5f02a1 Narrow metadata creator roles`
- Public site verified at `https://thedtl.github.io/toc-creator-ui/`
- Published HTML loads `app.js?v=20260619-creator-roles` and `styles.css?v=20260619-creator-roles`.
- Published JavaScript role order verified as Author, Editor, Compiler.

## 2026-06-18 - Preview Behavior And Contributor Filenames

### Added

- Repeatable contributor rows for filename metadata.
- Chicago-style filename construction for multiple authors, editors, translators, and compilers.
- Automatic metadata fill now prefers backend `contributors` arrays when present and falls back to legacy single-author fields when needed.

### Changed

- Public assets were cache-busted to `app.js?v=20260618-contributors` and `styles.css?v=20260618-contributors`.
- Row-level Preview now changes the PDF preview page without scrolling the Detected Bookmarks box back to the top.

### Deployed

- UI commit: `a5c0318 Support multiple filename contributors`
- Public site verified at `https://thedtl.github.io/toc-creator-ui/`

### Notes

- Future UI changes should update this changelog in the same commit whenever possible.
- Cross-repo changes should also update the backend repo changelog.
