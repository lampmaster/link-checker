import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { scan } from '../src/scan.js';
import { createFixture, startServer, type TestServer } from './helpers.js';

let cleanup: (() => Promise<void>) | undefined;
let server: TestServer | undefined;

afterEach(async () => {
  await cleanup?.();
  await server?.close();
  cleanup = undefined;
  server = undefined;
});

async function fixture(files: Record<string, string>): Promise<string> {
  const created = await createFixture(files);
  cleanup = created.cleanup;
  return created.root;
}

describe('scan', () => {
  it('reports local and external failures side by side', async () => {
    server = await startServer((request, response) => {
      if (request.url === '/ok') return void response.writeHead(200).end();
      if (request.url === '/boom') return void response.writeHead(500).end();
      response.writeHead(404).end();
    });

    const root = await fixture({
      'README.md': [
        '# Project',
        '',
        `[good](${server.origin}/ok)`,
        `[gone](${server.origin}/missing)`,
        '[docs](./docs/guide.md)',
        '[nope](./docs/missing.md)',
        '[anchor](#section)',
        '[mail](mailto:a@b.com)',
      ].join('\n'),
      'docs/guide.md': [`[api](${server.origin}/boom)`, '[up](../README.md)'].join('\n'),
    });

    const result = await scan(root);

    expect(result.summary).toEqual({
      filesScanned: 2,
      linkOccurrences: 8,
      uniqueExternalUrlsChecked: 3,
      valid: 3,
      notChecked: 2,
      brokenLocal: 1,
      brokenExternal: 2,
      brokenTotal: 3,
    });

    expect(result.brokenLocalLinks.map((b) => b.link)).toEqual(['./docs/missing.md']);
    expect(result.brokenExternalLinks.map((b) => b.reason).sort()).toEqual([
      '404 Not Found',
      '500 Internal Server Error',
    ]);
  });

  it('returns a clean result for a repository with no broken links', async () => {
    const root = await fixture({
      'README.md': '[docs](./docs/guide.md)',
      'docs/guide.md': '[back](../README.md)',
    });

    const result = await scan(root, { checkExternal: false });

    expect(result.summary.brokenTotal).toBe(0);
    expect(result.summary.valid).toBe(2);
    expect(result.brokenLocalLinks).toEqual([]);
    expect(result.brokenExternalLinks).toEqual([]);
  });

  it('handles an empty project', async () => {
    const root = await fixture({ 'src/index.ts': '' });
    const result = await scan(root);

    expect(result.summary).toMatchObject({
      filesScanned: 0,
      linkOccurrences: 0,
      brokenTotal: 0,
    });
  });

  it('skips ignored directories', async () => {
    const root = await fixture({
      'README.md': '[a](./a.md)',
      'a.md': '',
      'node_modules/pkg/README.md': '[broken](./nope.md)',
      'dist/out.md': '[broken](./nope.md)',
    });

    const result = await scan(root, { checkExternal: false });

    // README.md and a.md; nothing under node_modules/ or dist/.
    expect(result.summary.filesScanned).toBe(2);
    expect(result.summary.brokenTotal).toBe(0);
  });

  it('lets extra ignore entries stack on top of the defaults', async () => {
    const root = await fixture({
      'README.md': '',
      'vendor/x.md': '[broken](./nope.md)',
      'node_modules/y.md': '[broken](./nope.md)',
    });

    const result = await scan(root, { checkExternal: false, ignore: ['vendor'] });
    expect(result.summary.filesScanned).toBe(1);
  });

  it('can replace the default ignore list', async () => {
    const root = await fixture({
      'README.md': '',
      'dist/x.md': '',
    });

    const result = await scan(root, { checkExternal: false, ignoreOverride: ['.git'] });
    expect(result.summary.filesScanned).toBe(2);
  });

  it('accepts a relative path and resolves it', async () => {
    const root = await fixture({ 'README.md': '[a](./missing.md)' });
    const result = await scan(path.relative(process.cwd(), root), { checkExternal: false });

    expect(result.root).toBe(root);
    expect(result.brokenLocalLinks).toHaveLength(1);
  });

  it('continues after an unreadable file and records a warning', async () => {
    const root = await fixture({ 'ok.md': '[a](./ok.md)', 'locked.md': '[b](./nope.md)' });
    const locked = path.join(root, 'locked.md');
    await chmod(locked, 0o000);

    try {
      const result = await scan(root, { checkExternal: false });

      // Running as root defeats the permission bit; only assert when it took effect.
      if (result.warnings.length > 0) {
        expect(result.warnings[0]).toContain('locked.md');
        expect(result.summary.filesScanned).toBe(2);
        expect(result.brokenLocalLinks).toEqual([]);
      }
    } finally {
      await chmod(locked, 0o644);
    }
  });

  it('reports progress events', async () => {
    server = await startServer((_, response) => response.writeHead(200).end());
    const root = await fixture({ 'a.md': `[x](${server.origin}/a)\n[y](./a.md)` });

    const events: string[] = [];
    await scan(root, { onProgress: (event) => events.push(event.type) });

    expect(events).toContain('files-discovered');
    expect(events).toContain('links-extracted');
    expect(events).toContain('external-checked');
  });

  it('scans a single Markdown file', async () => {
    const root = await fixture({ 'docs/guide.md': '[x](./missing.md)' });
    const result = await scan(path.join(root, 'docs', 'guide.md'), { checkExternal: false });

    expect(result.summary.filesScanned).toBe(1);
    expect(result.brokenLocalLinks[0]).toMatchObject({
      relativeFile: 'guide.md',
      resolvedPath: path.join(root, 'docs', 'missing.md'),
    });
  });

  it('does not confuse a directory named like a Markdown file', async () => {
    const root = await fixture({ 'README.md': '[x](./weird.md/inner.md)' });
    await mkdir(path.join(root, 'weird.md'), { recursive: true });

    const result = await scan(root, { checkExternal: false });
    expect(result.brokenLocalLinks).toHaveLength(1);
  });

  it('uses the injected fetch implementation', async () => {
    const seen: string[] = [];
    const root = await fixture({ 'a.md': '[x](https://example.com/a)' });

    const result = await scan(root, {
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response('', { status: 404 });
      },
    });

    expect(seen).toEqual(['https://example.com/a']);
    expect(result.summary.brokenExternal).toBe(1);
  });
});
