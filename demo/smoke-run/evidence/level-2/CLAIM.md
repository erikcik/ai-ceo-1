# evidence/level-2/CLAIM.md — Level 2: comparison dimensions and claim → source map

Per acceptance criterion in `LEVELS.md` level 2: the artifact that satisfies it, and what in
that artifact does so. Everything asserted below was checked by opening the file or by running
the command whose output is in `evidence/level-2/map-check.txt`. Where something is thinner
than the criterion would like, it is said here rather than left for the evaluator to find.

**Session history on this level.** Three builder sessions have worked level 2. The first built
it; the evaluator run that should have judged that work crashed with an API error mid-response
and its verdict file was discarded by the operator (`logs/cycle-2-level-2-verdict-CRASHED.md`,
empty). The second therefore had no findings to work from and re-verified the level from disk
instead, tightening three drifted rows and moving the transcript into a script that
regenerates it. The third — this one — is the first with a real verdict: `NEXT_FINDINGS.md`
returned `NEEDS_WORK` on criterion 6 alone, over a derived and incorrect "three orders of
magnitude" in row C4, a `CLAIM.md` sentence that claimed more than its grep could show, and an
unsourced optionality clause in C13. All three are fixed; see "What this session changed" below.

**Artifacts for this level**

| path | what it is |
|---|---|
| `claims/dimensions.md` | 7 comparison dimensions, D1–D7 |
| `claims/claim-map.md` | 29 `OK` claim rows + 5 `WEAKENED`/`DROPPED` rows + 4 tightened rows recorded |
| `claims/gaps.md` | 7 questions the primary sources do not answer |
| `evidence/level-2/map-check.txt` | 7-section verification transcript, commands + real output |
| `evidence/level-2/make-map-check.sh` | the script that generates that transcript by running every command |
| `sources/CAPTURE_LOG.md` §4 | the one further source fetched at level 2 and why it was not added |
| `sources/rejected/probe-duckdb-gh-release-1-0-0.{src,headers.txt}` | that capture, kept so the rejection is checkable |

No `sources/<key>.md` entry was added, edited, or removed at level 2, and nothing under
`sources/raw/` was touched. The 8 level-1 captures and their sha256 values are unchanged —
which is not an assertion here: `map-check.txt` §7 hashes all 16 files and looks each hash up
in `sources/CAPTURE_LOG.md`, and all 16 return `1`.

---

## Criterion 1 — `claims/dimensions.md` names 6–9 dimensions, each justified for this scenario, each with a reader-observable

**Met.** `claims/dimensions.md` defines **seven** dimensions —
`grep -cE '^## D[0-9]+ ' claims/dimensions.md` → `7`, in `map-check.txt` §2, where the next
command shows `7` "What the reader can observe" headings, one per dimension.

Each has three parts: a **"Why it matters here"** paragraph tied to the ~5 GB / laptop /
analytical scenario, a **"What the reader can observe"** paragraph, and a **"Sources behind
it"** line. The observables are the part the criterion turns on, so here they are in full:

| dim | the observable the reader checks, without running either system |
|---|---|
| D1 | installed RAM against 5 GB; whether the ten most common queries include a join or sort over most rows; whether the dataset is fixed at 5 GB or grows toward hundreds of GB |
| D2 | for the ten most common queries: how many of the table's columns each names, and roughly what fraction of rows it touches |
| D3 | the number of OS processes holding the file open **for writing** at once; whether reads must continue during a load; whether the path is local disk or a network/NFS/synced share |
| D4 | the format the 5 GB arrives in; free disk space against 5 GB (does a second materialised copy fit); how often the data is replaced or extended |
| D5 | after load, whether the workflow issues single-row `UPDATE`/`DELETE`s or only bulk appends and rebuilds |
| D6 | whether the inputs still exist elsewhere so the database is rebuildable; whether the writing process can be killed abruptly in normal use; whether anyone but the author would notice a half-written table |
| D7 | how long the file must stay readable; whether it moves between machines of different word size or endianness; whether the reader controls the installed version |

Each is a property of the reader's own setup, countable or checkable before installing
anything. No bare "performance" or "ease of use" axis appears; the file's closing section
**"Axes considered and left out"** records that speed was deliberately not made an axis, and
why (no primary source measures either system on this workload).

## Criterion 2 — `claims/claim-map.md` is a table with the required seven columns

**Met.** Every claim row carries, in order: claim id (`C1`…`C29`, `W1`…`W5`), dimension,
the claim in one sentence, system (`sqlite` / `duckdb` / `both`), `key#Qn`, a short verbatim
fragment of the supporting quote, and status.

