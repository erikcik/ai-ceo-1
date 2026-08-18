# claims/dimensions.md — the axes this comparison runs on

The reader is one developer choosing **one** of SQLite or DuckDB for a **~5 GB analytical
workload on a laptop**. Every axis below was kept only because the answer on that axis can
change that decision, and only where the dossier in `sources/` holds a primary source on
**both** systems. Axes that are true of every database ("performance", "ease of use",
"maturity") are not here: they do not discriminate between these two systems for this reader,
and nothing in the dossier would let us say anything about them that a quote supports.

Each dimension states **what the reader can observe about their own setup** — without
installing or running either system — to know whether that dimension decides anything for
them. That is the test a dimension has to pass to be in this file.

Seven dimensions, D1–D7. Every claim row in `claims/claim-map.md` belongs to exactly one.

---

## D1 — Working-set size: 5 GB against RAM, and against each system's stated size limits

**Why it matters here.** 5 GB is the interesting size precisely because it straddles a
laptop: the base data will usually fit on disk without trouble and *may* fit in RAM, but a
join or a sort over most of it produces intermediates that can be several times the input.
The two systems fail differently when that happens, and only one of the two has a primary
source in this dossier describing what it does at the boundary.

**What the reader can observe.** (a) The machine's installed RAM against 5 GB — 8 GB, 16 GB
and 64 GB are three different situations. (b) Whether the ten queries they actually run
include a join or a sort over most rows, or only filters and aggregations that stream. (c)
Whether the dataset is a fixed 5 GB or grows monthly toward hundreds of GB — the SQLite
project's own guidance names a content-size boundary, so a reader who can state their
five-year size has already answered part of this.

**Sources behind it.** `duckdb-pvldb-hashjoin` (DuckDB side, 2025 — the only source here that
describes behaviour past the memory limit), `sqlite-whentouse` (SQLite side).

---

## D2 — Query shape: scans and aggregations over most rows, vs point lookups by key

**Why it matters here.** This is the axis the two systems were built on opposite sides of, and
it is the one where "analytical workload" stops being an adjective and becomes something
checkable. A query that reads three columns out of forty across every row is the case a
column-oriented, vectorized engine is designed for; a query that fetches one whole row by
primary key is the case a row-major B-tree is designed for. A 5 GB dataset queried the second
way is not the workload this comparison is about.

**What the reader can observe.** Take the ten queries that will run most often and, for each,
count (a) how many of the table's columns it names, and (b) roughly what fraction of rows it
touches. Few columns × most rows is the scan case; all columns × few rows is the lookup case.
If the same file must serve both — a dashboard that scans and an application that looks up
rows by id — the reader has found the case for keeping two files, not for picking one system.

**Sources behind it.** `duckdb-sigmod19` (both systems — DuckDB's own paper characterises
SQLite's engine as well as its own), `sqlite-whentouse` (SQLite's own position on data
analysis).

---

## D3 — Concurrent access: how many processes read and write at once, and where the file lives

**Why it matters here.** On a laptop this is usually a small number, which is exactly why it
is worth checking rather than assuming: a single analyst in a notebook is a very different
case from a loader process appending while a dashboard reads, and different again from a
database file on a mounted network volume. SQLite's documentation is unusually explicit about
its own limits here, which makes this the axis where the reader can most cheaply rule a system
in or out.

**What the reader can observe.** (a) The number of OS processes that will hold the file open
for **writing** at the same time — one, or more than one. (b) Whether reads must keep working
while a load is in progress. (c) Where the file will physically live: the laptop's own disk,
or a network share, an NFS mount, or a synced folder — a property of the path, observable
before any database exists.

**Sources behind it.** `sqlite-whentouse` and `sqlite-wal` (SQLite side, three quotes that
must be read together), `duckdb-sigmod19` (DuckDB side, its concurrency-control model).

---

## D4 — Ingest: how 5 GB of raw files becomes queryable, and whether a second copy is made

**Why it matters here.** At 5 GB the ingest step is not a detail; it is a decision about disk
and about how often the reader is willing to repeat it. The two systems differ in kind, not
degree: one documents a *load* that materialises a copy inside the database file, the other
describes *scanning the existing file* and appending the result only if you want it persisted.
On a laptop with limited free space, "does this double my footprint" is a real constraint, and
"is this a one-off or does it happen every morning" decides how much the difference costs.

**What the reader can observe.** (a) The format the 5 GB actually arrives in — CSV, TSV, some
other delimited text, or something else entirely. (b) Free disk space on the laptop against
5 GB, i.e. whether a second materialised copy fits at all. (c) How often the data is replaced
or extended: once, monthly, or every morning.

