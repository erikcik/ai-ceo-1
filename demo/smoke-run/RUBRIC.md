# RUBRIC.md — how work on this task is scored

Five criteria. The evaluator cites them **by name** in every finding. Scores are 1–5 per
criterion, judged against the level's acceptance criteria in `LEVELS.md` and the evidence
taxonomy in `EVIDENCE.md`.

The bias throughout is toward things that are **cheap to check and expensive to fake**. A
long bibliography is cheap to fake and expensive to check, so it is worth nothing here. A
quote that must appear character-for-character in a locally stored capture is the opposite,
so that is what carries the weight.

---

## Criterion 1 — Traceability

*Measures:* whether each substantive claim can be followed, by a stranger with a shell, from
the sentence to a citation key to a verbatim quote to a captured document that demonstrably
contains that quote. *Why it matters here:* the whole task is "sourced comparison". Without
the chain, the deliverable is indistinguishable from model recall dressed in citations, and
model recall about database internals is exactly what the constraint was written to exclude.

- **1** — Claims carry no citations, or citation keys that resolve to nothing. Quotes appear
  in source entries but no capture exists, so nothing can be checked.
- **2** — Citations exist but the chain breaks in most places: quotes are paraphrases, or
  captures are stubs, or the quote-check transcript shows commands with no output.
- **3** — The chain closes for most claims. A minority of quotes fail the canonical check, or
  a few claims cite a source whose quote is topically related but does not contain the claim.
- **4** — The evaluator, sampling **at least four** quotes the report or claim map relies on
  plus **at least three** sha256 values, reproduces the builder's counts and hashes; every
  remaining cited quote's transcript shows a real command with a count ≥1 in a
  copy-pasteable one-line form; and every claim's quote contains the claim's substance.
  Provenance is on disk, not asserted: every capture has both an unedited
  `sources/raw/<key>.src` and a `sources/raw/<key>.txt`, `sources/raw/<key>.headers.txt`
  holds the response headers as fetched (`curl -D`) including `Date`, `Content-Type`, and
  `Content-Length` or `Last-Modified`/`ETag`, and `sources/CAPTURE_LOG.md` records per
  capture the URL, UTC timestamp, HTTP status, byte size, sha256, the exact fetch command
  **and the exact extraction command**. At most cosmetic defects (one locator missing).
- **5** — All of 4, plus the verification is reproducible without the builder: transcripts
  show real output, sha256s reconcile against `CAPTURE_LOG.md`, the evaluator's own re-run
  of the canonical command reproduces the builder's counts, and the evaluator re-runs the
  recorded extraction command on the `.src` and gets a file whose sha256 matches the logged
  `.txt`.

### Traceability — caps that override the descriptors

These are not judgment calls. Where one applies, it sets the ceiling no matter how the
descriptors read.

- **Fabricated corpus.** A `.txt` with no `.src` behind it, or an `.src` that is a
  hand-composed document rather than the fetched bytes (no HTML/PDF structure, no headers,
  no boilerplate), is Traceability ≤ 2 regardless of how well the greps pass. Sniff test: an
  HTML capture with no `<`, no tags, and no nav/footer boilerplate is not a fetched page.
- **Contradicted transcript.** Any `0` where the builder recorded a match caps Traceability
  at 2.
- **Grep exemption.** A quote may be grep-exempt only if the entry records the extraction
  command that was attempted and its failing output in `sources/CAPTURE_LOG.md`. At most 2
  entries and at most 25% of quotes may be exempt. A dossier in which more than half the
  quotes are exempt scores Traceability ≤ 2. For each exempt quote the evaluator opens the
  cited PDF page with the Read tool and confirms the text; a page that does not contain it
  is Traceability 1.
- **Quote substance.** Each quote is a contiguous span of **≥12 words containing at least
  one complete sentence** of body prose. Headings, nav labels, table cells, and code-comment
  fragments do not qualify as quotes. A dossier where the median quote is under 12 words
  scores Traceability ≤ 3 regardless of grep results.
- **Source-list drift.** A `## Sources` entry that disagrees with its `sources/<key>.md`
  header in any of title, publisher, URL, `dated`, `accessed` is a Traceability defect — it
  breaks key resolution — not a cosmetic one, and caps Traceability at 3.
- **Coverage-table drift.** Rows in `evidence/level-3/claim-coverage.md` must carry the
  `REPORT.md` line number and the exact sentence text, so the evaluator can Read that line.
  A coverage table whose locations do not match the report caps Traceability at 3 (and Craft
  at 2).
