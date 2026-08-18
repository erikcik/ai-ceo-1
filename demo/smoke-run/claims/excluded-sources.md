# claims/excluded-sources.md — documents considered and rejected as non-primary

Four documents. **All four were actually fetched**, and each appears in
`sources/CAPTURE_LOG.md` §2 with its UTC timestamp, HTTP status, byte size and sha256; the
captures are on disk under `sources/rejected/`. Every "observed fact" below is a string in
that capture, and the command that shows it is printed with its output, so none of these
rejections could have been written without opening the document.

Nothing listed here may be cited by any claim row in later levels.

---

## 1. Why DuckDB — https://duckdb.org/why_duckdb

- **Capture:** `sources/rejected/excluded-why-duckdb.src` (276241 bytes, HTTP 200,
  2026-08-17T22:30:04Z), text at `sources/rejected/excluded-why-duckdb.txt`.
- **`EVIDENCE.md` §3 clause:** "vendor marketing pages" — and, separately, the clause
  requiring an official project page to be *dated* before it can serve as documentation or a
  release note.
- **Observed fact 1 — no date anywhere in the document.** The capture contains no ISO date, no
  "Month D, YYYY" date, and no "last updated"/"last modified" line:

```sh
grep -c -E '20[0-9]{2}-[0-9]{2}-[0-9]{2}|(January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{1,2}, 20[0-9]{2}|[Ll]ast (updated|modified)' sources/rejected/excluded-why-duckdb.txt
```
```
0
```

- **Observed fact 2 — comparative performance framing, asserted rather than measured**
  (8 words, quoted from the page):

```sh
tr -s '[:space:]' ' ' < sources/rejected/excluded-why-duckdb.txt | grep -F -c "leads to far better performance in OLAP queries"
```
```
1
```

- **Why it matters that this one is excluded:** it is published by the DuckDB project itself,
  under section headings "Fast", "Feature-Rich", "Free", "Thoroughly Tested". It is the
  hardest case in this dossier — a project's own marketing page looks like its documentation
  until you check the date and the framing. The comparable *facts* it states (vectorized
  execution, MVCC, single-file format) are all available from `duckdb-sigmod19` and
  `duckdb-cidr20`, which are dated papers, so nothing is lost by excluding it.

---

## 2. In-depth: DuckDB vs SQLite (PostHog) — https://posthog.com/blog/duckdb-vs-sqlite

- **Capture:** `sources/rejected/excluded-posthog-vs.src` (1052929 bytes, HTTP 200,
  2026-08-17T22:34:30Z).
- **`EVIDENCE.md` §3 clause:** "undated blog posts", third-party.
- **Observed fact 1 — no date in the capture** (same grep as above):

```sh
grep -c -E '20[0-9]{2}-[0-9]{2}-[0-9]{2}|(January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{1,2}, 20[0-9]{2}|[Ll]ast (updated|modified)' sources/rejected/excluded-posthog-vs.txt
```
```
0
```

- **Observed fact 2 — unfalsifiable comparative claim** (10 words, quoted from the post):

```sh
tr -s '[:space:]' ' ' < sources/rejected/excluded-posthog-vs.txt | grep -F -c "aggregate an entire table faster than SQLite ever could"
```
```
1
```

---

## 3. DuckDB vs SQLite: Choosing the Right Embedded Database (Better Stack) — https://betterstack.com/community/guides/scaling-python/duckdb-vs-sqlite/

- **Capture:** `sources/rejected/excluded-betterstack-vs.src` (177066 bytes, HTTP 200,
  2026-08-17T22:34:34Z).
- **`EVIDENCE.md` §3 clause:** third-party publication; "third-party benchmark posts".
- **Observed fact — a speed multiplier with no method and no citation** (8 words, quoted):

```sh
tr -s '[:space:]' ' ' < sources/rejected/excluded-betterstack-vs.txt | grep -F -c "DuckDB might be 10-50 times faster than SQLite"
```
```
1
```

  This is precisely the shape of claim `RUBRIC.md` Calibration example **A 1** names as a
  floor score. It is also the tempting one: it answers the reader's question directly, and no
  primary source in this dossier does. It stays out, and `claims/gaps.md` will say so at
  level 2.

---

## 4. Benchmarking DuckDB vs SQLite for Simple Queries (Lukas Barth) — https://www.lukas-barth.net/blog/sqlite-duckdb-benchmark/

- **Capture:** `sources/rejected/excluded-lukasbarth-bench.src` (33780 bytes, HTTP 200,
  2026-08-17T22:34:30Z).
- **`EVIDENCE.md` §3 clause:** "third-party benchmark posts".
- **Observed fact — the post's own statement of what it is** (10 words, quoted):

```sh
tr -s '[:space:]' ' ' < sources/rejected/excluded-lukasbarth-bench.txt | grep -F -c "whether DuckDB or SQLite is the better (read: faster) alternative"
```
```
1
```

  A benchmark run by someone else on their own hardware and their own queries. It is not
  primary, and its numbers are not transferable to a 5 GB laptop workload.

---

## Also considered and not fetched

`sources/CAPTURE_LOG.md` §3f records two further rejection candidates whose fetches failed
(motherduck.com, connection refused; datacamp.com, HTTP 403). They are **not** listed above,
because an exclusion that rests on nothing observed in the document is the failure mode
`EVIDENCE.md` §2 names in its list of worthless instances.
