```yaml
key: duckdb-pvldb-hashjoin
subject: duckdb
title: "Saving Private Hash Join"
publisher: "VLDB Endowment — PVLDB Vol. 18, No. 8 (vldb.org)"
source_type: paper
url: https://www.vldb.org/pvldb/vol18/p2748-kuiper.pdf
dated: 2025
dated_locator: "PVLDB Reference Format block on page 1 of the capture: 'Private Hash Join. PVLDB, 18(8): 2748-2760, 2025.' — the document prints its publication date at year granularity only, so `dated` is a year; the response header `Last-Modified: Mon, 28 Jul 2025 04:42:29 GMT` in sources/raw/duckdb-pvldb-hashjoin.headers.txt corroborates it"
accessed: 2026-08-17
capture_file: sources/raw/duckdb-pvldb-hashjoin.txt
sha256: 8edaeacdb0bfc142995e45a20ba7e6fc232ac3b436f62830a72bc6a954fc4ceb
```

**Why this source matters.** The larger-than-memory axis, and the most recent primary source
in the dossier. It is the only source here that says what DuckDB does when a workload does
not fit in RAM: intermediates live on pages in a single buffer pool and are evicted to storage
when the memory limit is exceeded (Q3), and the authors' claim for the result is *graceful
degradation*, not speed (Q1). Q2 pins the work to a named release, which is what lets a claim
built on this paper be stated as version-dependent rather than timeless.

**Primacy note.** Peer-reviewed PVLDB paper, hosted by vldb.org; three of the four authors are
DuckDB maintainers at CWI. It is a paper about DuckDB, so it is primary for DuckDB's design
and for what its authors claim, not for a head-to-head result against SQLite (SQLite is not
evaluated in it — the string "SQLite" does not occur in the capture).

**Calibration warning for later levels.** Q1 is a claim about *degradation shape*. It is not
a throughput figure and must not become one. The paper's own experiments are on its own
hardware and query set, not on a 5 GB laptop workload.

### Q1 — Abstract, page 1
> We integrate these techniques into DuckDB and experimentally show that when processing memory-intensive join query plans, our implementation gracefully degrades performance as the space requirement exceeds the memory limit.

### Q2 — §1 "Introduction", contributions, page 2
> All three are available in the v1.2.0 release. DuckDB is no research prototype but a widely used and well-tested system.

### Q3 — §3 "MANAGING TEMPORARY DATA", paragraph "Unified Memory Management", page 3
> DuckDB’s buffer manager not only uses paged allocations for persistent data but also for temporary data. Storing intermediates on pages allows the buffer manager to evict them to storage if intermediates exceed the available memory limit.
