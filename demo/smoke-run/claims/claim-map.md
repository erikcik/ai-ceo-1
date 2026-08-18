# claims/claim-map.md — every claim `REPORT.md` may make, bound to a quote

One row per intended substantive claim. A claim not in this table may not appear in
`REPORT.md`; a claim in this table may only be stated as strongly as the fragment in its row
supports. `key#Qn` refers to `sources/<key>.md`, quote `Qn`; the fragment is a verbatim
substring of that quote, and `evidence/level-2/map-check.txt` shows, for each distinct
`key#Qn`, that the quote exists in the entry **and** that its text is present in the stored
capture `sources/raw/<key>.txt`.

**Reading the `system` column.** `sqlite` / `duckdb` names the system the claim is *about*,
not the source it comes from. Two rows (C6, C20) are claims about SQLite sourced from
DuckDB's own SIGMOD 2019 paper; they are written as *what that paper states*, and the report
must attribute them the same way. See `claims/gaps.md` §6.

**Totals** (mechanically recounted in `evidence/level-2/map-check.txt` §2): 29 rows with
status `OK`, resting on 24 distinct `key#Qn` pairs across 8 distinct keys, maximum 2 rows on
any one `Qn`. Every dimension D1–D7 carries ≥1 row, and every dimension carries ≥1 row per
system. Five further rows are carried below as `DROPPED` or `WEAKENED`; they are **not**
counted in the 29.

---

## D1 — Working-set size: 5 GB against RAM and stated size limits

| id | dimension | claim | system | key#Qn | verbatim fragment | status |
|---|---|---|---|---|---|---|
| C1 | D1 | DuckDB's buffer manager stores query intermediates on pages, which lets it evict them to storage when they exceed the available memory limit. | duckdb | `duckdb-pvldb-hashjoin#Q3` | Storing intermediates on pages allows the buffer manager to evict them to storage | OK |
| C2 | D1 | For memory-intensive join plans, the paper's authors report that their implementation degrades gracefully as the space requirement passes the memory limit — a statement about the shape of the degradation, not about throughput. | duckdb | `duckdb-pvldb-hashjoin#Q1` | gracefully degrades performance as the space requirement exceeds the memory limit | OK |
| C3 | D1 | SQLite keeps the entire database in one disk file, so the host filesystem's maximum file size can bind before SQLite's own limits do. | sqlite | `sqlite-whentouse#Q2` | SQLite stores the entire database in a single disk file | OK |
| C4 | D1 | The SQLite project's own checklist recommends SQLite for device-local storage with low writer concurrency and less than a terabyte of content — a content-size bound far below which a 5 GB dataset sits. | sqlite | `sqlite-whentouse#Q4` | with low writer concurrency and less than a terabyte of content | OK |

## D2 — Query shape: scans and aggregations vs point lookups

| id | dimension | claim | system | key#Qn | verbatim fragment | status |
|---|---|---|---|---|---|---|
| C5 | D2 | DuckDB executes queries with a vectorized interpreted engine, chosen over JIT compilation for portability. | duckdb | `duckdb-sigmod19#Q2` | DuckDB uses a vectorized interpreted execution engine | OK |
| C6 | D2 | DuckDB's SIGMOD 2019 paper states that SQLite focuses on transactional workloads and that its performance on analytical workloads is very poor. | sqlite | `duckdb-sigmod19#Q1` | performance on analytical (OLAP) workloads is very poor | OK |
| C7 | D2 | The SQLite project itself lists analysis of large datasets through the `sqlite3` command-line shell as a situation where SQLite works well. | sqlite | `sqlite-whentouse#Q3` | employ the sqlite3 command-line shell | OK |

## D3 — Concurrent access and where the file lives