The fragment column is verbatim, and this was checked rather than asserted:
`map-check.txt` §6 pulls each cited quote out of `sources/<key>.md` and greps the row's
fragment against **that quote specifically**. All 29 rows return `1`; the section then re-runs
the same loop printing only rows whose count is not 1, and prints nothing. So no row's fragment
was lifted from some other passage of the same document.

## Criterion 3 — ≥14 rows, ≥10 distinct `key#Qn` across ≥6 keys, ≤3 rows per `Qn`, every dimension covered, ≥1 row per system where they differ

**Met, with margin on every count.** From `map-check.txt` §2, each figure produced by a
command shown with its output:

| requirement | actual |
|---|---|
| ≥14 claim rows | **29** rows with status `OK` |
| ≥10 distinct `key#Qn` | **24** — every quote in the dossier is used |
| ≥6 distinct keys | **8** — every entry |
| ≤3 rows per `Qn` | maximum is **2** (five `Qn` are used twice; the rest once) |
| every dimension ≥1 row | D1:4, D2:3, D3:5, D4:4, D5:4, D6:3, D7:6 |
| ≥1 row per system per dimension | every dimension carries both — the smallest cell is 1 |

The five `WEAKENED`/`DROPPED` rows are **not** counted in the 29; they are listed separately
under "Weakened and dropped claims".

**Where the per-system balance is thin, honestly.** The `D<n> <system>` counts in §2 are not
even: D3 is 4 SQLite rows to 1 DuckDB row, D4 is 3 to 1, D7 is 5 to 1, and D5 runs the other
way at 3 DuckDB to 1 SQLite. That asymmetry is real and it is a property of the dossier, not
of the systems: SQLite's project documentation states its own limits explicitly and in prose,
while the DuckDB side is three conference papers. The criterion's bar — ≥1 row per system in
each dimension where they differ — is met everywhere, but a reader of the map should not read
"5 rows to 1" as "the evidence favours SQLite". `claims/gaps.md` §4, §6 and §7 name the
specific places where the thin side is thin, and every DuckDB row is phrased as what a named
paper states.

## Criterion 4 — every `key` exists in `sources/`, every `Qn` exists in that entry, verified with commands and output

**Met.** `evidence/level-2/map-check.txt` §1 is 24 blocks, one per distinct `key#Qn`, each
with two copy-pasteable one-liners and their real output:

1. `grep -n '^### Q<n> ' sources/<key>.md` — shows the quote label exists in the entry, with
   the line number it is on.
2. The canonical check from the evidence taxonomy's §1.4,
   `tr -s '[:space:]' ' ' < sources/raw/<key>.txt | grep -F -c "<quote>"` — run with the
   **full text of the quote**, not a fragment, so a `1` means the whole quoted span is present
   in the stored capture verbatim after whitespace collapsing.

All 24 return `1`. §1 opens by comparing two sets: the 24 distinct `key#Qn` the map cites and
the 24 quotes the dossier holds, printing the difference in each direction — both empty, so
nothing is cited that does not exist and nothing exists that is not cited. §3 additionally
shows that every key cited in the map resolves to a file on disk (`FOUND` × 8).

Two of these one-liners were pulled back out of the finished transcript this session and
re-run verbatim — `duckdb-pvldb-hashjoin#Q2` (transcript line 82) and `sqlite-wal#Q3` (line
217). Both returned `1`. The transcript is generated by `evidence/level-2/make-map-check.sh`,
which reads each quote out of the entry file at generation time, so the quote text in a
command is the entry's text by construction rather than a retyping of it; re-running the
script reproduces the file with only the generation-date line changed.

## Criterion 5 — `claims/gaps.md` lists ≥3 unanswerable questions and states the report will not assert them

**Met.** Seven, not three — `grep -cE '^## [0-9]+\. ' claims/gaps.md` → `7`, in §2 of the
transcript. In order: (1) no head-to-head benchmark on this workload; (2) DuckDB's
storage-format stability across versions; (3) ingest formats other than delimited text,
Parquet in particular; (4) DuckDB's multi-process concurrency semantics; (5) neither project's
sizing guidance is laptop-specific; (6) version drift — most DuckDB evidence predates 1.0.0;
(7) SQLite's own docs make no analytical-performance claim.

Each gap has a **Consequence** paragraph naming what the report may therefore not say, and
each gap that caused a cut names the `claims/claim-map.md` row it cut: §1→W3, §2→W2, §3→W1,
§5→W5, §1/§3 together→the scoping of D4. The obvious one the criterion names — the missing
head-to-head benchmark — is §1.

