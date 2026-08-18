# SQLite or DuckDB for a ~5 GB analytical workload on a laptop

You have roughly 5 GB of data on a laptop, analytical queries to run against it, and one
embedded database to choose.
This report answers that from primary sources only — the SQLite project's own documentation and
release history, DuckDB's peer-reviewed papers — and nothing here was benchmarked.
DuckDB claims name their paper and year on purpose: two of those three sources are from 2019
and 2020, and a 2019 design description is not a claim about software you install today.

## Does 5 GB fit?

SQLite keeps the entire database in one disk file, so the host filesystem's maximum file size
can bind before SQLite's own limits do [sqlite-whentouse].
The SQLite project's own checklist recommends SQLite for device-local storage with low writer
concurrency and less than a terabyte of content — a content-size bound far below which a 5 GB
dataset sits [sqlite-whentouse].
A 2025 PVLDB paper describes DuckDB storing query intermediates on pages, which lets the buffer
manager evict them to storage when they exceed the available memory limit
[duckdb-pvldb-hashjoin].
For memory-intensive join plans that paper's authors report that their implementation degrades
gracefully as the space requirement exceeds the memory limit — a statement about the shape of
the degradation, not about throughput [duckdb-pvldb-hashjoin].

## Query shape

DuckDB executes queries with a vectorized interpreted execution engine, chosen over JIT
compilation for portability [duckdb-sigmod19].
DuckDB's SIGMOD 2019 paper characterises SQLite as containing a row-major execution engine
operating on a B-tree storage format, and presents its analytical performance as a consequence
of that design [duckdb-sigmod19].
The same paper states that SQLite focuses on transactional workloads and that its performance
on analytical workloads is very poor [duckdb-sigmod19].
The SQLite project itself lists analysis of large datasets through the `sqlite3` command-line
shell as a situation where SQLite works well [sqlite-whentouse].

## Concurrent access, and where the file lives

SQLite supports an unlimited number of simultaneous readers but allows only one writer at any
instant [sqlite-whentouse].
In WAL mode readers do not block writers and a writer does not block readers, so reading and
writing proceed concurrently [sqlite-wal].
WAL mode does not lift the single-writer limit: because there is only one WAL file, there can
be only one writer at a time [sqlite-wal].
WAL mode also requires every process using the database to be on the same host computer; it
does not work over a network filesystem [sqlite-wal].
For DuckDB this dossier reaches only the concurrency-control model: the SIGMOD 2019 paper
implements a serializable variant of MVCC tailored specifically for hybrid OLAP/OLTP systems
[duckdb-sigmod19].
That is isolation inside the engine, not a count of processes that may hold the file.

## Getting the data in, and changing it afterwards

In SQLite, `.import` reads a delimited file into a table; if the target table does not exist it
is created and the first input row supplies the column names [sqlite-cli].
DuckDB's CIDR 2020 paper describes the database directly scanning existing files such as CSV,
reshaping the result, and appending it to a persistent table [duckdb-cidr20].
DuckDB's single-file storage format is designed, that same paper says, to support efficient
scans and bulk updates, appends and deletes [duckdb-cidr20].
Single-value and single-row updates are supported by that format, but the paper states their
efficiency is explicitly not a design goal [duckdb-cidr20].
On durability, SQLite's release history records a 2020 change (3.33.0) after which, in WAL mode,
transactions can recover an inconsistent shm file left by a crashed writer even while read
transactions are active [sqlite-changes].
DuckDB's SIGMOD 2019 paper claims ACID compliance through MVCC [duckdb-sigmod19].

## How long the file has to last

SQLite database files are bit-for-bit identical across 32-bit, 64-bit, big-endian and
little-endian platforms and can be copied between systems without translation or conversion
[sqlite-lts].
The project states that its file format is well documented and stable and that files created
today will be readable and writable by future versions decades from now, and its developers
state an intent to support SQLite through the year 2050 [sqlite-lts].
DuckDB ships numbered releases, and its authors describe it in that 2025 peer-reviewed paper as
no research prototype but a widely used and well-tested system, with the paper's techniques
available in the v1.2.0 release [duckdb-pvldb-hashjoin].
No source here states whether a DuckDB file written today opens in a later release.

## Recommendation

Four properties of your setup, none needing either system installed.

**1. Installed RAM against your working set.**
If 5 GB sits comfortably inside RAM, this decides nothing; go by 2–4.
If it does not — less RAM than the working set, or joins and sorts touching most rows — the only
sourced statement here about exceeding a memory limit is DuckDB's [duckdb-pvldb-hashjoin]:
**DuckDB**.

