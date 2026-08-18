# evidence/level-1/CLAIM.md — Level 1, Primary source dossier

Session 1 (2026-08-18 local, 2026-08-17 UTC). One criterion is **partially met** and is
flagged as such in criterion 2 below; everything else is met. Read that one first if you are
short of time.

Scope note: the operator scoped this level to **5–8 entries and ≥2 per system** rather than
the 8–12/≥3 in the original text (`OPERATOR_NOTES.md` §4). The dossier has 8 entries, which is
the top of that band and the cap in criterion 1.

---

## Criterion 1 — ≥5 (≤8) entries with a complete §1.1 header, `dated_locator` grepped

**Met.** `sources/` holds **8** entry files, listed with their subject and type:

| key | subject | source_type | dated |
|---|---|---|---|
| `sqlite-whentouse` | sqlite | docs | 2025-05-31 |
| `sqlite-wal` | sqlite | docs | 2026-04-13 |
| `sqlite-lts` | sqlite | docs | 2025-05-31 |
| `sqlite-cli` | sqlite | docs | 2026-05-29 |
| `sqlite-changes` | sqlite | release-notes | 2026-07-24 |
| `duckdb-sigmod19` | duckdb | paper | 2019-06-30 |
| `duckdb-cidr20` | duckdb | paper | 2020-01-12 |
| `duckdb-pvldb-hashjoin` | duckdb | paper | 2025 |

Every entry carries all eleven fields (`key`, `subject`, `title`, `publisher`, `source_type`,
`url`, `dated`, `dated_locator`, `accessed`, `capture_file`, `sha256`) populated with a real
value — no `TBD`, no `n/a`. `evidence/level-1/quote-check.txt` opens each entry's block with a
**dated_locator check**: a `grep -F -c` of the date's printed form against that entry's own
capture, with output. All 8 return `1`.

Two `dated` values need a word, because both are honest at less than full ISO precision and I
would rather you read that here than infer it:

- `duckdb-pvldb-hashjoin` has `dated: 2025`, a **year**, because the paper prints its
  publication date at year granularity only: *"Private Hash Join. PVLDB, 18(8): 2748-2760,
  2025."* on page 1. That exact string is what the date grep matches. The response header
  `Last-Modified: Mon, 28 Jul 2025 04:42:29 GMT` in the capture's `.headers.txt` corroborates
  the year but is not the document's own statement, so it is not what `dated` records.
- `duckdb-sigmod19` and `duckdb-cidr20` have the **first day of the conference** as `dated`,
  because that is the date the paper prints (`SIGMOD ’19, June 30-July 5, 2019, …`;
  `(CIDR ‘20) January 12-15, 2020, …`). The `dated_locator` field says so explicitly in both
  entries.

## Criterion 2 — coverage: ≥2 per system, ≥1 paper, ≥1 release-notes, four scenario axes

**Met on every countable requirement; partially met in spirit on one axis — read the last
paragraph.**

- subject: **5 sqlite, 3 duckdb** (requirement: ≥2 each).
- source_type: **3 paper, 1 release-notes**, 4 docs (requirement: ≥1 paper, ≥1 release-notes).
- primacy: every entry is official project documentation, an official release changelog, or a
  peer-reviewed published paper. Four non-primary documents were fetched and rejected —
  `claims/excluded-sources.md`.

Scenario axes, each with the entries behind it:

| axis | SQLite side | DuckDB side |
|---|---|---|
| larger-than-memory / data size | `sqlite-whentouse#Q2` (single disk file, filesystem size limits) | `duckdb-pvldb-hashjoin#Q1`, `#Q3` (spilling to storage past the memory limit; graceful degradation) |
| write concurrency | `sqlite-wal#Q1`,`#Q2`,`#Q3`; `sqlite-whentouse#Q1` | `duckdb-sigmod19#Q3` (serializable MVCC) |
| ingest formats | `sqlite-cli#Q1`,`#Q2`; `sqlite-whentouse#Q3` | `duckdb-cidr20#Q1` (direct scan of existing files, e.g. CSV) |
| file format / durability | `sqlite-lts#Q1`,`#Q2`,`#Q3`; `sqlite-changes#Q3` | `duckdb-cidr20#Q2`,`#Q3` (single-file format; single-row update efficiency is a stated non-goal) |

**Where this is thinner than it looks, stated before you find it.** All three DuckDB entries
are *papers*; there is **no DuckDB documentation page in the dossier**, and the DuckDB
coverage of the two axes above rests on a 2020 paper (ingest, storage) and a 2025 paper
(memory). This was not an oversight, it was forced, and `sources/CAPTURE_LOG.md` §3d and §3e
record the evidence:

