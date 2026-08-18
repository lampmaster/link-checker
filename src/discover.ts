import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Directories that virtually never contain source-of-truth Markdown. */
export const DEFAULT_IGNORED_DIRECTORIES = ['.git', 'node_modules', 'dist', 'build', 'coverage'];

export interface DiscoverOptions {
  /** Directory names to skip anywhere in the tree. */
  ignore?: readonly string[];
  /** File extensions to collect, lower-case and dot-prefixed. Default: `['.md']`. */
  extensions?: readonly string[];
  /** Collect non-fatal problems (unreadable directories) instead of throwing. */
  onWarning?: (message: string) => void;
}

/**
 * Recursively collect Markdown files under `root`.
 *
 * Symlinked directories are not traversed (they are the usual source of
 * infinite recursion and duplicate results); symlinked files are included.
 * Results are sorted so output is deterministic.
 */
export async function discoverMarkdownFiles(
  root: string,
  options: DiscoverOptions = {},
): Promise<string[]> {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORED_DIRECTORIES);
  const extensions = new Set(options.extensions ?? ['.md']);
  const found: string[] = [];

  const rootStat = await stat(root);
  if (rootStat.isFile()) {
    return extensions.has(path.extname(root).toLowerCase()) ? [root] : [];
  }

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      options.onWarning?.(`Cannot read directory ${dir}: ${describeError(error)}`);
      return;
    }

    const subdirectories: string[] = [];

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) subdirectories.push(full);
        continue;
      }

      // `isFile()` is false for symlinks; accept them if they resolve to a file.
      if (entry.isFile() || entry.isSymbolicLink()) {
        if (extensions.has(path.extname(entry.name).toLowerCase())) found.push(full);
      }
    }

    // Bounded fan-out keeps the file-descriptor count sane on huge trees.
    for (const subdirectory of subdirectories) {
      await walk(subdirectory);
    }
  };

  await walk(root);
  return found.sort(comparePaths);
}

/**
 * Byte-order comparison. `localeCompare` would order results differently
 * depending on the machine's locale/ICU build, which makes CI output unstable.
 */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}` : error.message;
  }
  return String(error);
}
