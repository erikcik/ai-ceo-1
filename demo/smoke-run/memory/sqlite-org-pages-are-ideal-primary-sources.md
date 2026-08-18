# sqlite.org pages are dated and header-complete — use them as the default primary source

Every `sqlite.org` documentation page ends with a line of the form:

```
This page was last updated on 2025-05-31 13:08:22Z
```

so `dated` is an ISO date printed **in the document**, and the `dated_locator` writes itself.
The dates are per-page, not site-wide (`whentouse.html` 2025-05-31, `wal.html` 2026-04-13,
`cli.html` 2026-05-29 as captured 2026-08-17), so read each one rather than reusing a value.

Responses carry the full header set: `Date`, `Last-Modified`, `ETag`, `Content-type` **and**
`Content-length`. Nothing on the site needed a workaround.

Pages that earned their place in a SQLite-vs-DuckDB dossier, with what each is actually good
for:

- `whentouse.html` — "Appropriate Uses For SQLite". The project's own limits: one writer at a
  time with unlimited readers, the 281 TB / single-disk-file ceiling, CSV-driven analysis in
  the shell, and a closing checklist phrased as observable conditions on the reader's setup.
  The single most useful page for a decision-oriented comparison.
- `wal.html` — the concurrency story that matters in practice, including the constraint that
  WAL does not work over a network filesystem.
- `lts.html` — the durability/file-format axis: bit-for-bit identical files across platforms,
  format stable, support intended through 2050. Statements of *intent by the developers*, so
  claims built on it must stay at that strength.
- `cli.html` §7.5 — `.import`, i.e. ingest as a load step into a table.
- `changes.html` — "Release History", the `release-notes` source type. One 473 KB page
  covering 2000-05-29 to the present, so `dated` is the newest release heading in *your*
  capture and any claim from it is time-of-capture, not permanent.

Note `changes.html` contains no `releaselog/<ver>.html` links, so don't try to grep your way
to a per-release page from it.
