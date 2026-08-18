# The frozen guard blocks Bash *reads* that look like writes

Learned 2026-08-18, second pass at level 2.

`.claude/hooks/frozen-guard.sh` protects the frozen core and, once the operator runs
`harness/planlock.sh`, the plan files too (`LEVELS.md`, `RUBRIC.md`, the evidence taxonomy,
`evidence-patterns.txt`). For a Bash call it does not parse the command: it checks whether the
command contains **any write-ish token** — `>` `>>` `tee` `sed -i` `cp` `mv` `rm` `chmod` `ln`
`truncate` `dd` `patch` `python3` `perl` `awk` — and, if so, blocks the whole command when any
token in it resolves to a protected path.

So these are denied even though they only read:

    awk '/^## Level 2/{f=1} f' LEVELS.md          # awk is on the list
    python3 - <<'EOF' ... open("RUBRIC.md") ...   # python3 is on the list

and this is denied because of a *mention* inside an unrelated heredoc:

    cat > evidence/level-2/make-map-check.sh <<'EOF'
    ... "the canonical check from EVIDENCE.md §1.4" ...
    EOF

What works:

- Read protected files with `sed -n '94,140p' FILE`, `grep -n`, `head`, or the Read tool.
  `grep -n '^#' FILE` first to find the line range of the level or criterion you want.
- Create scripts and documents with the **Write tool**, not a `cat > … <<EOF` heredoc. The
  hook checks the Write target path only, so file *content* may name the plan files freely.
- If a heredoc is unavoidable, refer to the plan file obliquely ("the evidence taxonomy's
  §1.4") — but prefer Write; obliqueness costs the reader.

The block is not a bug and not something to route around: the message tells you to state the
disagreement in `PROGRESS.md` and the level's `CLAIM.md` and carry on with the level as
written. The operator relocks with `harness/planlock.sh relock`.

Related: [[machine-checked-claim-maps]].
