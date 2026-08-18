# sources/CAPTURE_LOG.md

Every fetch made in level 1, successful or not. Timestamps are **UTC**, taken immediately
before the fetch; the session's local date was 2026-08-18, so `accessed: 2026-08-17` in the
source entries is the UTC date and matches the `Date:` line in each `sources/raw/*.headers.txt`.

Captures are write-once. Nothing under `sources/raw/` has been edited since it was fetched;
the sha256 values below are the check on that.

## Conventions

**Fetch command** (identical for every capture, `<key>` and `<url>` substituted):

```sh
curl -sS -L -D sources/raw/<key>.headers.txt -o sources/raw/<key>.src --max-time 90 "<url>"
```

**Extraction command**, HTML captures:

```sh
pandoc -f html -t plain --wrap=none sources/raw/<key>.src -o sources/raw/<key>.txt
```

**Extraction command**, PDF captures:

```sh
pdftotext sources/raw/<key>.src sources/raw/<key>.txt
```

Both were re-run against the stored `.src` after capture and reproduced the stored `.txt`
byte for byte (all eight sha256 values matched). Tool versions on this machine: `pandoc
3.9.0.2`, `pdftotext` from poppler at `/opt/homebrew/bin/pdftotext`, `curl` from macOS,
`shasum -a 256`.

---

## 1. Captures used as dossier entries (8)

### sqlite-whentouse
- URL: https://www.sqlite.org/whentouse.html
- UTC: 2026-08-17T22:29:50Z — HTTP 200 — `.src` 21223 bytes
- fetch: `curl -sS -L -D sources/raw/sqlite-whentouse.headers.txt -o sources/raw/sqlite-whentouse.src --max-time 90 "https://www.sqlite.org/whentouse.html"`
- extract: `pandoc -f html -t plain --wrap=none sources/raw/sqlite-whentouse.src -o sources/raw/sqlite-whentouse.txt`
- sha256 `.src`: d0850096c26e9c888acaf2d6e2ac029e86f66f51a87461b77b94f1639d309b79
- sha256 `.txt`: d81424b957a9a05c6b457d6c76233734d356f7b0f96a49c619aa650dc400d63b (15499 bytes)

### sqlite-wal
- URL: https://www.sqlite.org/wal.html
- UTC: 2026-08-17T22:29:52Z — HTTP 200 — `.src` 41826 bytes
- fetch: `curl -sS -L -D sources/raw/sqlite-wal.headers.txt -o sources/raw/sqlite-wal.src --max-time 90 "https://www.sqlite.org/wal.html"`
- extract: `pandoc -f html -t plain --wrap=none sources/raw/sqlite-wal.src -o sources/raw/sqlite-wal.txt`
- sha256 `.src`: 29315aaa998c5e2acf29e3ac161e9e8bf786d0c82a85ac83eb4f4091234acb7b
- sha256 `.txt`: 344d748072ca5e4df3e46656944b116c1de75d99a507e44f5573b953f59e9980 (31484 bytes)

### sqlite-lts
- URL: https://www.sqlite.org/lts.html
- UTC: 2026-08-17T22:29:53Z — HTTP 200 — `.src` 7930 bytes
- fetch: `curl -sS -L -D sources/raw/sqlite-lts.headers.txt -o sources/raw/sqlite-lts.src --max-time 90 "https://www.sqlite.org/lts.html"`
- extract: `pandoc -f html -t plain --wrap=none sources/raw/sqlite-lts.src -o sources/raw/sqlite-lts.txt`
- sha256 `.src`: 1c8bc5dfbfca0f3cf7317cef15663ac0a9a2022770d0f06e0c05643d38108361
- sha256 `.txt`: 11472f71ffff6dca36dc6fb10708f914e43a1b6417d24fc239788ce2ffdb9e2a (3901 bytes)

