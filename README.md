# link-checker

A Markdown link checker for repositories. It walks a project, parses every `.md`
file with a real CommonMark parser, and verifies that

- **local links** point at files that actually exist on disk, and
- **external `http(s)` links** answer with a final `2xx`/`3xx` status.

It is built for CI: deterministic output, a non-zero exit code when something is
broken, one HTTP request per unique URL, and no single failure ever aborting the
run.

```
Markdown Link Checker

Scanning: /Users/user/project

Broken local links

┌───────────────┬──────┬───────────────────┬─────────────────────────┬────────────────┐
│ File          │ Line │ Link              │ Resolved path           │ Result         │
├───────────────┼──────┼───────────────────┼─────────────────────────┼────────────────┤
│ docs/guide.md │ 18   │ ../api/missing.md │ /project/api/missing.md │ File not found │
└───────────────┴──────┴───────────────────┴─────────────────────────┴────────────────┘

Broken external links

┌───────────────┬──────┬─────────────────────────────┬───────────────────────────┐
│ File          │ Line │ URL                         │ Result                    │
├───────────────┼──────┼─────────────────────────────┼───────────────────────────┤
│ README.md     │ 42   │ https://example.com/missing │ 404 Not Found             │
│ docs/guide.md │ 25   │ https://example.com/missing │ 404 Not Found             │
│ docs/api.md   │ 73   │ https://example.com/api     │ 500 Internal Server Error │
│ docs/setup.md │ 91   │ https://slow.example.com    │ Timeout                   │
└───────────────┴──────┴─────────────────────────────┴───────────────────────────┘

Summary

  Files scanned:                 24
  Link occurrences:             137
  Unique external URLs checked:  53
  Valid:                        132
  Broken local:                   1
  Broken external:                4
  Broken total:                   5
```

`https://example.com/missing` appears twice in that report but was requested
exactly once.

## Requirements

Node.js **20.16** or newer (Node 22+ recommended). No other runtime dependencies.

## Installation

```bash
# global install
npm install -g link-checker

# or run it without installing
npx link-checker ./my-project

# or add it to a project
npm install --save-dev link-checker
```

From a clone of this repository:

```bash
npm install
npm run build
npm link          # makes `link-checker` available on your PATH
```

## Usage

```bash
link-checker ./my-project     # scan a directory
link-checker                  # scan the current working directory
link-checker ./docs/guide.md  # scan a single file
```

### Options

| Option | Description | Default |
| --- | --- | --- |
| `--timeout <ms>` | Per-request timeout. | `10000` |
| `--concurrency <n>` | Simultaneous HTTP requests. | `10` |
| `--ignore <name>` | Extra directory name to skip. Repeatable or comma-separated. | – |
| `--only-ignore <list>` | Replace the default ignore list entirely. | – |
| `--no-external` | Skip all HTTP requests; check local links only. Malformed URLs are still reported, since detecting them needs no request. | – |
| `--no-images` | Do not check `![alt](src)` destinations. | – |
| `--no-definitions` | Do not check `[ref]: url` definitions. | – |
| `--user-agent <string>` | `User-Agent` header for HTTP requests. | `link-checker/1.0` |
| `--json` | Print a machine-readable JSON report. | – |
| `--no-color` | Disable colour (`NO_COLOR` is honoured too). | – |
| `-h, --help` | Show help. | – |
| `-v, --version` | Show the version. | – |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No broken links. |
| `1` | Broken links found. |
| `2` | The scan could not run (bad path or bad arguments). |

### In CI

```yaml
- run: npx link-checker .
```

Progress messages go to **stderr** and the report to **stdout**, so
`link-checker . > report.txt` keeps the report clean. `--json` prints only JSON
on stdout.

## What gets scanned

Every `.md` file (extension matched case-insensitively) below the given path,
recursively. These directories are skipped by default:

```
.git  node_modules  dist  build  coverage
```

Add more with `--ignore vendor,tmp`, or replace the list with `--only-ignore`.
Symlinked directories are not traversed, so symlink loops cannot hang a scan.

## What gets checked