1. `duckdb.org/docs/stable/...` URLs return HTTP 200 with a **569-byte JavaScript redirect
   stub**, not a document. The canonical URL is `/docs/current/...html`.
2. Those canonical pages return only `date:` and `content-type:` headers — **no
   `Content-Length`, no `Last-Modified`, no `ETag`** — under HTTP/2, HTTP/1.1, identity
   encoding, a `Range` request and a repeat request. LEVELS.md L1 criterion 5 requires one of
   those three.
3. They also carry **no date anywhere in the page body** (a date grep over the fetched HTML
   returns nothing; the only version marker is the string `DuckDB v1.5.2`), so `dated_locator`
   could not be satisfied either.

Static PDFs on the same host *do* return `content-length` and `etag`, which is why
`duckdb.org/pdf/*.pdf` captures are used. The consequence for later levels: DuckDB's Parquet
support has **no primary source in this dossier** and must not be asserted at level 3; the
ingest claim that *is* supported is CSV-shaped, via `duckdb-cidr20#Q1`. This belongs in
`claims/gaps.md` at level 2.

One further rejection worth naming: the ICDE 2024 out-of-core paper was fetched successfully
from `duckdb.org/pdf/` (HTTP 200, 1556690 bytes) and would have been the ideal
larger-than-memory source, but its text carries **no publication date at all** — no `©2024
IEEE` line, no conference header — so `dated` could not be located in the capture.
`duckdb-pvldb-hashjoin` was used instead. `sources/CAPTURE_LOG.md` §3b.

## Criterion 3 — ≥2 verbatim quotes per entry, ≥12 words, ≤75 words, complete sentence, locator

