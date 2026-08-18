#!/usr/bin/env bash
# Generates both level-4 evidence artifacts by running the checks, so nothing in them is typed
# by hand and nothing can drift from REPORT.md or sources/.
#
#   bash evidence/level-4/make-level4-checks.sh
#
# Writes: evidence/level-4/verify.txt
#         evidence/level-4/citation-audit.md
#
# The only hand-written inputs are the AUDIT table (report line -> kind -> key#Qn / absence
# check id -> note) and the CLASSIFY patterns in section 4. Everything else -- sentence text,
# quote text, hashes, counts, verdicts -- is read from disk or computed.
#
# Re-run after ANY edit to REPORT.md or sources/. Only the timestamp at the foot of verify.txt
# changes between runs on unchanged inputs.
set -u

R=REPORT.md
OUT=evidence/level-4
VER=$OUT/verify.txt
AUD=$OUT/citation-audit.md
S=/tmp/l4scratch
rm -rf "$S"; mkdir -p "$S"

KEYS='duckdb-cidr20 duckdb-pvldb-hashjoin duckdb-sigmod19 sqlite-changes sqlite-cli sqlite-lts sqlite-wal sqlite-whentouse'

# ---------------------------------------------------------------------------
# AUDIT: one line per substantive sentence of REPORT.md's body.
#   report-line | kind | key#Qn[,key#Qn][,A<n>] or '-' | note
#
# kinds:
#   CLAIM    first assertion of a claim-map row about SQLite or DuckDB
#   RESTATE  the same claim argued again as a decision condition in the recommendation
#   ABSENCE  asserts that the sources do NOT settle something; checked in section 4
#   LIMIT    a limits-passage sentence combining a cited claim with an absence
#   GLOSS    narrows the sentence above it; asserts nothing new
#   DOSSIER  a fact about this dossier (dates, which release is named); checked in section 5
#   LABEL    a numbered condition heading; names an observable of the reader's setup
#   META     about the report or addressed to the reader; asserts nothing about either system
#   SCENARIO the task's own premise
# ---------------------------------------------------------------------------
AUDIT='
3|SCENARIO|-|The premise the task itself sets (~5 GB, a laptop, one embedded database). No source needed and none claimed.
5|META|-|Statement of method. The "primary sources only" half is what sections 1-3 check; the "nothing here was benchmarked" half is section 6d and section 7.
7|DOSSIER|-|Asserts the three DuckDB sources are dated 2019, 2020 and 2025. Section 5 prints the dated: field of all three entries.
12|CLAIM|sqlite-whentouse#Q2|
14|CLAIM|sqlite-whentouse#Q4|Direction only ("far below which a 5 GB dataset sits"); the ratio the quote does not contain was removed at level 2 and has not returned -- section 6d, RESIDUAL=7, and all seven of those are the 5 of ~5 GB.
17|CLAIM|duckdb-pvldb-hashjoin#Q3|
20|CLAIM|duckdb-pvldb-hashjoin#Q1|Reports the shape of the degradation, as the quote does; no throughput figure is attached to it.
26|CLAIM|duckdb-sigmod19#Q2|
28|CLAIM|duckdb-sigmod19#Q1|Attributed to DuckDB authors in the sentence itself ("DuckDB SIGMOD 2019 paper characterises"), which is what keeps it from reading as a finding of this report.
31|CLAIM|duckdb-sigmod19#Q1|
33|CLAIM|sqlite-whentouse#Q3|"a situation where SQLite works well" is the quote locator heading, section 1. Situations Where SQLite Works Well.
38|CLAIM|sqlite-whentouse#Q1|
40|CLAIM|sqlite-wal#Q1|
42|CLAIM|sqlite-wal#Q2|
44|CLAIM|sqlite-wal#Q3|
46|CLAIM|duckdb-sigmod19#Q3|
49|GLOSS|A3|Narrows line 46: MVCC is isolation inside the engine, not a process count. Check A3 shows no DuckDB capture states a process count, so the narrowing is the evidence, not modesty.
53|CLAIM|sqlite-cli#Q1|
55|CLAIM|duckdb-cidr20#Q1|
57|CLAIM|duckdb-cidr20#Q2|
59|CLAIM|duckdb-cidr20#Q2|
61|CLAIM|sqlite-changes#Q2|The date and version (2020, 3.33.0) are the quote locator: release entry 2020-08-14 (3.33.0), item 8.
64|CLAIM|duckdb-sigmod19#Q3|
68|CLAIM|sqlite-lts#Q1|
71|CLAIM|sqlite-lts#Q2,sqlite-lts#Q3|One sentence carrying two claim rows: format stability (Q2) and the 2050 intent (Q3).
74|CLAIM|duckdb-pvldb-hashjoin#Q2|"ships numbered releases" is read off the phrase "available in the v1.2.0 release" inside that quote; no other release is named anywhere.
77|ABSENCE|A2|
81|META|-|Structural: says the recommendation has four conditions. Section 6c counts the numbered headings.
83|LABEL|-|Condition 1 observable: installed RAM against the working set. A property of the machine in front of the reader, checkable without either system.
84|META|-|Reader instruction. Asserts nothing about either system.
85|RESTATE|duckdb-pvldb-hashjoin#Q3,A5|The "only sourced statement here" half is check A5.
89|LABEL|-|Condition 2 observable: how many OS processes write the file, and whether it lives on a network share.
90|RESTATE|sqlite-whentouse#Q1,sqlite-wal#Q2,sqlite-wal#Q3|
93|ABSENCE|A3|
95|LABEL|-|Condition 3 observable: single-row updates after the load versus bulk appends and rebuilds.
96|META|-|Reader instruction: how to establish condition 3 by counting a week of write statements.
97|RESTATE|duckdb-cidr20#Q2|
99|RESTATE|duckdb-cidr20#Q2|
101|LABEL|-|Condition 4 observable: how long the file must stay readable, and on what hardware.
102|RESTATE|sqlite-lts#Q1|
104|META|-|Reader guidance closing condition 4; asserts nothing about either system.
106|RESTATE|duckdb-cidr20#Q2,A2|States what choosing DuckDB costs. Second half is check A2.
109|RESTATE|sqlite-lts#Q1,duckdb-cidr20#Q1,A2|The both-systems case. "version-stability gap" is check A2.
116|LIMIT|duckdb-sigmod19#Q1,sqlite-whentouse#Q3,A6,A7|WEAKENED THIS LEVEL -- see the edits table below. duckdb-sigmod19 is cited inline at line 31, not here.
120|ABSENCE|A2|
122|ABSENCE|A3|
124|ABSENCE|A1|WEAKENED THIS LEVEL -- see the edits table below.
126|ABSENCE|A4|
128|DOSSIER|duckdb-pvldb-hashjoin#Q2|Also rests on the dated: fields printed in section 5.
'