Links are found with a CommonMark parser
([`mdast-util-from-markdown`](https://github.com/syntax-tree/mdast-util-from-markdown)),
not a regular expression. That matters: destinations inside inline code, fenced
code blocks, indented code blocks and escaped brackets are correctly **not**
treated as links, while titles, angle-bracket destinations and escaped
characters inside a URL are handled properly.

| Construct | Checked |
| --- | --- |
| `[text](./file.md)` | yes |
| `[text](<./file with spaces.md>)` | yes |
| `[text](./file.md "Title")` | yes |
| `<https://example.com>` (autolink) | yes |
| `![alt](./img.png)` | yes (`--no-images` to skip) |
| `[ref]: ./file.md` (definition) | yes (`--no-definitions` to skip) |
| `file:///abs/path.md` | yes, as an absolute filesystem path |
| `#section` | no — nothing to resolve |
| `mailto:`, `tel:`, `data:`, `ftp:`, … | no — reported as "not checked" |
| `[text](./x.md)` inside code | no |
| `<a href="./x.md">` (raw HTML) | no |
| A bare `https://…` in prose | no (GFM autolink literals are out of scope) |

### Local links

- Relative links resolve against **the directory of the Markdown file that
  contains them** — never the CWD or the repository root. `docs/guide.md`
  linking `../README.md` resolves to `<root>/README.md`.
- Fragments and query strings are stripped before the existence check:
  `./guide.md#installation` checks `./guide.md`.
- Percent-encoding is decoded (`./my%20file.md` → `./my file.md`). If decoding
  fails, or a file is literally named `a%20b.md`, the raw spelling is accepted
  too, so both readings work.
- A link to an existing **directory** counts as valid.
- Root-absolute links (`/docs/x.md`) are ambiguous — a docs site means "relative
  to the repository root", the filesystem means `/`. Both are accepted; the
  repository-root path is the one shown in the report.
- `file:///…` is treated as an absolute filesystem path, with percent-decoding
  and fragment stripping applied.

### External links

- One `GET` per unique URL, redirects followed, only the **final** status judged:
  `2xx`/`3xx` valid, `4xx`/`5xx` broken. The response body is discarded as soon
  as the headers arrive.
- 10-second timeout per request, at most 10 requests in flight.
- Failure reasons are distinguished in the report: `404 Not Found`,
  `500 Internal Server Error`, `Timeout`, `DNS error (ENOTFOUND)`,
  `Connection error (ECONNREFUSED)`, `TLS error (CERT_HAS_EXPIRED)`,
  `Too many redirects`, `Malformed URL`.
- Malformed URLs are reported, never thrown, and one failing request never stops
  the rest of the scan.

> A single `GET` is used rather than `HEAD` with a `GET` fallback, because many
> servers answer `HEAD` with `403`/`405` and a fallback would mean two requests
> per URL.

### Deduplication

External URLs are normalised before being requested: the scheme and host are
lower-cased, default ports removed, an empty path becomes `/`, and the **fragment
is dropped** because it is never sent to the server. Query strings are kept —
they do change the response.

All of these are therefore one single request:

```markdown
[a](https://Example.com)
[b](https://example.com/)
[c](https://example.com/#intro)
[d](HTTPS://EXAMPLE.COM/#usage)
```

Every occurrence is still remembered with its file and line, so a broken URL
used in twenty files is requested once and reported twenty times.

`Link occurrences` in the summary counts links found in Markdown, not HTTP
requests; `Unique external URLs checked` counts the requests.

## Programmatic API

```ts
import { scan, formatReport } from 'link-checker';

const result = await scan('./my-project', {
  timeoutMs: 10_000,
  concurrency: 10,
  ignore: ['vendor'],
});

console.log(formatReport(result));
console.log(result.summary.brokenTotal, 'broken links');

for (const broken of result.brokenExternalLinks) {
  console.log(broken.url, broken.reason, broken.occurrences.length, 'occurrences');
}
```

`scan()` accepts a `fetchImpl` option, which makes the HTTP layer trivially
mockable. Smaller pieces — `extractLinks`, `classifyLink`, `normalizeExternalUrl`,
`discoverMarkdownFiles`, `checkExternalUrl`, `checkLocalPath`, `formatJson` — are
exported too.

## Development

```bash
npm install
npm test           # vitest, 160 tests
npm run test:watch
npm run typecheck
npm run build
npm run dev -- ./some-project   # run from source
```

The test suite runs against real temporary directories and a real local HTTP
server (no network access required), covering link-parsing edge cases, path
resolution, every failure classification, the concurrency limit, deduplication,
report rendering and CLI exit codes.

## Design notes

- **Modular.** Discovery, extraction, classification, the local checker, the HTTP
  checker, the reporter and the CLI are separate modules with no shared mutable
  state, each independently testable.
- **Never crashes on bad input.** Malformed URLs, unreadable files and network
  errors all become report entries or warnings.
- **Deterministic.** Files and findings are sorted in byte order, so output does
  not depend on filesystem order or the machine's locale.

## License

MIT
