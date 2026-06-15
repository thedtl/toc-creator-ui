# DTL ToC Creator UI

Frontend for the DTL PDF ToC/bookmark creator service.

The first version is a static app so it can run locally or from GitHub Pages
without a build step. It is designed for Dropbox-link workflows, quick bookmark
creation, and easy copy/paste debugging.

## Features

- Dropbox PDF link submission through the protected staff Worker
- staff-password check before running ToC analysis
- live backend progress polling while analysis runs
- protected PDF preview with page navigation
- editable detected bookmark table
- row-level preview buttons for detected bookmarks
- client-side bookmarked PDF creation with `pdf-lib`
- filename preview in the pattern `Last, First, Title, OCLC number`
- copyable progress log, backend JSON, and compact debug bundle

## Local Use

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Backend

The UI calls the shared DTL Cloudflare Worker:

```text
https://dtl-chapter-request.ccrawford.workers.dev
```

The Worker validates the staff password and forwards ToC analysis requests to
Cloud Run. Direct Cloud Run analysis calls are also protected by the same staff
password header.

Analysis runs as a backend job: the UI starts the job through the Worker, then
polls the Worker for job status and real backend progress messages until the
result is ready.

## Notes

Dropbox links are normalized to `dl=1`. PDF preview and bookmarked-PDF creation
download the source PDF through the existing protected Worker token route.

The browser PDF libraries are vendored under `vendor/` so the GitHub Pages app
does not depend on third-party CDN script loading at runtime.
