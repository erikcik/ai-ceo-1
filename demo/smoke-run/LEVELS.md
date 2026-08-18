# LEVELS.md — SQLite vs DuckDB for local analytics

**Deliverable:** `REPORT.md`, 900–1200 words, comparing SQLite and DuckDB for a developer
choosing one for a ~5 GB analytical workload on a laptop.

**Hard constraints, from the initialization prompt, binding on every level:**
- No application code is written, built, benchmarked, or run. No SQLite or DuckDB binary is
  executed. Every claim comes from published sources, never from measurement done here.
- Every substantive claim traces to a **primary** source: the projects' official
  documentation, their published papers, or their own release notes. Vendor marketing copy
  and undated blog posts are not primary.
- No money is spent. Nothing is published anywhere. `curl`/`WebFetch` reads of public docs
  are fine; posting, submitting, or publishing is not.

**Budget:** 4 sub-levels, 8 builder sessions. That is two sessions per level on average, and
a level that needs a retry after `NEEDS_WORK` consumes one of them. Where the budget binds
particularly hard is called out per level.

**Decomposition rationale:** sources first, then the claim skeleton, then prose, then an
independent audit. Each level leaves something a stranger can use even if the loop stops:
level 1 alone is a reusable primary-source dossier; level 2 adds a defensible comparison
frame; level 3 produces the deliverable; level 4 is what makes the deliverable trustworthy.
Writing prose before the claim map is what produces unsourceable sentences, so the order is
not cosmetic.

---

## Level 1 — Primary source dossier

**Goal.** Capture, locally and verifiably, the primary sources needed to compare the two
systems, and annotate each with the verbatim passages the report will lean on.

**Acceptance criteria.**

1. `sources/` contains **at least 5** source entry files `sources/<key>.md`, each with the
   full header block specified in `EVIDENCE.md` §1.1, every field populated with a real
   value — including `dated_locator`, naming the anchor, heading, or "last modified" line in
   the capture where the `dated` value appears. `evidence/level-1/quote-check.txt` includes,
   per entry, a grep for that date string against the capture with its output. At most 8
   entries — this level is not scored on volume, and an entry no claim will ever use is worth
   less than one the comparison needs (see level 2, criterion 7). Note that level 2 criterion
   3 and level 3 criterion 4 both require **≥6 distinct keys**, so a dossier of exactly 5
   entries cannot satisfy the later levels: capture 6–8 unless a fetch fails and is logged.
2. Coverage: at least 2 entries whose `subject` is `sqlite`, at least 2 whose `subject` is
   `duckdb`. Across the dossier, `source_type` includes at least one `paper` and at least
   one `release-notes`. Every entry is primary under `EVIDENCE.md` §3. Coverage is driven by
   the scenario, not by feature-tour breadth: larger-than-memory behaviour, write
   concurrency, ingest formats, and file format/durability each have at least one entry
   behind them.
3. Every entry has **≥2 verbatim quotes** labeled `Q1`, `Q2`, …, each ≤75 words and each a
   contiguous span of **≥12 words containing at least one complete sentence** of body prose,
   each with a locator (section heading, anchor, or PDF page number). Headings, nav labels,
   table cells, and code-comment fragments are not quotes.
4. Every quote is confirmed present in its capture. `evidence/level-1/quote-check.txt`
   contains, for **every** quote in the dossier, the canonical command from `EVIDENCE.md`
   §1.4 and its output, with a match count ≥1, written as a copy-pasteable one-liner the
   evaluator can re-run unmodified. A quote may be **grep-exempt only** if the entry records
   in `sources/CAPTURE_LOG.md` the extraction command that was attempted and its failing
   output; the exemption is stated per-quote in `quote-check.txt` and the quote cites a PDF
   page number. **At most 2 entries and at most 25% of quotes may be exempt.**
5. `sources/raw/` holds, for every entry, **both** `sources/raw/<key>.src` (the bytes as
   fetched, unedited) **and** `sources/raw/<key>.txt` (the text quotes are checked against),
   plus `sources/raw/<key>.headers.txt` (the response headers as fetched, e.g. `curl -D`,
   including `Date`, `Content-Type`, and `Content-Length` or `Last-Modified`/`ETag`). Each
   capture's sha256 matches the entry header and `sources/CAPTURE_LOG.md`. No capture is a
   redirect stub or an empty body — check the byte counts. A `.txt` with no `.src` behind it,
   or an `.src` that is a hand-composed document rather than fetched bytes, fails this
   criterion outright.
