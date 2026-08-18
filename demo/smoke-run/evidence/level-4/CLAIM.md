# evidence/level-4/CLAIM.md — what the level-4 artifacts show, criterion by criterion

Level 4 is "citation audit and final pass": re-verify the finished `REPORT.md` end to end as an
adversarial reader would, fix or remove whatever fails, and leave the transcript on disk.

**Both evidence files are generated** by `evidence/level-4/make-level4-checks.sh`, which runs the
checks and pastes their real output. Regenerate with `bash evidence/level-4/make-level4-checks.sh`;
two consecutive runs produce byte-identical files, and there is no timestamp in either — the one
line that legitimately moves is the `git status --porcelain` snapshot in §7, which changes when
this level is committed. The only hand-written inputs are the `AUDIT`
table (report line → kind → `key#Qn` / absence-check id → note) and the `CLASSIFY_*` patterns of
section 4. Sentence text, quote text, hashes, counts and **the PASS/FAIL verdicts themselves** are
computed from disk.

---

## Criterion 1 — one audit row per substantive sentence, every row PASS or naming its edit

**Artifact:** `evidence/level-4/citation-audit.md`.

**49 rows, one per sentence of the report body**, not one per cited sentence. Every sentence
between line 3 and line 128 is in the table, classified `CLAIM` (22), `RESTATE` (7), `ABSENCE` (6),
`META` (5), `LABEL` (4), `DOSSIER` (2), `LIMIT` (1), `GLOSS` (1), `SCENARIO` (1). The uncited
sentences are in there too, with the reason no source is required, so a sentence cannot escape the
audit by carrying no citation.

That the table is complete is itself checked, not asserted: the file's last code block prints the
report's sentence-start lines (produced by the same join-until-a-full-stop rule the report is
written to) beside the audit's row lines, and the two set differences — "sentences with no audit
row" and "audit rows pointing at no sentence" — both print `(none)`.

**Verdict tally: PASS 49, FAIL 0, `UNCHECKED` 0.** The verdict column is computed by the generator,
not typed:

- for a row citing `key#Qn`: PASS requires the canonical check to return ≥1 **and** records whether
  the report sentence carries the inline `[key]`. Where it does not, the row says
  `back-reference` rather than claiming an inline citation — exactly one row does
  (line 116, whose `duckdb-sigmod19` claim is cited inline at line 31);
- for a row resting on an absence check `A<n>`: PASS requires that check's residual to be 0.

Two rows (116 and 124) carry `WEAKENED THIS LEVEL` and point at the edits table at the top of the
file, which gives the before text, the after text and the check that forced it.

## Criterion 2 — `verify.txt` with all four checks re-run, output visible

**Artifact:** `evidence/level-4/verify.txt`, 7 sections.

1. **Canonical quote check** (§1) — all **24** quotes in the dossier, each as the copy-pasteable
   one-liner `tr -s '[:space:]' ' ' < sources/raw/<key>.txt | grep -F -c "<quote>"` with its
   output. **24 of 24 return ≥1, 0 return 0.** 20 of the 24 are marked `CITED` — those are the
   `key#Qn` set of the audit table, i.e. every quote the report rests on; the other four are
   checked anyway. No quote is grep-exempt.
2. **sha256 over `sources/raw/*`** (§2) — the literal `shasum -a 256 sources/raw/*` over all 24
   files, then a per-file reconciliation against `sources/CAPTURE_LOG.md`. **16 `.src`/`.txt`
   files reconcile, 0 mismatch.** The 8 `.headers.txt` files are classified
   `NOT-HASHED-IN-LOG` rather than left to print a bare `0` that reads like a tampered capture —
   the log hashes `.src` and `.txt` only.
3. **Extraction re-derivation** (§3) — `LEVELS.md` asks for at least one; **all eight** were done.
   Each capture's logged extraction command is re-run against the stored `.src` with its output
   redirected to `/tmp/l4scratch/` so the write-once capture is not touched, then hashed against
   the stored `.txt`. **8 of 8 re-derive byte for byte**, 0 differ, no stderr on any of them.
   Those stored hashes are the ones §2 just reconciled with the log, so the chain
   `.src` → logged command → `.txt` → `CAPTURE_LOG.md` → quote closes without me in it.
