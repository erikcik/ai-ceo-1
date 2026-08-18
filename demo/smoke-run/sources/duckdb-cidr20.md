```yaml
key: duckdb-cidr20
subject: duckdb
title: "Data Management for Data Science — Towards Embedded Analytics"
publisher: "CIDR 2020, 10th Conference on Innovative Data Systems Research (PDF hosted by the DuckDB project, duckdb.org)"
source_type: paper
url: https://duckdb.org/pdf/CIDR2020-raasveldt-muehleisen-duckdb.pdf
dated: 2020-01-12
dated_locator: "licence/venue block on page 1 of the capture: '10th Conference on Innovative Data Systems Research (CIDR ‘20) January 12-15, 2020, Amsterdam, The Netherlands.' (first day of the conference recorded as `dated`)"
accessed: 2026-08-17
capture_file: sources/raw/duckdb-cidr20.txt
sha256: b48ccc47b42900033ddb857ae26a9b810261f8724d85a92817881b51e894c994
```

**Why this source matters.** Covers two axes the SIGMOD paper does not: ingest and storage
format. Q1 is the ingest model — files such as CSV are scanned directly by the database and
the result appended, rather than loaded first — which is the direct counterpart to
`sqlite-cli#Q1`. Q2 states the single-file storage design *and its stated non-goal*
(single-row update efficiency), which is the sharpest calibrated tradeoff in the dossier. Q3
records that the single-file design was taken from SQLite.

**Primacy note.** Hosted by the DuckDB project, but the document is the CIDR 2020 conference
paper; the venue and licence block are on page 1 of the capture.

**Versioning — important.** 2020, pre-1.0. Design intent quoted here should be attributed to
the paper ("DuckDB's design ...", "the paper states ..."), not asserted as current behaviour
of an installed 1.x build.

### Q1 — §"INTRODUCTION" (ETL/embedded analytics argument), page 2
> Feasible because the database can directly scan existing files (e.g. CSV), reshape the result and then append it to a persistent table.

### Q2 — §"THE DUCKDB SYSTEM", storage subsection, page 4
> DuckDB uses a single-file storage format to store data on disk. The file format is designed to support efficient scans and bulk updates, appends and deletes. While single-value or single-row updates are supported, their efficiency is not a design goal.

### Q3 — §"THE DUCKDB SYSTEM", storage subsection, page 4
> The fact that the database only consists of a single file was inspired by SQLite [3] and repeated user requests for this feature in MonetDBLite.
