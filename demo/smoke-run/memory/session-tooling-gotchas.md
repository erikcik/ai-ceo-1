# Three things that waste a session if you learn them the hard way

Learned 2026-08-18, levels 2 and 3.

**`verify-gate.sh` re-arms after every write to `CLAIM.md`, not once per session.** The rule is
"open an evidence file with the Read tool, then write the claim" — and it applies to *each*
write. A run of three consecutive `Edit`s on `evidence/level-<N>/CLAIM.md` gets the first one
through and blocks the second with "you have not opened any evidence file this session".
Reading `CLAIM.md` itself does not re-arm it; read the artifact the edit is about
(`map-check.txt`, `claims/claim-map.md`, the source entry). This is not an obstacle — it is the
gate doing its job, since each claim sentence should be checked against the artifact right
before it is written. Plan for it: Read the exact lines you are about to cite, then edit, then
Read again for the next edit.

**The Bash tool's shell is zsh; scripts you write run under bash. `BASH_REMATCH` is indexed
differently in the two.** In bash `${BASH_REMATCH[0]}` is the whole match; in zsh arrays are
1-based, so `[0]` is empty and this spins forever:

    while [[ $n =~ [0-9]+ ]]; do ...; n=${n#*"${BASH_REMATCH[0]}"}; done

A one-liner tested interactively and then pasted into a `#!/usr/bin/env bash` script (or the
reverse) can behave differently for this reason. For anything that tokenizes a string, use
`awk` with `match()`/`RSTART`/`RLENGTH` instead of shell regex — it is identical in both
shells and it is what the transcript should show anyway. If a Bash call has to be killed on
timeout, suspect this class of bug before suspecting the data.

**`awk -v` cannot carry a multi-line string.** Passing a shell variable holding several lines
into awk with `-v spec="$SPEC"` dies with `awk: newline in string` — and the failure is quiet if
the awk is inside a function whose caller does not check: downstream `[: : integer expression
expected` from the empty result is the symptom you actually see. Write the multi-line spec to a
file and read it in `BEGIN { while ((getline line < specfile) > 0) ... }`. Same for anything you
were tempted to pass as a here-string.

**A generator script that emits Markdown will bite you on the backtick.** An unescaped backtick
inside a double-quoted `echo` opens command substitution, and the script then dies with a
syntax error at a *later* line — the reported line number points nowhere near the real one:

    echo "\$ grep -c '^- \*\*`' REPORT.md"     # opens `...`, breaks 100 lines down

Escape it (`` \` ``) or put the string in single quotes. Same class: `$(...)`, `$0`, `!`. When
a generator dies at a line that looks innocent, `grep -n '`' script.sh` and check quoting
before reading the logic.

Related: [[machine-checked-claim-maps]], [[frozen-guard-blocks-bash-not-just-writes]],
[[writing-a-word-banded-cited-report]].
