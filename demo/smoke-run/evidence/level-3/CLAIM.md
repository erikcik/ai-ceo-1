# evidence/level-3/CLAIM.md — what the level-3 artifacts show, criterion by criterion

Level 3 is "write `REPORT.md`": a 900–1200 word, decision-oriented, fully cited comparison built
from `claims/claim-map.md`. `REPORT.md` is the deliverable, not evidence; the evidence is
`evidence/level-3/wordcount.txt`, `claim-coverage.md`, this file, and the transcript
`evidence/level-3/verify.txt` that the other two rest on.

**Everything in `evidence/level-3/` except this file is generated** by
`evidence/level-3/make-level3-checks.sh`, which runs the checks and pastes their real output.
Regenerate with `bash evidence/level-3/make-level3-checks.sh`; only the timestamp at the foot of
`verify.txt` changes. The coverage table's sentence text is *extracted from `REPORT.md` at the
line number given*, not retyped, so a location and its text cannot drift apart.

---

## Criterion 1 — `REPORT.md` exists; body word count 900–1200, recorded with its command

**Artifact:** `evidence/level-3/wordcount.txt`.

It shows the canonical command and its output:

```
$ awk '/^## Sources/{exit} {print}' REPORT.md | wc -w
    1186
```

**1186 is inside the band**, 14 words below the ceiling. Two supporting counts are recorded with
it: `grep -c '' REPORT.md` → 163 lines total, and the body is 130 lines.

## Criterion 2 — the stated reader, the stated scenario, and a recommendation with ≥3 conditions observable in the reader's own setup

**Artifact:** `REPORT.md` lines 3–8 (who this is for) and lines 79–112 (`## Recommendation`).