**Sources behind it.** `sqlite-cli` and `sqlite-whentouse` (SQLite side, the `.import`
mechanism), `duckdb-cidr20` (DuckDB side, direct scan of existing files).

---

## D5 — On-disk format and update granularity: what the file is optimised for after the load

**Why it matters here.** What happens *after* ingest is where a reader gets surprised. A
storage format tuned for scans and bulk operations is not the same artifact as one tuned for
changing one row, and one of the two projects says so about its own format in as many words —
a stated non-goal, which is a much stronger signal than a benchmark. A reader who will
correct individual records in place has a different answer on this axis than one who rebuilds
the table from source each month.

**What the reader can observe.** After the initial load, does the workflow (a) update or
delete individual rows — corrections, status flips, a mutable "processed" column — or (b) only
append batches and occasionally rebuild the whole table? Count the write statements the
application will issue in a week and check whether they are single-row `UPDATE`s or bulk
`INSERT`/`DELETE`s.

**Sources behind it.** `duckdb-cidr20` (DuckDB side, including its explicit non-goal),
`duckdb-sigmod19` (SQLite's storage layout, as characterised by DuckDB's own authors).

---

## D6 — Crash durability of writes that are in progress

**Why it matters here.** Laptops are the hardware most likely to lose power mid-write: lids
close, batteries die, processes get killed. The question is not whether either project claims
ACID — both do — but whether the reader's 5 GB is the *system of record* or a derived cache
that can be rebuilt from the source files in an hour. Those two readers should weigh this axis
completely differently, and neither should weigh it on vibes.

**What the reader can observe.** (a) Whether the original inputs still exist somewhere else,
so the database can be thrown away and rebuilt — if yes, this dimension is nearly free. (b)
Whether the process writing to the file can be killed abruptly (a notebook kernel restart, a
laptop suspend, a CI timeout) as part of normal use. (c) Whether anyone other than the author
would notice a partially-written table.

**Sources behind it.** `sqlite-wal` and `sqlite-changes` (SQLite side, including a logged
recovery fix), `duckdb-sigmod19` (DuckDB side).

**Honest note on this axis.** The dossier's evidence is asymmetric: the SQLite side rests on
project documentation plus a dated changelog entry, the DuckDB side on a single sentence in a
2019 paper. `claims/claim-map.md` therefore carries no row asserting that the two systems
*differ* here, and `claims/gaps.md` records the asymmetry.

---

## D7 — Longevity: how long the file stays readable, and how each project versions itself

**Why it matters here.** A 5 GB file represents hours of loading and possibly the only
surviving shape of some upstream data. Whether it opens in five years, on a different machine
of a different architecture, matters to some readers and is irrelevant to others — and it is
the axis on which the two projects have made publicly different amounts of commitment. It is
also where version drift bites: a reader who cannot pin a version needs to know what the
project promises about compatibility.

**What the reader can observe.** (a) How long the file has to stay readable: until the end of
the analysis, or for years as an archive. (b) Whether it will be copied between machines that
differ in word size or endianness, or shared with someone on other hardware. (c) Whether the
reader controls the installed version (a pinned dependency, a container) or will be upgraded
underneath them by a package manager.

**Sources behind it.** `sqlite-lts` and `sqlite-changes` (SQLite side — a format commitment, a
support horizon, and a published changelog), `duckdb-pvldb-hashjoin` (DuckDB side, numbered
releases and the authors' own characterisation of maturity).

**Honest note on this axis.** No primary source in this dossier states DuckDB's guarantees
about *storage-format* stability across versions. That is the single sharpest asymmetry in the
comparison and it is a gap in the evidence, not a finding about DuckDB. It is recorded in
`claims/gaps.md` and the claim intended to assert it is carried as a `DROPPED` row in
`claims/claim-map.md`. The report must not turn the absence of a capturable source into a
claim about the software.

---

## Axes considered and left out

- **"Performance" / "speed" as a bare axis.** Ruled out by `RUBRIC.md` and by the evidence:
  benchmarking is forbidden here and no primary source in the dossier measures either system
  on a ~5 GB laptop workload. Where speed enters at all it is as a *characterisation by a
  named paper* (D2) or as a *degradation shape* (D1), never as a figure. See
  `claims/gaps.md` §1.
- **Ecosystem, language bindings, tooling.** Real, but no capturable primary source in this
  dossier addresses either system's bindings, and it is not a property of the 5 GB workload.
- **Extensions and file formats beyond delimited text** (Parquet in particular). Left out for
  lack of a source, not because it does not matter — see `claims/gaps.md` §3.
- **Cost / licensing.** Both are permissively licensed open-source projects; nothing here
  discriminates for this reader.
