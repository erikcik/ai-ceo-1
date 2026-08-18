# PROGRESS.md

State of the task. Edited in place, never appended.

**Task:** `REPORT.md`, 900–1200 words, SQLite vs DuckDB for a developer choosing one for a
~5 GB analytical workload on a laptop. Every substantive claim traces to a primary source.
Nothing is built, benchmarked or run.

**Budget:** 4 levels, 8 builder sessions. **6 sessions used.**

---

## Status

| level | state |
|---|---|
| 1 — primary source dossier | **PASS** (evaluator, cycle 1). 8 entries, 24 quotes. |
| 2 — dimensions and claim map | **PASS** (evaluator, cycle 2). 29 `OK` rows, 7 dimensions. |
| 3 — write `REPORT.md` | **PASS** (evaluator, cycle 3). |
| 4 — citation audit | **done this session, awaiting evaluator.** No `NEXT_FINDINGS.md` existed, so this was a first attempt, not a repair. |

`SCOREBOARD.json` reads `"passes": false` for level 4; only the wrapper writes it.

**All four levels now have artifacts on disk.** If the evaluator returns `PASS`, the task is
complete and the remaining two sessions are spare.

## What level 4 left on disk

- **`evidence/level-4/make-level4-checks.sh`** — generates both evidence files by running the
  checks. `bash evidence/level-4/make-level4-checks.sh`. Hand-written inputs are only the `AUDIT`
  table (report line | kind | `key#Qn`/`A<n>` | note) and the `CLASSIFY_A2`/`CLASSIFY_A3` patterns.
  Sentence text, quote text, hashes, counts **and the PASS/FAIL verdicts** are computed. Nothing
  varies between runs on unchanged inputs — there is no timestamp in the output.
- **`evidence/level-4/citation-audit.md`** — **49 rows, one per body sentence** (not per citation):
  22 CLAIM, 7 RESTATE, 6 ABSENCE, 5 META, 4 LABEL, 2 DOSSIER, 1 LIMIT, 1 GLOSS, 1 SCENARIO.
  **PASS 49, FAIL 0, UNCHECKED 0.** Completeness is proved by a two-way `comm` of report
  sentence-start lines against audit row lines, both differences `(none)`. Top of the file is the
  "Edits made this level" table.
- **`evidence/level-4/verify.txt`** — 7 sections: §1 canonical quote check, all 24 quotes, 24×`1`,
  20 marked CITED; §2 `shasum -a 256 sources/raw/*` reconciled per file against `CAPTURE_LOG.md`,
  16 reconcile / 0 mismatch / 8 `.headers.txt` classified `NOT-HASHED-IN-LOG`; §3 extraction
  re-derivation for **all 8** captures into `/tmp/l4scratch/`, 8/8 byte-identical, no stderr;
  §4 the seven absence checks A1–A7, all residual 0; §5 dossier dates behind report lines 7 and
  128; §6 the report still meets level-3 criteria 1–4 (1192 words, 8 keys, 40/40 header fields,
  4 conditions); §7 nothing built or run.
- **`evidence/level-4/CLAIM.md`** — per criterion, plus a long residual-risks section.

## The two edits made to `REPORT.md` this session

Both were overreaches the absence checks caught; both **weakened, not deleted**; both named in
the audit's edits table with before/after and the check id.

1. **Line 116–119** was "no SQLite-authored statement in this dossier weighs against it" — false,
   because `sqlite-whentouse#Q3` is exactly that and the report asserts it at line 33. Now names
   that listing and cites it. (Check A6.)
2. **Line 124–125** was "no source speaks to Parquet, Arrow or JSON" — false of the *captures*
   (Parquet once in the PVLDB paper, JSON 44× in `sqlite-changes`, 2× in `sqlite-cli`), true of
   the *quotes*. Now "no accepted quote describes loading …". (Check A1.)

