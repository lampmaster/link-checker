import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { LinkClass, LinkOccurrence } from './types.js';

export interface LocalResolution {
  /** The path reported to the user (first candidate that was tried). */
  resolvedPath: string;
  /** Every path considered valid for this link. */
  candidates: string[];
}

/**
 * Turn a local link into absolute filesystem candidates.
 *
 * Relative links resolve against the directory of the Markdown file that
 * contains them — never against the CWD or the repository root — so
 * `docs/guide.md` linking `../README.md` resolves to `<root>/README.md`.
 *
 * Root-absolute links (`/docs/x.md`) are ambiguous: in a docs site they mean
 * "relative to the repository root", on disk they mean "/". Both are accepted;
 * the repository-root interpretation is the one reported.
 *
 * Percent-encoded and literal spellings are both accepted, because
 * `./a%20b.md` may legitimately mean either `a b.md` or a file literally
 * named `a%20b.md`.
 */
export function resolveLocalLink(
  occurrence: LinkOccurrence,
  link: Extract<LinkClass, { kind: 'local' }>,
  root: string,
): LocalResolution {
  const fromDirectory = path.dirname(occurrence.file);
  const candidates: string[] = [];

  const add = (candidate: string): void => {
    const normalized = path.normalize(candidate);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  if (link.anchor === 'filesystem-absolute') {
    add(link.path);
  } else if (link.anchor === 'root-absolute') {
    add(path.join(root, link.path));
    add(path.resolve(link.path));
    if (link.rawPath !== link.path) add(path.join(root, link.rawPath));
  } else {
    add(path.resolve(fromDirectory, link.path));
    if (link.rawPath !== link.path) add(path.resolve(fromDirectory, link.rawPath));
  }

  return { resolvedPath: candidates[0]!, candidates };
}

export type LocalCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Check whether any candidate path exists. Directories count as valid targets.
 * Results are memoised per path so a link repeated across a repo costs one stat.
 */
export async function checkLocalPath(
  candidates: readonly string[],
  cache: Map<string, LocalCheckResult> = new Map(),
): Promise<LocalCheckResult> {
  let lastFailure: LocalCheckResult = { ok: false, reason: 'File not found' };

  for (const candidate of candidates) {
    const cached = cache.get(candidate);
    const result = cached ?? (await statPath(candidate));
    if (!cached) cache.set(candidate, result);
    if (result.ok) return result;
    lastFailure = result;
  }

  return lastFailure;
}

async function statPath(candidate: string): Promise<LocalCheckResult> {
  try {
    await stat(candidate);
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'File not found' };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: 'Permission denied' };
    if (code === 'ENAMETOOLONG') return { ok: false, reason: 'Path too long' };
    return { ok: false, reason: `Cannot access path (${code ?? 'unknown error'})` };
  }
}