4. **Body word count** (§6a) — `awk '/^## Sources/{exit} {print}' REPORT.md | wc -w` → **1192**,
   printed with an explicit in-band/out-of-band verdict.

§4 (absence checks), §5 (dossier facts) and §7 (nothing built or run) are beyond what the
criterion asks; they are what the audit's non-`CLAIM` rows rest on.

## Criterion 3 — claims that could not be re-verified were weakened, and the audit names the edit

**Artifact:** the "Edits made this level" table in `citation-audit.md`, and checks A1 and A6 in
`verify.txt` §4.

Two claims failed re-verification. Neither was kept.

**Line 116–119.** Was: *"and no SQLite-authored statement in this dossier weighs against it"*.
Check **A6** enumerates every SQLite-authored quote bearing on analytical work and finds one:
`sqlite-whentouse#Q3` — which the report itself asserts at line 33. The sentence contradicted the
report's own line 33. Now: *"and the only SQLite-authored statement here is its own unquantified
"works well" listing [sqlite-whentouse]"*, which is what the dossier actually contains and which
now carries a citation it did not have.

**Line 124–125.** Was: *"no source speaks to Parquet, Arrow or JSON on either side"*.
Check **A1** finds no *quote* mentioning any of the three (residual 0) — but the *captures* do:
Parquet once in the PVLDB paper (an aside about join reordering), JSON in `sqlite-cli`'s `-json`
output mode and 44 times across `sqlite-changes`. §4 prints the per-capture hit counts for all
eight captures, including the zeros, so the finding is visible rather than described. "No source
speaks to" was false as written. Now: *"no accepted quote describes loading Parquet, Arrow or
JSON on either side"* — narrower, and true of the scope the report actually relies on.

Both edits **weaken**, neither deletes, because in both cases a narrower true statement survived.
Word count went 1186 → 1192, still in band; line count is unchanged at 163, so
`evidence/level-3/claim-coverage.md` line numbers still resolve — it was regenerated anyway, along
with `wordcount.txt` and `evidence/level-3/verify.txt`.

## Criterion 4 — the final `REPORT.md` still satisfies level 3 criteria 1–4

**Artifact:** `evidence/level-4/verify.txt` §6.

- **§6a, word band:** 1192, band 900–1200 hard, printed with the canonical command. 8 words of
  headroom under the ceiling.
- **§6c, recommendation:** four numbered conditions at lines 83, 89, 95, 101, printed with
  `grep -n`, count 4 against a required 3. Each names a property of the reader's own setup —
  installed RAM against the working set, count of OS processes writing the file, single-row
  updates versus bulk rebuilds, how long the file must stay readable and on what hardware — and
  none is a workload adjective.
- **§6b, citations and `## Sources`:** 8 distinct keys cited (≥6 required), each `ls`-ed in
  `sources/`; then for each key the report's own bullet block is cut out of `REPORT.md`,
  whitespace-collapsed, and the five header values grepped against it. **40 of 40 fields found,
  0 missing.**
- **§6d:** the exhaustive per-number audit stays clean after the edits — `UNCLASSIFIED` 0,
  `RESIDUAL` 7, quoted from the regenerated `evidence/level-3/verify.txt` §6.

## Criterion 5 — residual risks, stated honestly

Below. This is the section of this file most worth reading against the artifacts.

---

## Residual risks

**Every DuckDB claim in this report comes from a peer-reviewed paper, none from DuckDB's own
documentation.** That is not a preference; `duckdb.org/docs/stable/*` returned 569-byte JavaScript
redirect stubs at capture time (`sources/CAPTURE_LOG.md`, and `memory/duckdb-org-capture-gotchas.md`).
So the DuckDB side of this comparison is a 2019 SIGMOD demo paper, a 2020 CIDR paper and a 2025
PVLDB paper — design descriptions, two of them six and seven years old. The report says this at
lines 7 and 128, but it bears repeating here: **a reader who needs current DuckDB behaviour should
read DuckDB's documentation, which this dossier does not contain.**

