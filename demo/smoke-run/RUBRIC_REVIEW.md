REVISE

I read `RUBRIC.md`, `LEVELS.md`, `EVIDENCE.md`, `SCOREBOARD.json`, the evaluator prompt + addendum, `.claude/evidence-patterns.txt`, and `INIT_PROMPT.md`. This is a better-than-average rubric — the strong parts are listed at the end and should survive untouched. But the whole chain rests on one unscored assumption, the mandatory bar can be cleared with self-authored transcripts, and two criteria are mandatory at levels where their own descriptors cannot be applied.

---

### 1. Traceability — the corpus itself is never scored for provenance (headline finding)

**Attack.** The builder never fetches anything. It writes eight plausible `sources/raw/<key>.txt` files by hand from model recall (DuckDB docs prose is easy to imitate), hashes them, records the hashes in `sources/<key>.md` and `CAPTURE_LOG.md` with invented UTC timestamps, `HTTP 200`, byte sizes, and a `curl` command string. Every quote it "extracts" greps to `1` because it wrote both sides. The evaluator has no `WebFetch` (the addendum says so explicitly), so every check in the rubric passes — sha256s reconcile, byte counts are non-trivial, the evaluator's own re-run reproduces the counts. **This scores Traceability 5.** The internal-consistency checks detect a *tampered* capture; they detect a *fabricated* corpus not at all.

**Replacement.** Score provenance, not just consistency. Traceability 4 should require, and 5 should require the evaluator to re-derive:

> **4** — … and every capture has both an unedited `sources/raw/<key>.src` and a `sources/raw/<key>.txt`; `CAPTURE_LOG.md` records the exact extraction command; and `sources/raw/<key>.headers.txt` holds the response headers as fetched (`curl -D`), including `Date`, `Content-Type`, and `Content-Length` or `Last-Modified`/`ETag`. A `.txt` with no `.src` behind it, or an `.src` that is a hand-composed document rather than the fetched bytes (no HTML/PDF structure, no headers, no boilerplate), is Traceability ≤ 2 regardless of how well the greps pass.
>
> **5** — … and the evaluator re-runs the recorded extraction command on the `.src` and gets a file whose sha256 matches the logged `.txt`.

Add to the addendum's sniff tests: *an HTML capture with no `<`, no nav/footer boilerplate, and no tags is not a fetched page.* Fabrication is currently free; this makes it require forging headers, markup, and a reproducible extraction pipeline.

---

### 2. Traceability — level 4 ("every cited quote is found by the canonical check") does not say *by whom*

**Attack.** The mandatory bar is ≥4. Level 4's wording — "Every cited quote is found in its capture by the canonical check" — is satisfiable by the builder's own `quote-check.txt`, since evaluator re-run only appears at level 5, which nothing requires. A builder pastes a transcript with fabricated `1`s and passes; the evaluator is not obliged by the rubric to run anything (the addendum asks for four, but the addendum "cannot lower the bar" and equally is not what sets it).

**Replacement.** Move the re-run into the mandatory level:

> **4** — The evaluator, sampling **at least four** quotes the report or claim map relies on plus **at least three** sha256 values, reproduces the builder's counts and hashes; every remaining cited quote's transcript shows a real command with a count ≥1 in a copy-pasteable one-line form. Any `0` where the builder recorded a match caps Traceability at 2.

This costs nothing when the work is honest and makes a forged transcript a coin flip rather than a free pass.

---

### 3. Traceability / `LEVELS.md` L1-4 — the PDF exemption is an opt-out from the entire criterion

**Attack.** Declare every source "PDF-only, no text extraction available", save PDFs (or files named `.pdf`), cite page numbers, and write "grep exempt per L1-4" beside each quote. Nothing is greppable, the evaluator's re-run has nothing to re-run, and the rubric never caps the score for a wholly exempt dossier. `pdftotext` is installed on this machine (`/opt/homebrew/bin/pdftotext`), so "no extraction available" is essentially always false — but neither the rubric nor `LEVELS.md` asks for proof that extraction was attempted.

