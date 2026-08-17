<!-- Copyright 2026 Anthropic PBC -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security and enforcement hygiene

This harness has an enforcement layer — hooks that deny writes to the scoreboard, block
money and posting and irreversible actions, and protect the frozen core. That layer is
worth having. It is also, as shipped, **defeatable by the agent it constrains**, and
pretending otherwise is worse than having no gate at all: a gate you trust more than it
deserves is how unreviewed work reaches production.

Read this before running anything unattended that touches something you care about.

## The requirement: make `.claude/` and `harness/` read-only to the agent

Every hook here is a file in the same working tree the agent has write access to. `frozen-guard.sh`
denies the obvious routes, but it is a regex over tool inputs — it is a speed bump, and the
real boundary is the operating system.

In a real deployment, the agent process must not be able to write:

```
.claude/                 hooks, settings, agent definitions
harness/                 the wrapper that writes the scoreboard
SCOREBOARD.json          the record of what was independently confirmed
```

Concretely, pick whichever your setup supports:

```bash
# Separate user, agent has no write bit on the enforcement layer
sudo chown -R harness-owner:harness .claude harness SCOREBOARD.json
sudo chmod -R a-w .claude harness SCOREBOARD.json

# macOS/Linux immutable flag
sudo chflags uchg .claude/hooks/*.sh          # macOS
sudo chattr +i .claude/hooks/*.sh             # Linux
```

Better still: run the agent in a container whose mount of `.claude/` and `harness/` is
read-only, with the wrapper on the host. The wrapper needs write access to
`SCOREBOARD.json`; the agent never does.

If you cannot do this, you are running a harness that reminds a cooperative agent of the
rules. That is genuinely useful — most drift is not adversarial — but do not call it
enforcement, and do not leave it unattended against anything irreversible.

## Known gaps in the shipped hooks

These are real and reachable today. They are listed because a documented gap can be
mitigated and an undocumented one gets trusted.

### 1. Stale evidence

`track-read.sh` records *that* an evidence file was opened; `verify-gate.sh` checks only that
the log is non-empty before allowing a `CLAIM.md` write. Any evidence read unlocks any claim.
A session can open a source file at minute two and write an unrelated claim at minute forty,
with the gate satisfied.

*Mitigation:* the gate consumes the log on each pass, so one read unlocks exactly one claim.
To close it properly, have `track-read.sh` record which level each artifact belongs to and
have `verify-gate.sh` match the claim's level against it.

### 2. Forged evidence

The agent can write a file that matches `.claude/evidence-patterns.txt`, read its own
forgery, and satisfy the gate. Nothing in the hook layer distinguishes an artifact produced
by doing the work from one produced by describing it.

*Mitigation:* this is the gap the **evaluator** exists to cover — it opens the artifact and
checks it against the claim, and a fabricated source that doesn't say what the claim says is
exactly what it is looking for. The hook enforces the *ritual*; the fresh-context evaluator
is what makes the ritual mean something. Prefer evidence kinds the agent cannot author
alone: a screenshot the evaluator takes itself via a browser MCP, a metrics export with a
server-side timestamp, a source file whose URL the evaluator re-fetches.

### 3. Bash side-door writes

`verify-gate.sh` and `frozen-guard.sh` hook `Write`/`Edit`. Bash reaches the same files by
other means. `frozen-guard.sh` also inspects `Bash` commands for redirects, `sed -i`, `cp`,
`mv`, `rm` and interpreter invocations naming a protected path — which catches the direct
attempts and not much else. `echo x | python3` with the path assembled at runtime, a
here-doc inside a script it wrote, `find -exec`, a symlink: none are caught.

*Mitigation:* filesystem permissions (above). Regexes over shell commands cannot be made
complete, and a version that tried would break ordinary work with false positives.

### 4. Ledger tampering

`PAUSED_ACTIONS.md`, `PROGRESS.md`, `NEXT_FINDINGS.md`, `memory/` and the `logs/` directory
are all agent-writable, because the agent has to maintain most of them. An agent can delete
a paused-action row, rewrite a `NEEDS_WORK` finding it doesn't like, or edit a log.

*Mitigation:* `git log` is the second record and the wrapper commits every cycle, so
tampering is visible in the diff. Evaluator verdicts are written by the wrapper to
`logs/cycle-N-*-verdict.md` from the evaluator's stdout, so a builder session rewriting one
after the fact shows up as a commit that edits a file no builder should touch. For anything
serious, ship the logs off-box as they are produced.

### 5. Settings edits

An agent that can write `.claude/settings.json` can unhook every gate in this document, and
one that can write `.claude/hooks/*.sh` can neuter them while leaving the wiring intact.
`frozen-guard.sh` denies both — but `frozen-guard.sh` is itself a file in `.claude/hooks/`,
protected by the same regex it implements, and reachable through gap #3.

*Mitigation:* filesystem permissions, again. This is the gap that makes the read-only
requirement non-negotiable rather than a nice-to-have. Note also that a hook edit does not
affect the running session — config is snapshotted at session start — so an edit here shows
up as *the next* session being ungoverned. Check `git status` on `.claude/` between cycles;
a wrapper that runs `git diff --quiet HEAD -- .claude harness || exit` before each cycle
turns tampering into a halt.

### 6. Also worth knowing

- **`STEER.md` is not a trust boundary.** The agent can write it and steer itself. It is a
  convenience channel for an operator, nothing more.
- **The safety gate matches patterns, not intent.** `.claude/hooks/danger-patterns.txt` is a
  denylist; anything not on it is allowed. An unfamiliar CLI that spends money, a new MCP
  tool that posts, a script whose name reveals nothing — all pass. Review the list against
  the tools each task actually has, and add to it before the run rather than after.
- **It fails closed on a malformed rule**, on purpose: an unparseable line in
  `danger-patterns.txt` blocks every tool call until a human fixes it. The alternative — the
  original behaviour — was silently skipping rules it couldn't parse, which made `git push`
  sail through a gate that reported clean. Run `harness/selftest.sh` after editing the list.
- **`--permission-mode bypassPermissions`**, which the wrapper uses so an unattended loop
  isn't stuck at a prompt, removes the interactive permission layer. Hooks still fire — that
  is verified in [`demo/safety-probe/`](./demo/safety-probe/) — but they become the *only*
  thing between the agent and the tool. Do not run the loop in bypass mode with credentials
  in the environment that you would not hand it deliberately.
- **The evaluator has `Bash`.** It has no `Write`/`Edit`, but Bash is not a read-only
  boundary; the instruction to use it only for inspection is a prompt, not a gate. Drop
  `Bash` from its `tools:` line if you need a hard boundary — you lose `git diff`.

## Threat model, honestly stated

This harness is built for a **capable, cooperative agent under long-horizon drift** — one
that will cut corners, mark things done that aren't, and lose the thread over ten sessions,
but is not trying to defeat you. Against that, the hooks work: they make the shortcut harder
than the honest path, which is usually enough.

It is **not** built for an adversarial agent, and no arrangement of in-tree shell scripts
would be. Against that threat, the boundary is the OS and the sandbox, and this document's
first section is the whole of the defence.