The report opens on the reader and the scenario ("roughly 5 GB of data on a laptop, analytical
queries to run against it, and one embedded database to choose") and the recommendation gives
**four** conditions, each a property the reader can check without installing either system:

1. **line 83** — installed RAM against the working set (a data-size relationship).
2. **line 89** — the number of OS processes writing the file at once (a concurrency count),
   plus where the file lives (laptop disk vs network share).
3. **line 95** — single-row `UPDATE`s/`DELETE`s after the load vs bulk appends and rebuilds,
   which line 96 tells the reader to establish by counting a week of write statements.
4. **line 101** — how long the file must stay readable and on what hardware.

Each names a system: **DuckDB** at line 87, **SQLite** at lines 98 and 103, with line 99 giving
the DuckDB-favouring branch of condition 3. No condition is a workload adjective.

Two further passages the rubric's top band asks for: **line 106** states what choosing DuckDB
*costs* the reader (single-row update efficiency is a stated non-goal, and its cross-version
format stability is unsourced here), and **lines 109–112** name the case where the answer is
both, with the division of labour spelled out — durable copy in SQLite, a regenerable DuckDB
file rebuilt from the same CSV inputs for the scanning dashboard.

## Criterion 3 — inline `[key]` citations, and a `## Sources` list matching each entry header field for field

**Artifacts:** `REPORT.md` lines 131–156 (`## Sources` and its eight bullets), and
`evidence/level-3/verify.txt` §5.

§5 cuts each key's bullet block out of `REPORT.md`, collapses whitespace, and greps the five
header values from `sources/<key>.md` against that block: **title, publisher, url, dated,
accessed — 5 fields × 8 keys = 40 greps, all `1`.** The bullet count check
(`grep -c '^- \*\*`' REPORT.md` → 8) shows the list has exactly one entry per cited key.

Note `duckdb-pvldb-hashjoin` carries `dated: 2025` — year granularity, deliberate, as its
header's `dated_locator` explains — and the report reproduces `dated 2025`, not an invented
month or day. All eight are `accessed: 2026-08-17`.

## Criterion 4 — ≥6 distinct keys cited, all existing in `sources/`

**Artifact:** `evidence/level-3/verify.txt` §4.

**All 8** keys in the dossier are cited: the enumerated list, an `ls sources/<key>.md` for each
(8 paths printed, no error), and the count `8` against a required minimum of 6. The dossier
itself is 8 entries, so no entry goes uncited.

## Criterion 5 — ≥12 claim-map rows appear, mapped to report line + exact sentence

**Artifacts:** `evidence/level-3/claim-coverage.md`, `evidence/level-3/verify.txt` §1–§3.

The coverage table has **23 rows on 23 distinct claim ids across 8 keys**, against a required
12. For each row `verify.txt` shows three checks:

- **§1** — the sentence, whitespace-collapsed, is found in the whitespace-collapsed report
  (23 × `1`), and the first eight words of the report line named are the first eight words of
  that sentence (23 × `SAME`). The printed one-liner is the extraction the script itself ran, so
  it is copy-pasteable and re-runs to `1`.
- **§2** — the claim id resolves in `claims/claim-map.md` to a row with **that same `key#Qn`**
  and status `OK` (23 × `MATCH`). No row rests on a `DROPPED` or `WEAKENED` claim.
- **§3** — the map's verbatim fragment for that row is inside the **quote the row cites**,
  pulled out of `sources/<key>.md` and grepped against that quote rather than against the
  capture (23 × `1`).

Two honest notes. **C25 and C26 share one sentence** (line 71): the sentence carries the
format-stability commitment and the through-2050 intent, which are separate claim rows on
separate quotes (`sqlite-lts#Q2`, `#Q3`); the coverage table says so. And **seven claim rows
appear a second time in the recommendation** (lines 90, 91, 97, 99, 103, 106, 110) — these are
listed in the table's second section and are *not* counted toward the 23.

**Six `OK` rows were left out** for want of words: C15, C16, C19, C21, C27, C28. No dimension
loses its coverage: D4 keeps C13/C14, D5 keeps C17/C18, D6 keeps C22/C23, D7 keeps
C24/C25/C26/C29.

## Criterion 6 — no untraceable figure, capability or version fact; no code, database or measurement in the diff

**Artifact:** `evidence/level-3/verify.txt` §6 and §7.

§6 enumerates **every numeric token in the report body** — 45 of them, with line numbers — and
assigns each a class: `SOURCED` (naming the quote, locator, or header field that accounts for
it), `NOT-A-QUANTITY` (digits inside a citation key such as `duckdb-sigmod19`, the shell name
`sqlite3`, or this report's own numbered conditions), or `RESIDUAL`. Then it prints the counts:
**`UNCLASSIFIED` → 0**, **`RESIDUAL` → 7**.

The residual is one number appearing seven times: the **5** of "~5 GB", the dataset size the
task itself specifies. It is the reader's input to the decision, not a claim about either
system, and the report derives nothing from it — in particular no ratio against the terabyte
bound in `sqlite-whentouse#Q4`, which is the arithmetic that failed level 2 the first time it
was judged. This is a pattern-free audit on purpose: two confirming greps follow it (`0` and
`0`), but the classification table, not the greps, is the check.

Version facts in the report are `3.33.0` (the `sqlite-changes#Q2` locator, release entry
`2020-08-14 (3.33.0)`) and `v1.2.0` (inside `duckdb-pvldb-hashjoin#Q2`). An earlier draft said
DuckDB's papers "predate the 1.0.0 release"; `1.0.0` is **not** in any accepted quote — the
v1.0.0 release probe was fetched and rejected at level 2 (`sources/CAPTURE_LOG.md` §4) — so that
phrasing was removed from lines 7 and 128 and replaced with the sourced years and the one
release the dossier does name.

§7 shows `git status --porcelain` (the level added `REPORT.md`, `evidence/level-3/`, and log
files only) and a filename check for database, data and program extensions → **0**. Nothing was
installed, executed or measured; `sources/raw/` still holds its 24 files untouched.

## Criterion 7 — a "Limits of this comparison" passage reflecting `claims/gaps.md`

**Artifact:** `REPORT.md` lines 114–129 (the `## Limits of this comparison` section).

Six sentences, one per gap: no head-to-head benchmark and no SQLite-authored analytical claim to
weigh against DuckDB's (gaps §1, §7); DuckDB's storage-format stability unsourced, so the
contrast with SQLite's commitment is an asymmetry in the evidence rather than a finding (§2);
DuckDB's multi-process file access unsourced, which is *why* SQLite's single-writer constraint
is never written as a contrast (§4) — the trap the level-2 handoff flagged; ingest coverage
limited to delimited text, so a Parquet dataset is out of scope (§3); no laptop-specific sizing
guidance in any quote (§5); and the DuckDB evidence being mostly 2019–2020 with v1.2.0 the only
release named (§6).

That restraint is traceable, not just asserted: `claims/claim-map.md` carries W1–W5 as
`DROPPED`/`WEAKENED` with the quote that failed to support each, `claims/gaps.md` gives the
reason, and the passage above is the third leg of that chain.

---

## Where this claim is weaker than it looks

- **Only 23 of 29 `OK` rows fit.** Six were cut for the word band, named above. A reader wanting
  the delimiter details of `.import` (C15) or the 2022 backwards-compatibility note (C28) will
  not find them in the report.
- **The recommendation restates claims rather than adding new ones.** That is deliberate — every
  sentence must trace to a map row — but it means conditions 1 and 4 lean on the same quotes as
  the body sections above them.
- **The DuckDB side of D3 and D7 is thin by evidence, not by choice.** The report says so in its
  limits passage; a reader who wants those answers must go outside this dossier.
- **`sources/rejected/excluded-motherduck-vs.headers.txt` is still a zero-byte file** left by the
  level-1 fetch failure whose `rm -f` the safety gate denied (`PAUSED_ACTIONS.md`). It backs no
  claim in this report. Untouched this level, as instructed.
- **Nothing here re-verifies the captures themselves.** Level 3 rests on level 1's quote checks
  and level 2's hash reconciliation; re-running the canonical quote check and the sha256
  reconcile end to end is level 4's job, and `evidence/level-3/verify.txt` §3 only re-checks
  fragments against the quotes as written in the entries.
