import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { classifyLink, normalizeExternalUrl } from './classify.js';
import { mapWithConcurrency } from './concurrency.js';
import {
  DEFAULT_IGNORED_DIRECTORIES,
  comparePaths,
  describeError,
  discoverMarkdownFiles,
} from './discover.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  checkExternalUrls,
  type FetchLike,
} from './external.js';
import { checkLocalPath, resolveLocalLink, type LocalCheckResult } from './local.js';
import { extractLinks } from './extract.js';
import type {
  BrokenExternalLink,
  BrokenLocalLink,
  ExternalCheckResult,
  LinkOccurrence,
  ScanResult,
} from './types.js';

export interface ScanOptions {
  /** Extra directory names to skip, on top of the defaults. */
  ignore?: readonly string[];
  /** Replace the default ignore list entirely. */
  ignoreOverride?: readonly string[];
  timeoutMs?: number;
  concurrency?: number;
  /** Skip all HTTP requests (local links are still checked). */
  checkExternal?: boolean;
  includeImages?: boolean;
  includeDefinitions?: boolean;
  userAgent?: string;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { type: 'files-discovered'; count: number }
  | { type: 'links-extracted'; occurrences: number; uniqueExternalUrls: number }
  | { type: 'external-checked'; done: number; total: number; result: ExternalCheckResult };

interface PendingLocal {
  occurrence: LinkOccurrence;
  resolvedPath: string;
  candidates: string[];
}

interface PendingExternal {
  /** Normalised URL that will be requested (deduplication key). */
  url: string;
  occurrences: LinkOccurrence[];
}

/** Read every Markdown file under `root` and check every link it contains. */
export async function scan(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absoluteRoot = path.resolve(root);
  const warnings: string[] = [];

  const ignore = options.ignoreOverride ?? [
    ...new Set([...DEFAULT_IGNORED_DIRECTORIES, ...(options.ignore ?? [])]),
  ];

  const files = await discoverMarkdownFiles(absoluteRoot, {
    ignore,
    onWarning: (message) => warnings.push(message),
  });
  options.onProgress?.({ type: 'files-discovered', count: files.length });

  // Display paths are relative to the scan root; when the root is a single
  // file, relative to its directory.
  const displayBase = files.length === 1 && files[0] === absoluteRoot
    ? path.dirname(absoluteRoot)
    : absoluteRoot;

  const perFileOccurrences = await mapWithConcurrency(files, 16, async (file) => {
    try {
      const source = await readFile(file, 'utf8');
      return extractLinks(source, {
        file,
        relativeFile: path.relative(displayBase, file) || path.basename(file),
        includeImages: options.includeImages ?? true,
        includeDefinitions: options.includeDefinitions ?? true,
      });
    } catch (error) {
      warnings.push(`Cannot read ${file}: ${describeError(error)}`);
      return [] as LinkOccurrence[];
    }
  });

  const occurrences = perFileOccurrences.flat();

  const pendingLocal: PendingLocal[] = [];
  const pendingExternal = new Map<string, PendingExternal>();
  const brokenLocalLinks: BrokenLocalLink[] = [];
  /** Malformed URLs never reach the network but are still reported as broken. */
  const malformedExternal = new Map<string, BrokenExternalLink>();
  let notChecked = 0;

  for (const occurrence of occurrences) {
    const classified = classifyLink(occurrence.target);

    switch (classified.kind) {
      case 'empty':
      case 'fragment':
      case 'unsupported':
        notChecked += 1;
        break;

      case 'local': {
        const { resolvedPath, candidates } = resolveLocalLink(occurrence, classified, absoluteRoot);
        pendingLocal.push({ occurrence, resolvedPath, candidates });
        break;
      }

      case 'external': {
        if (options.checkExternal === false) {
          notChecked += 1;
          break;
        }
        let key: string;
        try {
          key = normalizeExternalUrl(classified.url);
        } catch {
          addMalformed(malformedExternal, occurrence, 'Malformed URL');
          break;
        }
        const existing = pendingExternal.get(key);
        if (existing) existing.occurrences.push(occurrence);
        else pendingExternal.set(key, { url: key, occurrences: [occurrence] });
        break;
      }

      case 'malformed': {
        if (looksExternal(occurrence.target)) {
          addMalformed(malformedExternal, occurrence, classified.reason);
        } else {
          brokenLocalLinks.push({
            file: occurrence.file,
            relativeFile: occurrence.relativeFile,
            line: occurrence.line,
            link: occurrence.raw,
            resolvedPath: '—',
            reason: classified.reason,
          });
        }
        break;
      }
    }
  }

  const uniqueExternalUrls = [...pendingExternal.keys()];
  options.onProgress?.({
    type: 'links-extracted',
    occurrences: occurrences.length,
    uniqueExternalUrls: uniqueExternalUrls.length,
  });

  // --- local checks ---------------------------------------------------------
  const statCache = new Map<string, LocalCheckResult>();
  const localResults = await mapWithConcurrency(pendingLocal, 32, (pending) =>
    checkLocalPath(pending.candidates, statCache),
  );

  localResults.forEach((result, index) => {
    if (result.ok) return;
    const pending = pendingLocal[index]!;
    brokenLocalLinks.push({
      file: pending.occurrence.file,
      relativeFile: pending.occurrence.relativeFile,
      line: pending.occurrence.line,
      link: pending.occurrence.raw,
      resolvedPath: pending.resolvedPath,
      reason: result.reason,
    });
  });

  brokenLocalLinks.sort(
    (a, b) => comparePaths(a.relativeFile, b.relativeFile) || a.line - b.line,
  );

  // --- external checks (one request per unique URL) -------------------------
  let done = 0;
  const externalResults = await checkExternalUrls(uniqueExternalUrls, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    onChecked: (result) => {
      done += 1;
      options.onProgress?.({
        type: 'external-checked',
        done,
        total: uniqueExternalUrls.length,
        result,
      });
    },
  });

