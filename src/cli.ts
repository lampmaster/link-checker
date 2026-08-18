#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { DEFAULT_IGNORED_DIRECTORIES } from './discover.js';
import { DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS } from './external.js';
import { formatJson, formatReport } from './report.js';
import { scan } from './scan.js';

const VERSION = '1.0.0';

const HELP = `
Markdown Link Checker

  Recursively scans a project for .md files and verifies every link:
  local files must exist on disk, external http(s) URLs must answer 2xx/3xx.

Usage
  link-checker [path] [options]

Arguments
  path                       Directory (or single .md file) to scan.
                             Defaults to the current working directory.

Options
  --timeout <ms>             Per-request timeout.            (default ${DEFAULT_TIMEOUT_MS})
  --concurrency <n>          Simultaneous HTTP requests.     (default ${DEFAULT_CONCURRENCY})
  --ignore <name>            Extra directory name to skip. Repeatable, or comma separated.
  --only-ignore <list>       Replace the default ignore list entirely (comma separated).
  --no-external              Skip all HTTP requests; check local links only.
                             (Malformed URLs are still reported.)
  --no-images                Do not check image destinations.
  --no-definitions           Do not check [ref]: url definitions.
  --user-agent <string>      User-Agent header for HTTP requests.
  --json                     Print a machine-readable JSON report instead.
  --no-color                 Disable coloured output (NO_COLOR is honoured too).
  -h, --help                 Show this help.
  -v, --version              Show the version.

Default ignored directories
  ${DEFAULT_IGNORED_DIRECTORIES.join(', ')}

Exit codes
  0  no broken links
  1  broken links found
  2  the scan could not run (bad path or bad arguments)
`.trimStart();

function toPositiveInteger(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive number, received "${value}"`);
  }
  return Math.floor(parsed);
}

function splitList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(',')).map((v) => v.trim()).filter(Boolean);
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      // Enables the `--no-external` / `--no-color` spellings below.
      allowNegative: true,
      options: {
        timeout: { type: 'string' },
        concurrency: { type: 'string' },
        ignore: { type: 'string', multiple: true },
        'only-ignore': { type: 'string' },
        external: { type: 'boolean', default: true },
        images: { type: 'boolean', default: true },
        definitions: { type: 'boolean', default: true },
        'user-agent': { type: 'string' },
        json: { type: 'boolean', default: false },
        color: { type: 'boolean' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\nRun \`link-checker --help\`.\n`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (positionals.length > 1) {
    process.stderr.write(`Expected at most one path, received ${positionals.length}.\n`);
    return 2;
  }

  const target = path.resolve(positionals[0] ?? process.cwd());

  try {
    await stat(target);
  } catch {
    process.stderr.write(`Path not found: ${target}\n`);
    return 2;
  }

  let timeoutMs: number;
  let concurrency: number;
  try {
    timeoutMs = toPositiveInteger(values.timeout, '--timeout', DEFAULT_TIMEOUT_MS);
    concurrency = toPositiveInteger(values.concurrency, '--concurrency', DEFAULT_CONCURRENCY);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const quiet = values.json === true;
  const progress = (message: string): void => {
    if (!quiet) process.stderr.write(`${message}\n`);
  };

  const onlyIgnore = splitList(values['only-ignore'] ? [values['only-ignore']] : undefined);

  const result = await scan(target, {
    ignore: splitList(values.ignore),
    ...(onlyIgnore.length > 0 ? { ignoreOverride: onlyIgnore } : {}),
    timeoutMs,
    concurrency,
    checkExternal: values.external !== false,
    includeImages: values.images !== false,
    includeDefinitions: values.definitions !== false,
    ...(values['user-agent'] ? { userAgent: values['user-agent'] } : {}),
    onProgress: (event) => {
      if (event.type === 'files-discovered') {
        progress(`Found ${event.count} Markdown file${event.count === 1 ? '' : 's'}.`);
      } else if (event.type === 'links-extracted') {
        progress(
          `Checking ${event.occurrences} link occurrence${event.occurrences === 1 ? '' : 's'} ` +
            `(${event.uniqueExternalUrls} unique external URL${event.uniqueExternalUrls === 1 ? '' : 's'})...`,
        );
      }
    },
  });

  if (values.json) {
    process.stdout.write(`${formatJson(result)}\n`);
  } else {
    process.stdout.write(
      formatReport(result, {
        width: process.stdout.columns ?? 100,
        ...(values.color !== undefined ? { color: values.color } : {}),
      }),
    );
  }

  return result.summary.brokenTotal > 0 ? 1 : 0;
}

// Only run when executed as a program, so the module stays importable in tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`Unexpected error: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 2;
    });
}
