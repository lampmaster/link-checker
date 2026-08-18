import { fileURLToPath } from 'node:url';
import type { LinkClass } from './types.js';

/** `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` per RFC 3986. */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Percent-decode a path, tolerating malformed sequences.
 *
 * `./100%_done.md` is a perfectly valid filename but not valid percent-encoding,
 * so a decode failure falls back to the original text instead of throwing.
 */
export function percentDecode(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Split `path?query#fragment` on the *first* `?` / `#`, URL-style. */
function splitTarget(target: string): { path: string; query?: string; fragment?: string } {
  let rest = target;
  let fragment: string | undefined;
  let query: string | undefined;

  const hash = rest.indexOf('#');
  if (hash !== -1) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }

  const question = rest.indexOf('?');
  if (question !== -1) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }

  return { path: rest, query, fragment };
}

/**
 * Decide what kind of link a Markdown destination is, without touching the
 * filesystem or the network.
 */
export function classifyLink(target: string): LinkClass {
  const value = target.trim();

  if (value === '') return { kind: 'empty' };

  // Pure fragment: `#installation` — never a filesystem check.
  if (value.startsWith('#')) return { kind: 'fragment', fragment: value.slice(1) };

  // Protocol-relative URL: `//example.com/x`. Browsers inherit the page scheme;
  // for a static check https is the only sensible assumption.
  if (value.startsWith('//')) {
    return toExternal(`https:${value}`);
  }

  const schemeMatch = SCHEME_RE.exec(value);
  // A single-letter "scheme" is a Windows drive letter (`C:/docs/x.md`), not a URL.
  if (schemeMatch && schemeMatch[1]!.length > 1) {
    const scheme = schemeMatch[1]!.toLowerCase();

    if (scheme === 'http' || scheme === 'https') return toExternal(value);
    if (scheme === 'file') return toFileUrl(value);

    return { kind: 'unsupported', scheme };
  }

  const { path, query, fragment } = splitTarget(value);

  // `?tab=readme` or `#x` style targets carry no path to resolve.
  if (path === '') return { kind: 'fragment', fragment: fragment ?? '' };

  return {
    kind: 'local',
    path: percentDecode(path),
    rawPath: path,
    ...(fragment !== undefined ? { fragment } : {}),
    ...(query !== undefined ? { query } : {}),
    anchor: path.startsWith('/') ? 'root-absolute' : 'relative',
  };
}

function toExternal(value: string): LinkClass {
  try {
    const url = new URL(value);
    if (!url.hostname) return { kind: 'malformed', reason: 'URL has no host' };
    return { kind: 'external', url: url.toString() };
  } catch {
    return { kind: 'malformed', reason: 'Malformed URL' };
  }
}

function toFileUrl(value: string): LinkClass {
  try {
    const url = new URL(value);
    const fragment = url.hash ? url.hash.slice(1) : undefined;
    const query = url.search ? url.search.slice(1) : undefined;
    // `fileURLToPath` only looks at host + pathname, but clearing these keeps
    // the conversion unambiguous.
    url.hash = '';
    url.search = '';
    const path = fileURLToPath(url);
    return {
      kind: 'local',
      path,
      rawPath: path,
      ...(fragment !== undefined ? { fragment } : {}),
      ...(query !== undefined ? { query } : {}),
      anchor: 'filesystem-absolute',
    };
  } catch {
    return { kind: 'malformed', reason: 'Malformed file: URL' };
  }
}

/**
 * Canonical form of an external URL, used as the deduplication key.
 *
 * Fragments are dropped because they are never sent to the server: two links
 * differing only by `#section` are the same HTTP request. Scheme/host casing and
 * default ports are normalised by the WHATWG URL parser.
 */
export function normalizeExternalUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  if (parsed.pathname === '') parsed.pathname = '/';
  return parsed.toString();
}