| id | dimension | claim | system | key#Qn | verbatim fragment | status |
|---|---|---|---|---|---|---|
| C8 | D3 | SQLite supports an unlimited number of simultaneous readers but allows only one writer at any instant. | sqlite | `sqlite-whentouse#Q1` | will only allow one writer at any instant in time | OK |
| C9 | D3 | In WAL mode readers do not block writers and a writer does not block readers, so reading and writing proceed concurrently. | sqlite | `sqlite-wal#Q1` | readers do not block writers and a writer does not block readers | OK |
| C10 | D3 | WAL mode does not lift the single-writer limit: because there is only one WAL file, there can be only one writer at a time. | sqlite | `sqlite-wal#Q2` | there can only be one writer at a time | OK |
| C11 | D3 | WAL mode requires every process using the database to be on the same host computer; it does not work over a network filesystem. | sqlite | `sqlite-wal#Q3` | WAL does not work over a network filesystem | OK |
| C12 | D3 | DuckDB's concurrency control is MVCC — the paper implements HyPer's serializable variant, tailored for hybrid OLAP/OLTP systems. | duckdb | `duckdb-sigmod19#Q3` | serializable variant of MVCC that is tailored specifically for hybrid OLAP/OLTP systems | OK |

## D4 — Ingest and whether a second copy is made

| id | dimension | claim | system | key#Qn | verbatim fragment | status |
|---|---|---|---|---|---|---|
| C13 | D4 | DuckDB's CIDR 2020 paper describes the database directly scanning existing files such as CSV, reshaping the result, and appending it to a persistent table. | duckdb | `duckdb-cidr20#Q1` | the database can directly scan existing files (e.g. CSV), reshape the result and then append it | OK |
| C14 | D4 | In SQLite, `.import` reads a delimited file into a table; if the target table does not exist it is created and the first input row supplies the column names. | sqlite | `sqlite-cli#Q1` | the table is automatically created and the content of the first input row is used | OK |
| C15 | D4 | In the SQLite shell, `--csv` and `--ascii` control the import delimiters; otherwise the delimiters are those in effect for the current output mode. | sqlite | `sqlite-cli#Q2` | the delimiters are those in effect for the current output mode | OK |
| C16 | D4 | SQLite's own documentation describes the CSV path as importing raw data and then slicing it to generate summary reports. | sqlite | `sqlite-whentouse#Q3` | Raw data can be imported from CSV files | OK |

## D5 — On-disk format and update granularity

| id | dimension | claim | system | key#Qn | verbatim fragment | status |
|---|---|---|---|---|---|---|
| C17 | D5 | DuckDB's single-file storage format is designed to support efficient scans and bulk updates, appends and deletes. | duckdb | `duckdb-cidr20#Q2` | designed to support efficient scans and bulk updates, appends and deletes | OK |
| C18 | D5 | Single-value and single-row updates are supported by that format, but the paper states their efficiency is explicitly not a design goal. | duckdb | `duckdb-cidr20#Q2` | single-row updates are supported, their efficiency is not a design goal | OK |
| C19 | D5 | DuckDB's decision to keep the database in a single file was inspired by SQLite and by repeated user requests. | duckdb | `duckdb-cidr20#Q3` | only consists of a single file was inspired by SQLite | OK |
| C20 | D5 | DuckDB's SIGMOD 2019 paper characterises SQLite as containing a row-major execution engine operating on a B-tree storage format, and presents SQLite's analytical performance as a consequence of that design. | sqlite | `duckdb-sigmod19#Q1` | contains a row-major execution engine operating on a B-Tree storage format | OK |

## D6 — Crash durability of writes in progress

| id | dimension | claim | system | key#Qn | verbatim fragment | status |
|---|---|---|---|---|---|---|
| C21 | D6 | In WAL mode SQLite writers append new content to the end of the WAL file rather than overwriting pages in place. | sqlite | `sqlite-wal#Q2` | Writers merely append new content to the end of the WAL file | OK |
| C22 | D6 | SQLite's release history records a 2020 change (3.33.0) after which transactions can recover an inconsistent shm file left by a crashed writer even while read transactions are active. | sqlite | `sqlite-changes#Q2` | subsequent transactions are now able to recover the shm file even if there are active read transactions | OK |
| C23 | D6 | DuckDB's SIGMOD 2019 paper claims ACID compliance for the system. | duckdb | `duckdb-sigmod19#Q3` | provides ACID-compliance through Multi-Version Concurrency Control (MVCC) | OK |

