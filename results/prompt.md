Create a production-ready CLI tool with Node.js and TypeScript.

The CLI should accept a repository/project path as an argument:

link-checker ./my-project

If no path is provided, use the current working directory.

Requirements:

- Recursively discover all `.md` files.
- Ignore common generated/vendor directories such as:
  `.git`, `node_modules`, `dist`, `build`, `coverage`.
- Extract and check:
    - Standard Markdown links: `[text](url)`
    - `file:///...` links
- Correctly handle URLs containing fragments (`#section`), query parameters, URL encoding, spaces, and other common edge cases within these link types.
- Before implementation, research common edge cases for these Markdown link formats and make sure the implementation handles them correctly.

Local links:
- Check whether the referenced file exists.
- Resolve relative paths relative to the directory of the Markdown file containing the link, not relative to the repository root or CWD.
- Example:
  `docs/guide.md` contains `../README.md`
  → it should resolve to `README.md` in the repository root.
- Support `./`, `../`, nested paths and URL-encoded paths.
- Ignore URL fragments when checking file existence.
  Example: `./guide.md#installation` should check `./guide.md`.
- For links containing only a fragment, such as `#installation`, do not perform a filesystem check.
- Treat `file:///...` as an absolute filesystem path.

External links:
- Check `http` and `https` URLs using HTTP requests.
- Follow redirects and evaluate the final response status.
- Treat final `2xx` and `3xx` responses as valid.
- Treat final `4xx` and `5xx` responses as broken.
- Use a 10-second timeout per request.
- Limit concurrency to 10 simultaneous HTTP requests.
- Handle malformed URLs gracefully and report them instead of crashing.
- Distinguish different failure types in the report, including:
    - `404 Not Found`
    - `500 Internal Server Error`
    - `Timeout`
    - DNS errors
    - connection errors
    - malformed URL
- One failed request must never stop the rest of the scan.

Deduplication:
- Do not check the same external URL multiple times.
- Normalize and deduplicate external URLs before making HTTP requests.
- Each unique external URL should result in at most one HTTP request/check during a scan.
- Preserve all occurrences of each URL, including the Markdown file and line number where each occurrence was found.
- If a unique external URL is broken and appears in multiple Markdown files or on multiple lines, perform the HTTP check only once but show every occurrence in the report.

Output:
- Print a readable colored report in the terminal.
- Split broken links into two separate sections:
    - Broken local links
    - Broken external links
- For each broken link show:
    - The path to the `.md` file where the link was found
    - The line number where the link appears
    - The original link exactly as it appears in the Markdown file
    - The failure reason
- For local links, also show the resolved filesystem path.
- For a broken external URL that occurs multiple times, show all file/line occurrences even though the URL was checked only once.
- Print a final summary with total files scanned, total link occurrences, valid links, and broken links.
- `Links checked` / `link occurrences` should represent the total number of links found in Markdown files, not the number of unique HTTP requests.

Example:

Markdown Link Checker

Scanning: /Users/user/project

Broken local links

┌───────────────────────┬──────┬─────────────────────┬─────────────────────────────────┬────────────────┐
│ File                  │ Line │ Link                │ Resolved path                   │ Result         │
├───────────────────────┼──────┼─────────────────────┼─────────────────────────────────┼────────────────┤
│ docs/guide.md         │ 18   │ ../api/missing.md   │ /project/api/missing.md         │ File not found │
│ docs/setup.md         │ 31   │ ./config.md         │ /project/docs/config.md         │ File not found │
└───────────────────────┴──────┴─────────────────────┴─────────────────────────────────┴────────────────┘

Broken external links

┌───────────────────────┬──────┬──────────────────────────────┬───────────────────────────┐
│ File                  │ Line │ URL                          │ Result                    │
├───────────────────────┼──────┼──────────────────────────────┼───────────────────────────┤
│ README.md             │ 42   │ https://example.com/missing  │ 404 Not Found             │
│ docs/guide.md         │ 25   │ https://example.com/missing  │ 404 Not Found             │
│ docs/api.md           │ 73   │ https://example.com/api      │ 500 Internal Server Error │
│ docs/setup.md         │ 91   │ https://slow.example.com     │ Timeout                   │
└───────────────────────┴──────┴──────────────────────────────┴───────────────────────────┘

Note: `https://example.com/missing` appears twice above but must be requested only once.

Summary

Files scanned:                 24
Link occurrences:             137
Unique external URLs checked:  53
Valid:                        132
Broken local:                   1
Broken external:                4
Broken total:                   5

CLI behavior:
- Exit with code `0` if no broken links are found.
- Exit with code `1` if broken links are found.

Implementation:
- Use TypeScript.
- Use a proper Markdown parser rather than relying only on regex.
- Keep the code modular and easy to test.
- Add automated tests for all important edge cases described above.
- Tests must verify that duplicate external URLs result in only one HTTP request while preserving all occurrences in the report.
- Add a README with installation and usage instructions.