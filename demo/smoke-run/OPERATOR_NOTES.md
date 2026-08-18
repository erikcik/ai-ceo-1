# Operator notes — smoke run

Decisions I made at the approval gate, recorded so they are not mistaken for the
harness's own behaviour.

1. **Granted the evaluator `WebFetch`.** `.claude/agents/evaluator.addendum.md` asked for it
   (the planner correctly refused to grant itself tools) so the evaluator can spot-check a
   cited URL against the stored capture. Applied by hand to the `tools:` line in
   `.claude/agents/evaluator.md` in this workspace only.

2. **Applied all 13 findings from `RUBRIC_REVIEW.md`.** The verdict was `REVISE`, so per
   INIT.md the rubric was fixed before the loop ran. See `## Revision history` at the end of
   `RUBRIC.md`; `LEVELS.md` and `EVIDENCE.md` were edited to match.

3. **Applied `SCOREBOARD_CHECK_PATCH.md`** to `SCOREBOARD.json`'s level-1 `check` by hand,
   because no session can write that file. `"passes"` stayed `false`.

4. **Scoped level 1 down for a throwaway run:** 5-8 source entries instead of 8-12, and
   >=2 per system instead of >=3. This is a demo of the loop, not an attempt to produce a
   publishable review, and the budget is 8 builder sessions.

   This lowers *volume*, not verification: every entry still needs `.src` + `.txt` +
   `.headers.txt`, matching sha256s, a logged extraction command that reproduces the text,
   a greppable quote of >=12 words, and a locatable `dated` value. It is also the direction
   the rubric review itself pointed in -- finding 13 called ">=8 source entries" the one
   surviving volume proxy and asked for it to be tied to coverage instead.

5. **Models:** `BUILDER_MODEL=opus`, `EVALUATOR_MODEL=opus`. Judging is where capability pays
   and this level's criteria are unusually mechanical, so a weaker builder would have
   produced rework findings about format rather than about substance.
