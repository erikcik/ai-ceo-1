#!/usr/bin/env bash
# evidence/level-2/make-map-check.sh
#
# Regenerates evidence/level-2/map-check.txt by RUNNING every check and pasting its real
# output.  Run from the repository root:
#
#     bash evidence/level-2/make-map-check.sh > evidence/level-2/map-check.txt
#
# Nothing in the transcript is typed by hand: each quote string in a §1 command is read out
# of sources/<key>.md at generation time, so the transcript cannot disagree with the entry
# files or with the captures.  Re-running this script reproduces the transcript; only the
# generation-date line at the foot changes.
set -u
cd "$(dirname "$0")/../.." || exit 1

run() { printf '$ %s\n' "$1"; eval "$1" 2>&1; printf '\n'; }

# quote text of sources/<key>.md quote <Qn>, whitespace-collapsed onto one line
quote_text() {
  awk -v q="### $2 " '$0 ~ "^"q {getline; sub(/^> /,""); print; exit}' "sources/$1.md" \
    | tr -s '[:space:]' ' ' | sed 's/ *$//'
}
quote_locator() {
  awk -v q="### $2 " '$0 ~ "^"q {print; exit}' "sources/$1.md" | sed 's/^### //'
}
OK='grep -E "\| OK \|$" claims/claim-map.md'

cat <<'HDR'
# evidence/level-2/map-check.txt

Verification transcript for level 2, acceptance criteria 3, 4, 6 and 7.

Every block below is a copy-pasteable one-liner followed by its real output. The file is
produced by `evidence/level-2/make-map-check.sh`, which runs each command and pastes what it
printed; the quote strings in §1 are read out of the source entries at generation time, so
this transcript cannot drift from the entry files. Re-run the script from the repository
root and only the generation-date line at the foot should change.

What each section proves:
  §1  every distinct key#Qn in claims/claim-map.md resolves to a real quote in a real
      capture  ..................................................  criterion 4
  §2  the map arithmetic: row count, distinct key#Qn, distinct keys, rows-per-Qn cap,
      per-dimension and per-dimension-per-system coverage  .......  criterion 3
  §3  every sources/<key>.md entry is cited by at least one claim row  ..  criterion 7
  §4  no claim row cites a document from claims/excluded-sources.md  ...  criterion 6
  §5  the W1 Parquet negative check, and an exhaustive audit of every number in every
      OK claim sentence against the quote, locator and date behind it  ..  criterion 6
  §6  every row's verbatim fragment lies inside the quote that row cites  ..  criterion 2
  §7  the captures the quotes were checked against are the ones level 1 logged  (sha256)

The canonical quote check is the one the evidence taxonomy fixes in its §1.4:

    tr -s '[:space:]' ' ' < sources/raw/<key>.txt | grep -F -c "<quote on one line>"

It is run below with the FULL text of each quote, not a fragment, so a pass means the
entire quoted span is present in the capture verbatim after whitespace collapsing.

==============================================================================
## §1 - every distinct key#Qn resolves: entry -> quote -> capture
==============================================================================

Two commands per quote. The first shows the quote label exists in the source entry file
(criterion 4, "every Qn exists in that entry"); the second shows that quote's full text
exists in that entry's stored capture.
HDR