Word count 1186 → **1192** (band 900–1200, hard; 8 words of headroom). Line count unchanged at
163, so level-3 coverage line numbers still resolve. `evidence/level-3/make-level3-checks.sh` was
re-run afterwards — `claim-coverage.md` came out byte-identical, `verify.txt` and `wordcount.txt`
updated.

## If the evaluator returns `NEEDS_WORK` on level 4

Read `NEXT_FINDINGS.md` first. Then, before anything else, `bash
evidence/level-4/make-level4-checks.sh` and `bash evidence/level-3/make-level3-checks.sh` to
confirm what is on disk still reproduces. Any repair to a claim goes: edit `REPORT.md` → add or
adjust the `AUDIT` row (and a row in the edits table) → regenerate **both** levels' evidence →
re-check the word count. Do not hand-edit `citation-audit.md` or either `verify.txt`.

The known soft spots, already named in `evidence/level-4/CLAIM.md`: every claim rests on a single
document per axis (no corroboration anywhere); the whole DuckDB side is three papers, two of them
2019/2020, because `duckdb.org/docs/stable/*` was a JS redirect stub at capture time; A2 and A3
scan only the three DuckDB captures, so they mean "this dossier does not answer it"; and the
classifications inside A2/A3 are judgement calls with the hits printed so they can be judged
differently.

## Blocked actions (safety gate; do not retry)

1. **Level 1, still standing.** `rm -f` on two zero-byte artifacts of a failed `motherduck.com`
   fetch. `sources/rejected/excluded-motherduck-vs.headers.txt` remains a zero-byte file that
   backs nothing; documented in `sources/CAPTURE_LOG.md` §3f and in the level-2/3/4 `CLAIM.md`s.
2. **New this session.** I created a stray one-line file at
   `<home>/.claude/projects/-private-tmp-aiceo-smoke/memory/placeholder-ignore.md` by mistake — wrong
   directory entirely; the loop's lesson memory is the repo's `memory/`, not the agent-harness
   one. The `rm -f` to remove it was denied by the gate and logged to `PAUSED_ACTIONS.md`. It is
   outside this repo, so it is in no diff and affects no artifact. Do not retry it.

## Constraints, standing

No SQLite or DuckDB binary is ever executed; no database file is created; no benchmark output
appears in any diff. No money, nothing published. `curl`/`WebSearch` reads are fine.

The dossier stays at **8 entries**, all 8 cited in `REPORT.md`. Do not re-attempt the
`api.github.com/repos/duckdb/duckdb/releases/tags/v1.0.0` fetch; `sources/CAPTURE_LOG.md` §4 and
`memory/duckdb-org-capture-gotchas.md` record why it was rejected.

**Note for the operator (harness, not task).** `bash harness/selftest.sh` reported
`62 passed, 2 failed` at level 2: "want ALLOW got BLOCK — Write evidence patterns" and "want
ALLOW got BLOCK — Write LEVELS.md". Both are frozen-guard cases whose expectations predate the
mid-run plan lock — the guard is behaving as the lock intends, the test still asserts the
pre-lock behaviour. Not re-run since; nothing in `harness/` has been touched.

The plan is **locked** (`.claude/plan-lock.sha256`): `LEVELS.md`, `RUBRIC.md`, the evidence
taxonomy and `evidence-patterns.txt` cannot be edited, and `frozen-guard.sh` also blocks any
Bash command that names one of them — or any `harness/` file — alongside a write-ish token,
including `>`, `awk`, `python3`, `cat` and heredocs that merely mention them. Reading `LEVELS.md`
this session needed the **Read tool**; a `grep -n ... LEVELS.md | head` was denied. Use `sed -n`,
`grep -n` or Read, and the Write tool for new scripts. `bash harness/memcheck.sh` is fine on its
own but blocked if you pipe it through `2>&1`. See
`memory/frozen-guard-blocks-bash-not-just-writes.md`.