**Met.** 24 quotes across 8 entries (4/3/3/2/3/3/3/3), labelled `Q1`…`Qn`. Every quote is a
contiguous span of body prose containing at least one complete sentence. Word counts run
**13 to 50**; the shortest is `sqlite-lts#Q3` ("The intent of the developers is to support
SQLite through the year 2050.", 13 words) and none exceeds 75. No quote is a heading, nav
label, table cell or code comment. Every quote carries a locator: a section heading for the
HTML sources, a section heading **and a page number** for all three PDFs (page numbers were
established by extracting each PDF page individually and searching it, not by estimate).

## Criterion 4 — every quote confirmed in its capture; canonical transcript; no exemptions

**Met.** `evidence/level-1/quote-check.txt` contains **32 checks**: 8 dated_locator greps and
24 quote greps. Each is one copy-pasteable line in the canonical `EVIDENCE.md` §1.4 form —
`tr -s '[:space:]' ' ' < sources/raw/<key>.txt | grep -F -c "<quote>"` — followed by its
output. **Every one returned `1`.**

**Zero quotes claim the PDF grep exemption.** All three PDFs extracted cleanly with
`pdftotext`, so the ≤2-entry / ≤25%-of-quotes allowance is unused (0 of 24).

The checks were also run a second way, as a cross-check of this claim rather than of the
transcript: each `> ` quote line was read back **out of the eight `sources/<key>.md` files as
written** and grepped against its capture. All 24 returned ≥1. That is the path an evaluator
takes — entry → quote → capture — and it closes.

## Criterion 5 — `.src` + `.txt` + `.headers.txt` per entry; sha256s match; no stubs

**Met.** All 24 files exist and are non-empty. `.src` sizes: 7930 to 1756396 bytes; the
smallest, `sqlite-lts.src`, is a real 7930-byte HTML page, not a stub. Each `.headers.txt`
holds the response headers as returned by `curl -D`:

- the five `sqlite.org` captures carry `Date`, `Last-Modified`, `ETag`, `Content-type` **and**
  `Content-length`;
- the two `duckdb.org` PDF captures carry `date`, `content-type`, `content-length`, `etag`;
- the `vldb.org` PDF capture carries `Date`, `Last-Modified`, `Content-Length`, `Content-Type`.

Every capture satisfies `Date` + `Content-Type` + (`Content-Length` or `Last-Modified`/`ETag`).
The `.src` files are as fetched and unedited: the HTML ones contain full markup including the
sqlite.org nav and the site's inline JavaScript, and the PDFs are binary PDFs
(`Content-Type: application/pdf`, and `pdfinfo` reads their page counts).

sha256 reconciliation is pasted at the end of `evidence/level-1/quote-check.txt`: a
`shasum -a 256 sources/raw/*.txt sources/raw/*.src` dump, then a per-entry comparison of the
`sha256:` header field against the file on disk — **8 of 8 MATCH** — and every one of those
values also appears in `sources/CAPTURE_LOG.md`.

## Criterion 6 — capture log with exact fetch and extraction commands

**Met.** `sources/CAPTURE_LOG.md` records per capture: URL, UTC timestamp, exact fetch
command, HTTP status, `.src` byte size, sha256 of both `.src` and `.txt`, and the exact
extraction command (`pandoc -f html -t plain --wrap=none <src> -o <txt>` for HTML,
`pdftotext <src> <txt>` for PDF).

Re-derivation was tested, not assumed: **all eight** extraction commands were re-run against
the stored `.src` and each produced a file whose sha256 equals the logged `.txt`. Two of the
eight — one HTML, one PDF — are pasted into `quote-check.txt` with their output as the
transcript.

Failures are logged with their error output and the decision taken:
`sources/CAPTURE_LOG.md` §3 has the cidrdb.org connection failure, the unreachable author
copy of the ICDE paper, the 404 on `duckdb.org/duckdb-docs.pdf`, the 569-byte
`/docs/stable/` redirect stub, the `duckdb.org` header deficiency, and two failed rejection
candidates (motherduck connection refused, datacamp HTTP 403). **No extraction failed**, so
there are no failed extractions to log.

## Criterion 7 — `claims/excluded-sources.md`, ≥2 rejected, ≥1 traceable to a fetch

**Met, and above the bar.** Four rejected documents, and **all four were actually fetched**
and appear in `sources/CAPTURE_LOG.md` §2 with timestamp, status, byte size and sha256
(requirement: at least one). Each entry gives the URL, the `EVIDENCE.md` §3 clause, and the
observed fact — quoted in ≤10 words and shown with the grep that finds it in the capture,
with output:

1. `duckdb.org/why_duckdb` — vendor marketing page; **no date anywhere** (date grep returns
   `0`) and the framing "leads to far better performance in OLAP queries".
2. `posthog.com/blog/duckdb-vs-sqlite` — undated third-party post (date grep returns `0`);
   "aggregate an entire table faster than SQLite ever could".
3. `betterstack.com/…/duckdb-vs-sqlite/` — third-party guide; "DuckDB might be 10-50 times
   faster than SQLite", a multiplier with no method.
4. `lukas-barth.net/blog/sqlite-duckdb-benchmark/` — third-party benchmark post.

None of these could have been written without opening the document; each rests on a string
that greps to `1` in the stored capture.

---

## Constraint compliance

No SQLite or DuckDB binary was executed. No database file was created. No benchmark was run,
and no measurement made on this machine appears anywhere in the dossier. No money was spent,
and nothing was published — every network action was a `curl` GET or a `WebSearch` for
candidate URLs. `git status` for this level shows only Markdown, text, HTML and PDF artifacts.

## One blocked action

`rm -f` on two zero-byte artifacts of the failed motherduck.com fetch was denied by the
harness safety gate and logged to `PAUSED_ACTIONS.md`. Per `.claude/CLAUDE.md` it was not
retried or routed around. The consequence is visible on disk and is documented in
`sources/CAPTURE_LOG.md` §3f: `sources/rejected/excluded-motherduck-vs.headers.txt` is a
zero-byte file, sha256 `e3b0c442…` (the sha256 of the empty string). It backs no entry and no
exclusion.

## What level 2 should pick up

1. **DuckDB Parquet ingest has no primary source here.** Do not assert it at level 3 unless a
   dated, header-complete DuckDB source is added at level 2; otherwise it is a `gaps.md` entry.
2. **DuckDB's storage-format stability at 1.0.0 has no primary source here** either, for the
   same host reasons. `duckdb-cidr20#Q2` supports the single-file *design*, not a stability
   guarantee — the contrast with `sqlite-lts` must be drawn carefully or not at all.
3. **Version drift is the main calibration risk.** Two DuckDB entries are from 2019 and 2020;
   `duckdb-pvldb-hashjoin#Q2` ("available in the v1.2.0 release") is the one quote that pins a
   claim to a version. Every DuckDB claim should be phrased as what the cited paper states.
4. **`sqlite-cli` has only 2 quotes** — the minimum. If a level-2 claim needs a third
   ingest-side SQLite fact, add it from the same capture rather than fetching again.
