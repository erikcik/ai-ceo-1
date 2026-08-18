```yaml
key: sqlite-wal
subject: sqlite
title: "Write-Ahead Logging"
publisher: "SQLite project (sqlite.org)"
source_type: docs
url: https://www.sqlite.org/wal.html
dated: 2026-04-13
dated_locator: "final line of the capture: 'This page was last updated on 2026-04-13 10:54:51Z'"
accessed: 2026-08-17
capture_file: sources/raw/sqlite-wal.txt
sha256: 344d748072ca5e4df3e46656944b116c1de75d99a507e44f5573b953f59e9980
```

**Why this source matters.** WAL mode is the concurrency setting an analytics user on a
laptop will actually be running under, and this page is the project's own description of what
it does and does not buy. Q1 and Q2 are the two halves that must be stated together —
readers and a writer proceed concurrently, but there is still exactly one writer — and Q3 is
the constraint that matters if the database file sits on a network share rather than the
laptop's own disk.

**Versioning.** Version-sensitive: the page records behaviour changes by release (for example
the read-only-WAL change in 3.22.0). The quotes used here describe the design, not a
version-specific fix.

### Q1 — §"1. Overview", advantages list, item 2
> WAL provides more concurrency as readers do not block writers and a writer does not block readers. Reading and writing can proceed concurrently.

### Q2 — §"2. How WAL Works"
> Writers merely append new content to the end of the WAL file. Because writers do nothing that would interfere with the actions of readers, writers and readers can run at the same time. However, since there is only one WAL file, there can only be one writer at a time.

### Q3 — §"1. Overview", disadvantages list, item 1
> All processes using a database must be on the same host computer; WAL does not work over a network filesystem.
