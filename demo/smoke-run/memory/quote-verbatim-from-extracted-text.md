# Build quotes by copying out of the extracted text, never from memory

When a quote has to survive `grep -F` against a stored capture, the only reliable method is:
read the `.txt`, copy the span out of it, paste it into the source entry. Writing the quote
from recollection and then hunting for it is how a "verbatim" quote turns out to differ by a
character. Doing it the right way round made all 24 quotes and 8 date greps pass first try
(2026-08-18).

What silently breaks a quote that "looks identical":

- **Curly punctuation.** Extracted text carries `’` `‘` `“` `–` from the source, not ASCII
  `'` `-`. `SQLite’s performance` will not match a typed `SQLite's performance`.
- **De-hyphenation artifacts in PDFs.** `pdftotext` joins a line-broken `in-process` into
  `inprocess` and `out-of-core` into `out-ofcore`. Choose a span that does not cross one, or
  the quote is verbatim to the capture but *not* to the document — which is worse.
- **Line wrapping is harmless.** The canonical check normalises with
  `tr -s '[:space:]' ' '` first, so a span crossing line and column breaks matches fine.

**Pick spans containing no `"` character.** The canonical form is
`grep -F -c "<quote>"`; an embedded double quote forces the reader into single-quote shell
escaping and stops the transcript being copy-pasteable. There is nearly always an equally
good adjacent sentence without one.

**Verify the quote as written in the entry file, not the quote in your buffer.** After writing
the entries, re-extract each `> ` line from the `.md` files and grep it against the capture.
That is the path a reader takes — entry → quote → capture — and it catches typos introduced
while writing the entry, which the earlier check cannot.

Companion: [[web-capture-recipe]].
