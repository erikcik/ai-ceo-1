# Hosts that refuse connections on this machine (SelfControl), observed 2026-08-17

`curl: (7) Failed to connect ... Couldn't connect to server` in a few milliseconds is the
signature of the machine-level block, not of a host being down — a real outage takes longer to
fail and usually fails differently. Refused during a research session:

- `www.cidrdb.org` (443 and 80)
- `hannes.muehleisen.org`
- `mytherin.github.io` — and `github.io` generally appears blocked
- `motherduck.com`
- `www.youtube.com` (hit indirectly, when pandoc tried to resolve an embedded player)

Reachable in the same session:

- `www.sqlite.org`, `duckdb.org`, `www.vldb.org`
- `github.com`, `raw.githubusercontent.com`, `api.github.com`
- `posthog.com`, `betterstack.com`, `www.lukas-barth.net`

`www.datacamp.com` answered with HTTP 403 — that is the site refusing the client, a different
thing from the block, and worth distinguishing in a log.

Do not work around the block (never edit `/etc/hosts`, kill `selfcontrold`, or flush `pf`).
Route around it instead: for a paper, prefer the publisher's archive or the project's own
copy over an author's personal site. If a task genuinely cannot proceed, the sanctioned route
is `scblock` — see the global instructions, and ask rather than assume.