## Criterion 6 — no row cites an excluded document; no row asserts anything absent from its quote

**Met on the first half, mechanically.** `map-check.txt` §4 greps each of the four keys in
`claims/excluded-sources.md` against every claim row in the map. All four return `0`.

**On the second half — no row asserting more than its quote — here is the reasoning, since
this one cannot be fully settled by grep.** Four things back it:

- §6 of the transcript shows every row's fragment is a real substring of the cited quote, so
  no row is bound to a quote it does not overlap.
- **Every quote has been read against its row**, which is how the four rows in
  "Rows tightened on re-read" (C4, C13, C20, C28) were found and narrowed — see "What this
  session changed" below. The fragment check cannot catch that class of defect; only reading
  can, and in C13's case only an evaluator's reading did: the row's "only if persistence is
  wanted" survived two builder passes before it was cut.
- The five `W` rows exist precisely because the claim the report wanted to make exceeded the
  quote. Each names the overreach: W1 and W2 are `DROPPED` outright (no supporting quote at
  all); W3 weakens a speed claim into "what the 2019 paper states"; W4 keeps DuckDB's
  larger-than-memory behaviour restricted to *query intermediates in join plans*, which is
  what the quotes are about, rather than "handles datasets larger than memory"; W5 drops a
  numeric size limit because the captured passage carries no number.
- **Every number in every `OK` claim sentence is accounted for, one by one.** The previous
  version of this claim said "no figure, ratio, timing or version number appears in any `OK`
  row that is not in its quote" and rested on a §5 grep for `Nx faster` and timings — a
  pattern narrow enough that it could not see the derived ratio then sitting in C4. That was a
  real hole and it is now closed by a check rather than by wording: §5 of the transcript
  extracts **every numeric token** from the claim column of all 29 `OK` rows (14 tokens) and
  reports, for each, whether it occurs in the quote that row cites, in that quote's locator
  heading, or in the entry's `dated:` field. Matching is on numeric boundaries, so the `5` of
  "5 GB" cannot pass by hiding inside a `2025`.

  Reading the table at `map-check.txt` lines 444–457, the 14 tokens split 5 / 3 / 5 / 1. Five
  are in the quote itself
  (`3` in C7, `32` and `64` in C24, `2050` in C26, `1.2.0` in C29); three are in the locator
  heading (`3.33.0` and `2020` in C22, `2022` in C28) — the release headings those quotes sit
  under in `sources/sqlite-changes.md`; five are publication years carried by the attribution
  phrase ("DuckDB's SIGMOD 2019 paper", C6/C20/C23; "CIDR 2020 paper", C13; `2025`, C29) and
  match the cited entry's `dated:` field.

  **Exactly one token is unsourced by any of the three, and it is named here rather than left
  to be found: the `5` of "5 GB" in C4** (`map-check.txt` line 462). It is not a claim about
  the source — it is the reader's own workload size, given in the task statement, being
  compared against the terabyte bound the quote does state. C4 asserts only the direction of
  that comparison ("far below which a 5 GB dataset sits") and no derived quantity. The
  companion grep at line 469 — orders of magnitude, N-fold, N-times-below, percent, across
  every `OK`, `WEAKENED` and `DROPPED` row — prints nothing.

**The one place a reader should look hardest**, named here rather than left to be found: C6
and C20 are claims *about SQLite* sourced from *DuckDB's* paper. They are written as "DuckDB's
SIGMOD 2019 paper states / characterises", the map's preamble flags them, and
`claims/gaps.md` §7 records that no SQLite-authored counter-statement exists in this dossier.
That is a real limitation of the evidence, and the phrasing is the mitigation; the report must
keep the attribution in the sentence, not in a footnote.

## Criterion 7 — every dimension has a source; every entry is cited or moved to `sources/unused/`

**Met, and it closes in both directions.**

- *Every dimension has ≥1 primary source behind it.* Each section of `claims/dimensions.md`
  ends with a "Sources behind it" line naming the entries, and §3 of the transcript derives the
  same thing from the map rather than from that prose: the distinct source keys each dimension
  rests on, D1 through D7, none empty and each with at least one key per system.
