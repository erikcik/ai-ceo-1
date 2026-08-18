# EVIDENCE.md — what counts as proof in this task

Domain: technical research and writing. The deliverable is a sourced prose document. Nothing
is built, benchmarked, or run, so there are no tests, logs, or metrics to point at. That
makes the evidence question sharper, not softer: **the only thing that separates a sourced
comparison from a confident guess is a chain from each sentence in the report back to a
quoted passage in a captured primary document.** Everything below exists to make that chain
inspectable by someone who was not here.

A skeptical reader must be able to take any claim in `REPORT.md`, follow one citation key,
land on a source entry, read the verbatim quote, and confirm with a shell one-liner that the
quote really occurs in a locally stored capture of that URL. If they cannot do that for a
claim, the claim is unevidenced regardless of how true it happens to be.

---

## 1. Kinds of evidence

### 1.1 Source entry — `sources/<key>.md`

One file per source. `<key>` is lowercase, hyphenated, stable, and identifies the document,
not the topic: `sqlite-whentouse`, `duckdb-cidr19`, `duckdb-relnotes-1-0`. This key is what
`REPORT.md` cites and what `claims/claim-map.md` references.

Required header (a fenced YAML block at the top of the file):

```yaml
key: duckdb-cidr19
subject: duckdb            # duckdb | sqlite | both
title: "DuckDB: an Embeddable Analytical Database"
publisher: "CIDR 2019 / CWI Database Architectures"
source_type: paper         # docs | paper | release-notes | spec
url: https://...
dated: 2019-01-13          # publication date, version date, or release date of the document
dated_locator: "§ header block, line 'Published: January 13, 2019'"   # where that date appears in the capture
accessed: 2026-08-18       # ISO date the capture was taken
capture_file: sources/raw/duckdb-cidr19.txt
sha256: <sha256 of the capture file named above>
```

`dated_locator` is what makes `dated` checkable rather than assertable: it names the anchor,
heading, or "last modified" line **in the capture** where the date is printed, and
`evidence/level-1/quote-check.txt` carries a grep for that date string against the capture,
with output. A date that appears nowhere in the capture is an invented date, and an invented
date is how a non-primary source gets laundered into a primary-looking one.

Body: **two or more verbatim quotes**, each labeled `Q1`, `Q2`, … Each quote carries a
locator (section heading, HTML anchor, or PDF page number), is 75 words or fewer, and is a
contiguous span of **≥12 words containing at least one complete sentence of body prose**.
Headings, nav labels, table cells, and code-comment fragments are not quotes: a two-word
string that happens to occur in the document supports nothing, however cleanly it greps.
Format:

```
### Q1 — §"Why DuckDB" / page 3
> verbatim text, unaltered, no ellipsis inside the quoted span
```

A short "why this source matters" note is welcome. Paraphrase in the note is fine;
paraphrase inside a `>` quote block is a defect.

### 1.2 Raw capture — `sources/raw/<key>.<ext>`

The document as fetched, stored locally, plus a plain-text rendering that quotes are checked
against.

- `sources/raw/<key>.src` — bytes as fetched (HTML, PDF, or text), unedited.
- `sources/raw/<key>.txt` — plain text extracted from `.src` by a command recorded in the
  capture log. Both files must exist on disk. For a source fetched as plain text they may be
  byte-identical, in which case the recorded extraction command is the copy that produced the
  `.txt`.
- `sources/raw/<key>.headers.txt` — the response headers exactly as returned (`curl -D`),
  including `Date`, `Content-Type`, and `Content-Length` or `Last-Modified`/`ETag`.
- For PDFs where text extraction genuinely fails, every quote from the source must carry a
  **page number** so the evaluator can open that page with the Read tool — and the attempted
  extraction command *and its failing output* must be in `CAPTURE_LOG.md`. `pdftotext` is
  available on this machine, so "no extraction available" is a claim that has to be shown,
  not asserted. At most 2 entries and at most 25% of quotes may rely on this exemption.

Captures are **write-once**. Editing a capture so a quote matches is the single most serious
failure mode in this task; the capture log's `sha256` and byte size exist to make that
visible.

