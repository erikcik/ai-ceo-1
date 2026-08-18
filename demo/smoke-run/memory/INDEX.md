# memory/INDEX.md

Durable lessons. One line per file — FETCH the 2–5 that match the level you are on, never the
whole directory. Task state lives in the repo-root progress note, not here.

- `web-capture-recipe.md` — `curl -D` + `pandoc -t plain` / `pdftotext` as a reproducible
  capture pipeline; verify determinism by re-extracting and comparing sha256 (all 8 re-derived
  byte for byte at level 4, silently, under the network block); how to find a quote's PDF page.
- `quote-verbatim-from-extracted-text.md` — copy quotes out of the extracted `.txt`, never
  from memory; curly punctuation, PDF de-hyphenation and embedded `"` are what break a
  `grep -F` check; re-verify the quotes as written in the entry files.
- `machine-checked-claim-maps.md` — generate the verification transcript with a script that
  runs the commands and keep that script on disk; grep the full quote, and check each fragment
  against the quote it cites, not the document; prove row/coverage arithmetic with
  `awk -F'|'`; re-read each quote against its claim sentence; keep dropped claims; a derived
  number is an unsourced number, so enumerate-and-classify every one instead of grepping for a
  pattern, and match short numbers on boundaries.
- `auditing-a-finished-cited-report.md` — the final-pass method: enumerate every sentence and
  classify it by kind rather than auditing the cited ones, prove the table complete with a
  two-way set difference, compute the verdict column; and treat "no source says X" as a claim —
  enumerate-and-classify over the captures, watch the scope word (captures are dirtier than
  quotes), and grep the deliverable against itself for absence claims its own earlier lines
  contradict; weaken rather than delete, and re-derive every extraction, not the one required.
- `writing-a-word-banded-cited-report.md` — one sentence per line so coverage tables can carry
  exact line numbers and a script can extract the sentence text; budget ~45 words per claim row
  before choosing rows; a version number no quote names is an unsourced fact; print the command
  you actually ran; classify citation-key digits and list markers in a number audit; anchor
  short unit alternatives in negative greps so "2019 sentence" is not read as "2019 s".
- `session-tooling-gotchas.md` — `verify-gate.sh` re-arms after *every* `CLAIM.md` write, so
  Read the artifact again before each edit; the Bash tool runs zsh while scripts run bash, and
  `BASH_REMATCH[0]` differs between them — tokenize with `awk match()`, not shell regex;
  `awk -v` cannot carry a multi-line string (read it from a file in `BEGIN`); an unescaped
  backtick in a double-quoted `echo` breaks a generator script far from the real line.
- `frozen-guard-blocks-bash-not-just-writes.md` — the hook blocks any Bash command that names
  a frozen or plan-locked file *and* contains a write-ish token (`awk`, `python3`, `>`,
  `sed -i`, …), including reads and heredoc mentions; use `sed -n`/`grep`/Read, and the Write
  tool for new scripts.
- `sqlite-org-pages-are-ideal-primary-sources.md` — every sqlite.org page prints a per-page
  "last updated" ISO date and returns full HTTP headers; which pages cover which axis.
- `duckdb-org-capture-gotchas.md` — `/docs/stable/` URLs are 569-byte JS redirect stubs;
  duckdb.org HTML returns no `Content-Length`/`ETag`/`Last-Modified` and no in-body date;
  `duckdb.org/pdf/*.pdf` works, and the GitHub releases API has perfect headers but only two
  sentences of prose per release.
- `papers-must-print-their-own-date.md` — pick the copy of a paper that prints its publication
  date; what SIGMOD, CIDR, PVLDB and IEEE camera-ready copies do and don't print.
- `machine-network-blocks-observed.md` — hosts that refuse connections on this machine
  (cidrdb.org, github.io, motherduck.com, youtube.com) versus those that work; do not work
  around the block.