### sqlite-cli
- URL: https://www.sqlite.org/cli.html
- UTC: 2026-08-17T22:29:54Z — HTTP 200 — `.src` 93803 bytes
- fetch: `curl -sS -L -D sources/raw/sqlite-cli.headers.txt -o sources/raw/sqlite-cli.src --max-time 90 "https://www.sqlite.org/cli.html"`
- extract: `pandoc -f html -t plain --wrap=none sources/raw/sqlite-cli.src -o sources/raw/sqlite-cli.txt`
- sha256 `.src`: 3d0e7bf59cab38cc4609e8dd4de51c947bc9a643d45e1d4413b65713d8688c42
- sha256 `.txt`: e2d18f7a44989e4701db7f1bd6efb9d44246461b39c592344bef645038987aa6 (75904 bytes)

### sqlite-changes
- URL: https://www.sqlite.org/changes.html
- UTC: 2026-08-17T22:29:55Z — HTTP 200 — `.src` 473582 bytes
- fetch: `curl -sS -L -D sources/raw/sqlite-changes.headers.txt -o sources/raw/sqlite-changes.src --max-time 90 "https://www.sqlite.org/changes.html"`
- extract: `pandoc -f html -t plain --wrap=none sources/raw/sqlite-changes.src -o sources/raw/sqlite-changes.txt`
- sha256 `.src`: 7affb06012865c2b6026630fb6e9c2307642d5930a91857068184a17a0740f41
- sha256 `.txt`: c620bae85a2e9a24e3b362584fa405fc47af54516b54fcadd989039682900fc6 (329377 bytes)

### duckdb-sigmod19
- URL: https://duckdb.org/pdf/SIGMOD2019-demo-duckdb.pdf
- UTC: 2026-08-17T22:29:57Z — HTTP 200 — `.src` 974371 bytes (`Content-Type: application/pdf`)
- fetch: `curl -sS -L -D sources/raw/duckdb-sigmod19.headers.txt -o sources/raw/duckdb-sigmod19.src --max-time 90 "https://duckdb.org/pdf/SIGMOD2019-demo-duckdb.pdf"`
- extract: `pdftotext sources/raw/duckdb-sigmod19.src sources/raw/duckdb-sigmod19.txt`
- sha256 `.src`: 43fd71e165449dfce26f3e15b7c6452ac6c7f3bbedfaac41fd30949bb4bbbd9a
- sha256 `.txt`: 1fd8fdcf36e85b2f69808b5adc1beeb7e031b800a0e04926ec9e298efede0917 (20306 bytes)

### duckdb-cidr20
- URL: https://duckdb.org/pdf/CIDR2020-raasveldt-muehleisen-duckdb.pdf
- UTC: 2026-08-17T22:29:58Z — HTTP 200 — `.src` 197233 bytes (`Content-Type: application/pdf`)
- fetch: `curl -sS -L -D sources/raw/duckdb-cidr20.headers.txt -o sources/raw/duckdb-cidr20.src --max-time 90 "https://duckdb.org/pdf/CIDR2020-raasveldt-muehleisen-duckdb.pdf"`
- extract: `pdftotext sources/raw/duckdb-cidr20.src sources/raw/duckdb-cidr20.txt`
- sha256 `.src`: 51521141d0986bf823727598651562f2737146a666e4dcbb069455067bba9ed4
- sha256 `.txt`: b48ccc47b42900033ddb857ae26a9b810261f8724d85a92817881b51e894c994 (33682 bytes)

### duckdb-pvldb-hashjoin
- URL: https://www.vldb.org/pvldb/vol18/p2748-kuiper.pdf
- UTC: 2026-08-17T22:29:58Z — HTTP 200 — `.src` 1756396 bytes (`Content-Type: application/pdf`, `Last-Modified: Mon, 28 Jul 2025 04:42:29 GMT`)
- fetch: `curl -sS -L -D sources/raw/duckdb-pvldb-hashjoin.headers.txt -o sources/raw/duckdb-pvldb-hashjoin.src --max-time 90 "https://www.vldb.org/pvldb/vol18/p2748-kuiper.pdf"`
- extract: `pdftotext sources/raw/duckdb-pvldb-hashjoin.src sources/raw/duckdb-pvldb-hashjoin.txt`
- sha256 `.src`: 5df6abe28d57703a8792c4e91aaef321d46f8a2de4531c629d75a8273318eb5e
- sha256 `.txt`: 8edaeacdb0bfc142995e45a20ba7e6fc232ac3b436f62830a72bc6a954fc4ceb (88024 bytes)