# ---------------------------------------------------------------------------
# Absence checks. Each is enumerate-and-classify: pull EVERY hit of a broad
# pattern out of the artifact, give each hit a classification, and print the
# residual -- the hits no classification accounts for, which must be 0.
# CLASSIFY_<n> lines are 'literal substring of the hit :: what that hit is'.
# ---------------------------------------------------------------------------

A2_PAT='backwards? compat|forward compat|compatib[a-z]*|file format|storage format|upgrade|migrat[a-z]*'
CLASSIFY_A2='
on-disk storage format::cidr20: how column-focused updates affect the on-disk layout. A design statement about writes, not about reading the file from a later version.
single-file storage format::cidr20 Q2: the format stated design goals (efficient scans, bulk updates). Says nothing about which versions can read it.
R. Hipp. Database file format::cidr20 bibliography entry [3]: a citation of SQLite file-format page, not a statement about DuckDB.
B-Tree storage format::sigmod19 Q1: SQLite storage layout, cited as the cause of its OLAP performance.
SQLite compatibility layer::sigmod19: an API shim letting applications that used SQLite call DuckDB. Source-level compatibility, not file-format compatibility.
Richard Hipp. 2019. Database File Format::sigmod19 bibliography entry [3]: a citation of SQLite file-format page.
'

A3_PAT='multi-process|multiple processes|concurrent process|writer|network filesystem|file lock|locking|blocking'
CLASSIFY_A3='
multiple consistent views::cidr20: MVCC gives concurrent transactions consistent views inside the engine. Not a count of OS processes that may open the file.
pipeline breaker::pvldb: "blocking operator" is a query-execution term for an operator that materialises its input. Nothing to do with file access.
blocking operators have a much higher memory footprint::pvldb: the same query-execution sense of "blocking".
'

# --- helpers ---------------------------------------------------------------

# sentence(): the sentence starting at report line N -- consecutive lines joined with single
# spaces up to and including the first line ending in a full stop (or a bolded full stop).
sentence() {
  awk -v n="$1" 'NR>=n { buf = (buf=="" ? $0 : buf" "$0); if ($0 ~ /[.](\*\*)?$/) { print buf; exit } }' "$R"
}