A capture that was **never fetched at all** is the failure the `.src` and `.headers.txt`
exist to catch. A `.txt` with no `.src` behind it, or an `.src` that reads as a hand-composed
document rather than the bytes a server returned — an HTML capture containing no `<`, no
tags, and no nav or footer boilerplate — is not a capture, and no amount of internally
consistent hashing makes it one.

### 1.3 Capture log — `sources/CAPTURE_LOG.md`

One row or block per capture, recording: URL, UTC timestamp, the exact fetch command, HTTP
status code, byte size of `.src`, sha256 of the file quotes are checked against, and the text
extraction command. "Exact" is load-bearing for the extraction command: re-running it on the
`.src` must reproduce the `.txt` byte for byte, because that re-derivation is how a stranger
confirms the text was extracted from a fetched document rather than written by hand. Log
completeness is scored under **Traceability**, not Craft, for the same reason.

Failed fetches are logged too, with the error and the decision taken (usually: do not cite
this source) — as are failed *extractions*, with their error output, whenever a quote is
claimed grep-exempt.

Documents that were fetched and then rejected as non-primary belong in the log as well; at
least one entry in `claims/excluded-sources.md` must be traceable to such a fetch.

### 1.4 Quote-match transcript — `evidence/level-<N>/quote-check.txt`, `map-check.txt`, `verify.txt`, `wordcount.txt`

The commands the builder ran to verify its own artifacts, **with their output pasted in**.
Not a description of having run them. The canonical quote check, which the evaluator can
re-run verbatim:

```sh
tr -s '[:space:]' ' ' < sources/raw/<key>.txt | grep -F -c "<the quote text on one line>"
```

A quote passes if the count is ≥ 1 after whitespace normalization. Whitespace collapsing is
the only normalization permitted; changed words, dropped punctuation, or "cleaned up"
capitalization mean the quote is not verbatim and does not pass.

Each check is pasted as a **single copy-pasteable line** followed by its output, because the
evaluator samples at least four of them and re-runs them unmodified. A transcript the
evaluator has to reassemble by hand is not a transcript. A `1` that the evaluator's own
re-run reports as `0` is the worst outcome available in this task.

sha256 re-verification:

```sh
shasum -a 256 sources/raw/*.txt sources/raw/*.src
```

Extraction re-derivation — that the `.txt` came out of the `.src` rather than out of a model:

```sh
<the extraction command exactly as logged> && shasum -a 256 sources/raw/<key>.txt
```

Body word count of the report:

```sh
awk '/^## Sources/{exit} {print}' REPORT.md | wc -w
```

### 1.5 Claim scaffolding — `claims/*.md`

- `claims/dimensions.md` — the comparison axes, why each matters for this reader, and what
  the reader could observe about their own workload to know whether that axis decides
  anything for them.
- `claims/claim-map.md` — one row per intended substantive claim: claim id, dimension, the
  claim in one sentence, which system it concerns, `key#Qn`, a short verbatim fragment of the
  supporting quote, and a status. Status is `OK` until a check fails, then `WEAKENED` or
  `DROPPED` with the reason and the quote that failed to support it. Those rows are the
  durable record of restraint — a sentence in the report saying "we could not source this"
  with no such row behind it is a sentence, not a decision.
- `claims/gaps.md` — questions the primary sources do not answer, which the report therefore
  must not assert. Every `WEAKENED`/`DROPPED` row has a corresponding entry here.
- `claims/excluded-sources.md` — documents considered and rejected as non-primary: URL, the
  §3 clause, and the observed fact that triggers it (the missing date, the marketing framing
  quoted in ≤10 words). At least one entry is traceable to a fetch in `CAPTURE_LOG.md`.
  Absence of this file reads as "no filtering was done"; entries that could have been written
  without opening the document read the same way.
- `evidence/level-3/claim-coverage.md` — for each claim row that made it into the report, the
  `REPORT.md` line number and the exact sentence text, the claim id, and the `key#Qn`. Line
  number and sentence text, not "section + sentence opening": the point is that the evaluator
  can Read that line and see the claim asserted there.

