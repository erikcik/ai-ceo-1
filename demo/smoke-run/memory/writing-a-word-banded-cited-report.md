# Writing a hard-word-banded report out of a claim map

Learned 2026-08-18 writing a 900–1200 word sourced comparison from a 29-row claim map.

**Write one sentence per line.** Semantic line breaks, wrapped at ~100 columns, render as normal
paragraphs in Markdown and make the coverage table exact: "claim C12 → line 46" is checkable by
a stranger with `sed -n '46p'`. It also lets a script *extract* each mapped sentence from the
report instead of retyping it, so the location and the text cannot drift apart — the same
generate-don't-type rule that applies to verification transcripts. Extraction rule that works:
join lines from N until one ends in a full stop.

**Budget words before picking rows.** A cited claim sentence costs 20–40 words and is nearly
incompressible: it has to carry the claim, the attribution, and the `[key]`. Glue sentences,
the intro and the recommendation are the only real slack. First draft of a 1200-word ceiling
report came in at **1681** with 25 claims; landing it took cutting six claim rows and rewriting
every non-claim sentence. Plan ~45 words per claim row including its share of glue, then decide
how many rows fit — cutting a row later is cheap, compressing a claim into an uncitable
generality is not.

**A fact "everyone knows" is an unsourced fact.** A draft said two papers "predate the 1.0.0
release". True, and in no accepted quote — the release-notes fetch for it had been *rejected*
at capture time. Version numbers, release dates and product milestones are exactly the class an
evaluator greps for. State only the versions your quotes name.

**Print the command you actually ran.** A transcript line reading `sed -n 'Np;N+1p;N+2p'` next
to a check that really used a variable-length extraction is worse than no transcript: the
evaluator's re-run of the printed form returns something else. Emit the exact one-liner,
including the `awk` that did the work, and re-run one or two yourself afterwards.

**Classify every number, including the ones that are not quantities.** An enumerate-and-classify
audit over a report body pulls digits out of citation keys (`duckdb-sigmod19`, `duckdb-cidr20`),
out of code spans (`sqlite3`), and out of your own numbered list. Give those a
`NOT-A-QUANTITY` class rather than filtering them out silently, print the `UNCLASSIFIED` count
(must be 0) and the residual count, and name the residual in the claim.

**Watch the negative grep's alternatives.** `[0-9]+ *(ms|s|sec)` matched "2019 sentence" and
printed `1` under a note that said 0 expected — a self-contradicting transcript, which caps
traceability on its own. Anchor short unit alternatives on a non-letter: `(ms|s|sec)([^a-z]|$)`.

**A recommendation scores on observability, not on hedging.** Conditions have to be properties
the reader can check without installing anything — RAM vs working set, count of writing
processes, single-row updates vs bulk rebuild, how long the file must stay readable. Where one
side is unsourced, say "unknown, not an answer" instead of quietly awarding the point.

Related: [[machine-checked-claim-maps]], [[session-tooling-gotchas]].