- **`UNCHECKED` audit rows.** An audit row marked `UNCHECKED` with the reason is not a defect
  **provided the claim it covers has been removed or weakened in `REPORT.md`**, or the row is
  one of ≤3 and `CLAIM.md` names them as the residual risk. `UNCHECKED` rows for claims left
  standing in the report are FAILs, not honesty.

### Worked examples — Traceability

**A 1.** `REPORT.md` contains: *"DuckDB is roughly 10× faster than SQLite on analytical
scans."* No citation. No corresponding row in `claims/claim-map.md`. Nothing in `sources/`
contains the number 10. This is model recall presented as research — a floor score, and if
it appears in a finished report it also fails Calibration.

**A 3.** `REPORT.md` says: *"DuckDB uses a vectorized execution engine [duckdb-cidr19]."*
`sources/duckdb-cidr19.md` exists with a plausible header, and Q1 reads *"DuckDB uses a
vectorized interpreted execution engine, which balances performance and portability."*
But `sources/raw/duckdb-cidr19.txt` is absent — only the PDF was saved — and
`evidence/level-1/quote-check.txt` lists the file with no page number and no exemption note.
The claim is probably right and the chain is unverifiable, which is a 3, not a 4: the
evaluator has no way to distinguish this from a well-guessed quote.

**A 5.** `REPORT.md` says: *"DuckDB's execution engine is vectorized rather than
tuple-at-a-time [duckdb-cidr19]."* `claims/claim-map.md` row `C4` binds that sentence to
`duckdb-cidr19#Q1`. `sources/duckdb-cidr19.md` Q1 quotes the sentence with locator
"§3.2 Execution Engine, page 3". `sources/raw/duckdb-cidr19.src` (the fetched PDF),
`sources/raw/duckdb-cidr19.headers.txt` (`Content-Type: application/pdf`, `Last-Modified`)
and `sources/raw/duckdb-cidr19.txt` all exist; the `.txt`'s sha256 matches the header and
`CAPTURE_LOG.md`, which logs the extraction as `pdftotext -layout
sources/raw/duckdb-cidr19.src sources/raw/duckdb-cidr19.txt`. `evidence/level-1/quote-check.txt`
shows `tr -s '[:space:]' ' ' < sources/raw/duckdb-cidr19.txt | grep -F -c "vectorized
interpreted execution engine"` → `1`. The evaluator runs it and also gets `1`, re-runs the
`pdftotext` line against the `.src` and gets a file with the logged sha256.

---

## Criterion 2 — Source primacy

*Measures:* whether the sources actually meet the constraint — official documentation,
published papers, official release notes — and whether non-primary material was identified
and kept out rather than never considered. *Why it matters here:* the initialization prompt
names this as the binding constraint, and the failure mode is subtle: a project's own
marketing page looks exactly like its documentation until you read the URL and the date.

- **1** — Sources are blog posts, third-party benchmarks, forum answers, or undated pages.
  No `claims/excluded-sources.md`.
- **2** — A mix, with non-primary sources cited in the report, or entries whose `dated` field
  is empty or invented.
- **3** — Mostly primary, with one or two borderline entries admitted without argument, or an
  exclusion list that is pro forma (fewer than two entries, or reasons like "not useful").
- **4** — Every cited source is primary, and every entry's `dated` value is *locatable*: the
  header carries a `dated_locator` (the anchor, heading, or "last modified" line in the
  capture where the date appears), and `evidence/level-1/quote-check.txt` includes a grep for
  that date string against the capture with its output. The required paper and release-notes
  types are present. `claims/excluded-sources.md` names ≥2 rejected documents with URL, the
  `EVIDENCE.md` §3 clause, and the *observed* fact that triggers it (the missing date, the
  marketing framing quoted in ≤10 words), and **at least one of them appears in
  `sources/CAPTURE_LOG.md`** as a fetch that was made and then rejected.
- **5** — All of 4, and the borderline calls are argued rather than assumed: where an
  official project blog post is used as a release note, the entry says why it functions as
  one; where a doc page is versioned, the entry records which version it describes.

### Source primacy — caps that override the descriptors

- A `dated` value that appears nowhere in the capture — no `dated_locator`, or a grep for the
  date string against the capture that returns nothing — is Source primacy ≤ 2. An invented
  date launders a non-primary source into a primary-looking one, which is the exact failure
  this criterion exists to catch.