## D7 — Longevity of the file and of the project

| id | dimension | claim | system | key#Qn | verbatim fragment | status |
|---|---|---|---|---|---|---|
| C24 | D7 | SQLite database files are bit-for-bit identical across 32-bit, 64-bit, big-endian and little-endian platforms and can be copied between systems without translation or conversion. | sqlite | `sqlite-lts#Q1` | bit-for-bit identical on 32-bit, 64-bit, big-endian, and little-endian platforms | OK |
| C25 | D7 | The SQLite project states that its file format is well documented and stable and that files created today will be readable and writable by future versions decades from now. | sqlite | `sqlite-lts#Q2` | readable and writable by future versions of SQLite decades in the future | OK |
| C26 | D7 | The SQLite developers state an intent to support SQLite through the year 2050. | sqlite | `sqlite-lts#Q3` | support SQLite through the year 2050 | OK |
| C27 | D7 | SQLite publishes a page giving a high-level summary of changes to SQLite, and points to its Fossil check-in logs for more detail. | sqlite | `sqlite-changes#Q1` | This page provides a high-level summary of changes to SQLite | OK |
| C28 | D7 | That changelog shows the project describing a 2022 interface change as one that should be fully backwards compatible, though it might cause harmless compiler warnings when rebuilding some legacy applications. | sqlite | `sqlite-changes#Q3` | This interface change should be fully backwards compatible | OK |
| C29 | D7 | DuckDB ships numbered releases and its authors describe it, in a 2025 peer-reviewed paper, as no research prototype but a widely used and well-tested system, with that paper's techniques available in the v1.2.0 release. | duckdb | `duckdb-pvldb-hashjoin#Q2` | All three are available in the v1.2.0 release | OK |

---

## Weakened and dropped claims

These are claims that were intended for the report and did not survive contact with the
dossier. They are kept here, not deleted, because the record of what was cut is the only thing
that distinguishes restraint from never having thought of it. Each has a matching entry in
`claims/gaps.md`. **None of the five is counted toward the 29 rows above, and none may appear
in `REPORT.md` in its original form.**