### 1.6 Citation audit — `evidence/level-4/citation-audit.md`

One row per substantive sentence in the finished report, mapping it to `key#Qn` with a
PASS/FAIL/`UNCHECKED` and a note. This is the end-to-end check that the chain closes.

`UNCHECKED` is a legitimate verdict when the session ran out before the row could be checked —
but only where the claim it covers has been removed or weakened in `REPORT.md`, or where it is
one of at most three such rows and `evidence/level-4/CLAIM.md` names them as the residual
risk. A claim left standing in the report on an `UNCHECKED` row is a FAIL wearing an honest
label.

### 1.7 Builder claim — `evidence/level-<N>/CLAIM.md`

Per acceptance criterion: the artifact that satisfies it and what in that artifact does so.
A claim is not itself evidence — it is the index the evaluator checks the evidence against.

---

## 2. What makes an instance valid

A **source entry** is valid when every header field is filled with a real value (no `TBD`,
no empty string, no `n/a` for `dated` unless the document genuinely carries no date — in
which case it is not primary here and should not be an entry at all), the `capture_file`
exists, its sha256 matches, and every quote in the body is found in the capture by the
canonical check.

A **capture** is valid when it is non-trivial (an HTTP 200 with a body of a few hundred bytes
is usually a redirect stub or a JS shell, not the document — check it and re-fetch the real
URL), when its sha256 matches the log, and when it was fetched, not composed. "Fetched, not
composed" is checkable, and is checked: the `.src` carries the structure a server actually
sends (markup, PDF object headers, boilerplate), `.headers.txt` carries the response headers,
and the logged extraction command re-run on the `.src` reproduces the `.txt`. Internal
consistency — hashes that reconcile, greps that return `1` — proves only that one author
wrote both sides.

A **verification transcript** is valid when it shows commands *and* their real output, and
when the output is consistent with the artifacts on disk at the time the evaluator looks. A
transcript showing a count of `1` for a quote the evaluator's own re-run reports as `0` is
worse than no transcript.

A **claim-map row** is valid when the cited `key#Qn` resolves to an existing quote and that
quote actually contains the substance of the claim. A quote that is merely *about* the same
topic does not support the claim.

Concrete examples of worthless instances, all of which have been seen in this genre:

- A source entry whose header lists a URL but whose `capture_file` does not exist.
- A quote block that is a fluent paraphrase of the source rather than its words.
- A capture file that is a 473-byte redirect page while the entry quotes three paragraphs.
- A `quote-check.txt` that lists the commands but shows no output.
- A claim in `REPORT.md` with a citation key that appears nowhere in `sources/`.
- A performance figure with a citation to a page that contains no number.
- A `sources/raw/<key>.txt` with no `.src` and no `.headers.txt` behind it — nothing
  distinguishes it from prose written from memory and hashed.
- A "quote" of three or four words ("larger than memory", "single writer") that greps to `1`
  and supports no claim: the claim was written first and the string was found afterwards.
- A `dated:` value that appears nowhere in the capture.
- An `excluded-sources.md` entry naming a URL that appears in no fetch log — a document
  rejected without ever being seen.

## 3. What is explicitly not evidence here

- **The report itself.** `REPORT.md` is the deliverable, not proof that it is sourced. It is
  deliberately excluded from `.claude/evidence-patterns.txt` for that reason.
- **`PROGRESS.md`, `CLAIM.md`, commit messages, or session narration.** These are assertions.
- **Anything measured on this machine.** The task forbids benchmarking. A timing, a file
  size, or a query plan produced by running SQLite or DuckDB here is not admissible evidence
  and its presence is a constraint violation, not a bonus.
- **Non-primary publications**, per the initialization prompt: vendor marketing pages,
  undated blog posts, third-party benchmark posts, forum answers, Stack Overflow, LLM
  recall. Official project blogs *are* admissible only when the post is dated and functions
  as a release note or documentation for that project's own software; when in doubt, log it
  in `claims/excluded-sources.md` and prefer the docs or the paper.
- **A URL without a capture.** If it was not stored locally, no one can check it later.
