import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * Create a temporary directory tree.
 *
 * `files` maps a relative path to its contents; parent directories are created
 * automatically. An empty string value creates an empty file, which is enough
 * for existence checks.
 */
export async function createFixture(files: Record<string, string>): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  // macOS puts the temp dir behind a symlink (/var -> /private/var); resolving it
  // keeps expected absolute paths comparable to what the scanner reports.
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'link-checker-')));

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(base, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }

  return {
    root: base,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export interface TestServer {
  origin: string;
  /** Every path requested, in arrival order. */
  requests: string[];
  /** Highest number of simultaneously open requests observed. */
  maxConcurrent: number;
  close: () => Promise<void>;
}

/**
 * Start an HTTP server on an ephemeral port that records requests and tracks
 * how many were in flight at once.
 */
export async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => unknown,
): Promise<TestServer> {
  const state = { inFlight: 0, maxConcurrent: 0 };
  const requests: string[] = [];
  const openSockets = new Set<import('node:net').Socket>();

  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? '');
    state.inFlight += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
    response.on('close', () => {
      state.inFlight -= 1;
    });
    void handler(request, response);
  });

  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    get maxConcurrent() {
      return state.maxConcurrent;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Hanging requests (timeout tests) would otherwise keep the server open.
        for (const socket of openSockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Find a port that nothing is listening on, for connection-refused tests. */
export async function findClosedPort(): Promise<number> {
  const server = await startServer((_, response) => response.end());
  const port = Number(new URL(server.origin).port);
  await server.close();
  return port;
}
