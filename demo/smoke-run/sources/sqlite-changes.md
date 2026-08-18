```yaml
key: sqlite-changes
subject: sqlite
title: "Release History"
publisher: "SQLite project (sqlite.org)"
source_type: release-notes
url: https://www.sqlite.org/changes.html
dated: 2026-07-24
dated_locator: "most recent release heading in the capture: '2026-07-24 (3.53.4)'"
accessed: 2026-08-17
capture_file: sources/raw/sqlite-changes.txt
sha256: c620bae85a2e9a24e3b362584fa405fc47af54516b54fcadd989039682900fc6
```

**Why this source matters.** This is the `release-notes` entry of the dossier and the only
source here that dates the *software* rather than a documentation page. It is the project's
own per-release changelog, running from `2000-05-29` to `2026-07-24 (3.53.4)`, so it is what
a version-dependence claim about SQLite has to rest on. Q2 and Q3 are examples of the kind of
change it records — a WAL-mode recovery fix and an interface change explicitly held to
backwards compatibility.

**Versioning.** `dated` is the newest release listed in this capture (3.53.4, 2026-07-24). A
later capture will carry later releases; any claim citing this key is a claim about the state
of the release history as captured on 2026-08-17, not a permanent fact.

### Q1 — §"Release History", opening paragraph
> This page provides a high-level summary of changes to SQLite. For more detail, see the Fossil checkin logs at https://sqlite.org/src/timeline and https://sqlite.org/src/timeline?t=release.

### Q2 — release entry "2020-08-14 (3.33.0)", item 8
> In WAL mode, if a writer crashes and leaves the shm file in an inconsistent state, subsequent transactions are now able to recover the shm file even if there are active read transactions.

### Q3 — release entry "2022-11-16 (3.40.0)", item 4
> This interface change should be fully backwards compatible, though it might cause (harmless) compiler warnings when rebuilding some legacy applications.