**Every claim rests on a single document per axis.** Audit rows per key: `duckdb-cidr20` 7,
`sqlite-whentouse` 6, `duckdb-sigmod19` 6, `sqlite-wal` 5, `sqlite-lts` 5,
`duckdb-pvldb-hashjoin` 5, `sqlite-cli` 1, `sqlite-changes` 1. Nothing in the report is
corroborated by a second, independent source — there is no axis where two documents say the same
thing. In particular:

- **larger-than-memory behaviour** (lines 17, 20, 85) rests entirely on `duckdb-pvldb-hashjoin`,
  one paper, whose own claim is about *memory-intensive join plans*, not about arbitrary queries;
- **DuckDB's storage format and ingest** (lines 55, 57, 59, 97, 99, 106, 109) rests entirely on
  `duckdb-cidr20#Q1`/`#Q2` — two quotes from one 2020 paper carry seven of the report's rows;
- **the harshest sentence about SQLite** (line 31, "very poor" on analytical workloads) is
  `duckdb-sigmod19#Q1` — DuckDB's authors on their competitor, in their own demo paper. The report
  attributes it in the sentence and line 116 now names the one SQLite-authored statement that
  bears on the same question, but no neutral third party weighs in.

**Version-dependent facts, and what to re-check.** The report names `3.33.0`
(`sqlite-changes#Q2` locator), `v1.2.0` (`duckdb-pvldb-hashjoin#Q2`) and the years 2019/2020/2025.
The five sqlite.org pages carry per-page dates between 2025-05-31 and 2026-07-24 and are living
documents: `whentouse.html`, `wal.html`, `lts.html`, `cli.html` and `changes.html` can all change
under the same URL. **Every `accessed` field is 2026-08-17.** A reader relying on this report later
than that should re-fetch the five sqlite.org pages before trusting the concurrency, ingest and
longevity sections, and should check DuckDB's current release notes before trusting anything the
2019/2020 papers say about how DuckDB works today.

**The absence checks scan the captures, not the world.** A2 ("no DuckDB capture states
cross-version file-format stability") and A3 ("no DuckDB capture states how many OS processes may
hold the file") search the three DuckDB captures only. A statement in DuckDB's documentation would
settle either question, and this dossier does not have that documentation. So lines 77, 93, 120 and
122 mean *"this dossier does not answer it"*, not *"it is unanswerable"* — and the report's own
wording ("unsourced here", "No source here states") is the sentence a reader should read literally.

**The classifications in A2 and A3 are my judgement.** The *hits* are enumerated mechanically and
printed in full with 90 characters of context on either side; whether "DuckDB provides a SQLite
compatibility layer" is a statement about file-format stability is a call I made, and the
transcript prints the hit so the evaluator can make it differently. A residual of 0 means "no hit
went unclassified", not "no hit could be read another way".

**Line 124's scope narrowed this level, and a reader should notice.** The report now says *no
accepted quote* describes loading Parquet, Arrow or JSON. The captures behind those quotes do
mention Parquet and JSON, in the ways §4 lists. If a reader's question is "can either system read
Parquet", this report does not answer it and its silence is a property of the dossier, not of the
systems.

**Two things this level did not do.** It did not re-open the six claim-map rows level 3 dropped for
the word band (C15, C16, C19, C21, C27, C28) — the budget spent on the audit was the better trade,
but those rows remain unused evidence. And it did not touch
`sources/rejected/excluded-motherduck-vs.headers.txt`, still a zero-byte artifact of a failed
level-1 fetch whose `rm -f` the safety gate denied (`PAUSED_ACTIONS.md`, `sources/CAPTURE_LOG.md`
§3f). It backs no claim in this report.

**Self-verification is the structural limit.** The same session wrote the report's two edits and
the checks that justify them. What makes that survivable is that the checks are generated rather
than described: the quote text in §1 comes out of `sources/*.md`, the sentence text in the audit
comes out of `REPORT.md` at the line given, the hashes come out of `shasum`, and the verdict column
is computed from those. Every one-liner in `verify.txt` is copy-pasteable and re-runs without
modification — that, not this file, is the evidence.