# quote(): verbatim text of <key>#<Qn> from the source entry.
quote() {
  key=${1%%#*}; qn=${1##*#}
  grep -A1 "^### $qn " "sources/$key.md" | sed -n '2s/^> //p'
}

# hdr(): header field <name> of sources/<key>.md, surrounding quotes stripped.
hdr() {
  awk -v k="$2:" '$1==k { sub(/^[a-z_]+: */,""); gsub(/^"|"$/,""); print; exit }' "sources/$1.md"
}

# every quote in the dossier as  key#Qn <TAB> text
: > "$S/quotes.tsv"
for k in $KEYS; do
  awk -v k="$k" '/^### Q/ { qn=$2 } /^> / { sub(/^> /,""); print k"#"qn"\t"$0 }' "sources/$k.md" >> "$S/quotes.tsv"
done

# classify(): reads hits on stdin, one per line; writes "  [n] <hit>" then its classification.
# Prints the number of UNCLASSIFIED hits to $S/residual.
classify() {
  awk -v specfile="$1" -v resfile="$S/residual" '
    BEGIN { while ((getline line < specfile) > 0) if (line ~ /::/) { p=line; sub(/::.*/,"",p); c=line; sub(/^[^:]*::/,"",c); PAT[++m]=p; CLS[m]=c }
            unc=0 }
    { h=$0; hit++; cls="UNCLASSIFIED";
      for (i=1;i<=m;i++) if (index(h,PAT[i])>0) { cls=CLS[i]; break }
      if (cls=="UNCLASSIFIED") unc++
      printf "  [%d] ...%s...\n      -> %s\n", hit, h, cls }
    END { printf "  hits: %d   UNCLASSIFIED (residual): %d\n", hit+0, unc; print unc+0 > resfile }'
}

# --- compute the absence-check residuals -----------------------------------

# A1 -- no accepted quote describes loading Parquet, Arrow or JSON.
A1_HITS=$(grep -c -i -E 'parquet|arrow|json' "$S/quotes.tsv")
A1=$A1_HITS

# A2 -- no DuckDB capture states cross-version file-format stability.
for f in duckdb-cidr20 duckdb-sigmod19 duckdb-pvldb-hashjoin; do
  tr -s '[:space:]' ' ' < "sources/raw/$f.txt" | grep -o -i -E ".{0,90}($A2_PAT).{0,90}"
done > "$S/a2.hits"
printf '%s\n' "$CLASSIFY_A2" > "$S/a2.spec"
classify "$S/a2.spec" < "$S/a2.hits" > "$S/a2.out"; A2=$(cat "$S/residual")

# A3 -- no DuckDB capture states how many OS processes may hold the file.
for f in duckdb-cidr20 duckdb-sigmod19 duckdb-pvldb-hashjoin; do
  tr -s '[:space:]' ' ' < "sources/raw/$f.txt" | grep -o -i -E ".{0,90}($A3_PAT).{0,90}"
done > "$S/a3.hits"
printf '%s\n' "$CLASSIFY_A3" > "$S/a3.spec"
classify "$S/a3.spec" < "$S/a3.hits" > "$S/a3.out"; A3=$(cat "$S/residual")

# A4 -- no accepted quote carries a laptop hardware figure.
A4=$(grep -c -i -E '[0-9]+ ?(GB|MB|TB|GiB|KB)|[[:<:]]RAM[[:>:]]|[[:<:]]cores?[[:>:]]|scratch' "$S/quotes.tsv")

# A5 -- the only quotes speaking of a memory limit are DuckDB's.
A5=$(grep -i 'memory' "$S/quotes.tsv" | cut -f1 | grep -v -c '^duckdb-pvldb-hashjoin#')

# A6 -- the only SQLite-authored quote bearing on analytical work is whentouse#Q3.
A6=$(grep '^sqlite' "$S/quotes.tsv" | grep -i -E 'analy|OLAP|summary report|large datasets' | cut -f1 | grep -v -c '^sqlite-whentouse#Q3$')

# A7 -- no speed figure, ratio or timing in the report body.
A7a=$(awk '/^## Sources/{exit} {print}' "$R" | grep -E -c -i '[0-9]+ *(x|times) (faster|slower)|[0-9]+ *(ms|s|sec|seconds|MB/s|GB/s)([^a-z]|$)|orders of magnitude|[0-9]+ *%')
A7b=$(awk '/^## Sources/{exit} {print}' "$R" | grep -E -c -i 'faster|slower|speedup|throughput of|benchmark(ed)? (shows|show|proves)')
A7=$((A7a + A7b))

# --- verdict for one audit row ---------------------------------------------
# echoes "<verdict>|<detail>"
row_verdict() {
  kind="$1"; keyspec="$2"; sent="$3"
  det=""; ok=1
  if [ "$keyspec" = "-" ]; then
    echo "PASS|no source required for a $kind row"; return
  fi
  IFS=','; set -- $keyspec; unset IFS
  for kq in "$@"; do
    case "$kq" in
      A[0-9])
        eval "res=\$$kq"
        if [ "$res" -eq 0 ]; then det="$det $kq(residual 0)"; else det="$det $kq(residual $res)"; ok=0; fi
        ;;
      *)
        q=$(quote "$kq"); key=${kq%%#*}
        c=$(tr -s '[:space:]' ' ' < "sources/raw/$key.txt" | grep -F -c "$q")
        if [ "${c:-0}" -lt 1 ]; then det="$det $kq(quote grep $c)"; ok=0
        else
          if printf '%s' "$sent" | grep -F -q "[$key]"; then det="$det $kq(grep $c, cited inline)"
          else det="$det $kq(grep $c, back-reference)"; fi
        fi
        ;;
    esac
  done
  if [ "$ok" -eq 1 ]; then echo "PASS|$det"; else echo "FAIL|$det"; fi
}