**Replacement.** In `LEVELS.md` L1-4 and mirrored in Traceability:

> A quote may be grep-exempt only if the entry records the extraction command that was attempted and its failing output in `CAPTURE_LOG.md`. At most 2 entries and at most 25% of quotes may be exempt. A dossier in which more than half the quotes are exempt scores Traceability ≤ 2. For each exempt quote the evaluator opens the cited PDF page with the Read tool and confirms the text; a page that does not contain it is Traceability 1.

---

### 4. Decision utility — mandatory ≥4 at levels 1 and 2, where its own descriptors are unscorable

**Attack.** No attack needed; the criterion self-destructs. At level 1 there is no report, no dimensions, and no recommendation, so read literally the maximum achievable is 1 ("No recommendation") — yet the bar is ≥3. At level 2 the bar is ≥4, but level 4 says "the recommendation names conditions the reader can test", and level 2 forbids prose. Two careful evaluators will resolve this differently: one scores level 1 at 3 by fiat, another fails it. This is the widest scoring variance in the rubric.

**Replacement.** Add per-level anchors:

> **Levels 1–2 read the criterion against the scaffolding, not prose.** At level 1: score 4 requires the dossier's coverage to be driven by the scenario — sources captured on larger-than-memory behaviour, write concurrency, ingest formats and file-format/durability, not eight pages of general feature documentation. At level 2: score 4 requires each dimension in `claims/dimensions.md` to name **what the reader could observe about their own workload** to know whether that dimension is decisive for them (a data-size threshold, a concurrency pattern, an ingest format, a durability requirement), and `claims/claim-map.md` to carry, for each dimension where the systems differ, ≥1 row per system. "Performance" or "ease of use" as a bare axis does not count toward the six.

---

### 5. Decision utility 4/5 — "conditions the reader can test" and "sharp enough to change a decision" are vibes

**Attack.** "Choose DuckDB if your workload is analytical and your data is large; choose SQLite if you need transactional writes." That reads like conditions and names two systems, and a sympathetic evaluator gives it a 4. A strict one calls it a 3.

**Replacement.** Make the test mechanical:

> **4** — the recommendation contains **≥3 conditions each stated as an observable property of the reader's own setup** — a data-size relationship (fits in RAM / exceeds it), a concurrency pattern (number of concurrent writers), an ingest format, or a durability/embedding requirement — and each condition is checkable without running either system. Conditions phrased as workload adjectives ("analytical", "heavy", "fast") do not count.
> **5** — … and at least one passage states what the recommended choice **costs** the reader, cited, plus one named case where the answer is "use both" with the specific division of labour.

---

### 6. Calibration 5 — "visible restraint" is one sentence of theatre

**Attack.** Add to `REPORT.md`: *"We would have liked to quantify the gap, but no primary source benchmarks this workload, so we make no speed claim."* One sentence, zero work, and it matches the rubric's own worked A5 almost word for word. The worked example has become a template to copy.

**Replacement.** Require restraint to leave a diff, not a sentence:

> **5** — … plus restraint that is traceable in the artifacts: at least one claim row in `claims/claim-map.md` marked `DROPPED` or `WEAKENED` with the reason and the quote that failed to support it, or an edit named in `evidence/level-4/citation-audit.md`, **and** the corresponding entry in `claims/gaps.md`, **and** the report passage reflecting it. A statement of restraint in prose with no dropped or weakened claim behind it scores 3, not 5.

---

### 7. Source primacy 4 — `claims/excluded-sources.md` is unfalsifiable, and "tied to §3" is keyword bait

**Attack.** Invent two URLs never fetched: "`someblog.example/duckdb-vs-sqlite` — undated blog post, `EVIDENCE.md` §3"; "`vendor.example/compare` — marketing page, §3". Two entries, both reasons name §3, criterion met. The builder did no filtering at all.

**Replacement.**

> **4** — `claims/excluded-sources.md` names ≥2 rejected documents with URL, the §3 clause and the *observed* fact that triggers it (the missing date, the marketing framing quoted in ≤10 words), and **at least one of them appears in `sources/CAPTURE_LOG.md`** as a fetch that was made and then rejected. Exclusions that could have been written without ever seeing the document score 3.

