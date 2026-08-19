<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Memory

Two kinds of memory, kept strictly separate because they have different lifetimes and get
useless when mixed. The usual failure is one growing file that is part status report, part
notebook, part diary — too stale to trust as state and too task-specific to reuse.

| | STATE | LESSON |
|---|---|---|
| **File** | `PROGRESS.md` | `memory/*.md` + `memory/INDEX.md` |
| **Scope** | this task only | across every task on this machine |
| **Lifetime** | dies with the task | outlives it |
| **Written** | overwritten in place | appended to, then curated |
| **Answers** | "where are we?" | "what do we know?" |
| **Budget** | ~8k tokens, hard | ~2k tokens per file |

**The test:** would this sentence still be true and useful on a completely different task?
Yes → `memory/`. No → `PROGRESS.md`.

- `PROGRESS.md`: level 3 is half done, the source list needs two more entries, the evaluator
  rejected the draft for uncited claims in §2.
- `memory/`: DuckDB's docs version-pin their URLs, so a bare `duckdb.org/docs/x` link may
  resolve to a different page next month — always record the versioned URL.

## STATE — `PROGRESS.md`

One file. **Edited in place, never appended.** It holds current state and what the next
session must know, not a history of how you got here — `git log` is the history, and it is
better at it.

Hard budget ~8k tokens. When a session starts over budget, the loop's progress-budget check injects the
instruction to condense before doing anything else. Condensing means deleting narration of
completed, committed work — not summarizing it. If something is worth keeping past this
task, it was never STATE; move it to `memory/`.

`PROGRESS.md` is deleted when the task ends. Nothing durable should live only there.

## LESSON — `memory/`

A karpathy-style wiki: one topic per file, a flat directory, plus an index. `INDEX.md` is
the only file anyone reads in full.

```
memory/
  INDEX.md                  one line per file: filename — what it covers
  duckdb-docs-gotchas.md
  citation-verification.md
  evaluator-expectations.md
```

Each file: a title, then short factual entries. Facts learned, mistakes worth not repeating,
tool and domain gotchas, things that turned out to be false. Write for a stranger — you will
be one next time.

Three operations, run at fixed points so they don't get skipped.

### GROW — at the end of every sub-level

The builder writes what this level taught: facts that will still be true next time, mistakes
that cost time, gotchas in the tools or the domain. Then updates `INDEX.md` with a one-line
summary for anything new.

Write the lesson, not the event. "Spent an hour on X" is a diary entry; "X fails silently
when Y, check Z first" is a lesson. If a level taught nothing durable, write nothing — an
honestly empty GROW beats padding the wiki with restated task status.

### MAINTAIN — before writing, every time

Curation over accumulation. A wiki that only grows becomes a wiki nobody reads, and an
unread memory is the same as no memory at a fraction of the context budget.

Before adding anything:

1. **Merge duplicates.** Two files circling one topic become one file.
2. **Delete what is now wrong.** A superseded fact is worse than a missing one, because it
   will be trusted. Delete it; don't annotate it.
3. **Keep each file under ~2k tokens.** Over budget, either condense or split into two
   topics and index both.
4. **Keep `INDEX.md` exact.** One line per file, no orphans, no unindexed files.

the loop's memcheck report reports over-budget files, unindexed files, and index lines pointing at
files that no longer exist. The wrapper pastes its output into the builder's prompt, so
MAINTAIN starts from a concrete worklist rather than good intentions.

### FETCH — at the start of every sub-level

Read `INDEX.md`. **Only** `INDEX.md`. Then open the **2–5** files whose summaries look
relevant to this level.

This is retrieval, not loading. Reading all of `memory/` defeats the point: the wiki exists
so a session can afford to have memory at all, and a session that reads everything has spent
its context before starting. If nothing in the index looks relevant, read nothing — that is
a correct FETCH.

If the index is useless for deciding what to open, that is a MAINTAIN failure: the summaries
are too vague. Fix them at the end of the session.

## Where memory sits in the loop

```
session start ──► FETCH   (INDEX.md, then 2–5 files)
                  read PROGRESS.md, LEVELS.md, EVIDENCE.md, RUBRIC.md
                  ... do the level ...
session end   ──► MAINTAIN (merge, delete, condense, fix INDEX.md)
                  GROW     (write this level's lessons)
                  update PROGRESS.md in place, commit
```

The evaluator checks the result: a level that produced good work and left `INDEX.md`
inconsistent with `memory/` is `NEEDS_WORK`. The handoff is part of the deliverable, because
the next session has nothing else.
