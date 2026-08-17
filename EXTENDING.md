<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Extending to a new domain

Three worked initializations, in unrelated domains. Each shows the four things that change
between domains — the **initialization prompt**, the **evidence taxonomy**, the **rubric**,
and the **evaluator addendum** — and nothing else. The loop, the hooks, the memory system,
and the scoreboard are identical in all three; that is the claim this page exists to test.

Read one that's close to your problem, then write yours. The single question that decides
whether a domain works here:

> **What artifact on disk would convince a skeptical reader who wasn't there?**

If you can answer it concretely, the harness runs. If you can't, [it refuses to
start](./INIT.md#a-domain-with-no-evidence-taxonomy-does-not-start), which is the correct
outcome — not an obstacle to route around.

A fourth, fully executed example — technical research, with real artifacts, real verdicts,
and a real `NEEDS_WORK` rework — is in [`demo/`](./demo/).

---

## 1. Medical literature research

*A clinician wants the current evidence on a treatment question, and "the model said so" is
not an acceptable basis for anything.*

### Initialization prompt

> **Task:** Produce a structured evidence review of GLP-1 receptor agonists for weight
> management in adults **without** type 2 diabetes, covering efficacy, adverse events, and
> discontinuation/weight-regain. Deliverable is `REVIEW.md` with a PRISMA-style flow
> summary, an evidence table, and a plain-language summary for a non-specialist.
>
> **Domain:** clinical literature review. Sources are peer-reviewed publications and
> regulatory documents only. No patient data, no clinical recommendations, no dosing advice
> — this is a summary of published evidence, and it must say so.
>
> **Constraints:** every quantitative claim traces to a named study with PMID/DOI, sample
> size, study design, and follow-up duration. Preprints allowed but labelled. Trials with
> undisclosed funding flagged. Where studies disagree, both results appear — no averaging
> away a conflict. Nothing published anywhere; no money spent.
>
> **Budget:** at most 5 sub-levels; at most 10 builder sessions.

### Evidence taxonomy (`EVIDENCE.md`)

| Kind | Location | Valid when | Not evidence |
|---|---|---|---|
| Source record | `sources/<pmid>.md` | PMID/DOI, title, journal, year, design, n, follow-up, funding, access date | a citation with no record file |
| Extracted quote | `quotes/<pmid>-<topic>.md` | verbatim passage in quotes, with section/page, supporting exactly one claim | a paraphrase, or a quote with no locator |
| Evidence table | `tables/efficacy.md` | one row per study, columns matching the source records | a table whose rows have no source record |
| Screening log | `screening/log.md` | every candidate with include/exclude and a stated reason | a count with no per-item reasons |
| Claim map | `evidence/level-N/CLAIM.md` | every claim in the draft → the quote file backing it | "well sourced throughout" |

```
# .claude/evidence-patterns.txt
sources/*.md
quotes/*.md
tables/*.md
screening/*.md
evidence/level-*/*.md
```

### Rubric excerpt (`RUBRIC.md`)

> **Traceability** — can a reader get from any number in the review to the passage it came
> from, without trusting the author?
> **5** Every quantitative claim carries a PMID and a quote file with a verbatim passage and
> locator; spot-checking three at random, all three say what the review says.
> **3** Claims are cited, but some cite a whole paper rather than a passage; a reader must
> re-read the study to check.
> **1** Claims are cited in aggregate ("studies show"), or a cited source does not contain
> the claim.
>
> **Disagreement handling** — does the review preserve conflict?
> **5** Every conflict between studies is stated, with both results and a stated reason for
> the difference (population, dose, duration) where one is identifiable.
> **3** Conflicts noted but not explained.
> **1** A single number is presented where the literature disagrees.
>
> **Mandatory:** Traceability ≥ 4. A review that fails Traceability fails the level
> regardless of every other score — an unverifiable review is worse than none, because it
> reads as authoritative.

**What the rubric reviewer will attack:** a criterion like "comprehensive coverage" is
satisfied by a source list nobody read. That is why the criteria above score the *link*
between claim and passage — cheap for the evaluator to spot-check, expensive to fake, and
uncorrelated with volume.

### Evaluator addendum (`.claude/agents/evaluator.addendum.md`)

> Pick three quantitative claims from `REVIEW.md` at random and trace each one all the way
> to its quote file and source record. If any of the three does not survive, the level is
> `NEEDS_WORK` — do not check the rest, report the broken chain.
>
> Check the screening log accounts for every source in `sources/`, and that excluded studies
> have stated reasons rather than counts.
>
> Reject any sentence that reads as clinical advice to an individual. The deliverable
> summarizes published evidence; "patients should" is out of scope even when the underlying
> study says it.
>
> Study design and follow-up must appear next to every efficacy number. A 68-week result and
> a 12-week result presented in the same sentence without their durations is `NEEDS_WORK`.

**Tools to add:** `WebFetch` on the evaluator, so it can re-fetch a DOI and confirm a source
record isn't invented. Add it to `tools:` in `evaluator.md` at approval time.

**Safety gate:** nothing here spends money or posts, so the gate should stay quiet. If
`PAUSED_ACTIONS.md` grows a row, something has gone wrong with the plan, not with the gate.

---

## 2. Growing a furniture business

*The domain the harness is least obviously suited to, which is why it's here. The work is
real-world and mostly irreversible, so most of the agent's output is a decision packet for a
human rather than an action.*

### Initialization prompt

> **Task:** Build a plan to grow monthly revenue of a two-person custom furniture workshop
> from £8k to £20k over two quarters. Deliverables: `MARKET.md` (where the demand is),
> `PRICING.md` (a costed price list with margins), `CHANNELS.md` (ranked acquisition
> channels with cost per enquiry), and `PLAN.md` (a sequenced quarter-by-quarter plan with
> a cash projection).
>
> **Domain:** small-business strategy. Inputs are our own exported books, our own website
> analytics, and public market data. All figures in GBP.
>
> **Constraints:** every number in `PLAN.md` traces to either an export from our books
> (`books/`) or a cited public source. No listings created, no ads bought, no emails or
> messages sent, no supplier contacted, no prices changed anywhere real — every outward
> action is written up as a proposal for me to execute. Assume 2 makers, 60 build-hours a
> week, no new hires.
>
> **Budget:** at most 5 sub-levels; at most 10 builder sessions.

### Evidence taxonomy (`EVIDENCE.md`)

The hard part of a business domain is that most claims are about the future. So the taxonomy
draws the line at **inputs**: assumptions may be assumptions, but they must be *labelled*
ones with a stated basis, and every derived number must be reproducible from a file.

| Kind | Location | Valid when | Not evidence |
|---|---|---|---|
| Books export | `books/<period>-<report>.csv` | exported from the accounting system, period and export date in a header row | a number typed from memory |
| Analytics export | `analytics/<period>-<metric>.csv` | date range + metric definition stated | a screenshot of a dashboard with no range |
| Market source | `market/<slug>.md` | URL, publisher, publication date, and the extracted figure quoted verbatim | a market size with no source |
| Assumption record | `assumptions/<slug>.md` | the assumption, its basis, its sensitivity (what changes if it's wrong by 50%) | an unlabelled number in a spreadsheet |
| Calculation | `calc/<slug>.md` | the arithmetic written out, inputs referencing the files above | a total with no derivation |
| Proposal | `proposals/<slug>.md` | the outward action, the exact text/price/spend, the expected effect, and how to reverse it | "we should advertise more" |

```
# .claude/evidence-patterns.txt
books/*.csv
analytics/*.csv
market/*.md
assumptions/*.md
calc/*.md
proposals/*.md
evidence/level-*/*.md
```

### Rubric excerpt (`RUBRIC.md`)

> **Reproducibility** — can I rebuild any number in `PLAN.md` from the files?
> **5** Every figure traces through a `calc/` file to a books export, an analytics export, a
> cited market source, or a labelled assumption. Recomputing three at random, all three tie.
> **3** Headline figures trace; intermediate ones appear without derivation.
> **1** Figures appear with no derivation, or a derivation that doesn't reproduce.
>
> **Assumption honesty** — is guessing labelled as guessing?
> **5** Every assumption has its own record with a stated basis and sensitivity; the plan
> states which two assumptions it is most exposed to.
> **3** Assumptions listed but without sensitivity.
> **1** Assumptions presented as findings.
>
> **Actionability** — could the owner execute Monday morning?
> **5** Every proposal names the exact action, the money at risk, who does it, and how to
> undo it.
> **1** Recommendations are strategic postures ("build brand awareness").
>
> **Mandatory:** Reproducibility ≥ 4 and Assumption honesty ≥ 4. A confident plan built on
> unlabelled guesses is the specific failure this rubric exists to prevent.

### Evaluator addendum

> Recompute three figures from `PLAN.md` yourself, from the files in `calc/`, `books/` and
> `assumptions/`. A figure that doesn't reproduce is `NEEDS_WORK` even if it is plausible.
>
> Every growth number must be reachable within the stated capacity — 2 makers, 60
> build-hours a week, no new hires. A revenue plan that implicitly needs a third maker is
> `NEEDS_WORK`; check the hours before the money.
>
> Check `proposals/` against `PAUSED_ACTIONS.md`. Anything outward should be a written
> proposal, not an attempt. If the gate had to stop the builder from sending or buying
> something, note it — the plan should not have led there.
>
> Be suspicious of round numbers. £5,000/month of new revenue with no derivation is a wish.

**Safety gate:** this is the domain where it earns its keep. Ad spend, supplier emails,
marketplace listings, and price changes are all one tool call away and all irreversible in
the real world. Expect `PAUSED_ACTIONS.md` to have rows, treat it as the run's outbox, and
review it before you execute anything in it. Consider adding domain-specific denylist rows
before the run:

```
# .claude/hooks/danger-patterns.txt
MONEY	\b(etsy|shopify|ebay)\b.*\b(list|publish|create)	creates a live listing
PUBLISH	\b(mailchimp|sendgrid|klaviyo)\b	sends to a customer list
```

---

## 3. Building a website

*The domain the original repo was built for, restated in AI-CEO's terms — and the one where
the evaluator should stop trusting the builder's screenshots and take its own.*

### Initialization prompt

> **Task:** Build a marketing site for the workshop above: home, gallery, about, and an
> enquiry form that posts to a local stub endpoint. Astro + Tailwind, static output, no CMS.
> Deliverable is a site that builds clean and works on mobile.
>
> **Domain:** frontend web development. `npm run build` and `npm run preview` are available;
> Playwright is installed for screenshots.
>
> **Constraints:** works at 375px and 1440px; Lighthouse accessibility ≥ 95 on every page;
> no layout shift on image load; no external fonts or trackers; the enquiry form posts to
> `http://localhost:4321/api/stub` and nothing leaves the machine. Nothing deployed
> anywhere.
>
> **Budget:** at most 6 sub-levels; at most 12 builder sessions.

### Evidence taxonomy (`EVIDENCE.md`)

| Kind | Location | Valid when | Not evidence |
|---|---|---|---|
| Screenshot | `screenshots/<page>-<width>.png` | taken from the running preview server, full page, viewport in the filename | a screenshot of a dev-server error page |
| Console log | `screenshots/<page>-console.txt` | captured during the same page load, empty or explained | a log from a different run |
| Build output | `evidence/level-N/build.txt` | full `npm run build` output including exit status | "the build passed" |
| Lighthouse report | `evidence/level-N/lighthouse-<page>.json` | run against the preview server, scores present | a claimed score |
| Interaction trace | `evidence/level-N/<flow>.md` | the steps performed and the screenshot after each | "the form works" |

```
# .claude/evidence-patterns.txt
screenshots/*.png
screenshots/*-console.txt
evidence/level-*/*.txt
evidence/level-*/*.json
evidence/level-*/*.md
```

### Rubric excerpt (`RUBRIC.md`)

Subjective quality is why the rubric exists; this is the domain the [harness-design
article](https://www.anthropic.com/engineering/harness-design-long-running-apps) works
through in depth.

> **Visual craft** — does it look considered rather than assembled?
> **5** Consistent spacing scale, deliberate type hierarchy, images cropped to a common
> ratio, hover/focus states on every interactive element, nothing touching a viewport edge.
> **3** Consistent but generic — default Tailwind spacing, one type size for everything,
> no focus states.
> **1** Visible defects: overlapping text, unstyled form controls, images at native size.
>
> **Responsive integrity**
> **5** At 375px and 1440px, no horizontal scroll, no clipped text, tap targets ≥ 44px,
> images reflow rather than squash. Screenshots at both widths for every page.
> **1** Desktop layout scaled down, or a mobile screenshot that doesn't exist.
>
> **Evidence discipline**
> **5** Every acceptance criterion has a screenshot of the *running* page, and the console
> log for that load is clean or the noise is explained.
> **1** Claims backed by code diffs rather than by the page.
>
> **Mandatory:** Responsive integrity ≥ 4 and a clean build. "It builds" is table stakes,
> not a score.

### Evaluator addendum

> **Do not trust the builder's screenshots. Take your own.** Start the preview server, open
> each page at 375px and 1440px, and compare what you see against the claim. If your
> screenshot and the builder's disagree, yours wins and the level is `NEEDS_WORK`.
>
> Load every page and read the console yourself. A React key warning is not a failure; an
> uncaught exception is.
>
> Walk the enquiry form: submit empty, submit invalid, submit valid. Check the error states
> render visibly, not just in the DOM.
>
> Check the build output for warnings the builder summarized away.

**Tools to add** — this is the change that matters most in this domain:

```yaml
tools: Read, Glob, Grep, Bash, mcp__playwright__browser_navigate, mcp__playwright__browser_take_screenshot, mcp__playwright__browser_console_messages, mcp__playwright__browser_resize
```

An evaluator that opens the app itself closes the [forged-evidence
gap](./SECURITY.md#2-forged-evidence) for this domain almost completely: the builder can
fabricate a screenshot, but it cannot fabricate the page the evaluator loads.

**Safety gate:** watch for deploys. `vercel deploy`, `netlify deploy`, and `wrangler deploy`
are on the denylist; add whatever your stack uses before the run. The constraint "nothing
deployed anywhere" belongs in `danger-patterns.txt`, not only in the prompt — a constraint
that lives only in prose is a suggestion.

---

## Writing your own

1. **Answer the evidence question first.** Everything else follows from it. If the honest
   answer is "nothing on disk would convince me", stop — that domain needs a different tool.
2. **Prefer evidence the builder cannot author alone.** An export with a server timestamp, a
   page the evaluator loads itself, a source it can re-fetch. See [SECURITY.md
   §2](./SECURITY.md#2-forged-evidence).
3. **Write rubric criteria that are cheap to check and expensive to fake.** "Every claim
   traces to a quoted passage" beats "thorough research" — the first is spot-checkable in
   two minutes, the second is satisfied by a long bibliography nobody opened.
4. **Make the mandatory criterion the one that matters.** One criterion that fails the level
   on its own, chosen because that failure would make the deliverable worthless.
5. **Put real-world constraints in `danger-patterns.txt`, not just the prompt.** "Don't
   deploy" and "don't email customers" are hooks, or they are wishes.
6. **Let the rubric reviewer do its job.** If it says `REVISE`, it has usually found the
   criterion you wrote to be passable rather than true.
