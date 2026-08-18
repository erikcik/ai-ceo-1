# duckdb.org: HTML pages are uncapturable as evidence; the PDFs are fine

Observed 2026-08-17/18 while building a primary-source dossier. Three separate problems, all
of which cost time before they were understood.

**1. `/docs/stable/...` URLs are 569-byte JavaScript redirect stubs.** They return HTTP 200
with a body of only `<title>Redirecting…</title>`, a `location=` script and a
`<meta http-equiv="refresh">`. `curl -L` does **not** follow them, because the redirect is not
an HTTP status. The canonical URL is `https://duckdb.org/docs/current/<path>.html` (note the
`.html`), which returns the real ~350 KB page. This is the textbook "HTTP 200 but a few
hundred bytes" stub — check `size_download`, not just the status.

**2. duckdb.org HTML responses carry no `Content-Length`, `Last-Modified` or `ETag`** — only
`date:` and `content-type:` (Cloudflare, `cf-cache-status: DYNAMIC`). Tried and failed to get
one: HTTP/2, `--http1.1`, `Accept-Encoding: identity`, a `Range: bytes=0-` request, and a
repeat request for a cache HIT. If a task requires those headers as provenance, no duckdb.org
HTML page can satisfy it.

**3. duckdb.org documentation pages carry no date in the body either.** A grep for
`20[0-9]{2}-[0-9]{2}-[0-9]{2}` over a fetched docs page returns nothing; the only version
marker is a string like `DuckDB v1.5.2`. So they cannot support a `dated` field located in the
capture. Dated DuckDB material lives in the blog posts (`duckdb.org/<yyyy>/<mm>/<dd>/...`,
date printed in the page) — but those are HTML, so problem 2 still applies.

**What does work: `https://duckdb.org/pdf/*.pdf`.** Static PDF assets on the same host return
`content-length` **and** `etag`. The project hosts its own published papers there, e.g.
`SIGMOD2019-demo-duckdb.pdf`, `CIDR2020-raasveldt-muehleisen-duckdb.pdf`,
`ICDE2024-kuiper-boncz-muehleisen-out-of-core.pdf`, `ICDE2023-kuiper-muehleisen-sorting.pdf`.
`duckdb.org/duckdb-docs.pdf` does **not** exist (404).

GitHub is the other route, and it is the only DuckDB source that satisfies a strict header
requirement: `api.github.com/repos/duckdb/duckdb/releases/tags/<tag>` returns JSON with
`content-length`, `etag` **and** `last-modified`, plus a real `published_at` date in the body.
Its body is useless as prose, though — checked exactly for `v1.0.0` and `v1.2.0` (2026-08-18),
each is a PR bullet list with precisely **two** prose sentences: one naming the release after a
duck species, one linking to the announcement blog post. Nothing about the storage format,
compatibility, or behaviour. So: good provenance, no quotable content — do not plan on it for
a source that needs two substantive quotes. The docs' markdown source lives in
`duckdb/duckdb-web` under version-frozen directories (`docs/1.3/...`, `docs/current/...`) and
is fetchable from `raw.githubusercontent.com` with full headers, but carries no date.

Contrast: [[sqlite-org-pages-are-ideal-primary-sources]].