**No extraction failed.** No quote in this dossier claims the PDF grep exemption of
`EVIDENCE.md` §1.2; all three PDFs extracted to text cleanly with `pdftotext` and every quote
is verified by the canonical grep in `evidence/level-1/quote-check.txt`.

---

## 2. Fetched and then rejected as non-primary (4)

These were fetched, read, and rejected. Captures kept under `sources/rejected/` so the
rejection is checkable; they are deliberately **not** under `sources/raw/`, which holds only
entry captures. Written up in `claims/excluded-sources.md`.

| key | URL | UTC | status | `.src` bytes | sha256 `.src` | decision |
|---|---|---|---|---|---|---|
| excluded-why-duckdb | https://duckdb.org/why_duckdb | 2026-08-17T22:30:04Z | 200 | 276241 | ff69b271cc7567878ff6712424f1b72082373ece948f7f9d135a6f47763791b8 | reject: undated vendor page, comparative performance framing |
| excluded-posthog-vs | https://posthog.com/blog/duckdb-vs-sqlite | 2026-08-17T22:34:30Z | 200 | 1052929 | 22bc876eacc3c14babd12da3ce88fdb7b698b1bd3eed3af37ee8cdc9981da92e | reject: undated third-party blog post |
| excluded-betterstack-vs | https://betterstack.com/community/guides/scaling-python/duckdb-vs-sqlite/ | 2026-08-17T22:34:34Z | 200 | 177066 | 7b08e7af9ad0933a8f79200d32f1f3f90d933da7fede86317bdf8e92e2c53af3 | reject: third-party guide asserting uncited speed multipliers |
| excluded-lukasbarth-bench | https://www.lukas-barth.net/blog/sqlite-duckdb-benchmark/ | 2026-08-17T22:34:30Z | 200 | 33780 | bdc63ceef5cff44001385c9fe23ce49419a39c3a4070c987a6a58ca491bea251 | reject: third-party benchmark post |

Extraction for all four: `pandoc -f html -t plain --wrap=none sources/rejected/<key>.src -o sources/rejected/<key>.txt`.

Note on `excluded-lukasbarth-bench`: pandoc emitted a `[WARNING] Could not fetch resource
https://www.youtube.com/embed/...` while converting it — pandoc tried to resolve an embedded
media element over the network. The warning went to stderr and did not enter the `.txt`. None
of the eight entry captures produced such a warning, and re-extraction of all eight reproduced
their `.txt` byte for byte, so no entry's text depends on a network fetch at extraction time.

---

## 3. Failed fetches and rejected captures (5)

Logged with the error and the decision taken. Re-run at 2026-08-17T22:40:17Z to record exact
output; the first observation of each was during source selection ~22:20–22:26Z, same result.

**a. CIDR 2019 DuckDB paper — unreachable.**
```
https://www.cidrdb.org/cidr2019/papers/p127-raasveldt-cidr19.pdf
curl: (7) Failed to connect to www.cidrdb.org port 443 after 4 ms: Couldn't connect to server
```
Decision: do not cite. The DuckDB paper coverage was taken instead from
`duckdb.org/pdf/SIGMOD2019-demo-duckdb.pdf` and `duckdb.org/pdf/CIDR2020-...pdf`, which are
the project's own copies of published papers and were reachable.

