# SCOREBOARD_CHECK_PATCH.md — operator patch for `SCOREBOARD.json`

**Status: applied.** The operator applied this patch to `SCOREBOARD.json`'s level-1 `check` by
hand (`OPERATOR_NOTES.md` item 3), with one deliberate change of their own: the dossier volume
was scoped down for this throwaway run — `5-8` entry files instead of `8-12`, `>=2` per system
instead of `>=3` (`OPERATOR_NOTES.md` item 4). `LEVELS.md` L1-1 and L1-2 carry the same
numbers. Every verification requirement below is unchanged by that rescope. Because level 2
criterion 3 and level 3 criterion 4 both require ≥6 distinct cited keys, the effective floor
is 6 entries, not 5; that is noted in `LEVELS.md` L1-1.

`RUBRIC_REVIEW.md` finding 13, second bullet:

> **`LEVELS.md` L1-5 says "a capture for every entry"** (singular) while `EVIDENCE.md` §1.2
> requires `.src` *and* `.txt`. Fix L1-5 and `SCOREBOARD.json` level-1 `check` to name both
> explicitly, or finding #1's fix has no acceptance criterion behind it.

`LEVELS.md` L1-5 has been fixed in place. `SCOREBOARD.json` is written by the wrapper and the
builder cannot edit it (`frozen-guard.sh` denies the write), so the corrected string is given
here for the operator to apply by hand.

**Do not change `"passes": false`.** Only the `check` value changes.

---

## Replacement for `SCOREBOARD.json` → `level-1` → `check`

Replace the entire current value with the following string, verbatim (one line, no embedded
newlines or double quotes, so it drops into the JSON as-is):

```
sources/ holds 8-12 entry files sources/<key>.md, each with a complete EVIDENCE.md 1.1 header (key, subject, title, publisher, source_type, url, dated, dated_locator, accessed, capture_file, sha256) and >=2 verbatim quotes labeled Q1.. of <=75 words, each a contiguous span of >=12 words containing at least one complete sentence of body prose and each with a locator; >=3 entries subject=sqlite and >=3 subject=duckdb; source_type set includes >=1 paper and >=1 release-notes; scenario coverage present for larger-than-memory behaviour, write concurrency, ingest formats, and file format/durability; every entry has BOTH sources/raw/<key>.src (bytes as fetched, unedited) AND sources/raw/<key>.txt (text extracted from it), plus sources/raw/<key>.headers.txt holding the response headers as fetched including Date, Content-Type, and Content-Length or Last-Modified/ETag; each capture sha256 matches the entry header and sources/CAPTURE_LOG.md, and no capture is a redirect stub, an empty body, or a hand-composed document rather than fetched bytes; sources/CAPTURE_LOG.md records per capture URL, UTC timestamp, exact fetch command, HTTP status, byte size, sha256, and the exact extraction command such that re-running it on the .src reproduces the .txt, plus failed fetches and failed extractions with their error output and the decision taken; evidence/level-1/quote-check.txt shows the canonical tr/grep -F -c command and its output with count >=1 for every quote, written as copy-pasteable one-liners, plus a grep of each entry dated value against its own capture with output; a quote is grep-exempt only with the attempted extraction command and its failing output logged and a PDF page number cited, and at most 2 entries and at most 25% of quotes may be exempt; claims/excluded-sources.md lists >=2 rejected non-primary documents, each with URL, the EVIDENCE.md section 3 clause, and the observed fact that triggers it, at least one of which appears in sources/CAPTURE_LOG.md as a fetch that was made and then rejected.
```

---

## Note for the operator — levels 2–4 `check` strings

Not requested by finding 13, and **not** included above; flagged only so the drift is visible.
The level-2, level-3 and level-4 `check` strings in `SCOREBOARD.json` still describe the
pre-revision acceptance criteria. They are not wrong, but they no longer name these additions
now present in `LEVELS.md`:

- **level-2** — dimensions must name an observable property of the reader's workload; the ≥14
  claim rows must rest on ≥10 distinct `key#Qn` across ≥6 distinct keys with ≤3 rows per `Qn`;
  a status column (`OK`/`WEAKENED`/`DROPPED`); new criterion 7 (every dimension has ≥1 primary
  source, every entry cited by ≥1 row or moved to `sources/unused/`).
- **level-3** — recommendation must state ≥3 conditions as observable properties of the
  reader's setup; `## Sources` must match the entry header field for field; coverage rows must
  carry the `REPORT.md` line number and exact sentence text.
- **level-4** — `UNCHECKED` is a permitted verdict under the stated conditions (≤3 rows named
  in `CLAIM.md`, or the claim cut/weakened); `verify.txt` gains a fourth check, the extraction
  command re-run on at least one `.src` reconciled by sha256 against the logged `.txt`.