---

### 8. Source primacy — `dated:` is the field most worth faking and the least checkable

**Attack.** Fill every `dated:` with a plausible ISO date. The addendum only checks it is non-empty and not after `accessed`. An invented date launders a non-primary source into a primary-looking one, which is precisely the failure mode this criterion exists to catch.

**Replacement.**

> **4** — every entry's `dated` value is *locatable*: the header carries a `dated_locator` (the anchor, heading, or "last modified" line in the capture where the date appears), and `evidence/level-1/quote-check.txt` includes a grep for that date string against the capture with output. A date that appears nowhere in the capture is Source primacy ≤ 2.

Same mechanism as the quote check: cheap to check, expensive to fake.

---

### 9. Craft ≥3 lets a level pass while failing its own acceptance criteria

**Attack (a).** Craft 3 explicitly tolerates "the `## Sources` list disagreeing with a source entry header" and "`memory/INDEX.md` out of sync" — but `LEVELS.md` L3-3 requires the `## Sources` block to match the entry header *exactly*, and the frozen core requires one INDEX line per file. A builder ships a mismatched source list, scores Craft 3, and passes a level whose criterion 3 is unmet. The catch-all ("any acceptance criterion with no evidence artifact behind it is `NEEDS_WORK`") does not fire, because the artifact exists — it is merely wrong.

**Attack (b).** 1,270 body words is "outside the band" but not "by a wide margin", so it is a 2 or 3, and L3-1 is a hard 900–1200. Same passing-while-failing gap.

**Replacement.**

> - Word count outside 900–1200 is Craft ≤ 2 **and** an unmet acceptance criterion → `NEEDS_WORK`, no margin.
> - A `## Sources` entry that disagrees with its `sources/<key>.md` header in any of title, publisher, URL, `dated`, `accessed` is a **Traceability** defect (it breaks key resolution), not a cosmetic one, and caps Traceability at 3.
> - **Craft must score ≥ 4 on levels 3 and 4**, where the mechanical contract *is* the deliverable.

Also add to the catch-all: *an acceptance criterion whose artifact exists but does not show what the criterion requires is `NEEDS_WORK`, the same as a missing artifact.*

---

### 10. `LEVELS.md` promises a rubric behaviour the rubric does not have (UNCHECKED rows)

**Drift.** L4 "Where the budget binds" says a partial audit that marks rows `UNCHECKED` "is far more useful than a completed table of unverified PASSes, **and the rubric scores it that way**." `RUBRIC.md` never mentions `UNCHECKED`. Read as written, a partial audit fails Traceability 4 ("every cited quote is found") and L4-1 ("in the final state every row reads PASS"), so the honest builder is punished and the dishonest one — all PASS, all self-certified — is rewarded. That is exactly inverted from the closing paragraph's stated philosophy.

**Replacement.** Add to Traceability, and mirror in L4-1:

> An audit row marked `UNCHECKED` with the reason is not a defect **provided the claim it covers has been removed or weakened in `REPORT.md`**, or the row is one of ≤3 and `CLAIM.md` names them as the residual risk. `UNCHECKED` rows for claims left standing in the report are FAILs, not honesty.

---

### 11. Level-3 claim coverage and level-2 row counts are self-certifying / volume proxies

**Attack (a).** `evidence/level-3/claim-coverage.md` is a builder-written table of "section + sentence opening → claim id → key#Qn". Nothing requires the sentence opening to actually exist at that location, and nothing scores whether the sentence asserts the claim. Fabricate twelve rows; L3-5 met.

**Attack (b).** ≥14 claim rows is a count. Split one quote into three near-identical claims ("DuckDB is columnar", "DuckDB stores data by column", "DuckDB's storage is column-oriented"), all citing `duckdb-cidr19#Q1`. 14 rows on 5 distinct quotes.

**Replacement.**