- Exclusions that could have been written without ever seeing the document — no URL, no
  observed fact quoted from it, no corresponding fetch in `sources/CAPTURE_LOG.md` — score 3,
  however many are listed.

### Worked examples — Source primacy

**A 1.** The dossier's DuckDB coverage rests on a 2023 third-party post comparing embedded
databases and on `duckdb.org`'s front-page tagline. Neither is documentation, a paper, or a
release note; the post is not the project's own. `claims/excluded-sources.md` does not exist.

**A 3.** Seven of eight entries are `sqlite.org` and `duckdb.org` documentation pages with
dates. The eighth is a conference talk write-up on a personal site, admitted with the header
`source_type: docs` and no comment. `claims/excluded-sources.md` lists one rejected item with
the reason "blog". Direction is right; the judgment is not shown.

**A 5.** The dossier includes `sqlite.org` documentation pages (each entry recording the
page's "last change" date and, in `dated_locator`, the footer line where that date is printed,
grepped against the capture in `quote-check.txt`), the SQLite release history page as
`release-notes`, the DuckDB
CIDR paper as `paper`, DuckDB documentation pages recording the doc version they describe,
and one DuckDB release announcement whose entry notes: *"used as release notes: it is
published by the project, dated, and enumerates changes in that version; no marketing claims
are quoted from it."* `claims/excluded-sources.md` lists three rejected documents — an
undated benchmark post, a vendor comparison page, and a Stack Overflow answer — each with the
`EVIDENCE.md` §3 clause it falls under.

---

## Criterion 3 — Decision utility

*Measures:* whether the artifacts help the actual reader — a developer choosing between the
two for a ~5 GB analytical workload on a laptop — make that specific choice. *Why it matters
here:* a comparison that recites both feature lists and concludes "it depends" is worthless
even if every sentence is perfectly cited.

- **1** — Generic database comparison; the 5 GB, single-machine, laptop, analytical framing
  never shapes anything. No recommendation.
- **2** — Facts are relevant but assembled as parallel feature lists; the reader must do all
  the synthesis. Recommendation is a hedge.
- **3** — Dimensions are relevant and a recommendation exists, but the conditions attached to
  it are vague ("if you need speed") rather than checkable by the reader.