# the set of pairs the map cites, and the set of quotes the dossier holds
cited=$(eval "$OK" | grep -oE '`[a-z0-9-]+#Q[0-9]+`' | tr -d '`' | sort -u)
allq=$(for f in sources/*.md; do k=$(basename "$f" .md); [ "$k" = "CAPTURE_LOG" ] && continue
         grep -oE '^### Q[0-9]+ ' "$f" | awk -v k="$k" '{print k"#"$2}'; done | sort -u)
printf 'Distinct key#Qn cited by OK claim rows: %s. Quotes present in the dossier: %s.\n' \
  "$(printf '%s\n' "$cited" | wc -l | tr -d ' ')" "$(printf '%s\n' "$allq" | wc -l | tr -d ' ')"
printf 'Pairs cited but absent from the dossier (must be empty):\n'
comm -23 <(printf '%s\n' "$cited") <(printf '%s\n' "$allq") | sed 's/^/  /'
printf 'Quotes in the dossier that no claim row cites (must be empty; criterion 7):\n'
comm -13 <(printf '%s\n' "$cited") <(printf '%s\n' "$allq") | sed 's/^/  /'
printf '\n'

n=0
for pair in $cited; do
  k=${pair%%#*}; q=${pair##*#}; n=$((n+1))
  printf -- '------------------------------------------------------------------------------\n'
  printf -- '### %s   (locator recorded in entry: %s)\n' "$pair" "$(quote_locator "$k" "$q")"
  printf -- '------------------------------------------------------------------------------\n'
  run "grep -n '^### $q ' sources/$k.md"
  run "tr -s '[:space:]' ' ' < sources/raw/$k.txt | grep -F -c \"$(quote_text "$k" "$q")\""
done
printf '%s distinct key#Qn pairs checked, 2 commands each.\n\n' "$n"

cat <<'H2'
==============================================================================
## §2 - map arithmetic (criterion 3)
==============================================================================
H2
printf 'Claim rows with status OK (criterion 3 requires >= 14):\n'
run "$OK | wc -l | tr -d ' '"
printf 'Distinct key#Qn pairs across those rows (requires >= 10):\n'
run "$OK | grep -oE '\`[a-z0-9-]+#Q[0-9]+\`' | sort -u | wc -l | tr -d ' '"
printf 'Distinct source keys across those rows (requires >= 6):\n'
run "$OK | grep -oE '\`[a-z0-9-]+#Q[0-9]+\`' | sed 's/#Q[0-9]*\`/\`/' | sort -u | wc -l | tr -d ' '"
printf 'Rows per Qn, most-used first (requires no Qn above 3):\n'
run "$OK | grep -oE '\`[a-z0-9-]+#Q[0-9]+\`' | sort | uniq -c | sort -rn | head -6"
printf 'Rows per dimension (requires every dimension D1-D7 to have >= 1):\n'
run "$OK | awk -F'|' '{gsub(/ /,\"\",\$3); print \$3}' | sort | uniq -c"
printf 'Rows per dimension per system (requires >= 1 row per system in each dimension where\nthe systems differ; here every dimension carries both):\n'
run "$OK | awk -F'|' '{gsub(/ /,\"\",\$3); gsub(/ /,\"\",\$5); print \$3, \$5}' | sort | uniq -c"
printf 'Rows carried as WEAKENED or DROPPED (not counted toward the 14):\n'
run "grep -cE '\| (WEAKENED|DROPPED) \|\$' claims/claim-map.md"
printf 'Dimensions defined in claims/dimensions.md (criterion 1 requires 6-9):\n'
run "grep -cE '^## D[0-9]+ ' claims/dimensions.md"
printf 'Each dimension states what the reader can observe (must equal the dimension count):\n'
run "grep -cE '^\*\*What the reader can observe' claims/dimensions.md"
printf 'Questions listed in claims/gaps.md (criterion 5 requires >= 3):\n'
run "grep -cE '^## [0-9]+\. ' claims/gaps.md"

cat <<'H3'
==============================================================================
## §3 - dossier closure: every entry is cited by >= 1 claim row (criterion 7)
==============================================================================

For each sources/<key>.md, the number of OK claim rows citing it. A zero would require that
entry to be moved to sources/unused/ with a note; there are none, so sources/unused/ does
not exist.
H3
run "for k in \$(ls sources/*.md | xargs -n1 basename | sed 's/\.md\$//' | grep -v CAPTURE_LOG); do printf '%-24s %s\n' \"\$k\" \"\$($OK | grep -c \"\\\`\$k#Q\")\"; done"
printf 'Confirming sources/unused/ is absent (exit status 1 and "No such file" is the expected\nresult, because no entry went uncited):\n'
run 'ls -d sources/unused 2>&1; echo "exit=$?"'
printf 'And that every key cited in the map is a file that exists on disk:\n'
run "$OK | grep -oE '\`[a-z0-9-]+#Q[0-9]+\`' | tr -d '\`' | sed 's/#Q[0-9]*//' | sort -u | while read k; do printf '%-24s %s\n' \"\$k\" \"\$(test -f sources/\$k.md && echo FOUND || echo MISSING)\"; done"
printf 'And the other direction of criterion 7 - the distinct source keys each dimension rests\non, so no dimension is left without a primary source:\n'
run "$OK | awk -F'|' '{gsub(/ /,\"\",\$3); gsub(/\`/,\"\",\$6); gsub(/ /,\"\",\$6); sub(/#Q[0-9]+/,\"\",\$6); print \$3\" \"\$6}' | sort -u | awk '{a[\$1]=a[\$1]\" \"\$2} END{for(d in a) print d\":\"a[d]}' | sort"

cat <<'H4'
==============================================================================
## §4 - no claim row cites an excluded document (criterion 6)
==============================================================================

The keys in claims/excluded-sources.md, counted against every claim row in
claims/claim-map.md (rows beginning "| C<n> |" or "| W<n> |"). All must be 0.
H4
run "for k in excluded-why-duckdb excluded-posthog-vs excluded-betterstack-vs excluded-lukasbarth-bench; do printf '%-26s %s\n' \"\$k\" \"\$(grep -E '^\| [CW][0-9]+ \|' claims/claim-map.md | grep -c \"\$k\")\"; done"
printf 'The excluded keys as they are listed in claims/excluded-sources.md, for comparison:\n'
run "grep -oE 'excluded-[a-z-]+' claims/excluded-sources.md | sort -u"

cat <<'H5'
==============================================================================
## §5 - no number is smuggled into a claim row (and the W1 Parquet negative check)
==============================================================================

W1 claims nothing because nothing supports it. Occurrences of "Parquet" (case-insensitive)
in each capture:
H5
run "for f in sources/raw/*.txt; do printf '%-45s %s\n' \"\$f\" \"\$(grep -ic parquet \"\$f\")\"; done"
printf 'The single occurrence, in context - a future-work sentence about join plans, not about\ningest:\n'
run "grep -n -B1 -A2 -i parquet sources/raw/duckdb-pvldb-hashjoin.txt"
printf 'And no speed figure was smuggled into the map either - rows carrying a multiplier or a\ntiming (must be empty):\n'
run "grep -nE '[0-9]+(\.[0-9]+)? ?(x|times) (faster|slower)|[0-9]+ ?(ms|milliseconds|seconds|minutes)' claims/claim-map.md"

cat <<'H5B'
That grep only catches multipliers and timings. Criterion 6 is wider than that: it forbids
ANY number in a claim sentence that is absent from the quote the row cites. So the check
below is exhaustive rather than pattern-based - it extracts every numeric token from the
claim column of every OK row and asks three questions of each:

  in-quote    does the number appear in the text of the quote this row cites?
  in-locator  does it appear in that quote's locator heading in sources/<key>.md
              (this is how a release number or release year is sourced)?
  in-dated    does it appear in the cited entry's `dated:` header field (this is how a
              paper's publication year is sourced, e.g. "DuckDB's SIGMOD 2019 paper")?

A row is clean if at least one column is 1. Anything that is 0/0/0 is a number the map
asserts on its own authority and must be justified by name in evidence/level-2/CLAIM.md.
The number is matched on numeric boundaries, not as a bare substring, so the 5 of "5 GB"
cannot count itself sourced by finding a 5 inside a 2025 date.
H5B
run "grep -E '\| OK \|\$' claims/claim-map.md | awk -F'|' '{gsub(/^ +| +\$/,\"\",\$2);gsub(/^ +| +\$/,\"\",\$6);gsub(/\`/,\"\",\$6); n=\$4; while (match(n,/[0-9][0-9.]*[0-9]|[0-9]/)) { t=substr(n,RSTART,RLENGTH); print \$2\"\t\"\$6\"\t\"t; n=substr(n,RSTART+RLENGTH) } }' | while IFS=\$'\t' read -r id kq num; do k=\${kq%%#*}; q=\${kq##*#}; qt=\$(grep -A1 \"^### \$q \" \"sources/\$k.md\" | sed -n '2s/^> //p'); loc=\$(grep -m1 \"^### \$q \" \"sources/\$k.md\"); dt=\$(grep -m1 '^dated:' \"sources/\$k.md\"); re=\"(^|[^0-9.])\$(printf '%s' \"\$num\" | sed 's/\./\\\\./g')([^0-9]|\\\$)\"; printf '%-5s %-28s %-8s in-quote=%s in-locator=%s in-dated=%s\n' \"\$id\" \"\$kq\" \"\$num\" \"\$(printf '%s' \"\$qt\" | grep -Ec \"\$re\")\" \"\$(printf '%s' \"\$loc\" | grep -Ec \"\$re\")\" \"\$(printf '%s' \"\$dt\" | grep -Ec \"\$re\")\"; done"
printf 'The same audit, printing only the numbers that are 0/0/0 - unsourced by quote, locator or\nentry date. Each one that remains is named and justified in evidence/level-2/CLAIM.md:\n'
run "grep -E '\| OK \|\$' claims/claim-map.md | awk -F'|' '{gsub(/^ +| +\$/,\"\",\$2);gsub(/^ +| +\$/,\"\",\$6);gsub(/\`/,\"\",\$6); n=\$4; while (match(n,/[0-9][0-9.]*[0-9]|[0-9]/)) { t=substr(n,RSTART,RLENGTH); print \$2\"\t\"\$6\"\t\"t; n=substr(n,RSTART+RLENGTH) } }' | while IFS=\$'\t' read -r id kq num; do k=\${kq%%#*}; q=\${kq##*#}; qt=\$(grep -A1 \"^### \$q \" \"sources/\$k.md\" | sed -n '2s/^> //p'); loc=\$(grep -m1 \"^### \$q \" \"sources/\$k.md\"); dt=\$(grep -m1 '^dated:' \"sources/\$k.md\"); re=\"(^|[^0-9.])\$(printf '%s' \"\$num\" | sed 's/\./\\\\./g')([^0-9]|\\\$)\"; a=\$(printf '%s' \"\$qt\" | grep -Ec \"\$re\"); b=\$(printf '%s' \"\$loc\" | grep -Ec \"\$re\"); c=\$(printf '%s' \"\$dt\" | grep -Ec \"\$re\"); [ \"\$a\$b\$c\" = 000 ] && printf '%-5s %-28s %s\n' \"\$id\" \"\$kq\" \"\$num\"; done; true"
printf 'And a grep for derived-ratio language - orders of magnitude, N-fold, N-times-below,\npercent - across every claim row, OK and cut alike (must be empty; this is the class of\nwording that got C4 narrowed twice). The filter selects rows by their status column, so the\n\"rows tightened on re-read\" table, which quotes the removed wording on purpose, is not\nsearched here - it is meant to contain it:\n'
run "grep -E '\| (OK|WEAKENED|DROPPED) \|\$' claims/claim-map.md | grep -nEi 'orders? of magnitude|[0-9]+ ?[x×] (below|above|larger|smaller|more|less|faster|slower)|[0-9]+ ?-?fold|[0-9]+ ?%'; true"

cat <<'H6'
==============================================================================
## §6 - every claim row's verbatim fragment lies inside the quote it cites
==============================================================================

Criterion 2 requires the map to carry "a short verbatim fragment of the supporting quote".
This check does not test the fragment against the capture (§1 already did that for the full
quote); it tests the fragment against the *specific quote the row cites*, by pulling that
quote out of sources/<key>.md and grepping the fragment against it. A 1 means the row could
not have picked its fragment from some other passage of the document.
H6
run "$OK | awk -F'|' '{gsub(/^ +| +\$/,\"\",\$2);gsub(/^ +| +\$/,\"\",\$6);gsub(/^ +| +\$/,\"\",\$7);gsub(/\`/,\"\",\$6);print \$2\"\t\"\$6\"\t\"\$7}' | while IFS=\$'\t' read -r id kq frag; do k=\${kq%%#*}; q=\${kq##*#}; qt=\$(grep -A1 \"^### \$q \" \"sources/\$k.md\" | sed -n '2s/^> //p'); printf '%-5s %-30s %s\n' \"\$id\" \"\$kq\" \"\$(printf '%s' \"\$qt\" | grep -F -c \"\$frag\")\"; done"
printf 'The same loop, printing only rows whose count is not 1 (must be empty):\n'
run "$OK | awk -F'|' '{gsub(/^ +| +\$/,\"\",\$2);gsub(/^ +| +\$/,\"\",\$6);gsub(/^ +| +\$/,\"\",\$7);gsub(/\`/,\"\",\$6);print \$2\"\t\"\$6\"\t\"\$7}' | while IFS=\$'\t' read -r id kq frag; do k=\${kq%%#*}; q=\${kq##*#}; qt=\$(grep -A1 \"^### \$q \" \"sources/\$k.md\" | sed -n '2s/^> //p'); c=\$(printf '%s' \"\$qt\" | grep -F -c \"\$frag\"); [ \"\$c\" = 1 ] || printf '%s %s %s\n' \"\$id\" \"\$kq\" \"\$c\"; done"

cat <<'H7'
==============================================================================
## §7 - the captures checked above are the ones level 1 fetched and logged (sha256)
==============================================================================

§1 greps quotes against sources/raw/<key>.txt. That only means anything if those files are
still the captures sources/CAPTURE_LOG.md recorded at level 1. Every hash below must appear
in the log. (The `.headers.txt` files are deliberately not in this check: level 1 logged a
hash for each `.src` and each `.txt`, not for the header dumps.)
H7
run "shasum -a 256 sources/raw/*.src \$(ls sources/raw/*.txt | grep -v headers)"
printf 'Each of those hashes looked up in sources/CAPTURE_LOG.md (a 0 would mean a capture was\nedited or replaced after level 1 logged it):\n'
run "shasum -a 256 sources/raw/*.src \$(ls sources/raw/*.txt | grep -v headers) | while read h f; do printf '%-45s %s\n' \"\$f\" \"\$(grep -c \"\$h\" sources/CAPTURE_LOG.md)\"; done"

printf '==============================================================================\n\n'
printf '## End of transcript. Generated %s by evidence/level-2/make-map-check.sh,\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
printf '## repository root %s.\n\n' "$(pwd)"
printf '==============================================================================\n'
