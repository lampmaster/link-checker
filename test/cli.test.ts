import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, startServer, type TestServer } from './helpers.js';

const run = promisify(execFile);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(projectRoot, 'src', 'cli.ts');
const tsx = path.join(projectRoot, 'node_modules', '.bin', 'tsx');

let cleanup: (() => Promise<void>) | undefined;
let server: TestServer | undefined;

afterEach(async () => {
  await cleanup?.();
  await server?.close();
  cleanup = undefined;
  server = undefined;
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], options: { cwd?: string } = {}): Promise<CliRun> {
  try {
    const { stdout, stderr } = await run(tsx, [cliEntry, ...args], {
      cwd: options.cwd ?? projectRoot,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function fixture(files: Record<string, string>): Promise<string> {
  const created = await createFixture(files);
  cleanup = created.cleanup;
  return created.root;
}

describe('cli', () => {
  it('exits 0 when there are no broken links', async () => {
    const root = await fixture({ 'README.md': '[a](./a.md)', 'a.md': '' });
    const result = await cli([root, '--no-external']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No broken links found.');
  });

  it('exits 1 when broken links are found', async () => {
    const root = await fixture({ 'README.md': '[a](./missing.md)' });
    const result = await cli([root, '--no-external']);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Broken local links');
    expect(result.stdout).toContain('./missing.md');
    expect(result.stdout).toContain('File not found');
  });

  it('scans the current working directory when no path is given', async () => {
    const root = await fixture({ 'README.md': '[a](./missing.md)' });
    const result = await cli(['--no-external'], { cwd: root });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`Scanning: ${root}`);
  });

  it('reports both sections and the summary', async () => {
    server = await startServer((_, response) => response.writeHead(404).end());
    const root = await fixture({
      'README.md': `[bad](./missing.md)\n[gone](${server.origin}/x)`,
    });

    const result = await cli([root]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Broken local links');
    expect(result.stdout).toContain('Broken external links');
    expect(result.stdout).toContain('404 Not Found');
    expect(result.stdout).toMatch(/Broken total:\s+2/);
  });

  it('emits JSON with --json and keeps stdout free of progress output', async () => {
    const root = await fixture({ 'README.md': '[a](./missing.md)' });
    const result = await cli([root, '--no-external', '--json']);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary.brokenLocal).toBe(1);
    expect(parsed.brokenLocalLinks[0].link).toBe('./missing.md');
    expect(result.stderr).toBe('');
  });

  it('writes progress to stderr, not stdout', async () => {
    const root = await fixture({ 'README.md': '[a](./a.md)', 'a.md': '' });
    const result = await cli([root, '--no-external']);

    expect(result.stderr).toContain('Found 2 Markdown files.');
    expect(result.stdout).not.toContain('Found 2 Markdown files.');
  });

  it('exits 2 for a path that does not exist', async () => {
    const result = await cli(['/definitely/not/a/real/path']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Path not found');
  });

  it('exits 2 for an unknown option', async () => {
    const result = await cli(['--nope']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--help');
  });

  it('exits 2 for an invalid numeric option', async () => {
    const root = await fixture({ 'README.md': '' });
    const result = await cli([root, '--timeout', 'soon']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--timeout expects a positive number');
  });

  it('prints help and version', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage');
    expect(help.stdout).toContain('--no-external');

    const version = await cli(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('honours --ignore', async () => {
    const root = await fixture({ 'README.md': '', 'vendor/x.md': '[a](./missing.md)' });

    expect((await cli([root, '--no-external'])).code).toBe(1);
    expect((await cli([root, '--no-external', '--ignore', 'vendor'])).code).toBe(0);
  });

  it('honours --no-images', async () => {
    const root = await fixture({ 'README.md': '![a](./missing.png)' });

    expect((await cli([root, '--no-external'])).code).toBe(1);
    expect((await cli([root, '--no-external', '--no-images'])).code).toBe(0);
  });

  it('rejects more than one path argument', async () => {
    const result = await cli(['a', 'b']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('at most one path');
  });
});
