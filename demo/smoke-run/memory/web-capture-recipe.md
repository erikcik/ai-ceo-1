# Reproducible web capture: curl -D, pandoc, pdftotext

The capture recipe that satisfies a `.src` + `.txt` + `.headers.txt` provenance requirement,
verified end to end on 8 captures (2026-08-18).

**Fetch** — one command produces the bytes and the headers together:

```sh
curl -sS -L -D <key>.headers.txt -o <key>.src --max-time 90 "<url>"
```

`-D` writes every response header block, including those of redirects followed by `-L`. Add
`-w '%{http_code} %{size_download} %{content_type}'` to get the status and size for the log
without a second request.

**Extract to text** — both of these are deterministic, so a log entry naming them is
re-derivable by a stranger:

```sh
pandoc -f html -t plain --wrap=none <key>.src -o <key>.txt   # HTML
pdftotext <key>.src <key>.txt                                # PDF
```

`pandoc -t plain` strips `<script>` and `<style>` properly. Naive tag-stripping (regex, or
`re.sub('<[^>]+>','')`) leaves the whole inline JavaScript body in the text — on sqlite.org
that is ~1200 characters of JS before the first sentence of prose.

**Always verify determinism before logging the command as reproducible**: re-run the
extraction into a scratch path and compare `shasum -a 256`. Both tools reproduced byte-for-byte
across all 8 captures. One caveat found: pandoc will try to **fetch remote resources** it finds
in the HTML (it attempted a `youtube.com/embed/...` URL on one page and warned on stderr).
That warning did not change the output, but it means extraction is not guaranteed offline —
the re-run check is what proves the `.txt` came from the `.src`. Re-tested at level 4 with the
machine's network block in force: all 8 re-derived byte for byte, **and pandoc wrote nothing to
stderr on any of them**, so a blocked remote resource is not fatal here. Still capture the
stderr of each re-run and print it when non-empty rather than assuming that holds.

Locating a quote's PDF page: extract pages one at a time and search, don't estimate.

```sh
for p in $(seq 1 $(pdfinfo f.pdf | awk '/^Pages:/{print $2}')); do
  pdftotext -f $p -l $p f.pdf - | tr -s '[:space:]' ' ' | grep -qF "<fragment>" && echo $p
done
```

See [[quote-verbatim-from-extracted-text]] for what to do with the text once you have it.
