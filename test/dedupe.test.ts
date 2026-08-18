import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
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

describe('external URL deduplication', () => {
  it('requests a repeated broken URL once but reports every occurrence', async () => {
    server = await startServer((request, response) => {
      response.writeHead(request.url === '/missing' ? 404 : 200).end();
    });
    const missing = `${server.origin}/missing`;

    const root = await fixture({
      'README.md': `intro\n\nsee [a](${missing})`,
      'docs/guide.md': `[b](${missing})`,
      'docs/api.md': `line one\n[c](${missing}) and [d](${missing})`,
    });

    const result = await scan(root);

    // One HTTP request, four reported occurrences.
    expect(server.requests).toEqual(['/missing']);
    expect(result.brokenExternalLinks).toHaveLength(1);

    const [broken] = result.brokenExternalLinks;
    expect(broken?.url).toBe(missing);
    expect(broken?.reason).toBe('404 Not Found');
    expect(broken?.occurrences.map((o) => [o.relativeFile, o.line])).toEqual([
      ['README.md', 3],
      [path.join('docs', 'api.md'), 2],
      [path.join('docs', 'api.md'), 2],
      [path.join('docs', 'guide.md'), 1],
    ]);

    expect(result.summary.uniqueExternalUrlsChecked).toBe(1);
    expect(result.summary.linkOccurrences).toBe(4);
    expect(result.summary.brokenExternal).toBe(4);
    expect(result.summary.brokenTotal).toBe(4);
  });

  it('counts occurrences, not requests, in the summary', async () => {
    server = await startServer((request, response) => {
      response.writeHead(request.url === '/missing' ? 404 : 200).end();
    });

    const root = await fixture({
      'a.md': [
        `[ok](${server.origin}/ok)`,
        `[ok again](${server.origin}/ok)`,
        `[bad](${server.origin}/missing)`,
        `[bad again](${server.origin}/missing)`,
      ].join('\n'),
    });

    const result = await scan(root);

    expect(server.requests.sort()).toEqual(['/missing', '/ok']);
    expect(result.summary).toMatchObject({
      linkOccurrences: 4,
      uniqueExternalUrlsChecked: 2,
      valid: 2,
      brokenExternal: 2,
      brokenTotal: 2,
    });
  });

  it('treats URLs differing only by fragment as the same request', async () => {
    server = await startServer((_, response) => response.writeHead(404).end());

    const root = await fixture({
      'a.md': [
        `[one](${server.origin}/page#intro)`,
        `[two](${server.origin}/page#usage)`,
        `[three](${server.origin}/page)`,
      ].join('\n'),
    });

    const result = await scan(root);

    expect(server.requests).toEqual(['/page']);
    expect(result.brokenExternalLinks).toHaveLength(1);
    expect(result.brokenExternalLinks[0]?.occurrences).toHaveLength(3);
    // Each occurrence keeps the link exactly as written, fragment included.
    expect(result.brokenExternalLinks[0]?.occurrences.map((o) => o.link)).toEqual([
      `${server.origin}/page#intro`,
      `${server.origin}/page#usage`,
      `${server.origin}/page`,
    ]);
  });

  it('treats equivalent spellings of the same URL as one request', async () => {
    server = await startServer((_, response) => response.writeHead(200).end());
    const port = new URL(server.origin).port;

    const root = await fixture({
      'a.md': [
        `[a](http://127.0.0.1:${port})`,
        `[b](http://127.0.0.1:${port}/)`,
        `[c](HTTP://127.0.0.1:${port}/)`,
      ].join('\n'),
    });

    const result = await scan(root);

    expect(server.requests).toEqual(['/']);
    expect(result.summary.uniqueExternalUrlsChecked).toBe(1);
    expect(result.summary.valid).toBe(3);
  });

  it('keeps URLs that differ by query string separate', async () => {
    server = await startServer((_, response) => response.writeHead(200).end());

    const root = await fixture({
      'a.md': [
        `[a](${server.origin}/p?v=1)`,
        `[b](${server.origin}/p?v=2)`,
        `[c](${server.origin}/p?v=1)`,
      ].join('\n'),
    });

    await scan(root);

    expect(server.requests.sort()).toEqual(['/p?v=1', '/p?v=2']);
  });

  it('deduplicates across many files and reports each occurrence once', async () => {
    server = await startServer((_, response) => response.writeHead(500).end());
    const url = `${server.origin}/api`;

    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) files[`docs/f${i}.md`] = `[x](${url})`;
    const root = await fixture(files);

    const result = await scan(root);

    expect(server.requests).toEqual(['/api']);
    expect(result.brokenExternalLinks).toHaveLength(1);
    expect(result.brokenExternalLinks[0]?.occurrences).toHaveLength(25);
    expect(result.brokenExternalLinks[0]?.reason).toBe('500 Internal Server Error');
    expect(result.summary.brokenExternal).toBe(25);
  });

  it('orders broken URLs by where they first appear', async () => {
    server = await startServer((_, response) => response.writeHead(404).end());

    const root = await fixture({
      'README.md': `[c](${server.origin}/c)`,
      'docs/a.md': `[a](${server.origin}/a)`,
      'docs/b.md': `[b](${server.origin}/b)`,
    });

    const result = await scan(root);

    expect(result.brokenExternalLinks.map((b) => b.occurrences[0]?.relativeFile)).toEqual([
      'README.md',
      path.join('docs', 'a.md'),
      path.join('docs', 'b.md'),
    ]);
  });

  it('makes no request at all when external checking is disabled', async () => {
    server = await startServer((_, response) => response.writeHead(404).end());

    const root = await fixture({ 'a.md': `[x](${server.origin}/missing)` });
    const result = await scan(root, { checkExternal: false });

    expect(server.requests).toEqual([]);
    expect(result.brokenExternalLinks).toEqual([]);
    expect(result.summary.notChecked).toBe(1);
  });

  it('reports a malformed URL once per distinct spelling, without any request', async () => {
    const root = await fixture({
      'a.md': '[x](https://)\n[y](https://)',
    });

    let called = 0;
    const result = await scan(root, {
      fetchImpl: async () => {
        called += 1;
        return new Response('', { status: 200 });
      },
    });

    expect(called).toBe(0);
    expect(result.brokenExternalLinks).toHaveLength(1);
    expect(result.brokenExternalLinks[0]).toMatchObject({
      kind: 'malformed-url',
      reason: 'Malformed URL',
    });
    expect(result.brokenExternalLinks[0]?.occurrences).toHaveLength(2);
    expect(result.summary.brokenExternal).toBe(2);
  });
});
