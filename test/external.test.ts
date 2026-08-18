import { afterEach, describe, expect, it } from 'vitest';
import {
  checkExternalUrl,
  checkExternalUrls,
  classifyRequestError,
  statusReason,
} from '../src/external.js';
import { mapWithConcurrency } from '../src/concurrency.js';
import { findClosedPort, startServer, type TestServer } from './helpers.js';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A server covering the response shapes the checker has to judge. */
async function routedServer(): Promise<TestServer> {
  return startServer((request, response) => {
    const url = request.url ?? '/';

    if (url === '/ok') return void response.writeHead(200).end('hello');
    if (url === '/created') return void response.writeHead(201).end();
    if (url === '/not-modified') return void response.writeHead(304).end();
    if (url === '/missing') return void response.writeHead(404).end();
    if (url === '/boom') return void response.writeHead(500).end();
    if (url === '/teapot') return void response.writeHead(418).end();
    if (url === '/redirect-to-ok') return void response.writeHead(302, { location: '/ok' }).end();
    if (url === '/redirect-to-missing') {
      return void response.writeHead(301, { location: '/missing' }).end();
    }
    if (url === '/redirect-chain-1') {
      return void response.writeHead(302, { location: '/redirect-chain-2' }).end();
    }
    if (url === '/redirect-chain-2') {
      return void response.writeHead(302, { location: '/ok' }).end();
    }
    if (url === '/redirect-loop') {
      return void response.writeHead(302, { location: '/redirect-loop' }).end();
    }
    if (url === '/dangling-redirect') {
      // A 3xx with no Location cannot be followed: the final status is 3xx.
      return void response.writeHead(302).end();
    }
    if (url === '/hang') return; // never responds
    if (url === '/no-status-text') return void response.writeHead(404, '').end();
    if (url === '/big') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      return void response.end(Buffer.alloc(1024 * 512));
    }

    response.writeHead(404).end();
  });
}