**b. Author's copy of the ICDE 2024 out-of-core paper — unreachable.**
```
https://hannes.muehleisen.org/publications/icde2024-out-of-core-kuiper-boncz-muehleisen.pdf
curl: (7) Failed to connect to hannes.muehleisen.org port 443 after 5 ms: Couldn't connect to server
```
Decision: do not cite. The reachable copy at
`https://duckdb.org/pdf/ICDE2024-kuiper-boncz-muehleisen-out-of-core.pdf` *was* fetched
during selection (HTTP 200, 1556690 bytes) and extracted cleanly, but was **rejected as an
entry for a different reason**: its text carries no publication date at all — no `©2024
IEEE` line, no conference header — so `dated` could not be located in the capture as
`EVIDENCE.md` §1.1 requires. `duckdb-pvldb-hashjoin` (PVLDB 2025, date printed on page 1) was
used for the larger-than-memory axis instead.

**c. DuckDB documentation PDF — does not exist.**
```
https://duckdb.org/duckdb-docs.pdf  ->  404, 267944 bytes, text/html
```
Decision: not a document; the 404 body is the site's HTML error page. Do not cite.

**d. DuckDB `/docs/stable/` URLs are redirect stubs, not documents.**
```
https://duckdb.org/docs/stable/connect/concurrency  ->  200, 569 bytes, text/html
```
HTTP 200 with a 569-byte body containing only
`<title>Redirecting&hellip;</title>` and a JS/meta-refresh to
`https://duckdb.org/docs/current/connect/concurrency.html`. This is exactly the
"HTTP 200 with a body of a few hundred bytes is usually a redirect stub" case of
`EVIDENCE.md` §2. `curl -L` does not follow it, because the redirect is in JavaScript and a
`<meta http-equiv="refresh">`, not in an HTTP status. Decision: never capture a
`duckdb.org/docs/stable/...` URL; the canonical URL is `/docs/current/...html`.

**e. `duckdb.org` HTML pages cannot satisfy the headers requirement — a selection constraint,
not a one-off failure.** The canonical `/docs/current/...html` pages and the dated blog posts
under `duckdb.org/<yyyy>/<mm>/<dd>/...` do return HTTP 200 with real content, but their
response headers carry only `date:` and `content-type:` — no `Content-Length`, no
`Last-Modified`, no `ETag`, under HTTP/2, HTTP/1.1, `Accept-Encoding: identity`, a `Range`
request, and a repeat request (all tried):
```
HTTP/2 200
date: Mon, 17 Aug 2026 22:21:16 GMT
content-type: text/html; charset=utf-8
cf-cache-status: DYNAMIC
```
`LEVELS.md` L1 criterion 5 requires `Date`, `Content-Type`, **and** `Content-Length` or
`Last-Modified`/`ETag`. Decision: no `duckdb.org` HTML page is used as an entry. Static PDFs
on the same host *do* return `content-length` and `etag`, which is why
`duckdb.org/pdf/*.pdf` captures are acceptable and were used. A second consequence:
`duckdb.org` documentation pages carry no date anywhere in the page body either (a grep for
`20[0-9]{2}-[0-9]{2}-[0-9]{2}` over the fetched HTML returns nothing; the only version marker
is the string `DuckDB v1.5.2`), so they could not satisfy `dated_locator` regardless. This is
why all three DuckDB entries are papers rather than documentation pages, and it is the main
coverage limitation this level leaves behind — see `evidence/level-1/CLAIM.md`.

**f. Two rejection candidates could not be fetched** (recorded for completeness; neither is
used in `claims/excluded-sources.md`, because an exclusion has to rest on something observed
*in* the document):
```
https://motherduck.com/learn/duckdb-vs-sqlite-databases/
curl: (7) Failed to connect to motherduck.com port 443 after 26 ms: Couldn't connect to server

https://www.datacamp.com/blog/duckdb-vs-sqlite-complete-database-comparison
403, 5608 bytes, text/html
```
The failed motherduck attempt left a zero-byte `sources/rejected/excluded-motherduck-vs.headers.txt`
(sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855, the sha256 of the
empty string). Deleting it was blocked by the harness safety gate and is logged in
`PAUSED_ACTIONS.md`; it is left in place, and this line is what it means. The datacamp 403
body was kept as `sources/rejected/excluded-datacamp-vs.src` (5608 bytes, sha256
b738fd33e048d7b8977b763ddae037d38a111136f6a7164ab3d6b11bc8b76618); it is an access-denied
page, not the article, so nothing is quoted from it.

