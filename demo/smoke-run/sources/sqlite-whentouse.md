```yaml
key: sqlite-whentouse
subject: sqlite
title: "Appropriate Uses For SQLite"
publisher: "SQLite project (sqlite.org)"
source_type: docs
url: https://www.sqlite.org/whentouse.html
dated: 2025-05-31
dated_locator: "final line of the capture: 'This page was last updated on 2025-05-31 13:08:22Z'"
accessed: 2026-08-17
capture_file: sources/raw/sqlite-whentouse.txt
sha256: d81424b957a9a05c6b457d6c76233734d356f7b0f96a49c619aa650dc400d63b
```

**Why this source matters.** This is the SQLite project's own statement of where SQLite fits
and where it does not. It is the primary source for three of the four scenario axes on the
SQLite side: write concurrency, database-size limits, and CSV-driven data analysis. Its
closing checklist is written as observable conditions on the reader's own setup, which is the
shape the level-3 recommendation needs.

**Versioning.** The page is not versioned; it describes SQLite as a project rather than a
release. The `dated` value is the page's own "last updated" footer, not a release date.

### Q1 — §"2. Situations Where A Client/Server RDBMS May Work Better" → "High Concurrency"
> SQLite supports an unlimited number of simultaneous readers, but it will only allow one writer at any instant in time.

### Q2 — §"2. Situations Where A Client/Server RDBMS May Work Better" → "Very large datasets"
> And even if it could handle larger databases, SQLite stores the entire database in a single disk file and many filesystems limit the maximum size of files to something less than this.

### Q3 — §"1. Situations Where SQLite Works Well" → "Data analysis"
> People who understand SQL can employ the sqlite3 command-line shell (or various third-party SQLite access programs) to analyze large datasets. Raw data can be imported from CSV files, then that data can be sliced and diced to generate a myriad of summary reports.

### Q4 — §"3. Checklist For Choosing The Right Database Engine", item 4 ("Otherwise → choose SQLite!")
> For device-local storage with low writer concurrency and less than a terabyte of content, SQLite is almost always a better solution.
