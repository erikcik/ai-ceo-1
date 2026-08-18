# Auditing a finished cited report: audit sentences, not citations

Learned 2026-08-18 doing the end-to-end citation audit of a 1192-word sourced comparison.
Companion to [[machine-checked-claim-maps]], which covers the map; this covers the final pass.

**Enumerate every sentence, then classify — do not audit the cited ones.** A table with a row
per `[key]` proves nothing about the sentences that carry no key, and those are where the
overreach lives: limits passages, glue, "no source says X". Pull the sentence-start lines out of
the deliverable mechanically (same join-until-a-full-stop rule the report is written to, skipping
heading lines), give every row a *kind* — CLAIM / RESTATE / ABSENCE / GLOSS / LIMIT / DOSSIER /
LABEL / META / SCENARIO — and state per kind what would count as verification. Uncited sentences
get a row saying why no source is required. 49 rows for 22 cited claims, in the case that taught
this.

**Prove the table is complete with a set difference, not a sentence.** Print the report's
sentence-start lines and the audit's row lines side by side and `comm` them both ways. "Sentences
with no audit row: (none)" is a check; "one row per sentence" is a promise. Guard the `(none)`:
`echo "${d:-(none)}"`, never a bare `echo "(none)"` after the output — that prints "(none)"
underneath the very rows it denies.

**Compute the verdict column.** PASS = the canonical quote grep returned ≥1 **and** the sentence
carries the inline `[key]`. Where it does not, emit `back-reference` and name the line that does,
rather than silently counting it as cited. A hand-typed PASS column is the same artifact as no
audit at all.

## Absence claims are checkable, and they are where the report lies

"No source here states X" is a *claim*, and the honest check is enumerate-and-classify, not a
negative grep: run a deliberately **broad** pattern over the captures, print every hit with ~90
characters of context, attach a classification to each, and print the residual (hits nothing
accounted for), which must be 0. A residual of 0 means "no hit went unclassified" — say that,
because whether a given hit reads the other way is still a judgement, and printing the hit is what
lets the evaluator judge it differently.

**Two absence claims failed this way, and both are recurring shapes:**

1. **The scope word is load-bearing.** "No source speaks to Parquet, Arrow or JSON" was false —
   the *captures* mention Parquet once and JSON 46 times — while "no *accepted quote* describes
   loading Parquet, Arrow or JSON" was true (0 hits across 24 quotes). Captures are always dirtier
   than the quotes drawn from them. Decide which set the sentence means, write that word, and
   check that set. Then print the *other* set's hit counts anyway, including the zeros, so the
   narrowing is visible rather than hidden.
2. **An absence claim can contradict the report's own earlier sentence.** "No SQLite-authored
   statement in this dossier weighs against it" — while the same report asserted, forty lines
   earlier, SQLite's own listing of large-dataset analysis. Grep the deliverable against itself:
   for each absence claim, search the *quotes* for the topic it denies and check whether any of
   the hits is a quote the report already cites.

Both were fixed by **weakening, not deleting** — a narrower true statement survived in each case,
and a weakened claim with the before/after and the check that forced it is worth more to a
calibration rubric than a clean one. Keep the edits in a table at the top of the audit: before,
after, and the check id.

**Re-derive all the extractions, not the one the criteria ask for.** "At least one `.src`
re-extracted to a matching sha256" costs the same script as all eight, and one capture proves one
capture. Redirect the re-run's output to a scratch path (`/tmp/...`) so the write-once capture is
never the target, and print both the logged command and the substituted one.

**Never print a bare `0` you expect.** `shasum -a 256 sources/raw/*` picks up `.headers.txt`
files the capture log does not hash. Classify them (`NOT-HASHED-IN-LOG`) in the same table as the
matches instead of leaving eight `log-hits=0` lines that read as tampering.

Related: [[machine-checked-claim-maps]], [[writing-a-word-banded-cited-report]],
[[quote-verbatim-from-extracted-text]], [[session-tooling-gotchas]].
