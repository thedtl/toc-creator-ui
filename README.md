# DTL ToC Creator UI

Frontend for the DTL PDF ToC/bookmark creator service.

The first version is a static app so it can run locally or from GitHub Pages
without a build step. It is designed for Dropbox-link workflows, quick bookmark
creation, and easy copy/paste debugging.

## Features

- Dropbox PDF link submission to the ToC backend
- local PDF fallback for debugging
- editable detected bookmark table
- client-side bookmarked PDF creation with `pdf-lib`
- filename preview in the pattern `Last, First, Title, OCLC number`
- copyable progress log, backend JSON, and compact debug bundle
- optional bearer-token and PDF-proxy fields for private/backend testing

## Local Use

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Backend

Default backend:

```text
https://toc-service-4s2ll3m6pa-uc.a.run.app
```

If Cloud Run is private, paste a short-lived bearer token in Connection
settings while testing locally. For public GitHub Pages use, the backend will
need to be callable from the browser.

## Notes

Dropbox links are normalized to `dl=1`. Browser CORS can still block direct PDF
downloads for client-side bookmark creation; if that happens, configure a small
PDF proxy in Connection settings or use the local PDF fallback.