- *Every entry is cited.* §3 counts the `OK` rows citing each of the 8 entries:
  `duckdb-cidr20` 4, `duckdb-pvldb-hashjoin` 3, `duckdb-sigmod19` 5, `sqlite-changes` 3,
  `sqlite-cli` 2, `sqlite-lts` 3, `sqlite-wal` 4, `sqlite-whentouse` 5. No zeros, so nothing
  needed moving and `sources/unused/` does not exist — the transcript shows the `ls` returning
  "No such file or directory", which is the expected result here, not an error.

Beyond the criterion: all **24** quotes are cited, not merely all 8 keys (§1's set comparison).

---

## What this session changed — the `NEXT_FINDINGS.md` work list

This session is the third pass at level 2 and the first to have an evaluator verdict to work
from. `NEXT_FINDINGS.md` confirmed criteria 1, 2, 3, 4, 5 and 7 and failed the level on
criterion 6 alone. All three of its items are addressed; no other file was touched.

1. **C4's derived ratio is gone (the finding that failed the level).** The row ended "— a
   content-size bound that 5 GB is three orders of magnitude inside." That figure was not in
   `sqlite-whentouse#Q4`, which bounds content at "less than a terabyte", **and it was wrong**:
   1 TB / 5 GB ≈ 200×, about 2.3 orders of magnitude, not three. The row now reads "— a
   content-size bound far below which a 5 GB dataset sits" (`claims/claim-map.md` line 30):
   the direction of the comparison, which the quote and the reader's own 5 GB support, and no
   quantity. `key#Qn` and the verbatim fragment are untouched, so §1 and §6 are unaffected.
2. **C13's "only if persistence is wanted" is gone.** `duckdb-cidr20#Q1` says the database
   "can directly scan existing files (e.g. CSV), reshape the result and then append it to a
   persistent table" and states no optionality; the surrounding capture (lines 137–145) argues
   desirability, not optional persistence. The clause was the builder's inference and is cut
   (`claims/claim-map.md` line 54). Both rows are now in "Rows tightened on re-read", C4 with
   both of its narrowings recorded.
3. **The `CLAIM.md` sentence that overstated its evidence is replaced by a check that earns
   it.** The old wording claimed no unquoted figure appeared in any `OK` row while resting on
   a grep for `Nx faster` and timings — too narrow to see C4's ratio, which is why the finding
   calls it out separately. §5 of the transcript now audits **every numeric token** in every
   `OK` claim sentence against the cited quote, its locator heading and the entry's `dated:`
   field, on numeric boundaries; the residual is one token (`5`, C4) and criterion 6 above
   names it. A second grep looks for derived-ratio language across all claim rows and prints
   nothing. Both are in `evidence/level-2/make-map-check.sh`, so they re-run with the file.
4. C21 was left alone deliberately: the finding flagged "rather than overwriting pages in
   place" as a fair reading of "Writers merely append new content to the end of the WAL file"
   and said not to spend time on it.

`evidence/level-2/map-check.txt` was regenerated with `bash evidence/level-2/make-map-check.sh`
after the edits. Every count is unchanged — 29 `OK` rows, 24 distinct `key#Qn`, 8 keys, max 2
rows per `Qn`, 24 canonical quote greps at `1`, 29 fragment checks at `1`, 16/16 capture
hashes at `1` — because the edits touched only claim prose, never a citation or a fragment.

## What the previous session (same level, no verdict) changed

1. **`evidence/level-2/make-map-check.sh` was written and the transcript regenerated from
   it.** The previous transcript was assembled by running commands and pasting output; this
   one is produced by a script the evaluator can re-run (`bash
   evidence/level-2/make-map-check.sh`), which removes the possibility that the transcript and
   the files disagree after a late edit. Every count in it was reproduced: 29 / 24 / 8, max 2
   rows per `Qn`, 24 canonical checks returning `1`, 29 fragment checks returning `1`.
2. **A seventh section was added**: §7 hashes the 8 `.src` and 8 `.txt` captures and looks
   each hash up in `sources/CAPTURE_LOG.md`. All 16 return `1`, which is what makes §1's greps
   mean anything — the captures are still the bytes level 1 fetched and logged.
3. **Three rows were tightened** (the table carries four now — C13 was added this session, and
   C4's entry records both of its narrowings), recorded in `claims/claim-map.md` under "Rows
   tightened on re-read": C4 (its "well inside it" implied 5 GB clears all three parts of the quote's
   boundary, when only the content-size part is a size), C20 (an em-dash gloss — "the layout
   that makes single-row work natural and wide scans expensive" — that is nowhere in the
   capture), C28 (its "at worst" turned the quote's "might cause" into a bound). Each row's
   `key#Qn` and fragment are unchanged, so §6 still returns `1` for all of them.
4. Two checks were added to §2 and §5: one confirming each dimension carries a "What the
   reader can observe" paragraph (7 of 7), one grepping the whole map for smuggled speed
   figures (none).

Nothing else was touched: no source entry, no capture, no header, no `SCOREBOARD.json`.

## The optional source addition, and why there is none

`LEVELS.md` level 2 "Where the budget binds" invites adding one source here to fix a thin spot
from level 1. The thin spot was real — all three DuckDB entries are papers, two of them
pre-1.0, and nothing covers DuckDB's storage-format stability. A candidate was fetched at
level 2, `api.github.com/repos/duckdb/duckdb/releases/tags/v1.0.0`, and **not added**.

It is logged in full at `sources/CAPTURE_LOG.md` §4, with the capture kept at
`sources/rejected/probe-duckdb-gh-release-1-0-0.{src,headers.txt}`. Its headers and its
`published_at` date would have qualified — it is the first DuckDB source found that satisfies
the header requirement `duckdb.org` HTML cannot. Its **body** disqualifies it: the release
notes are a PR bullet list with two sentences of prose, one naming the release after a duck
and one linking to a blog post. Neither supports any claim. The same is true of the v1.2.0
release body, checked the same way. Admitting it would have produced an entry cited by no
claim row — which criterion 7 scores as worthless — or, worse, a quote chosen because it
greps rather than because it supports something.

So the dossier stays at 8 entries and the gap is carried as evidence of restraint instead:
`claims/gaps.md` §2, the `DROPPED` row `W2`, and a note in the capture log pointing at the
`duckdb.org` blog post that would close it if this task's provenance rules allowed capturing
it.

## Known weak points, stated rather than hidden

- **The DuckDB side of the dossier is three papers, two of them pre-1.0.** Everything the map
  says about DuckDB is what a named paper states, on the date it states it. It is not a
  statement about the version a reader installs today. `claims/gaps.md` §6.
- **Two SQLite claims come from DuckDB's paper** (C6, C20). Attributed in the row text, but a
  competitor's characterisation is not a neutral source and the report must not launder it
  into one.
- **D6 carries no row asserting the two systems differ**, because the SQLite side is
  documentation plus a changelog entry and the DuckDB side is one sentence. The dimension file
  says so in its "Honest note on this axis".
- **A zero-byte artifact of a failed level-1 fetch is still on disk**,
  `sources/rejected/excluded-motherduck-vs.headers.txt`. The `rm` was denied by the safety gate
  and logged to `PAUSED_ACTIONS.md`; it was not retried. It backs no claim and is documented
  in `sources/CAPTURE_LOG.md` §3f.

## What level 3 should pick up

1. **Write from the map, not from knowledge.** Every sentence in `REPORT.md` should trace to a
   `C<n>` row. Level 3 criterion 5 needs ≥12 of the 29 in the report with line numbers and
   exact sentence text; at 900–1200 words, roughly 18–22 rows will fit comfortably. Pick the
   rows, then write.
2. **Keep the attributions.** C6 and C20 must read "DuckDB's SIGMOD 2019 paper states…", and
   every DuckDB row should name the paper or its year. Dropping that turns a 2019 design
   description into a present-tense claim about installed software — `claims/gaps.md` §6.
3. **The limits passage has its content already.** Level 3 criterion 7 wants a "Limits of this
   comparison" passage reflecting `claims/gaps.md`; the seven sections there, especially §1
   (no benchmark), §2 (DuckDB format stability unsourced) and §4 (DuckDB multi-process
   semantics unsourced), are what it should say. §4 in particular: do not present SQLite's
   single-writer limit as a *contrast* with DuckDB, because the DuckDB side is unsourced.
4. **The recommendation's ≥3 conditions are already written** — they are the "What the reader
   can observe" lines in `claims/dimensions.md`. The strongest three for a recommendation are
   D1 (RAM vs working set), D3 (count of concurrent writing processes), and D5 (single-row
   updates after load vs bulk rebuild). D7 (how long the file must stay readable) is a good
   fourth and is the one where the sourced asymmetry is sharpest.
5. **`## Sources` must match the entry headers field for field** — title, publisher, URL,
   `dated`, `accessed`. `RUBRIC.md` caps Traceability at 3 for any disagreement, so copy them
   out of `sources/<key>.md` mechanically rather than retyping. Note `duckdb-pvldb-hashjoin`
   has `dated: 2025` (year granularity, deliberately) and every entry has
   `accessed: 2026-08-17`.
