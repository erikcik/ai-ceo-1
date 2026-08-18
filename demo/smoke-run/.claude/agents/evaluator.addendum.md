# Evaluator addendum — SQLite vs DuckDB sourced comparison

Domain-specific checks. These add strictness. They do not waive any acceptance criterion in
`LEVELS.md`, do not lower the bar in `RUBRIC.md`, and do not change the verdict format.

## Re-run the builder's own verification; do not read it

The central defect in this domain is a quote that does not exist in the source. The builder's
`quote-check.txt` / `verify.txt` transcripts are claims about commands, not results. For **at
least four quotes** that the report actually relies on, run the canonical check yourself:

```sh
tr -s '[:space:]' ' ' < sources/raw/<key>.txt | grep -F -c "<quote text on one line>"
```

A `0` where the builder recorded a match is a Traceability finding naming the quote and the
file. Also reconcile at least three sha256 values:

```sh
shasum -a 256 sources/raw/<key>.txt
```

against both `sources/<key>.md` and `sources/CAPTURE_LOG.md`. A mismatch means the capture
changed after it was logged; say so explicitly, because the innocent explanation (re-fetch
without updating the log) and the bad one (capture edited to make a quote match) look
identical from disk and both invalidate the chain.

## Sniff tests specific to this material

- **Stub captures.** `wc -c sources/raw/*` — a capture of a few hundred bytes is a redirect
  or a JS shell, not a document. An entry quoting three paragraphs from a 473-byte file is a
  fabrication, not an oversight.
- **Invented numbers.** Grep the report for digits. Every figure — a version number, a size
  limit, a page count, a default — must appear in a captured source. Numbers are where
  plausible invention concentrates.
- **Performance claims.** No primary source is likely to benchmark this exact 5 GB laptop
  workload. Any sentence asserting one system is *N× faster*, or faster *by a stated margin*,
  needs a quote containing that comparison. "Columnar storage is faster for analytics" stated
  as the report's own finding rather than as a sourced design rationale is a Calibration
  finding.
- **Constraint violation.** `git log --stat` and `git diff` for the level: any `.py`, `.sql`,
  `.db`, `.duckdb`, `.sqlite`, `.parquet`, or timing output means something was run. That is
  Craft criterion score 1 and an automatic `NEEDS_WORK`.
- **Dates.** An entry with `dated:` empty, `n/a`, or a date later than `accessed:` fails
  Source primacy. Undated documents are excluded by `EVIDENCE.md` §3.
- **Key drift.** Every `[key]` in `REPORT.md` must have a `sources/<key>.md`; every key in
  `## Sources` must match that file's header fields (title, publisher, URL, dates) rather
  than a prettier version of them.

## On the ARS plugin

This environment loads an academic-writing plugin whose agents (`report_compiler_agent`,
`synthesis_agent`, and the `/ars-*` commands) can produce polished APA-styled prose and
bibliographies with no captured source behind them. Fluent, well-formatted output is
therefore **not** a signal of good sourcing here, and a bibliography that is longer than the
dossier is a red flag: check that every entry in the report's `## Sources` has a file in
`sources/` and a capture in `sources/raw/`. Extra sources listed but not captured are a
Source primacy finding.

## Tools this evaluator would benefit from

Not granted in `evaluator.md`; noted for the operator, not to be added from inside a session:

- **`WebFetch`** — to spot-check one or two cited URLs against the stored capture, which is
  the only way to catch a capture that was fabricated wholesale rather than edited. Without
  it, judge internal consistency (sha256, byte size, capture log, grep) and say in the
  verdict that live re-fetch was not possible.

## Weighting reminder

Judge the level in front of you. Level 1 has no prose, so do not fault it for lacking
argument; level 3 has no new captures, so do not fault it for not re-fetching. Traceability
and Source primacy are mandatory ≥4 at every level.