> - Coverage rows must carry the **`REPORT.md` line number and the exact sentence text**, so the evaluator can Read that line. A coverage table whose locations do not match the report caps Traceability at 3 and Craft at 2.
> - Level 2 requires ≥14 rows resting on **≥10 distinct `key#Qn` pairs across ≥6 distinct keys, no more than 3 rows per `Qn`**. Rows that restate the same fact in different words count once.

---

### 12. No minimum quote substance — the grep is passable with fragments

**Attack.** Write the claim from model recall first, then grep the real capture for any short string that co-occurs — "larger than memory", "single writer" — and record it as `Q1` with a locator. Every canonical check returns 1 and the quote is genuinely in the document, yet it supports nothing. Traceability 4's "the claim's quote contains the claim's substance" is the only guard and is pure judgment.

**Replacement.** In `EVIDENCE.md` §1.1 and Traceability:

> Each quote is a contiguous span of **≥12 words containing at least one complete sentence** of body prose. Headings, nav labels, table cells, and code-comment fragments do not qualify as quotes. A dossier where the median quote is under 12 words scores Traceability ≤ 3 regardless of grep results.

---

### 13. Minor / notes

- **`CAPTURE_LOG.md` field completeness has no scoring home.** L1-6 requires HTTP status, UTC timestamp, exact fetch command and extraction command; the only rubric hook is Craft, whose 3 is passing. Since the extraction command is what makes finding #1's re-derivation possible, put log completeness under **Traceability**, not Craft.
- **`LEVELS.md` L1-5 says "a capture for every entry"** (singular) while `EVIDENCE.md` §1.2 requires `.src` *and* `.txt`. Fix L1-5 and `SCOREBOARD.json` level-1 `check` to name both explicitly, or finding #1's fix has no acceptance criterion behind it.
- **"≥8 source entries" is the one surviving volume proxy.** Tie it to coverage instead: every dimension in `claims/dimensions.md` must have ≥1 primary source in the dossier, and every entry must be cited by ≥1 claim row by the end of level 2 or moved to a `sources/unused/` note.
- **Calibration 5 requires `CLAIM.md` "honest about unmet criteria"** — which a level that genuinely meets everything cannot satisfy, and which invites performative fake-unmet admissions. Reword as: "*where* a criterion is unmet, `CLAIM.md` says so before the evaluator finds it; where all are met, the CLAIM makes no assertion the artifact does not show."
- **Quote-check transcripts should be required copy-pasteable at level 4, not 5** — the evaluator's sampled re-run (finding #2) depends on it.

---

### What is good and should not be rewritten

- **The stated bias — "cheap to check and expensive to fake" — is actually implemented** in the canonical `tr | grep -F -c` chain. That one command does more anti-gaming work than most whole rubrics.
- **Volume is explicitly refused**, in the rubric ("a long bibliography is worth nothing here") and in `LEVELS.md` ("at most 12 entries — this level is not scored on volume", "a 9th source is worth less than a verified 8th"). Rare and correct.
- **Worked examples at 1/3/5 with real file paths and real quote text.** The 3-anchors especially ("probably right and unverifiable, which is a 3, not a 4") do the hard work of separating *true* from *shown*. Keep them — but see finding #6, where the A5 example has become copyable.
- **`EVIDENCE.md` §3 excluding `REPORT.md`, `CLAIM.md`, `PROGRESS.md`, and commit messages from evidence**, enforced in `.claude/evidence-patterns.txt`. The deliverable is not proof of itself; that is the right cut.
- **The automatic `NEEDS_WORK` for a forbidden action**, with the addendum's concrete extension detector (`.py`, `.db`, `.duckdb`, `.parquet` in the diff). Unambiguous and unbargainable.
- **Mandatory floors on exactly the two criteria that encode the binding constraint**, with the explicit "a level cannot pass by being well written." That is the correct place to be inflexible, and the ARS-plugin note in the addendum ("fluent, well-formatted output is *not* a signal of good sourcing") anticipates the specific way this environment produces polish without provenance.
- **The closing philosophy** — honest partial work outscores complete-looking work that does not survive checking — is right. Findings #6 and #10 are about making the rubric's mechanics actually pay it out, not about changing it.
