```yaml
key: duckdb-sigmod19
subject: duckdb
title: "DuckDB: an Embeddable Analytical Database"
publisher: "ACM — SIGMOD 2019 demonstration paper (PDF hosted by the DuckDB project, duckdb.org)"
source_type: paper
url: https://duckdb.org/pdf/SIGMOD2019-demo-duckdb.pdf
dated: 2019-06-30
dated_locator: "conference header line on page 1 of the capture: 'SIGMOD ’19, June 30-July 5, 2019, Amsterdam, Netherlands' (first day of the conference recorded as `dated`)"
accessed: 2026-08-17
capture_file: sources/raw/duckdb-sigmod19.txt
sha256: 1fd8fdcf36e85b2f69808b5adc1beeb7e031b800a0e04926ec9e298efede0917
```

**Why this source matters.** DuckDB's own published paper, and the only source in the dossier
in which the two systems are compared by the same authors in a peer-reviewed venue. Q1 is
DuckDB's stated reason for existing — SQLite's row-major B-tree engine — which is the
architectural claim the whole comparison turns on. Q2 and Q3 give the execution model and the
transaction/concurrency model.

**Primacy note.** The PDF is hosted by the DuckDB project itself, but the document is the
peer-reviewed SIGMOD 2019 demonstration paper (ACM ISBN 978-1-4503-5643-5/19/06,
doi 10.1145/3299869.3320212, both on page 1 of the capture), not a project web page.

**Versioning — important.** This paper describes DuckDB as of 2019, years before the 1.0.0
release. Statements of architecture (vectorized engine, MVCC) have held; anything about
limits, performance or feature coverage must not be carried forward from it. Where a current
figure is needed, `duckdb-pvldb-hashjoin` (2025) is the fresher source.

### Q1 — §1 "Introduction", page 1
> SQLite strongly focuses on transactional (OLTP) workloads, and contains a row-major execution engine operating on a B-Tree storage format [3]. As a consequence, SQLite’s performance on analytical (OLAP) workloads is very poor.

### Q2 — §"DESIGN AND IMPLEMENTATION" (execution engine paragraph), page 3
> DuckDB uses a vectorized interpreted execution engine [1]. This approach was chosen over Just-in-Time compilation (JIT) of SQL queries [8] for portability reasons.

### Q3 — §"DESIGN AND IMPLEMENTATION" (transaction manager paragraph), page 3
> DuckDB provides ACID-compliance through Multi-Version Concurrency Control (MVCC). We implement HyPer’s serializable variant of MVCC that is tailored specifically for hybrid OLAP/OLTP systems [10].
