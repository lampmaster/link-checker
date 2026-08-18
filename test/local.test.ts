import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { scan } from '../src/scan.js';
import { createFixture } from './helpers.js';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** Scan a fixture with the network switched off. */
async function scanLocal(files: Record<string, string>) {
  const created = await createFixture(files);
  cleanup = created.cleanup;
  const result = await scan(created.root, { checkExternal: false });
  return { root: created.root, result };
}

describe('local link resolution', () => {
  it('resolves relative links against the containing file, not the repository root', async () => {
    const { root, result } = await scanLocal({
      'README.md': '# Root readme',
      'docs/guide.md': 'Back to [readme](../README.md).',
    });

    expect(result.brokenLocalLinks).toEqual([]);
    expect(result.summary.valid).toBe(1);
    expect(root).toBeTruthy();
  });

  it('does not fall back to the repository root for a relative link', async () => {
    // `./README.md` inside docs/ must NOT match the README.md at the root.
    const { root, result } = await scanLocal({
      'README.md': '# Root readme',
      'docs/guide.md': 'See [readme](./README.md).',
    });

    expect(result.brokenLocalLinks).toHaveLength(1);
    expect(result.brokenLocalLinks[0]).toMatchObject({
      relativeFile: path.join('docs', 'guide.md'),
      line: 1,
      link: './README.md',
      resolvedPath: path.join(root, 'docs', 'README.md'),
      reason: 'File not found',
    });
  });

  it('reports the file, line, original link and resolved path of a broken link', async () => {
    const { root, result } = await scanLocal({
      'docs/guide.md': ['# Guide', '', 'intro', '', 'See [api](../api/missing.md).'].join('\n'),
    });

    expect(result.brokenLocalLinks).toEqual([
      {
        file: path.join(root, 'docs', 'guide.md'),
        relativeFile: path.join('docs', 'guide.md'),
        line: 5,
        link: '../api/missing.md',
        resolvedPath: path.join(root, 'api', 'missing.md'),
        reason: 'File not found',
      },
    ]);
  });

  it('supports ./, ../ and deeply nested paths', async () => {
    const { result } = await scanLocal({
      'a/b/c/deep.md': [
        '[same dir](./sibling.md)',
        '[up two](../../top.md)',
        '[down](./more/leaf.md)',
        '[missing](../nope.md)',
      ].join('\n'),
      'a/b/c/sibling.md': '',
      'a/top.md': '',
      'a/b/c/more/leaf.md': '',
    });

    expect(result.brokenLocalLinks.map((b) => b.link)).toEqual(['../nope.md']);
  });

  it('ignores the fragment when checking existence', async () => {
    const { result } = await scanLocal({
      'index.md': '[guide](./guide.md#installation)',
      'guide.md': '',
    });

    expect(result.brokenLocalLinks).toEqual([]);
    expect(result.summary.valid).toBe(1);
  });

  it('still reports a missing file when a fragment is present', async () => {
    const { result } = await scanLocal({ 'index.md': '[guide](./guide.md#installation)' });

    expect(result.brokenLocalLinks[0]).toMatchObject({
      link: './guide.md#installation',
      reason: 'File not found',
    });
    expect(result.brokenLocalLinks[0]?.resolvedPath.endsWith('guide.md')).toBe(true);
  });

  it('performs no filesystem check for fragment-only links', async () => {
    const { result } = await scanLocal({ 'index.md': '[top](#installation)\n[x](#)' });

    expect(result.brokenLocalLinks).toEqual([]);
    expect(result.summary.notChecked).toBe(2);
    expect(result.summary.valid).toBe(0);
  });

  it('ignores query strings when checking existence', async () => {
    const { result } = await scanLocal({
      'index.md': '[raw](./guide.md?raw=1)\n[both](./guide.md?raw=1#top)',
      'guide.md': '',
    });

    expect(result.brokenLocalLinks).toEqual([]);
  });

  it('resolves percent-encoded paths', async () => {
    const { result } = await scanLocal({
      'index.md': '[spaced](./my%20file.md)',
      'my file.md': '',
    });

    expect(result.brokenLocalLinks).toEqual([]);
  });

  it('resolves unicode percent-encoded paths', async () => {
    const { result } = await scanLocal({
      'index.md': '[doc](./%D0%B4%D0%BE%D0%BA.md)',
      'док.md': '',
    });

    expect(result.brokenLocalLinks).toEqual([]);
  });

  it('resolves angle-bracket destinations containing literal spaces', async () => {
    const { result } = await scanLocal({
      'index.md': '[spaced](<./my file.md>)',
      'my file.md': '',
    });

    expect(result.brokenLocalLinks).toEqual([]);
  });

  it('accepts a file literally named with a percent sequence', async () => {
    const { result } = await scanLocal({
      'index.md': '[weird](./a%20b.md)',
      'a%20b.md': '',
    });

    expect(result.brokenLocalLinks).toEqual([]);
  });

  it('resolves escaped characters in the destination', async () => {
    const { result } = await scanLocal({
      'index.md': '[escaped](./foo\\_bar.md)',
      'foo_bar.md': '',
    });

    expect(result.brokenLocalLinks).toEqual([]);
  });

  it('treats file:// links as absolute filesystem paths', async () => {
    const created = await createFixture({ 'target.md': '' });
    cleanup = created.cleanup;
    const target = path.join(created.root, 'target.md');
    await createFixture({});

    const result = await scan(created.root, { checkExternal: false });
    expect(result.summary.filesScanned).toBe(1);

    const withLink = await createFixture({
      'index.md': `[abs](file://${target})\n[missing](file:///definitely/not/here.md)`,
    });
    try {
      const second = await scan(withLink.root, { checkExternal: false });
      expect(second.brokenLocalLinks).toHaveLength(1);
      expect(second.brokenLocalLinks[0]).toMatchObject({
        link: 'file:///definitely/not/here.md',
        resolvedPath: path.normalize('/definitely/not/here.md'),
        reason: 'File not found',
      });
    } finally {
      await withLink.cleanup();
    }
  });

  it('decodes percent-encoding inside file:// links', async () => {
    const created = await createFixture({ 'my doc.md': '' });
    cleanup = created.cleanup;
    const encoded = `file://${created.root}/my%20doc.md`;

    const withLink = await createFixture({ 'index.md': `[abs](${encoded})` });
    try {
      const result = await scan(withLink.root, { checkExternal: false });
      expect(result.brokenLocalLinks).toEqual([]);
    } finally {
      await withLink.cleanup();
    }
  });

  it('accepts a link to an existing directory', async () => {
    const { result } = await scanLocal({
      'index.md': '[docs](./docs)',
      'docs/guide.md': '',
    });

    expect(result.brokenLocalLinks).toEqual([]);
  });

  it('resolves root-absolute links against the scan root', async () => {
    const { result } = await scanLocal({
      'docs/guide.md': '[abs](/README.md)\n[abs-missing](/nope.md)',
      'README.md': '',
    });

    expect(result.brokenLocalLinks.map((b) => b.link)).toEqual(['/nope.md']);
  });

  it('checks image destinations and reference definitions', async () => {
    const { result } = await scanLocal({
      'index.md': ['![logo](./logo.png)', '', '[ref link][ref]', '', '[ref]: ./missing-ref.md'].join(
        '\n',
      ),
    });

    expect(result.brokenLocalLinks.map((b) => [b.link, b.line])).toEqual([
      ['./logo.png', 1],
      ['./missing-ref.md', 5],
    ]);
  });

  it('checks each occurrence of a repeated local link', async () => {
    const { result } = await scanLocal({
      'a.md': '[x](./missing.md)',
      'b.md': '[x](./missing.md)\n[x](./missing.md)',
    });

    expect(result.brokenLocalLinks).toHaveLength(3);
    expect(result.summary.brokenLocal).toBe(3);
  });

  it('sorts broken local links by file and line', async () => {
    const { result } = await scanLocal({
      'z.md': '[a](./no1.md)',
      'a.md': '\n\n[b](./no2.md)\n[c](./no3.md)',
    });

    expect(result.brokenLocalLinks.map((b) => [b.relativeFile, b.line])).toEqual([
      ['a.md', 3],
      ['a.md', 4],
      ['z.md', 1],
    ]);
  });

  it('does not check mailto:, tel: or data: links', async () => {
    const { result } = await scanLocal({
      'index.md': '[m](mailto:a@b.com)\n[t](tel:+1)\n[d](data:text/plain,x)',
    });

    expect(result.brokenLocalLinks).toEqual([]);
    expect(result.summary.notChecked).toBe(3);
  });

  it('ignores empty link destinations', async () => {
    const { result } = await scanLocal({ 'index.md': '[empty]()' });

    expect(result.brokenLocalLinks).toEqual([]);
    expect(result.summary.notChecked).toBe(1);
  });
});
