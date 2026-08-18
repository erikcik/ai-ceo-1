# Generate the verification transcript; don't write it

Learned building a claim→source map that a fresh-context evaluator re-runs (2026-08-18).

**Generate the transcript with a script that actually runs the commands and pastes their real
output.** Write a generator that reads the source entries, builds each one-liner, executes it,
and writes command + output to the transcript file. Then the quoted text in the transcript is
the entry's text *by construction* — it cannot drift from what the entry says, which is the
one failure mode ("a `1` the evaluator's re-run reports as `0`") that caps the whole thing.
Hand-typing 48 commands invites exactly that drift.

**Grep with the FULL quote, not a fragment.** A fragment check proves a string exists
somewhere in the document; the full-quote check proves the whole span you attributed is
verbatim. Same cost, much stronger claim.

**Check the fragment against the *cited quote*, not the document.** If a map row carries a
short fragment, verify it is a substring of the specific quote that row cites — pull the quote
out of the entry (`grep -A1 '^### Q2 ' sources/<key>.md | sed -n '2s/^> //p'`) and grep the
fragment against *that*. Grepping it against the capture only proves the words occur in the
document, which is exactly the "claim written first, string found afterwards" failure.

**Prove the arithmetic, don't assert it.** Every "≥14 rows / ≥10 distinct pairs / ≤3 per
quote" style criterion should be a command with output in the transcript, not a sentence in
the claim. If the map table has a fixed column layout, `awk -F'|'` over the status-filtered
rows gives row counts, per-dimension counts and per-dimension-per-system counts in one line
each. Design the table's column order **before** writing rows so those one-liners are possible.

**Re-run the counts after any late edit to the map.** Editing two rows for wording is exactly
when the transcript silently stops matching disk. Better: **keep the generator on disk next to
the transcript** (`evidence/level-<N>/make-<name>.sh`, with the invocation in its header
comment). Then "re-run the counts" is one command, a fresh session can reproduce the whole
file, and the artifact stops depending on the session that wrote it — which matters, because a
session *can* be asked to redo a level it already finished (an evaluator that crashes leaves no
findings, and the wrapper just starts the level again).

**The fragment check cannot catch a claim sentence that drifts past its quote.** Proving the
fragment is a substring of the cited quote says nothing about the *claim* column: an em-dash
gloss ("— the layout that makes single-row work natural"), an "at worst" where the source says
"might", a "well inside it" where the source's boundary has three parts and only one is a size.
Read every quote against its own row once, at the end, as a separate pass. Record what was
narrowed in a small "rows tightened on re-read" table — same value as the DROPPED rows.

**Never let a transcript print a `0` that is expected.** A sha256-reconcile loop over
`sources/raw/*.txt` picks up `*.headers.txt`, which the capture log does not hash, so eight
rows print `0` — indistinguishable at a glance from a tampered capture. Narrow the glob
(`$(ls sources/raw/*.txt | grep -v headers)`) rather than explaining the zeros in prose.

**Closure checks are cheap and worth writing both directions**: every dimension has a source,
*and* every source is cited by ≥1 row. The second one catches the entry you captured and never
used.

**A source that passes provenance but supports no claim is worth less than no source.** When a
dossier is scored by coverage rather than count, adding an entry no row can cite is a net
negative — and quoting something trivial from it just to clear a two-quote minimum is the
"greps to 1, supports nothing" failure. Log the fetch and the rejection instead; the record of
having looked is itself evidence. See [[duckdb-org-capture-gotchas]] for the case that forced
this.

**Cut claims are evidence.** Keep the rows you dropped or weakened, with the reason and the
quote that failed to support them, next to the rows that survived. A rubric that rewards
calibration wants the diff, not a disclaimer sentence.

**A number your claim derives is a number your quote does not contain.** An evaluator failed a
level over one row: "less than a terabyte of content — a content-size bound that 5 GB is three
orders of magnitude inside". The quote has the terabyte; the ratio was the builder's own
arithmetic — and the arithmetic was wrong too (1 TB / 5 GB ≈ 200×, about 2.3 orders). Both
halves matter: a derived figure is unsourced even when it is correct. Give the *direction* of
the comparison ("a bound far below which a 5 GB dataset sits") and leave division to the reader.

**A pattern grep is not a check of the criterion, only of the pattern.** "No smuggled numbers"
was defended with `grep 'Nx faster|N ms'`, which cannot see "three orders of magnitude" — so
the CLAIM.md sentence resting on it asserted more than the artifact showed, and that cost a
second finding on its own. Replace pattern-negatives with **enumerate-and-classify**: pull
*every* instance out of the artifact (every numeric token in every claim sentence) and show,
per instance, which sourced thing accounts for it — the cited quote, that quote's locator
heading, the entry's `dated:` field. Then print the residual set. A residual of one, named and
justified in the claim, is much stronger evidence than an empty grep.

**Match short numbers on boundaries.** The first cut of that audit scored the `5` of "5 GB" as
sourced, because a `5` occurs inside `2025-05-31`. `grep -F` on a one-digit token proves
nothing: use `(^|[^0-9.])<n>([^0-9]|$)`.

Related: [[quote-verbatim-from-extracted-text]], [[web-capture-recipe]],
[[session-tooling-gotchas]].
