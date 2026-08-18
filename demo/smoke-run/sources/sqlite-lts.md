```yaml
key: sqlite-lts
subject: sqlite
title: "Long Term Support"
publisher: "SQLite project (sqlite.org)"
source_type: docs
url: https://www.sqlite.org/lts.html
dated: 2025-05-31
dated_locator: "final line of the capture: 'This page was last updated on 2025-05-31 13:08:22Z'"
accessed: 2026-08-17
capture_file: sources/raw/sqlite-lts.txt
sha256: 11472f71ffff6dca36dc6fb10708f914e43a1b6417d24fc239788ce2ffdb9e2a
```

**Why this source matters.** The file-format/durability axis. For a reader deciding what to
store a 5 GB dataset *in*, the question is not only how fast it reads back but whether the
file will still open in five years and on another machine. This is the project's own
commitment on both points. It is a statement of intent by the developers, not a measurement,
and claims built on it must stay at that strength.

**Versioning.** Not versioned; it is a project-level commitment page.

### Q1 — §"Stable, Cross-platform Database Files"
> SQLite database files are bit-for-bit identical on 32-bit, 64-bit, big-endian, and little-endian platforms. You can copy an SQLite database file from one system to another without having to translate or convert the database.

### Q2 — §"Stable, Cross-platform Database Files"
> Furthermore, the file format is well documented and stable. Database files created today will be readable and writable by future versions of SQLite decades in the future.

### Q3 — opening paragraph, under heading "Long Term Support"
> The intent of the developers is to support SQLite through the year 2050.