---

## 4. Level 2 — one further source considered, fetched, and not added

`LEVELS.md` level 2, "Where the budget binds", permits adding one source at level 2 to fix a
thin spot found at level 1, logged the same way. The thin spot named in
`evidence/level-1/CLAIM.md` was **DuckDB's storage-format stability and its release-notes
coverage**: all three DuckDB entries are papers, two of them pre-1.0. One candidate was
fetched to close it. It did not qualify, so **no source was added**, and the gap is carried in
`claims/gaps.md` §2 and §6 instead. The capture is kept so the decision is checkable.

### probe-duckdb-gh-release-1-0-0 — fetched, rejected as unusable
- URL: https://api.github.com/repos/duckdb/duckdb/releases/tags/v1.0.0
- UTC: 2026-08-17T22:54:40Z — HTTP 200 — `.src` 30770 bytes
- fetch: `curl -sS -D sources/rejected/probe-duckdb-gh-release-1-0-0.headers.txt -o sources/rejected/probe-duckdb-gh-release-1-0-0.src --max-time 30 -H "Accept: application/vnd.github+json" "https://api.github.com/repos/duckdb/duckdb/releases/tags/v1.0.0"`
- sha256 `.src`: 6c92c689eef12c0ea5c8af2736d6b0b25d756bb3b9d5cd895e6c5da48376fb3c
- headers: `date`, `content-type: application/json`, `content-length: 30770`, `etag`,
  `last-modified: Thu, 27 Jun 2024 12:59:03 GMT` — this capture **does** satisfy the header
  requirement of L1 criterion 5, unlike every `duckdb.org` HTML page (§3e).
- date in body: `"published_at": "2024-06-03T13:08:46Z"` — a real, locatable `dated`.

**Why it was rejected: the body carries no quotable prose.** `EVIDENCE.md` §1.1 requires two
or more verbatim quotes, each a contiguous span of ≥12 words containing a complete sentence of
**body prose**; the release body is a PR bullet list with exactly two prose sentences, neither
of which supports any claim this comparison makes:

```
$ python3 -c "import json;b=json.load(open('sources/rejected/probe-duckdb-gh-release-1-0-0.src'))['body'];print(chr(10).join(l for l in b.split(chr(10)) if l.strip() and not l.strip()[0] in '*-#|' and len(l.split())>=8))"
This release of DuckDB is named "Nivis" after the sadly non-existent Snow Duck (Anas Nivis) that is known for its stability.
Please also refer to the announcement blog post: https://duckdb.org/2024/06/03/announcing-duckdb-100
```

The same check was run against `.../releases/tags/v1.2.0` (HTTP 200, 121418 bytes, the release
`duckdb-pvldb-hashjoin#Q2` names) and returned the same two-sentence shape — a duck-naming
sentence and a pointer to the blog post. Neither release body mentions the storage format,
backward compatibility, or anything else the thin spot needed.

**Decision.** Do not add. An entry admitted here would have been cited by no claim row, which
level 2 criterion 7 scores as worth nothing, and quoting "named after the Snow Duck" to satisfy
a two-quote minimum would be exactly the "quote that greps to 1 and supports no claim" failure
`EVIDENCE.md` §2 names. The dossier stays at 8 entries. The consequence — that DuckDB's
storage-format stability is unsourced and must not be asserted — is recorded in
`claims/gaps.md` §2 and carried as the `DROPPED` row `W2` in `claims/claim-map.md`.

**Note on the pointer this leaves.** The material that would close the gap is the DuckDB blog
post at `duckdb.org/2024/06/03/announcing-duckdb-100`, named in the release body above. It is
not capturable under this task's provenance rules for the reason in §3e (no `Content-Length` /
`Last-Modified` / `ETag` on any `duckdb.org` HTML response), not because it does not exist.
That distinction belongs in the report's limits passage, not in a claim.
