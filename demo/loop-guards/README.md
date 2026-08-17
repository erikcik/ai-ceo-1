# Loop guard demonstrations

Captured 2026-08-18T01:11:41 by running harness/loop.sh in a scratch workspace.
No model sessions involved -- these are the wrapper's own refusals and exits.

## 1. A domain with no evidence taxonomy does not start

Workspace has nothing yet:
```
$ harness/loop.sh
loop: refusing to start. Missing:
  - LEVELS.md (the ordered plan -- run harness/plan.sh)
  - SCOREBOARD.json (the default-FAIL contract)
  - EVIDENCE.md (the evidence taxonomy for this domain)
  - .claude/evidence-patterns.txt (machine-readable evidence patterns)
  - RUBRIC.md (how quality is scored)

This harness does not run a domain whose evidence taxonomy is undefined:
without one there is no way to tell finished work from claimed work, and
every verdict downstream is a guess. Run harness/plan.sh with your
initialization prompt, review what it produces, then start the loop.
(exit code: 2)
```

Now with the plan and rubric present, but the evidence taxonomy still missing --
this is the case the harness exists to refuse:
```
$ harness/loop.sh
loop: refusing to start. Missing:
  - EVIDENCE.md (the evidence taxonomy for this domain)
  - .claude/evidence-patterns.txt (machine-readable evidence patterns)

This harness does not run a domain whose evidence taxonomy is undefined:
without one there is no way to tell finished work from claimed work, and
every verdict downstream is a guess. Run harness/plan.sh with your
initialization prompt, review what it produces, then start the loop.
(exit code: 2)
```

## 2. The kill switch stops the loop between steps

With the taxonomy in place the preflight passes, so `AGENT_STOP` is what stops it.
No builder session is ever launched:
```
$ touch AGENT_STOP
$ harness/loop.sh
[2026-08-18 01:11:41] loop start | builder=sonnet evaluator=opus max_cycles=12
[2026-08-18 01:11:41] preflight ok | 1 level(s) still failing
[2026-08-18 01:11:41] exit: AGENT_STOP present
(exit code: 0)
```

## 3. A completed plan exits cleanly

With every scoreboard row passing, there is nothing left to build:
```
$ harness/loop.sh
[2026-08-18 01:11:41] loop start | builder=sonnet evaluator=opus max_cycles=12
[2026-08-18 01:11:41] preflight ok | 0 level(s) still failing
[2026-08-18 01:11:41] exit: every level in SCOREBOARD.json passes
(exit code: 0)
```

## 4. The scoreboard cannot be flipped without a PASS verdict

Even from a shell, `scoreboard.sh pass` requires an evaluator verdict file whose
first line is PASS:
```
$ harness/scoreboard.sh pass level-1 "trust me"
scoreboard: refusing to pass 'level-1' -- PASS_VERDICT_FILE must name an evaluator verdict whose first line is PASS
(exit code: 3)

$ echo NEEDS_WORK > v.md; PASS_VERDICT_FILE=v.md harness/scoreboard.sh pass level-1 "..."
scoreboard: refusing to pass 'level-1' -- PASS_VERDICT_FILE must name an evaluator verdict whose first line is PASS
(exit code: 3)

$ echo PASS > v.md; PASS_VERDICT_FILE=v.md harness/scoreboard.sh pass level-1 "evidence/level-1/"
scoreboard: level-1 -> passes: true (evaluator PASS)
(exit code: 0)
```
