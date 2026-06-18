# Changelog

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