**2. The number of OS processes writing the file at once.**
If more than one, SQLite allows one writer at any instant and WAL mode does not change that
[sqlite-whentouse][sqlite-wal]; if it will live on a network share, WAL mode does not work there
[sqlite-wal].
The DuckDB side of both is unsourced here: unknown, not an answer.

**3. Single-row updates after the load, or bulk rebuilds.**
Count a week's write statements.
Single-row `UPDATE`s and `DELETE`s: their efficiency is an explicit non-goal of DuckDB's format
[duckdb-cidr20] — **SQLite**.
Bulk appends and periodic rebuilds: that format is designed for them [duckdb-cidr20].

**4. How long the file must stay readable, and on what hardware.**
For an archive, or a file copied to a machine of different word size or endianness, only
SQLite's side is sourced [sqlite-lts]: **SQLite**.
For a scratch file you rebuild anyway, this decides nothing.

**What DuckDB costs you:** single-row update efficiency is a stated non-goal [duckdb-cidr20],
and nothing here says whether today's file opens in a later release.

**Where the answer is both:** if the same 5 GB serves an application writing individual rows
*and* a dashboard scanning most rows, keep the durable copy in SQLite [sqlite-lts] and rebuild a
separate DuckDB file for the dashboard from the same CSV inputs [duckdb-cidr20] — derived data
you regenerate, so DuckDB's version-stability gap stops mattering.

## Limits of this comparison

No source here benchmarks the two systems against each other, and running them was forbidden, so
this report carries no speed figure, ratio or timing; the SIGMOD 2019 sentence on SQLite's
analytical performance is a qualitative characterisation by DuckDB's authors, not a measurement,
and the only SQLite-authored statement here is its own unquantified "works well" listing [sqlite-whentouse].
DuckDB's storage-format stability across versions is unsourced, so the contrast with SQLite's
format commitment is an asymmetry in the evidence, not a finding about DuckDB.
DuckDB's multi-process file access is unsourced too, which is why SQLite's single-writer
constraint is never stated here as a comparison.
Ingest coverage here is delimited text only — no accepted quote describes loading Parquet, Arrow
or JSON on either side — so a 5 GB Parquet dataset is outside what this covers.
No captured guidance is laptop-specific: no RAM size, core count or scratch-space figure appears
in any quote.
And most of the DuckDB evidence here is from 2019 and 2020, while the only release any of it
names is v1.2.0 [duckdb-pvldb-hashjoin].

## Sources

- **`duckdb-cidr20`** — "Data Management for Data Science — Towards Embedded Analytics".
  CIDR 2020, 10th Conference on Innovative Data Systems Research (PDF hosted by the DuckDB
  project, duckdb.org).
  <https://duckdb.org/pdf/CIDR2020-raasveldt-muehleisen-duckdb.pdf> — dated 2020-01-12,
  accessed 2026-08-17.
- **`duckdb-pvldb-hashjoin`** — "Saving Private Hash Join".
  VLDB Endowment — PVLDB Vol. 18, No. 8 (vldb.org).
  <https://www.vldb.org/pvldb/vol18/p2748-kuiper.pdf> — dated 2025, accessed 2026-08-17.
- **`duckdb-sigmod19`** — "DuckDB: an Embeddable Analytical Database".
  ACM — SIGMOD 2019 demonstration paper (PDF hosted by the DuckDB project, duckdb.org).
  <https://duckdb.org/pdf/SIGMOD2019-demo-duckdb.pdf> — dated 2019-06-30, accessed 2026-08-17.
- **`sqlite-changes`** — "Release History".
  SQLite project (sqlite.org).
  <https://www.sqlite.org/changes.html> — dated 2026-07-24, accessed 2026-08-17.
- **`sqlite-cli`** — "Command Line Shell For SQLite".
  SQLite project (sqlite.org).
  <https://www.sqlite.org/cli.html> — dated 2026-05-29, accessed 2026-08-17.
- **`sqlite-lts`** — "Long Term Support".
  SQLite project (sqlite.org).
  <https://www.sqlite.org/lts.html> — dated 2025-05-31, accessed 2026-08-17.
- **`sqlite-wal`** — "Write-Ahead Logging".
  SQLite project (sqlite.org).
  <https://www.sqlite.org/wal.html> — dated 2026-04-13, accessed 2026-08-17.
- **`sqlite-whentouse`** — "Appropriate Uses For SQLite".
  SQLite project (sqlite.org).
  <https://www.sqlite.org/whentouse.html> — dated 2025-05-31, accessed 2026-08-17.

Each key is the filename stem of `sources/<key>.md`; title, publisher, URL, `dated` and
`accessed` are copied from that entry's header.
`claims/claim-map.md` binds every sentence above to a quote, and
`evidence/level-3/claim-coverage.md` maps each one to its line in this file.