- **4** — Dimensions are chosen for this scenario and justified as such, and the
  recommendation contains **≥3 conditions each stated as an observable property of the
  reader's own setup** — a data-size relationship (fits in RAM / exceeds it), a concurrency
  pattern (number of concurrent writers), an ingest format, or a durability/embedding
  requirement (whether the file is also the application's transactional store) — and each
  condition is checkable without running either system. Conditions phrased as workload
  adjectives ("analytical", "heavy", "fast") do not count.
- **5** — All of 4, and the tradeoffs are sharp enough to change a decision: at least one
  passage states what the recommended choice **costs** the reader, cited, plus one named case
  where the answer is "use both, for different jobs" with the specific division of labour.

### Decision utility on levels 1–2 — read against the scaffolding, not prose

There is no report to score yet, so the criterion is applied to the artifacts that exist.

- **At level 1**, score 4 requires the dossier's coverage to be *driven by the scenario*:
  sources captured on larger-than-memory behaviour, write concurrency, ingest formats, and
  file-format/durability — not eight pages of general feature documentation.
- **At level 2**, score 4 requires each dimension in `claims/dimensions.md` to name **what
  the reader could observe about their own workload** to know whether that dimension is
  decisive for them (a data-size threshold, a concurrency pattern, an ingest format, a
  durability requirement), and `claims/claim-map.md` to carry, for each dimension where the
  systems differ, ≥1 row per system. "Performance" or "ease of use" as a bare axis does not
  count toward the six.
- **The dossier is scored by coverage, not by entry count.** Every dimension in
  `claims/dimensions.md` must have ≥1 primary source behind it in `sources/`, and by the end
  of level 2 every `sources/<key>.md` entry must be cited by ≥1 claim row or moved to
  `sources/unused/` with a one-line note. An uncited entry adds nothing to Decision utility;
  a dimension with no source caps it at 3.

---

## Criterion 4 — Calibration

*Measures:* whether claims are exactly as strong as the sources support — no smuggled
numbers, no experiment-flavoured statements, gaps named rather than filled. *Why it matters
here:* benchmarking is forbidden, so every quantitative or comparative-performance statement
is a place where a plausible-sounding invention can enter, and it will read as authoritative.

- **1** — Contains figures, timings, or head-to-head performance results with no source, or
  results from something run on this machine.
- **2** — Sources exist but claims routinely overreach them: a quote about columnar storage
  becomes a claim about query latency; a doc's "may" becomes the report's "will".
- **3** — Mostly proportionate, with a few overreaches or a `claims/gaps.md` that is thin or
  not reflected in the report.
- **4** — Claims match their quotes in strength and scope; version-dependence is flagged;
  `claims/gaps.md` names the real gaps and the report's "Limits" passage reflects them.
- **5** — All of 4, plus restraint that is **traceable in the artifacts**: at least one claim
  row in `claims/claim-map.md` marked `DROPPED` or `WEAKENED` with the reason and the quote
  that failed to support it, or an edit named in `evidence/level-4/citation-audit.md`, **and**
  the corresponding entry in `claims/gaps.md`, **and** the report passage reflecting it. A
  statement of restraint in prose with no dropped or weakened claim behind it scores 3, not 5.
  On the `CLAIM.md` files: *where* a criterion is unmet, `CLAIM.md` says so before the
  evaluator finds it; where all are met, the `CLAIM.md` makes no assertion the artifact does
  not show.

### Worked examples — Calibration

**A 1.** *"On a 5 GB Parquet dataset, DuckDB completes a typical group-by scan in under two
seconds, while SQLite takes over a minute."* No citation could support this: no primary
source benchmarks this workload, and running it here is forbidden. Invented specificity.

**A 3.** *"DuckDB handles datasets larger than memory."* The cited quote says larger-than-
memory processing is supported for certain operators with spilling to disk. The claim drops
the qualification. Nearby claims are proportionate and `claims/gaps.md` exists but lists only
"performance comparisons".

**A 5.** *"DuckDB's documentation describes support for processing datasets larger than
memory by spilling intermediates to disk, though it does not characterise the performance
cost, and no primary source benchmarks either system on a 5 GB workload — so this report
makes no speed claim [duckdb-docs-memory]."* Behind that sentence there is a diff, not just
a disclaimer: `claims/claim-map.md` row `C9` — originally *"DuckDB is faster than SQLite on
larger-than-memory scans"* — is marked `WEAKENED`, with the reason and the quote that failed
to support it; `claims/gaps.md` names the missing head-to-head benchmark, the absence of
laptop-hardware guidance, and the version drift between the doc version captured and the
version a reader will install; and the "Limits" passage carries all three. The prose above is
the *last* of the four artifacts, not a substitute for them — copying the sentence without the
`WEAKENED` row scores 3.

---

## Criterion 5 — Craft and constraint compliance

*Measures:* the mechanical contract — word band, structure, citation formatting, evidence
files where `EVIDENCE.md` says they live, handoff (`PROGRESS.md` current and under budget,
`memory/INDEX.md` exactly one line per file in `memory/`), and no forbidden action taken.
*Why it matters here:* these are the parts a reader checks in thirty seconds, and failing
them costs the rest of the work its credibility.

- **1** — The deliverable is missing, or a forbidden action was taken (code run, benchmark
  executed, anything published).
- **2** — Body word count outside 900–1200 — **any amount, no margin** — or artifacts
  scattered outside the taxonomy's paths, inconsistent or broken citation keys, handoff stale
  or over budget, or a `claim-coverage.md` whose locations do not match the report.
- **3** — Contract mostly met with real defects: a few keys formatted inconsistently,
  `memory/INDEX.md` out of sync. (A `## Sources` list disagreeing with a source entry header
  is *not* scored here — it is a Traceability defect and caps that criterion at 3.)
- **4** — Word count in band and recorded with its command; all artifacts at the specified
  paths; citation keys uniform and resolving; verification transcripts pasted as
  copy-pasteable one-liners with their output; handoff current and within budget.
- **5** — All of 4, and the artifacts are pleasant to audit: the source list matches the
  entry headers field for field, the evidence files are ordered and skimmable, and the report
  reads as two clean pages rather than a citation-studded wall.

---

## The passing bar

- **Traceability and Source primacy are mandatory: each must score ≥ 4.** These encode the
  initialization prompt's binding constraint; a level cannot pass by being well written.
- **Calibration must score ≥ 4** on levels 3 and 4 (where prose exists) and ≥ 3 on levels 1
  and 2.
- **Decision utility must score ≥ 4** on levels 2, 3 and 4, and ≥ 3 on level 1.
- **Craft and constraint compliance must score ≥ 3**, and **≥ 4 on levels 3 and 4**, where
  the mechanical contract *is* the deliverable. A score of 1 caused by a forbidden action
  (code executed, benchmark run, anything published, money spent) is an automatic
  `NEEDS_WORK` regardless of every other score.
- **A body word count outside 900–1200 is Craft ≤ 2 *and* an unmet acceptance criterion →
  `NEEDS_WORK`, no margin.**
- Any acceptance criterion in `LEVELS.md` with no evidence artifact behind it is
  `NEEDS_WORK`, independent of scores. **An acceptance criterion whose artifact exists but
  does not show what the criterion requires is `NEEDS_WORK`, the same as a missing artifact.**
- Where a criterion's **"caps that override the descriptors"** section applies, the cap is the
  score. It is not weighed against the descriptors; it replaces them.

Honest partial work outscores complete-looking work that does not survive checking. A
`CLAIM.md` that says "criterion 5 is unmet: two quotes could not be re-verified and the
claims resting on them were cut" is evidence of a working process; the same level with all
criteria claimed and one quote that fails the evaluator's re-run is not.

---

## Revision history

**2026-08-18 — applied `RUBRIC_REVIEW.md` (verdict: REVISE).** An independent adversarial
review of this rubric found that a fabricated corpus scored Traceability 5, that the mandatory
bar could be cleared with self-authored transcripts, and that two criteria were mandatory at
levels where their own descriptors could not be applied. All findings were applied, with the
reviewer's proposed wording adapted to fit these documents:

- **1** — Traceability now scores *provenance*, not only internal consistency: `.src` +
  `.txt` + `.headers.txt` per capture, the hand-composed-`.src` cap at ≤ 2, the HTML sniff
  test, and evaluator re-derivation of the extraction command at level 5.
- **2** — The evaluator's sampled re-run (≥4 quotes, ≥3 sha256s) moved into the mandatory
  Traceability 4; a contradicted transcript caps at 2.
- **3** — The PDF grep exemption bounded: attempted-command-and-failure logged, ≤2 entries
  and ≤25% of quotes, >half exempt caps at 2, evaluator reads the cited page.
- **4** — Per-level anchors added for Decision utility on levels 1–2, where no prose exists.
- **5** — Decision utility 4/5 made mechanical: ≥3 conditions as observable properties of the
  reader's setup; adjectives excluded; cost passage and "use both" case at 5.
- **6** — Calibration 5 requires restraint that leaves a diff (`DROPPED`/`WEAKENED` row +
  gap + report passage); prose-only restraint scores 3. Worked example A5 extended so it is
  no longer copyable as a single sentence.
- **7** — `claims/excluded-sources.md` must name the observed fact and URL, with ≥1 exclusion
  appearing in `CAPTURE_LOG.md` as a fetch made and rejected.
- **8** — `dated` must be locatable: `dated_locator` header field plus a date grep against
  the capture; an unlocatable date is Source primacy ≤ 2.
- **9** — Word count outside 900–1200 is Craft ≤ 2 and `NEEDS_WORK` with no margin; `##
  Sources` drift reclassified as a Traceability cap; Craft ≥ 4 required on levels 3 and 4;
  catch-all extended to artifacts that exist but do not show what the criterion requires.
- **10** — `UNCHECKED` audit rows given an explicit scoring home, matching `LEVELS.md` L4.
- **11** — Coverage rows must carry `REPORT.md` line number and exact sentence text; level-2
  row counts tied to ≥10 distinct `key#Qn` across ≥6 keys, ≤3 rows per `Qn`.
- **12** — Minimum quote substance: ≥12 words, one complete sentence of body prose; median
  under 12 words caps Traceability at 3.
- **13** — `CAPTURE_LOG.md` completeness rehoused under Traceability; `.src`/`.txt` named in
  `LEVELS.md` L1-5 (and in `SCOREBOARD_CHECK_PATCH.md` for the level-1 `check`); the ≥8-entry
  volume proxy tied to dimension coverage and claim usage; Calibration 5's `CLAIM.md` clause
  reworded so a fully-met level need not invent an unmet one; copy-pasteable transcripts
  required at score 4 rather than 5.

Corresponding edits were made to `LEVELS.md` and `EVIDENCE.md`. Nothing listed in the
review's "what is good and should not be rewritten" section was weakened.