| id | dimension | claim as originally intended | system | key#Qn | what the quote actually says | status |
|---|---|---|---|---|---|---|
| W1 | D4 | "DuckDB reads Parquet files directly, so a 5 GB Parquet dataset needs no load step." | duckdb | — | **No quote supports this.** The string "Parquet" occurs **zero** times in `sources/raw/duckdb-cidr20.txt`, `duckdb-sigmod19.txt` and all five SQLite captures, and exactly **once** in `sources/raw/duckdb-pvldb-hashjoin.txt` — in a future-work sentence about "join plans including Parquet files", which describes a query-optimisation difficulty, not an ingest capability. Counts shown in `evidence/level-2/map-check.txt` §5. | DROPPED |
| W2 | D7 | "DuckDB's on-disk format is stable across versions, so a file written today will open in a later release." | duckdb | — | **No quote supports this.** `duckdb-cidr20#Q2` supports the existence of a single-file format and what it is optimised for; it says nothing about compatibility across versions, and it is a January 2020 paper, four years before the 1.0.0 release. No capturable primary source for this was found — see `sources/CAPTURE_LOG.md` §4. | DROPPED |
| W3 | D2 | "DuckDB is substantially faster than SQLite on analytical queries over a 5 GB dataset." | both | `duckdb-sigmod19#Q1` | The quote is a 2019 qualitative characterisation written by DuckDB's own authors ("very poor"), with no measurement of this workload, this data size, or this hardware anywhere in the capture. Weakened to **C6**, which asserts only *what that paper states*, with the paper named in the sentence. No speed figure, ratio or timing appears anywhere in this map. | WEAKENED |
| W4 | D1 | "DuckDB handles datasets larger than memory." | duckdb | `duckdb-pvldb-hashjoin#Q1`, `#Q3` | Both quotes are about **query intermediates** — pages in the buffer manager, and memory-intensive **join** plans — not about arbitrary workloads of arbitrary size. Weakened to **C1** and **C2**, which keep the restriction to intermediates and to the degradation shape the authors claim. | WEAKENED |
| W5 | D1 | "SQLite's practical size limit is *N* GB." | sqlite | `sqlite-whentouse#Q2` | The captured span states that the database is one file and that filesystems impose their own maximum, but the passage quoted carries **no number**. Weakened to **C3** (the mechanism) plus **C4** (the project's own stated boundary, which is a terabyte of content, not a limit on the database). | WEAKENED |

---

## Rows tightened on re-read

Not cuts — surviving rows whose wording had drifted a little past the quote under it, caught
by reading each quote against its row again rather than trusting the first pass. Recorded
because "the fragment is in the quote" (§6 of the transcript) cannot catch this class of
defect; only reading can.

| id | what the row used to say | why it was narrowed |
|---|---|---|
| C4 | first pass: "…which places a 5 GB dataset well inside it."; second pass: "…— a content-size bound that 5 GB is three orders of magnitude inside." | Narrowed twice. **First:** the quote's boundary has three parts — device-local storage, low writer concurrency, under a terabyte of content. Only the third is something 5 GB can be "inside", so the row says *content-size bound* and leaves the concurrency part to D3, where it is separately sourced. **Second (this pass):** "three orders of magnitude" was a figure derived by the builder, absent from `sqlite-whentouse#Q4`, and arithmetically wrong — 1 TB / 5 GB ≈ 200×, about 2.3 orders of magnitude. The row now states the relation ("far below which a 5 GB dataset sits") with no number of its own. The `key#Qn` and verbatim fragment are unchanged. |
| C13 | "…and appending it to a persistent table only if persistence is wanted." | `duckdb-cidr20#Q1` says the database "can directly scan existing files (e.g. CSV), reshape the result and then append it to a persistent table" — it states no optionality, and the surrounding context (`sources/raw/duckdb-cidr20.txt` lines 137–145) argues that embedded analytics is *desirable*, not that persistence is optional. The clause was the builder's inference; it is gone and the row now tracks the quote. |
| C20 | "…— the layout that makes single-row work natural and wide scans expensive." | The em-dash gloss was the builder's explanation, not the paper's words: `duckdb-sigmod19#Q1` states the row-major/B-Tree design and then draws one consequence (analytical performance). "Makes single-row work natural" appears nowhere in the capture, so it is gone. |
| C28 | "…as fully backwards compatible, at worst producing harmless compiler warnings…" | The quote hedges twice — "should be fully backwards compatible", "might cause (harmless) compiler warnings" — and "at worst" converted a possibility into a bound. The row now carries both hedges and the year. |

---

## Checks this table is built to satisfy

- **Level 2, criterion 4** — every `key` exists in `sources/` and every `Qn` exists in that
  entry: `evidence/level-2/map-check.txt` §1, one pair of commands per distinct `key#Qn`.
- **Level 2, criterion 6** — no row cites a document in `claims/excluded-sources.md`: none of
  the four excluded keys (`excluded-why-duckdb`, `excluded-posthog-vs`,
  `excluded-betterstack-vs`, `excluded-lukasbarth-bench`) appears in this file; checked
  mechanically in `evidence/level-2/map-check.txt` §4.
- **Level 2, criterion 7** — every `sources/<key>.md` entry is cited by ≥1 row: all 8 keys are
  cited, so `sources/unused/` is not needed and does not exist; checked in
  `evidence/level-2/map-check.txt` §3.