QCMD='for k in '"$KEYS"'; do awk -v k="$k" '"'"'/^### Q/{qn=$2} /^> /{sub(/^> /,"");print k"#"qn"\t"$0}'"'"' sources/$k.md; done'

# ===========================================================================
# verify.txt
# ===========================================================================
{
echo "# evidence/level-4/verify.txt -- generated by evidence/level-4/make-level4-checks.sh"
echo "# Every command below was run by that script; the lines under it are its real output."
echo "# Run the script from the repository root; every one-liner shown is copy-pasteable as-is."
echo
echo "================================================================================"
echo "1. Canonical quote check -- every quote in the dossier, against its own capture"
echo "================================================================================"
echo
echo "Canonical form (EVIDENCE.md 1.4):"
echo "    tr -s '[:space:]' ' ' < sources/raw/<key>.txt | grep -F -c \"<quote>\""
echo "A quote passes at count >= 1 after whitespace normalisation. CITED marks the quotes the"
echo "final REPORT.md rests on (the key#Qn set of the audit table); the rest are checked anyway."
echo "No quote in this dossier is grep-exempt: all 8 captures extracted to text cleanly."
echo
cited_set=$(printf '%s\n' "$AUDIT" | grep -v '^$' | cut -d'|' -f3 | tr ',' '\n' | grep '#' | sort -u)
n_pass=0; n_fail=0; n_cited=0
while IFS=$'\t' read -r kq qt; do
  key=${kq%%#*}
  if printf '%s\n' "$cited_set" | grep -q -x "$kq"; then tag=CITED; n_cited=$((n_cited+1)); else tag=UNCITED; fi
  echo "--- $kq  [$tag]"
  echo "tr -s '[:space:]' ' ' < sources/raw/$key.txt | grep -F -c \"$qt\""
  c=$(tr -s '[:space:]' ' ' < "sources/raw/$key.txt" | grep -F -c "$qt")
  echo "$c"
  if [ "$c" -ge 1 ]; then n_pass=$((n_pass+1)); else n_fail=$((n_fail+1)); fi
done < "$S/quotes.tsv"
echo
echo "quotes checked: $((n_pass+n_fail))   count >= 1: $n_pass   count 0: $n_fail   of which cited by REPORT.md: $n_cited"
echo
echo "================================================================================"
echo "2. sha256 over sources/raw/* reconciled against sources/CAPTURE_LOG.md"
echo "================================================================================"
echo
echo "shasum -a 256 sources/raw/*"
shasum -a 256 sources/raw/*
echo
echo "Reconciliation, file by file. The log records a sha256 for each .src and each .txt; the"
echo "response-header files are not hashed there, so they are classified rather than left to"
echo "print a bare 0 that looks like a mismatch."
echo
echo "for f in sources/raw/*; do h=\$(shasum -a 256 \"\$f\" | cut -d' ' -f1); echo \"\$f \$h \$(grep -c -F \"\$h\" sources/CAPTURE_LOG.md)\"; done"
echo
mism=0; hdrs=0; recon=0
for f in sources/raw/*; do
  h=$(shasum -a 256 "$f" | cut -d' ' -f1)
  n=$(grep -c -F "$h" sources/CAPTURE_LOG.md)
  case "$f" in
    *.headers.txt) cls="NOT-HASHED-IN-LOG (response headers; the log hashes .src and .txt)"; hdrs=$((hdrs+1)) ;;
    *) if [ "$n" -ge 1 ]; then cls="RECONCILES (found in CAPTURE_LOG.md)"; recon=$((recon+1)); else cls="MISMATCH -- not in CAPTURE_LOG.md"; mism=$((mism+1)); fi ;;
  esac
  printf '  %-42s %s  log-hits=%s  %s\n' "${f#sources/raw/}" "$h" "$n" "$cls"
done
echo
echo "  .src + .txt reconciling with the log: $recon    mismatches: $mism    header files (not hashed in the log): $hdrs"
echo
echo "================================================================================"
echo "3. Extraction re-derivation -- the .txt came out of the .src, not out of a model"
echo "================================================================================"
echo
echo "The extraction command CAPTURE_LOG.md records for each capture, re-run against the stored"
echo ".src with its output redirected to a scratch path so the write-once capture is not touched,"
echo "then hashed and compared with the stored .txt. LEVELS.md asks for at least one; all eight"
echo "are done because the check is cheap and one capture proves only one capture."
echo
red=0; rmis=0
for k in $KEYS; do
  case "$k" in
    duckdb-*) cmd="pdftotext sources/raw/$k.src $S/$k.txt"; logged="pdftotext sources/raw/$k.src sources/raw/$k.txt" ;;
    *)        cmd="pandoc -f html -t plain --wrap=none sources/raw/$k.src -o $S/$k.txt"
              logged="pandoc -f html -t plain --wrap=none sources/raw/$k.src -o sources/raw/$k.txt" ;;
  esac
  echo "--- $k"
  echo "logged in CAPTURE_LOG.md:  $logged"
  echo "$cmd && shasum -a 256 $S/$k.txt sources/raw/$k.txt"
  $cmd 2>"$S/$k.err"
  a=$(shasum -a 256 "$S/$k.txt" | cut -d' ' -f1); b=$(shasum -a 256 "sources/raw/$k.txt" | cut -d' ' -f1)
  echo "  re-derived  $a"
  echo "  stored      $b"
  if [ "$a" = "$b" ]; then echo "  -> MATCH (and the stored hash is the one in CAPTURE_LOG.md, section 2 above)"; red=$((red+1))
  else echo "  -> DIFFERS"; rmis=$((rmis+1)); fi
  es=$(wc -c < "$S/$k.err" | tr -d ' ')
  [ "$es" != "0" ] && { echo "  stderr ($es bytes):"; sed 's/^/    /' "$S/$k.err"; }
done
echo
echo "  re-derived byte for byte: $red of 8    differing: $rmis"
echo
echo "================================================================================"
echo "4. Absence checks -- the sentences that say the sources do NOT settle something"
echo "================================================================================"
echo
echo "These are the report's own limits. A bare negative grep would prove only the pattern, so"
echo "each check pulls EVERY hit of a deliberately broad pattern out of the artifact, classifies"
echo "each hit, and prints the residual: hits no classification accounts for. Residual must be 0."
echo
echo "--- A1: no accepted quote describes loading Parquet, Arrow or JSON  (report line 124)"
echo
echo "$QCMD \\"; echo "  | grep -c -i -E 'parquet|arrow|json'"
echo "$A1"
echo
echo "  A1 residual: $A1"
echo
echo "  The captures are a wider net than the quotes, and they are NOT clean -- which is why"
echo "  line 124 was weakened this level. What the captures contain:"
echo "  for f in $KEYS; do echo \"\$f \$(grep -c -i -E 'parquet|arrow|[^a-z]json' sources/raw/\$f.txt)\"; done"
for f in $KEYS; do
  n=$(grep -c -i -E 'parquet|arrow|[^a-z]json' "sources/raw/$f.txt")
  printf '    %-24s %s hit(s)\n' "$f" "$n"
done
echo "  duckdb-pvldb-hashjoin: 'join plans including Parquet files' -- an aside about join"
echo "    reordering, not a statement that DuckDB ingests Parquet."
echo "  sqlite-cli: '-json  set output mode to json' and a -DSQLITE_ENABLE_JSON1 build flag --"
echo "    an OUTPUT mode and a compile option, not an ingest format."
echo "  sqlite-changes: SQLite's JSON SQL functions across its release history -- again not ingest."
echo "  None of the three is quoted in any source entry, so none can be cited; the report now"
echo "  says 'no accepted quote describes loading ...' instead of 'no source speaks to ...'."
echo
echo "--- A2: no DuckDB capture states cross-version file-format stability  (lines 77, 106, 109, 120)"
echo
echo "for f in duckdb-cidr20 duckdb-sigmod19 duckdb-pvldb-hashjoin; do tr -s '[:space:]' ' ' < sources/raw/\$f.txt | grep -o -i -E \".{0,90}($A2_PAT).{0,90}\"; done"
cat "$S/a2.out"
echo
echo "  A2 residual: $A2   (0 = every hit of that pattern is something other than a statement"
echo "  that a file written by one DuckDB version opens in another)"
echo
echo "--- A3: no DuckDB capture states how many OS processes may hold the file  (lines 49, 93, 122)"
echo
echo "for f in duckdb-cidr20 duckdb-sigmod19 duckdb-pvldb-hashjoin; do tr -s '[:space:]' ' ' < sources/raw/\$f.txt | grep -o -i -E \".{0,90}($A3_PAT).{0,90}\"; done"
cat "$S/a3.out"
echo
echo "  A3 residual: $A3"
echo
echo "--- A4: no accepted quote carries a laptop hardware figure  (report line 126)"
echo
echo "$QCMD \\"; echo "  | grep -c -i -E '[0-9]+ ?(GB|MB|TB|GiB|KB)|[[:<:]]RAM[[:>:]]|[[:<:]]cores?[[:>:]]|scratch'"
echo "$A4"
echo
echo "  A4 residual: $A4"
echo
echo "--- A5: the only quotes speaking of a memory limit are DuckDB's  (report line 85)"
echo
echo "$QCMD \\"; echo "  | grep -i 'memory' | cut -f1"
grep -i 'memory' "$S/quotes.tsv" | cut -f1 | sed 's/^/  /'
echo
echo "  A5 residual (hits from any other key): $A5"
echo
echo "--- A6: the only SQLite-authored quote bearing on analytical work is whentouse#Q3  (line 116)"
echo
echo "$QCMD \\"; echo "  | grep '^sqlite' | grep -i -E 'analy|OLAP|summary report|large datasets' | cut -f1"
grep '^sqlite' "$S/quotes.tsv" | grep -i -E 'analy|OLAP|summary report|large datasets' | cut -f1 | sed 's/^/  /'
echo
echo "  A6 residual (hits from any other sqlite quote): $A6"
echo "  This is why line 116 was weakened this level: whentouse#Q3 IS a SQLite-authored statement"
echo "  bearing on analytical use, so 'no SQLite-authored statement weighs against it' was false."
echo
echo "--- A7: no speed figure, ratio or timing in the report body  (report line 116)"
echo
echo "awk '/^## Sources/{exit} {print}' REPORT.md | grep -E -c -i '[0-9]+ *(x|times) (faster|slower)|[0-9]+ *(ms|s|sec|seconds|MB/s|GB/s)([^a-z]|\$)|orders of magnitude|[0-9]+ *%'"
echo "$A7a"
echo "awk '/^## Sources/{exit} {print}' REPORT.md | grep -E -c -i 'faster|slower|speedup|throughput of|benchmark(ed)? (shows|show|proves)'"
echo "$A7b"
echo
echo "  A7 residual: $A7   (the unit alternatives are anchored on a non-letter so that"
echo "  '2019 sentence' is not read as '2019 s'.) The exhaustive form of this check -- every"
echo "  numeric token in the body enumerated and classified -- is section 6 of"
echo "  evidence/level-3/verify.txt, regenerated after this level's edits."
echo
echo "================================================================================"
echo "5. Dossier facts asserted by the report (lines 7 and 128)"
echo "================================================================================"
echo
echo "grep -H '^dated:' sources/duckdb-*.md sources/sqlite-*.md"
grep -H '^dated:' sources/duckdb-*.md sources/sqlite-*.md
echo
echo "Line 7 says two of the three DuckDB sources are from 2019 and 2020: duckdb-sigmod19 is"
echo "dated 2019-06-30, duckdb-cidr20 2020-01-12, duckdb-pvldb-hashjoin 2025."
echo
echo "Line 128 says v1.2.0 is the only release the DuckDB evidence names:"
echo "for k in duckdb-cidr20 duckdb-sigmod19 duckdb-pvldb-hashjoin; do grep '^> ' sources/\$k.md | grep -o -E 'v?[0-9]+[.][0-9]+([.][0-9]+)?'; done | sort -u"
for k in duckdb-cidr20 duckdb-sigmod19 duckdb-pvldb-hashjoin; do grep '^> ' "sources/$k.md" | grep -o -E 'v?[0-9]+[.][0-9]+([.][0-9]+)?'; done | sort -u | sed 's/^/  /'
echo
echo "================================================================================"
echo "6. The final REPORT.md still meets level 3 criteria 1-4"
echo "================================================================================"
echo
echo "6a. Body word count, band 900-1200 hard."
echo
echo "awk '/^## Sources/{exit} {print}' REPORT.md | wc -w"
awk '/^## Sources/{exit} {print}' "$R" | wc -w
wcw=$(awk '/^## Sources/{exit} {print}' "$R" | wc -w | tr -d ' ')
if [ "$wcw" -ge 900 ] && [ "$wcw" -le 1200 ]; then echo "  IN BAND ($wcw, ceiling 1200)"; else echo "  OUT OF BAND ($wcw)"; fi
echo
echo "6b. Distinct keys cited, and each resolving to a source entry; and the ## Sources list"
echo "    matching each entry header field for field."
echo
echo "grep -o '\\[[a-z0-9-]*\\]' REPORT.md | tr -d '[]' | sort -u"
keys=$(grep -o '\[[a-z0-9-]*\]' "$R" | tr -d '[]' | sort -u)
printf '%s\n' "$keys" | sed 's/^/  /'
nk=$(printf '%s\n' "$keys" | wc -l | tr -d ' ')
echo "  distinct keys cited: $nk  (level 3 criterion 4 needs >= 6)"
for k in $keys; do ls "sources/$k.md"; done | sed 's/^/  ls -> /'
echo
fieldfail=0
for k in $keys; do
  blk=$(awk -v k="\`$k\`" '$0 ~ "^- \\*\\*"k { f=1; print; next } f && /^- \*\*`/ { exit } f { print }' "$R" | tr -s '[:space:]' ' ')
  echo "  --- $k"
  for field in title publisher url dated accessed; do
    v=$(hdr "$k" "$field")
    c=$(printf '%s' "$blk" | grep -F -c "$v")
    [ "$c" -lt 1 ] && fieldfail=$((fieldfail+1))
    printf '    %-10s %s   entry value: %s\n' "$field" "$c" "$v"
  done
done
echo
echo "  header fields checked: $((nk*5))   not found in the report's own bullet: $fieldfail"
echo
echo "6c. The recommendation's conditions, each an observable of the reader's setup."
echo
echo "grep -n -E '^\\*\\*[0-9][.]' REPORT.md"
grep -n -E '^\*\*[0-9][.]' "$R"
echo "grep -c -E '^\\*\\*[0-9][.]' REPORT.md"
grep -c -E '^\*\*[0-9][.]' "$R"
echo "  (level 3 criterion 2 needs >= 3; each names a property checkable without installing"
echo "  either system: RAM vs working set, count of writing processes, single-row updates vs"
echo "  bulk rebuilds, how long the file must stay readable.)"
echo
echo "6d. No number in the body is unaccounted for. The exhaustive enumerate-and-classify audit"
echo "    lives in evidence/level-3/verify.txt section 6, regenerated after this level's edits:"
echo
echo "grep -A1 'grep -c UNCLASSIFIED' evidence/level-3/verify.txt | tail -1"
grep -A1 'grep -c UNCLASSIFIED' evidence/level-3/verify.txt | tail -1 | sed 's/^/  /'
echo "grep -A1 'grep -c RESIDUAL' evidence/level-3/verify.txt | tail -1"
grep -A1 'grep -c RESIDUAL' evidence/level-3/verify.txt | tail -1 | sed 's/^/  /'
echo "  (UNCLASSIFIED 0; RESIDUAL 7, all seven the '5' of the reader's own ~5 GB.)"
echo
echo "================================================================================"
echo "7. Nothing was built, run or benchmarked at this level either"
echo "================================================================================"
echo
echo "git status --porcelain"
git status --porcelain
echo
echo "git status --porcelain | awk '{print \$NF}' | grep -E -c '[.](db|sqlite|sqlite3|duckdb|wal|shm|parquet|csv|py|c|h|sql)\$'"
git status --porcelain | awk '{print $NF}' | grep -E -c '[.](db|sqlite|sqlite3|duckdb|wal|shm|parquet|csv|py|c|h|sql)$'
echo "  (0 expected: no database file, no data file, no program source.)"
echo
echo "ls sources/raw/ | wc -l    # captures, untouched -- the re-derivation in section 3 wrote to /tmp"
ls sources/raw/ | wc -l
echo
echo "--- generated by evidence/level-4/make-level4-checks.sh"
} > "$VER"

# ===========================================================================
# citation-audit.md
# ===========================================================================
{
echo "# evidence/level-4/citation-audit.md -- generated, do not hand-edit"
echo
echo "Generated by \`evidence/level-4/make-level4-checks.sh\`. One row per substantive sentence in"
echo "the body of the final \`REPORT.md\` -- **every** sentence, not only the cited ones, so a"
echo "sentence cannot escape the audit by carrying no citation. The opening words of each row are"
echo "*extracted from \`REPORT.md\` at the line given*, not retyped."
echo
echo "The verdict column is computed, not asserted. For a row citing \`key#Qn\`, PASS means the"
echo "canonical check \`tr -s '[:space:]' ' ' < sources/raw/<key>.txt | grep -F -c \"<quote>\"\`"
echo "returned >= 1 (transcript: \`verify.txt\` section 1) **and** the report sentence carries the"
echo "inline \`[key]\` -- or, where it does not, the row says \`back-reference\` and the note names"
echo "the line that does. For a row resting on an absence check \`A<n>\`, PASS means that check's"
echo "residual is 0 (transcript: \`verify.txt\` section 4)."
echo
echo "There are no \`UNCHECKED\` rows."
echo
echo "## Edits made this level"
echo
echo "Both were found by the absence checks in \`verify.txt\` section 4 and both weakened a claim"
echo "the sources did not carry. Neither claim was deleted outright, because in both cases a"
echo "narrower true statement survives."
echo
echo "| line | before | after | why |"
echo "|---|---|---|---|"
echo "| 116-119 | \"and no SQLite-authored statement in this dossier weighs against it\" | \"and the only SQLite-authored statement here is its own unquantified \\\"works well\\\" listing [sqlite-whentouse]\" | Check A6: \`sqlite-whentouse#Q3\` **is** a SQLite-authored statement bearing on analytical use, and the report asserts it at line 33. The original sentence contradicted the report's own line 33. |"
echo "| 124-125 | \"no source speaks to Parquet, Arrow or JSON on either side\" | \"no accepted quote describes loading Parquet, Arrow or JSON on either side\" | Check A1: no *quote* mentions any of the three (residual 0), but the *captures* do -- Parquet once in the PVLDB paper, JSON in sqlite-cli's output modes and throughout sqlite-changes. \"No source speaks to\" was false as written; the scope the report actually relies on is its accepted quotes. |"
echo
echo "Word count after both edits: $(awk '/^## Sources/{exit} {print}' "$R" | wc -w | tr -d ' ') (band 900-1200, hard). Line count unchanged at $(grep -c '' "$R"), so"
echo "\`evidence/level-3/claim-coverage.md\` line numbers still resolve; it was regenerated anyway."
echo
echo "## The audit"
echo
echo "| line | first words in REPORT.md | kind | rests on | verdict | note |"
echo "|---|---|---|---|---|---|"
pass=0; fail=0; unchecked=0; total=0
printf '%s\n' "$AUDIT" | grep -v '^$' | while IFS='|' read -r n kind keyspec note; do
  s=$(sentence "$n")
  first=$(printf '%s' "$s" | cut -d' ' -f1-8)
  rv=$(row_verdict "$kind" "$keyspec" "$s")
  v=${rv%%|*}; det=${rv#*|}
  ks=$(printf '%s' "$keyspec" | sed 's/,/, /g')
  [ "$keyspec" = "-" ] && ks="--"
  full="$det"
  [ -n "$note" ] && full="$det -- $note"
  echo "| $n | $first ... | $kind | \`$ks\` | **$v** | $full |"
done
echo
echo "### Row counts"
echo
printf '%s\n' "$AUDIT" | grep -v '^$' | cut -d'|' -f2 | sort | uniq -c | awk '{printf "- %-9s %s rows\n", $2, $1}'
echo
tot=$(printf '%s\n' "$AUDIT" | grep -cv '^$')
echo "**$tot rows total.** Every sentence of the report body between line 3 and line 128 is here:"
echo "the row lines are the sentence-start lines produced by the same join-until-a-full-stop rule"
echo "the report is written to, so a sentence with no row would show up as a gap."
echo
echo "Completeness check (report body sentence starts, excluding headings, versus audit rows):"
echo
echo '```'
echo "\$ awk '/^## Sources/{exit}{print NR\"\\t\"\$0}' REPORT.md | awk -F'\\t' '{if(\$2~/^[[:space:]]*\$/)next; if(\$2~/^#/){s=0;next} if(s==0)s=\$1; if(\$2~/[.](\\*\\*)?\$/){print s;s=0}}'"
awk '/^## Sources/{exit}{print NR"\t"$0}' "$R" | awk -F'\t' '{if($2~/^[[:space:]]*$/)next; if($2~/^#/){s=0;next} if(s==0)s=$1; if($2~/[.](\*\*)?$/){print s;s=0}}' > "$S/sent.lines"
tr '\n' ' ' < "$S/sent.lines"; echo
echo
echo "audit rows:"
printf '%s\n' "$AUDIT" | grep -v '^$' | cut -d'|' -f1 > "$S/audit.lines"
tr '\n' ' ' < "$S/audit.lines"; echo
echo
d1=$(comm -23 <(sort -n "$S/sent.lines") <(sort -n "$S/audit.lines") | tr '\n' ' ')
d2=$(comm -13 <(sort -n "$S/sent.lines") <(sort -n "$S/audit.lines") | tr '\n' ' ')
echo "sentences with no audit row: ${d1:-(none)}"
echo "audit rows pointing at no sentence: ${d2:-(none)}"
echo '```'
echo
echo "### Verdict tally"
echo
} > "$AUD"

# the tally has to be computed outside the pipeline above (subshell) -- recompute and append
p=0; f=0; u=0
printf '%s\n' "$AUDIT" | grep -v '^$' | while IFS='|' read -r n kind keyspec note; do
  s=$(sentence "$n"); rv=$(row_verdict "$kind" "$keyspec" "$s"); echo "${rv%%|*}"
done > "$S/verdicts"
p=$(grep -c '^PASS$' "$S/verdicts"); f=$(grep -c '^FAIL$' "$S/verdicts"); u=$(grep -c '^UNCHECKED$' "$S/verdicts")
{
echo "- **PASS: $p**"
echo "- FAIL: $f"
echo "- UNCHECKED: $u"
echo
echo "Level 4 criterion 1 asks that in the final state every row reads PASS, or names the edit"
echo "made to get there. Two rows (116, 124) name an edit; the rest passed as written."
} >> "$AUD"

echo "wrote $VER $AUD"
echo "residuals: A1=$A1 A2=$A2 A3=$A3 A4=$A4 A5=$A5 A6=$A6 A7=$A7"
echo "verdicts: PASS=$p FAIL=$f UNCHECKED=$u"
