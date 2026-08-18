# claims/gaps.md — what the primary sources do not answer

Questions this reader — one developer, ~5 GB, analytical queries, a laptop — would reasonably
want answered, and which **no source in `sources/` answers**. `REPORT.md` will not assert any
of them. Each gap that corresponds to a cut claim names the `claims/claim-map.md` row that was
`DROPPED` or `WEAKENED` because of it.

The distinction that matters throughout: these are gaps in *the evidence available under this
task's constraints*, not findings about the software. "No primary source in this dossier says
X" is not the same statement as "X is false", and the report must not let the two blur.

---

## 1. There is no head-to-head benchmark of the two systems on this workload

**The question.** On a ~5 GB dataset on a laptop, how much faster is one than the other on the
queries this reader will actually run?

**Why it is unanswerable here.** No source in the dossier measures both systems on comparable
hardware, and the task forbids running either system on this machine, so no measurement can be
produced. The closest thing in the dossier is `duckdb-sigmod19#Q1`, a 2019 qualitative
sentence by DuckDB's own authors; it names no dataset, no hardware and no figure. The DuckDB
papers' own experiments (`duckdb-pvldb-hashjoin`) are on the authors' hardware and query set,
and SQLite is not evaluated in that paper at all — the string "SQLite" does not occur in the
capture.

**Consequence.** `claims/claim-map.md` row **W3** is `WEAKENED` to C6. No speed figure, ratio,
or timing appears in the claim map, and none may appear in the report. A reader who needs this
number has to measure it on their own data; that is the honest answer and the report will give
it.

---

## 2. DuckDB's storage-format stability across versions is unsourced here

**The question.** If a 5 GB DuckDB file is written today, will a later DuckDB release open it?

**Why it is unanswerable here.** `duckdb-cidr20#Q2` establishes that DuckDB uses a single-file
storage format and what it is optimised for, but says nothing about cross-version
compatibility, and it is a January 2020 paper — four years before the 1.0.0 release. The
project *does* publish material on this, but not in a form this task's evidence rules can
capture: `duckdb.org` HTML pages return no `Content-Length`, `Last-Modified` or `ETag` header
and carry no date in the page body (`sources/CAPTURE_LOG.md` §3e), and the GitHub API's
release notes for v1.0.0 and v1.2.0 contain no prose on the subject (§4).

**Consequence.** `claims/claim-map.md` row **W2** is `DROPPED`. The report may state SQLite's
format commitment (C24–C26, which are sourced) but must not draw the contrast as though the
DuckDB side had been checked and found wanting. What is true is narrower and must be said that
way: *this comparison could not source a DuckDB equivalent.*

---

## 3. Ingest formats other than delimited text — Parquet in particular — are uncovered

**The question.** If the 5 GB arrives as Parquet, or Arrow, or JSON, does the ingest picture in
D4 still hold?

**Why it is unanswerable here.** The word "Parquet" occurs zero times in seven of the eight
captures and once in the eighth, inside a future-work sentence about join plans over Parquet
files — a remark about optimiser statistics, not a statement of ingest capability. The
SQLite-side quotes (`sqlite-cli#Q1`, `#Q2`) are explicitly about delimited text. Nothing in
the dossier speaks to any other format on either side.

**Consequence.** `claims/claim-map.md` row **W1** is `DROPPED`. D4 in `claims/dimensions.md`
is scoped to delimited text and says so, and the reader-observable it names is "what format
does the data actually arrive in" — a reader whose answer is "Parquet" is told, in the report's
limits passage, that this comparison does not cover their case.

---

## 4. DuckDB's multi-process concurrency semantics are uncovered

**The question.** Can two processes on the laptop open the same DuckDB file at once — one
loading, one querying — the way `sqlite-wal#Q1` describes for SQLite?

**Why it is unanswerable here.** `duckdb-sigmod19#Q3` describes DuckDB's *concurrency-control
model* (MVCC, HyPer's serializable variant), which is a statement about transaction isolation
inside the system, not about how many OS processes may hold the database file. No source in
the dossier addresses multi-process access to a DuckDB file, nor whether the file may live on
a network filesystem — the question `sqlite-wal#Q3` answers for SQLite.

**Consequence.** D3 in `claims/dimensions.md` carries C12 for DuckDB, phrased as a claim about
the concurrency-control model and nothing more. The report must not present the SQLite
single-writer constraint as a *contrast* with DuckDB, because the DuckDB side of that
comparison is unsourced. This asymmetry is the one most likely to be read into the report by a
reader who wants a winner, so the limits passage names it explicitly.

---

## 5. Neither project's sizing guidance is specific to a laptop

**The question.** On 8 GB of RAM versus 64 GB, what actually changes for a 5 GB dataset — how
much memory should be given to the engine, how many threads, how much scratch disk?

**Why it is unanswerable here.** `sqlite-whentouse#Q4` gives a content-size boundary (under a
terabyte, device-local) and no memory guidance at all. `duckdb-pvldb-hashjoin#Q3` refers to
"the available memory limit" as a configured quantity but the capture states no default, no
recommended value, and nothing about laptop-class hardware. No quote in the dossier mentions
RAM sizes, core counts, or scratch-space requirements.

**Consequence.** D1 in `claims/dimensions.md` asks the reader to observe their own RAM against
their own working set; it does not tell them what the answer should be, because no source
here does. Row **W5** is `WEAKENED` for the related reason that the captured SQLite passage
carries no number.

---

## 6. Version drift: most of the DuckDB evidence predates the versions a reader will install

**The question.** Do statements taken from DuckDB's 2019 and 2020 papers still describe the
DuckDB a reader installs today?

**Why it is unanswerable here.** Two of the three DuckDB entries are `duckdb-sigmod19` (2019)
and `duckdb-cidr20` (2020), both years before 1.0.0. Only `duckdb-pvldb-hashjoin#Q2` pins
anything to a named release (v1.2.0, 2025). The reason the dossier leans on papers rather than
current documentation is a capture constraint, not a preference: no `duckdb.org` HTML page
satisfies this task's provenance requirements (`sources/CAPTURE_LOG.md` §3e), and the
project's GitHub release notes carry no prose (§4). The SQLite side does not have this problem
— every `sqlite.org` entry carries a page-level "last updated" date from 2025 or 2026, and
`sqlite-changes` is dated 2026-07-24.

**Consequence.** Every DuckDB row in `claims/claim-map.md` is phrased as *what the cited paper
states* and names the paper or its year, rather than asserting current behaviour. The report
must preserve that attribution; dropping it would turn a 2019 design description into a
present-tense claim about software the reader is about to install. This is the most likely
route by which an over-confident sentence enters the report, and it is deliberately made
awkward to write.

---

## 7. SQLite's own documentation makes no analytical-performance claim

**The question.** What does the SQLite project itself say about how SQLite performs on
analytical scans?

**Why it is unanswerable here.** `sqlite-whentouse#Q3` says people *do* use the shell to
analyse large datasets; it makes no claim about how fast that is. The only characterisation of
SQLite's analytical performance anywhere in the dossier comes from DuckDB's paper
(`duckdb-sigmod19#Q1`) — a competitor's peer-reviewed statement, which is a real source but
not a neutral one.

**Consequence.** C6 and C20 are written as claims about *what DuckDB's paper states*, with the
paper named in the sentence, and the report will attribute them the same way rather than
presenting them as settled fact. There is no SQLite-authored counter-statement in the dossier
to weigh against them, and the limits passage will say so.
