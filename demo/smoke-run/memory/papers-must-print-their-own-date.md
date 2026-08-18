# Choose the copy of a paper that prints its own publication date

If a source entry's `dated` has to be locatable *in the capture*, the choice of which PDF copy
to fetch decides whether the source is usable at all. Author copies and camera-ready
preprints frequently carry **no date anywhere in the text**. Checked 2026-08-18:

| copy | date printed on page 1 | greppable string |
|---|---|---|
| ACM SIGMOD (`duckdb.org/pdf/SIGMOD2019-demo-duckdb.pdf`) | yes | `SIGMOD ’19, June 30-July 5, 2019, Amsterdam, Netherlands` |
| CIDR (`duckdb.org/pdf/CIDR2020-...pdf`) | yes | `(CIDR ‘20) January 12-15, 2020, Amsterdam, The Netherlands.` |
| PVLDB (`vldb.org/pvldb/volNN/pNNNN-author.pdf`) | year only | `PVLDB, 18(8): 2748-2760, 2025.` in the "PVLDB Reference Format" block |
| ICDE camera-ready hosted by the project | **no** — no `©20xx IEEE`, no conference header | — |

Practical rules:

- **Grep the extracted text for a date before committing to a source.** A single
  `grep -nE 'Conference|©|ISBN|PVLDB|20[0-9]{2}'` over the first ~120 lines settles it.
- Conference papers print a date **range**; record the first day as ISO `dated` and say so in
  `dated_locator`, quoting the printed form. Don't silently invent a single ISO date.
- PVLDB gives you a **year only**. A year is an honest `dated` value; say in the entry that the
  document prints year granularity, and note the HTTP `Last-Modified` as corroboration rather
  than as the source of the value.
- An unreachable host is not the only reason to pass on a copy: the ICDE 2024 out-of-core
  paper fetched fine (HTTP 200, 1.5 MB) and was still unusable, purely because it prints no
  date.

Conference sites can be down when you need them — `cidrdb.org` refused connections entirely.
Projects that host their own papers (`duckdb.org/pdf/`) and publisher archives (`vldb.org`)
were the reliable routes. See [[machine-network-blocks-observed]].