  const brokenExternalLinks: BrokenExternalLink[] = [...malformedExternal.values()];

  for (const [url, pending] of pendingExternal) {
    const result = externalResults.get(url);
    if (!result || result.ok) continue;
    brokenExternalLinks.push({
      url,
      kind: result.kind,
      reason: result.reason,
      ...(result.status !== undefined ? { status: result.status } : {}),
      occurrences: pending.occurrences.map((occurrence) => ({
        file: occurrence.file,
        relativeFile: occurrence.relativeFile,
        line: occurrence.line,
        link: occurrence.raw,
      })),
    });
  }

  // Group order follows the first place each URL appears, so the report reads
  // in roughly document order even though each URL is checked only once.
  brokenExternalLinks.sort((a, b) => {
    const first = a.occurrences[0]!;
    const second = b.occurrences[0]!;
    return comparePaths(first.relativeFile, second.relativeFile) || first.line - second.line;
  });

  const brokenExternalOccurrences = brokenExternalLinks.reduce(
    (total, entry) => total + entry.occurrences.length,
    0,
  );
  const brokenTotal = brokenLocalLinks.length + brokenExternalOccurrences;

  return {
    root: absoluteRoot,
    files,
    brokenLocalLinks,
    brokenExternalLinks,
    warnings,
    summary: {
      filesScanned: files.length,
      linkOccurrences: occurrences.length,
      uniqueExternalUrlsChecked: uniqueExternalUrls.length,
      valid: occurrences.length - notChecked - brokenTotal,
      notChecked,
      brokenLocal: brokenLocalLinks.length,
      brokenExternal: brokenExternalOccurrences,
      brokenTotal,
    },
  };
}

function looksExternal(target: string): boolean {
  return /^(https?:|\/\/)/i.test(target.trim());
}

function addMalformed(
  bucket: Map<string, BrokenExternalLink>,
  occurrence: LinkOccurrence,
  reason: string,
): void {
  const key = occurrence.target.trim();
  const entry = bucket.get(key);
  const item = {
    file: occurrence.file,
    relativeFile: occurrence.relativeFile,
    line: occurrence.line,
    link: occurrence.raw,
  };
  if (entry) entry.occurrences.push(item);
  else bucket.set(key, { url: key, kind: 'malformed-url', reason, occurrences: [item] });
}
