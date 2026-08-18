```yaml
key: sqlite-cli
subject: sqlite
title: "Command Line Shell For SQLite"
publisher: "SQLite project (sqlite.org)"
source_type: docs
url: https://www.sqlite.org/cli.html
dated: 2026-05-29
dated_locator: "final line of the capture: 'This page was last updated on 2026-05-29 15:17:09Z'"
accessed: 2026-08-17
capture_file: sources/raw/sqlite-cli.txt
sha256: e2d18f7a44989e4701db7f1bd6efb9d44246461b39c592344bef645038987aa6
```

**Why this source matters.** The ingest axis on the SQLite side. It documents the mechanism
by which raw files become queryable in SQLite: `.import` reads a delimited file *into a
table*, i.e. ingest is a load step that materialises a copy, and the column names come from
the file's first row only when the table does not already exist. That is the concrete
contrast with `duckdb-cidr20#Q1`, where files are scanned directly.

**Versioning.** The page documents the shell shipped with current SQLite; option spellings
(`--csv`, `--skip`) are those of recent releases. The quotes describe behaviour, not a
version number.

### Q1 — §"7.5. Importing files as CSV or other formats"
> When .import is run, its treatment of the first input row depends upon whether the target table already exists. If it does not exist, the table is automatically created and the content of the first input row is used to set the name of all the columns in the table.

### Q2 — §"7.5. Importing files as CSV or other formats"
> If the --csv or --ascii options are used, they control import input delimiters. Otherwise, the delimiters are those in effect for the current output mode.
