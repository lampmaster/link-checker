/**
 * Shared types for the Markdown link checker.
 *
 * The pipeline is:
 *   discover(.md files) -> extract(link occurrences) -> classify(pure) ->
 *   check local (fs) / check external (http, deduplicated) -> report
 */

/** Where a link literally appears in a Markdown file. */
export interface LinkOccurrence {
  /** Absolute path of the Markdown file containing the link. */
  file: string;
  /** Path of the Markdown file relative to the scan root (used for display). */
  relativeFile: string;
  /** 1-based line number where the link starts. */
  line: number;
  /** 1-based column where the link starts. */
  column: number;
  /**
   * The link destination exactly as written in the Markdown source
   * (before backslash-escape / character-reference decoding).
   */
  raw: string;
  /**
   * The link destination after Markdown-level decoding (backslash escapes and
   * character references such as `&amp;`). This is what gets resolved/requested.
   */
  target: string;
  /** Which Markdown construct the destination came from. */
  origin: 'link' | 'image' | 'definition';
}

/** Result of classifying a destination string, without touching fs or network. */
export type LinkClass =
  | { kind: 'empty' }
  /** `#section` — nothing to check on disk. */
  | { kind: 'fragment'; fragment: string }
  /** `http:` / `https:` (and protocol-relative `//host/path`). */
  | { kind: 'external'; url: string }
  /** A path on the local filesystem. */
  | {
      kind: 'local';
      /** Path portion, percent-decoded when possible, without query/fragment. */
      path: string;
      /** Path portion exactly as written (still percent-encoded), without query/fragment. */
      rawPath: string;
      fragment?: string;
      query?: string;
      /** How the path should be anchored. */
      anchor: 'relative' | 'root-absolute' | 'filesystem-absolute';
    }
  /** `mailto:`, `tel:`, `data:`, ... — recognised but intentionally not checked. */
  | { kind: 'unsupported'; scheme: string }
  | { kind: 'malformed'; reason: string };

export type ExternalFailureKind =
  | 'http-status'
  | 'timeout'
  | 'dns'
  | 'connection'
  | 'tls'
  | 'too-many-redirects'
  | 'malformed-url'
  | 'unknown';

export type ExternalCheckResult =
  | { ok: true; url: string; status: number; finalUrl: string }
  | {
      ok: false;
      url: string;
      kind: ExternalFailureKind;
      /** Human readable reason, e.g. `404 Not Found`, `Timeout`, `DNS error (ENOTFOUND)`. */
      reason: string;
      status?: number;
    };

export interface BrokenLocalLink {
  file: string;
  relativeFile: string;
  line: number;
  /** Link exactly as it appears in the Markdown file. */
  link: string;
  /** Absolute filesystem path the link resolved to. */
  resolvedPath: string;
  reason: string;
}

/** One broken external URL, together with every place it was found. */
export interface BrokenExternalLink {
  /** Normalised URL that was actually requested. */
  url: string;
  kind: ExternalFailureKind;
  reason: string;
  status?: number;
  occurrences: Array<{
    file: string;
    relativeFile: string;
    line: number;
    /** Link exactly as it appears in that Markdown file. */
    link: string;
  }>;
}

export interface ScanSummary {
  filesScanned: number;
  /** Every link found in every Markdown file (not unique URLs). */
  linkOccurrences: number;
  /** Unique external URLs that produced an HTTP request. */
  uniqueExternalUrlsChecked: number;
  /** Occurrences that were checked and turned out to be fine. */
  valid: number;
  /** Occurrences deliberately not checked (fragment-only, mailto:, ...). */
  notChecked: number;
  brokenLocal: number;
  brokenExternal: number;
  brokenTotal: number;
}

export interface ScanResult {
  root: string;
  files: string[];
  brokenLocalLinks: BrokenLocalLink[];
  brokenExternalLinks: BrokenExternalLink[];
  summary: ScanSummary;
  /** Non-fatal problems, e.g. a Markdown file that could not be read. */
  warnings: string[];
}
