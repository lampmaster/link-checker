import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { symlink } from 'node:fs/promises';
import { DEFAULT_IGNORED_DIRECTORIES, discoverMarkdownFiles } from '../src/discover.js';
import { createFixture } from './helpers.js';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const fixture = async (files: Record<string, string>) => {
  const created = await createFixture(files);
  cleanup = created.cleanup;
  return created.root;
};

const relative = (root: string, files: string[]) =>
  files.map((file) => path.relative(root, file)).sort();

describe('discoverMarkdownFiles', () => {
  it('finds Markdown files recursively', async () => {
    const root = await fixture({
      'README.md': '',
      'docs/guide.md': '',
      'docs/deep/nested/api.md': '',
      'src/index.ts': '',
      'notes.txt': '',
    });

    expect(relative(root, await discoverMarkdownFiles(root))).toEqual([
      'README.md',
      path.join('docs', 'deep', 'nested', 'api.md'),
      path.join('docs', 'guide.md'),
    ]);
  });

  it('ignores generated and vendor directories by default', async () => {
    const files: Record<string, string> = { 'README.md': '' };
    for (const directory of DEFAULT_IGNORED_DIRECTORIES) {
      files[`${directory}/ignored.md`] = '';
      files[`nested/${directory}/also-ignored.md`] = '';
    }
    const root = await fixture(files);

    expect(relative(root, await discoverMarkdownFiles(root))).toEqual(['README.md']);
  });

  it('accepts additional ignored directory names', async () => {
    const root = await fixture({ 'README.md': '', 'vendor/x.md': '' });

    expect(
      relative(root, await discoverMarkdownFiles(root, { ignore: ['vendor'] })),
    ).toEqual(['README.md']);
  });

  it('does not ignore dot-directories that are not on the list', async () => {
    const root = await fixture({ '.github/CONTRIBUTING.md': '', '.git/config.md': '' });

    expect(relative(root, await discoverMarkdownFiles(root))).toEqual([
      path.join('.github', 'CONTRIBUTING.md'),
    ]);
  });

  it('matches the extension case-insensitively', async () => {
    const root = await fixture({ 'A.MD': '', 'B.Md': '', 'C.markdown': '' });

    expect(relative(root, await discoverMarkdownFiles(root))).toEqual(['A.MD', 'B.Md']);
  });

  it('returns results in a deterministic order', async () => {
    const root = await fixture({ 'b.md': '', 'a.md': '', 'c/d.md': '' });
    const first = await discoverMarkdownFiles(root);
    const second = await discoverMarkdownFiles(root);

    expect(first).toEqual(second);
    // Byte order, so the result does not depend on the machine's locale.
    expect(first).toEqual([...first].sort());
  });

  it('accepts a single Markdown file as the root', async () => {
    const root = await fixture({ 'README.md': '' });
    const file = path.join(root, 'README.md');

    expect(await discoverMarkdownFiles(file)).toEqual([file]);
  });

  it('does not follow symlinked directories', async () => {
    const root = await fixture({ 'docs/a.md': '', 'other/b.md': '' });
    await symlink(path.join(root, 'other'), path.join(root, 'docs', 'link-to-other'));

    expect(relative(root, await discoverMarkdownFiles(root))).toEqual([
      path.join('docs', 'a.md'),
      path.join('other', 'b.md'),
    ]);
  });

  it('reports unreadable directories as warnings instead of failing', async () => {
    const root = await fixture({ 'a.md': '' });
    const warnings: string[] = [];

    const files = await discoverMarkdownFiles(root, {
      onWarning: (message) => warnings.push(message),
    });

    expect(files).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('returns an empty list for an empty tree', async () => {
    const root = await fixture({ 'src/index.ts': '' });
    expect(await discoverMarkdownFiles(root)).toEqual([]);
  });
});