describe('checkExternalUrl', () => {
  it('treats a 2xx response as valid', async () => {
    server = await routedServer();
    await expect(checkExternalUrl(`${server.origin}/ok`)).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    await expect(checkExternalUrl(`${server.origin}/created`)).resolves.toMatchObject({
      ok: true,
      status: 201,
    });
  });

  it('treats a final 3xx response as valid', async () => {
    server = await routedServer();
    await expect(checkExternalUrl(`${server.origin}/dangling-redirect`)).resolves.toMatchObject({
      ok: true,
      status: 302,
    });
  });

  it('follows redirects and judges the final response', async () => {
    server = await routedServer();

    await expect(checkExternalUrl(`${server.origin}/redirect-to-ok`)).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    await expect(checkExternalUrl(`${server.origin}/redirect-chain-1`)).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
    await expect(checkExternalUrl(`${server.origin}/redirect-to-missing`)).resolves.toMatchObject({
      ok: false,
      status: 404,
      reason: '404 Not Found',
    });
  });

  it('reports the final URL after redirects', async () => {
    server = await routedServer();
    const result = await checkExternalUrl(`${server.origin}/redirect-chain-1`);

    expect(result.ok && result.finalUrl).toBe(`${server.origin}/ok`);
  });

  it('distinguishes 404 from 500', async () => {
    server = await routedServer();

    await expect(checkExternalUrl(`${server.origin}/missing`)).resolves.toMatchObject({
      ok: false,
      kind: 'http-status',
      status: 404,
      reason: '404 Not Found',
    });
    await expect(checkExternalUrl(`${server.origin}/boom`)).resolves.toMatchObject({
      ok: false,
      kind: 'http-status',
      status: 500,
      reason: '500 Internal Server Error',
    });
  });

  it('falls back to a standard reason phrase when the server sends none', async () => {
    server = await routedServer();
    await expect(checkExternalUrl(`${server.origin}/no-status-text`)).resolves.toMatchObject({
      reason: '404 Not Found',
    });
  });

  it('reports a timeout', async () => {
    server = await routedServer();
    const result = await checkExternalUrl(`${server.origin}/hang`, { timeoutMs: 150 });

    expect(result).toMatchObject({ ok: false, kind: 'timeout', reason: 'Timeout' });
  });

  it('does not let a timeout exceed the configured budget by much', async () => {
    server = await routedServer();
    const started = Date.now();
    await checkExternalUrl(`${server.origin}/hang`, { timeoutMs: 200 });

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reports a refused connection', async () => {
    const port = await findClosedPort();
    const result = await checkExternalUrl(`http://127.0.0.1:${port}/`);

    expect(result).toMatchObject({ ok: false, kind: 'connection' });
    expect(result.ok === false && result.reason).toContain('ECONNREFUSED');
  });

  it('reports too many redirects instead of looping forever', async () => {
    server = await routedServer();
    const result = await checkExternalUrl(`${server.origin}/redirect-loop`);

    expect(result).toMatchObject({ ok: false, kind: 'too-many-redirects' });
  });

  it('reports a malformed URL instead of throwing', async () => {
    await expect(checkExternalUrl('http://')).resolves.toMatchObject({
      ok: false,
      kind: 'malformed-url',
      reason: 'Malformed URL',
    });
    await expect(checkExternalUrl('https://exa mple.com')).resolves.toMatchObject({
      ok: false,
      kind: 'malformed-url',
    });
  });

  it('never throws, whatever fetch does', async () => {
    const explode = () => Promise.reject(new Error('kaboom'));
    await expect(
      checkExternalUrl('https://example.com/', { fetchImpl: explode }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('does not download the response body', async () => {
    server = await routedServer();
    // A 512 KiB body must not be buffered; the check only needs the headers.
    await expect(checkExternalUrl(`${server.origin}/big`)).resolves.toMatchObject({ ok: true });
  });

  it('sends a descriptive user agent', async () => {
    let seen: string | undefined;
    server = await startServer((request, response) => {
      seen = request.headers['user-agent'];
      response.writeHead(200).end();
    });

    await checkExternalUrl(`${server.origin}/`, { userAgent: 'my-agent/2.0' });
    expect(seen).toBe('my-agent/2.0');
  });
});

describe('checkExternalUrls', () => {
  it('never lets one failure stop the others', async () => {
    server = await routedServer();
    const closedPort = await findClosedPort();

    const results = await checkExternalUrls([
      `${server.origin}/ok`,
      `${server.origin}/missing`,
      `http://127.0.0.1:${closedPort}/`,
      'http://',
      `${server.origin}/hang`,
      `${server.origin}/boom`,
    ], { timeoutMs: 200 });

    expect([...results.values()].map((r) => r.ok)).toEqual([true, false, false, false, false, false]);
  });

  it('honours the concurrency limit', async () => {
    server = await startServer(async (_, response) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      response.writeHead(200).end();
    });

    const urls = Array.from({ length: 30 }, (_, i) => `${server!.origin}/p${i}`);
    await checkExternalUrls(urls, { concurrency: 5 });

    expect(server.requests).toHaveLength(30);
    expect(server.maxConcurrent).toBeLessThanOrEqual(5);
    expect(server.maxConcurrent).toBeGreaterThan(1);
  });

  it('issues one request per unique URL even if the caller repeats them', async () => {
    server = await routedServer();
    const url = `${server.origin}/ok`;

    const results = await checkExternalUrls([url, url, url]);

    expect(server.requests).toEqual(['/ok']);
    expect(results.size).toBe(1);
  });
});

describe('classifyRequestError', () => {
  const wrap = (code: string) =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

  it('recognises DNS failures', () => {
    expect(classifyRequestError(wrap('ENOTFOUND'), 1000)).toEqual({
      kind: 'dns',
      reason: 'DNS error (ENOTFOUND)',
    });
    expect(classifyRequestError(wrap('EAI_AGAIN'), 1000).kind).toBe('dns');
  });

  it('recognises connection failures', () => {
    expect(classifyRequestError(wrap('ECONNREFUSED'), 1000)).toEqual({
      kind: 'connection',
      reason: 'Connection error (ECONNREFUSED)',
    });
    expect(classifyRequestError(wrap('ECONNRESET'), 1000).kind).toBe('connection');
    expect(classifyRequestError(wrap('EHOSTUNREACH'), 1000).kind).toBe('connection');
  });

  it('recognises TLS failures', () => {
    expect(classifyRequestError(wrap('CERT_HAS_EXPIRED'), 1000).kind).toBe('tls');
    expect(classifyRequestError(wrap('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 1000).kind).toBe('tls');
    expect(classifyRequestError(wrap('DEPTH_ZERO_SELF_SIGNED_CERT'), 1000).kind).toBe('tls');
  });

  it('recognises timeouts', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(classifyRequestError(abort, 1000)).toEqual({ kind: 'timeout', reason: 'Timeout' });
    expect(classifyRequestError(wrap('UND_ERR_HEADERS_TIMEOUT'), 1000).kind).toBe('timeout');
  });

  it('recognises redirect loops', () => {
    expect(classifyRequestError(new Error('redirect count exceeded'), 1000).kind).toBe(
      'too-many-redirects',
    );
  });

  it('falls back to a connection error for anything unknown', () => {
    expect(classifyRequestError(new Error('something odd'), 1000)).toEqual({
      kind: 'connection',
      reason: 'Connection error (something odd)',
    });
  });
});

describe('statusReason', () => {
  it('uses the reason phrase sent by the server', () => {
    expect(statusReason(404, 'Not Found')).toBe('404 Not Found');
    expect(statusReason(503, 'Service Unavailable')).toBe('503 Service Unavailable');
  });

  it('falls back to the standard phrase, then to a bare code', () => {
    expect(statusReason(500, '')).toBe('500 Internal Server Error');
    expect(statusReason(599, '')).toBe('HTTP 599');
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const out = await mapWithConcurrency([5, 1, 3], 2, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, n * 5));
      return n * 2;
    });

    expect(out).toEqual([10, 2, 6]);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 10, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 100, async (n) => n)).toEqual([1, 2]);
  });

  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(4);
  });
});