6. `sources/CAPTURE_LOG.md` records, per capture: URL, UTC timestamp, exact fetch command,
   HTTP status, byte size, sha256, and the **exact** text-extraction command — exact enough
   that re-running it on the `.src` reproduces the `.txt` byte for byte. Failed fetches, and
   failed extractions claimed as grep exemptions, are logged with their error output and the
   decision taken.
7. `claims/excluded-sources.md` lists **≥2** documents considered and rejected as
   non-primary, each with its URL, the `EVIDENCE.md` §3 clause it falls under, and the
   *observed* fact that triggers it (the missing date, the marketing framing quoted in ≤10
   words). **At least one of them appears in `sources/CAPTURE_LOG.md`** as a fetch that was
   made and then rejected. An exclusion that could have been written without ever seeing the
   document does not count toward the two.

**Evidence artifacts.** `sources/<key>.md` (5–8), `sources/raw/*` (`.src` + `.txt` +
`.headers.txt` per entry), `sources/CAPTURE_LOG.md`,
`claims/excluded-sources.md`, `evidence/level-1/quote-check.txt`, `evidence/level-1/CLAIM.md`.

**Dependencies.** None.

**Where the budget binds.** This is the fetch-heavy level and the likeliest to need a second
session. Capture first and annotate second, so a session that runs long still leaves usable
captures plus a log. Do not exceed 8 sources to buy safety margin — a 6th source is worth
less than a verified 5th, and an entry that no claim ends up citing is worth nothing at all.

---

## Level 2 — Comparison dimensions and claim → source map

**Goal.** Fix the axes the report compares on, and bind every claim it intends to make to a
specific quote, before a single sentence of prose is written.

**Acceptance criteria.**

1. `claims/dimensions.md` names **6–9** comparison dimensions, each with 1–2 sentences on
   why it matters *specifically* for a ~5 GB analytical workload on a laptop, and each
   naming **what the reader could observe about their own workload** to know whether that
   dimension is decisive for them — a data-size threshold, a concurrency pattern, an ingest
   format, a durability requirement. Generic database-comparison axes with no bearing on that
   scenario do not count toward the six; "performance" or "ease of use" as a bare axis does
   not count.
2. `claims/claim-map.md` is a table with one row per intended substantive claim, columns:
   claim id (`C1`, `C2`, …), dimension, the claim in one sentence, system (`sqlite` /
   `duckdb` / `both`), `key#Qn`, a short verbatim fragment of the supporting quote, and
   status (`OK`, or later `WEAKENED` / `DROPPED` with the reason).
3. **≥14** claim rows resting on **≥10 distinct `key#Qn` pairs across ≥6 distinct keys, with
   no more than 3 rows per `Qn`**; every dimension covered by ≥1 row, and for each dimension
   where the systems differ, ≥1 row per system. Rows that restate the same fact in different
   words count once toward the fourteen.
4. Every `key` referenced exists in `sources/` and every `Qn` exists in that entry.
   `evidence/level-2/map-check.txt` shows the commands and output verifying that each
   distinct `key#Qn` resolves to a real quote.
5. `claims/gaps.md` lists **≥3** questions this reader would want answered that the primary
   sources do not answer — a head-to-head benchmark on this exact 5 GB workload being the
   obvious one — and states plainly that the report will not assert them.
6. No claim row cites a document listed in `claims/excluded-sources.md`, and no claim row
   asserts a number or behaviour absent from the quote it cites.
7. Dossier coverage closes both ways: every dimension in `claims/dimensions.md` has ≥1
   primary source behind it in `sources/`, and every `sources/<key>.md` entry is cited by ≥1
   claim row or has been moved to `sources/unused/` with a one-line note saying why it was
   captured and not used. The dossier is scored by coverage, not by entry count.

**Evidence artifacts.** `claims/dimensions.md`, `claims/claim-map.md`, `claims/gaps.md`,
`evidence/level-2/map-check.txt`, `evidence/level-2/CLAIM.md`.

**Dependencies.** Level 1.

**Where the budget binds.** If level 1 revealed a thin spot (say, nothing primary on
DuckDB's larger-than-memory or concurrency behaviour), fix it by adding one source *here*,
logged the same way as level 1, rather than opening a new session for it.

---

## Level 3 — Write `REPORT.md`

**Goal.** Produce the deliverable: a decision-oriented, fully cited 900–1200 word comparison
built from the claim map.

**Acceptance criteria.**

1. `REPORT.md` exists. Body word count, measured by
   `awk '/^## Sources/{exit} {print}' REPORT.md | wc -w`, is **900–1200**.
   `evidence/level-3/wordcount.txt` records that command and its output. The band is hard:
   any count outside it is an unmet criterion, with no margin.
2. The report addresses the stated reader and the stated scenario, and contains an explicit
   recommendation section giving the conditions under which each system is the right choice
   for ~5 GB local analytics — not a both-are-great non-answer. The recommendation states
   **≥3 conditions, each an observable property of the reader's own setup** (a data-size
   relationship such as fits-in-RAM vs exceeds-it, a concurrency pattern such as the number
   of concurrent writers, an ingest format, or a durability/embedding requirement), each
   checkable without running either system. Workload adjectives — "analytical", "heavy",
   "fast" — are not conditions.
3. Every substantive claim carries an inline `[key]` citation. A `## Sources` section at the
   end lists each cited key with title, publisher, URL, document date, and access date,
   matching the corresponding `sources/<key>.md` header **exactly, field for field**. A
   disagreement in any of title, publisher, URL, `dated`, `accessed` is a traceability defect,
   not a cosmetic one.
4. **≥6 distinct** source keys are cited, and every cited key exists in `sources/`.
5. The report is built from the map: **≥12** of the claim rows in `claims/claim-map.md`
   appear in it. `evidence/level-3/claim-coverage.md` maps, for each, the **`REPORT.md` line
   number and the exact sentence text** → claim id → `key#Qn`, so the evaluator can Read that
   line and see the claim asserted there. A coverage row whose location does not match the
   report is a failed row, not a formatting slip.
6. No performance figure, capability statement, version fact, or limit appears that is not
   traceable to a quote in `sources/`. No benchmark was run: the git diff for this level
   contains no code, no database files, and no measurement output.
7. A short "Limits of this comparison" passage reflects `claims/gaps.md`, naming what the
   primary sources do not settle.

**Evidence artifacts.** `evidence/level-3/wordcount.txt`,
`evidence/level-3/claim-coverage.md`, `evidence/level-3/CLAIM.md`. (`REPORT.md` is the
deliverable under review, not evidence — see `EVIDENCE.md` §3.)

**Dependencies.** Level 2.

**Where the budget binds.** 900–1200 words for 14+ claims is tight. Cutting a dimension is
better than compressing every claim into an uncitable generality; if a dimension is dropped,
say so in `evidence/level-3/CLAIM.md`.

---

## Level 4 — Citation audit and final pass

**Goal.** Re-verify the finished report end to end as an adversarial reader would, fix or
remove whatever fails, and leave the verification transcript on disk.

**Acceptance criteria.**

1. `evidence/level-4/citation-audit.md` has one row per substantive sentence in the final
   `REPORT.md`: line number and first ~8 words, the `key#Qn` it rests on, PASS/FAIL/
   `UNCHECKED`, and a note. In the final state every row reads PASS, or names the edit made
   to get there. An `UNCHECKED` row with its reason is acceptable **only** where the claim it
   covers has been removed or weakened in `REPORT.md`, or where it is one of ≤3 such rows and
   `evidence/level-4/CLAIM.md` names them as the residual risk. `UNCHECKED` rows for claims
   left standing in the report are FAILs, not honesty.
2. `evidence/level-4/verify.txt` contains re-run output of all four checks, with output
   visible: the canonical quote check across every quote cited by the report, `shasum -a
   256` over `sources/raw/*` compared against `sources/CAPTURE_LOG.md`, a re-run of the
   logged extraction command on at least one `.src` showing that the resulting sha256 matches
   the logged `.txt`, and the body word count command.
3. Any claim that could not be re-verified was **removed or weakened** in `REPORT.md`, and
   the audit names each such edit. "Could not re-verify but kept it" is a fail.
4. Final `REPORT.md` still satisfies level 3 criteria 1–4 (word band, recommendation,
   citations resolving to `## Sources`, ≥6 distinct keys).
5. `evidence/level-4/CLAIM.md` states residual risks honestly: which claims rest on a single
   source, which are version-dependent, what a reader should re-check before relying on the
   report.

**Evidence artifacts.** `evidence/level-4/citation-audit.md`, `evidence/level-4/verify.txt`,
`evidence/level-4/CLAIM.md`.

**Dependencies.** Level 3.

**Where the budget binds.** This is the last level; if sessions run out mid-audit, a partial
audit that honestly marks unchecked rows as `UNCHECKED` is far more useful than a completed
table of unverified PASSes — but honesty is only scored that way on the terms in criterion 1:
at most 3 such rows, named in `CLAIM.md` as the residual risk, or the claims they cover cut
or weakened in `REPORT.md`. Leaving a claim standing on an `UNCHECKED` row is a FAIL under
Traceability, not a partial pass.
