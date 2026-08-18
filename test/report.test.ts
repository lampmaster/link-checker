import { describe, expect, it } from 'vitest';
import { formatJson, formatReport } from '../src/report.js';
import type { ScanResult } from '../src/types.js';

const result: ScanResult = {
  root: '/project',
  files: [],
  warnings: [],
  brokenLocalLinks: [
    {
      file: '/project/docs/guide.md',
      relativeFile: 'docs/guide.md',
      line: 18,
      link: '../api/missing.md',
      resolvedPath: '/project/api/missing.md',
      reason: 'File not found',
    },
  ],
  brokenExternalLinks: [
    {
      url: 'https://example.com/missing',
      kind: 'http-status',
      status: 404,
      reason: '404 Not Found',
      occurrences: [
        { file: '/project/README.md', relativeFile: 'README.md', line: 42, link: 'https://example.com/missing' },
        {
          file: '/project/docs/guide.md',
          relativeFile: 'docs/guide.md',
          line: 25,
          link: 'https://example.com/missing#top',
        },
      ],
    },
    {
      url: 'https://slow.example.com/',
      kind: 'timeout',
      reason: 'Timeout',
      occurrences: [
        { file: '/project/docs/setup.md', relativeFile: 'docs/setup.md', line: 91, link: 'https://slow.example.com/' },
      ],
    },
  ],
  summary: {
    filesScanned: 24,
    linkOccurrences: 137,
    uniqueExternalUrlsChecked: 53,
    valid: 131,
    notChecked: 2,
    brokenLocal: 1,
    brokenExternal: 3,
    brokenTotal: 4,
  },
};

const render = (input: ScanResult = result) => formatReport(input, { color: false, width: 140 });

describe('formatReport', () => {
  it('shows the header and the scanned root', () => {
    const output = render();
    expect(output).toContain('Markdown Link Checker');
    expect(output).toContain('Scanning: /project');
  });

  it('splits broken links into a local and an external section', () => {
    const output = render();
    expect(output).toContain('Broken local links');
    expect(output).toContain('Broken external links');
    expect(output.indexOf('Broken local links')).toBeLessThan(output.indexOf('Broken external links'));
  });

  it('shows file, line, link, resolved path and reason for a local failure', () => {
    const output = render();
    expect(output).toContain('docs/guide.md');
    expect(output).toContain('18');
    expect(output).toContain('../api/missing.md');
    expect(output).toContain('/project/api/missing.md');
    expect(output).toContain('File not found');
  });

  it('lists every occurrence of an external URL that was checked once', () => {
    const output = render();
    const rows = output.split('\n').filter((line) => line.includes('example.com/missing'));

    expect(rows).toHaveLength(2);
    expect(output).toContain('README.md');
    expect(output).toContain('42');
    expect(output).toContain('25');
  });

  it('distinguishes failure reasons', () => {
    const output = render();
    expect(output).toContain('404 Not Found');
    expect(output).toContain('Timeout');
  });

  it('prints the summary counts', () => {
    const output = render();
    expect(output).toMatch(/Files scanned:\s+24/);
    expect(output).toMatch(/Link occurrences:\s+137/);
    expect(output).toMatch(/Unique external URLs checked:\s+53/);
    expect(output).toMatch(/Valid:\s+131/);
    expect(output).toMatch(/Broken local:\s+1/);
    expect(output).toMatch(/Broken external:\s+3/);
    expect(output).toMatch(/Broken total:\s+4/);
  });

  it('says so when nothing is broken', () => {
    const clean: ScanResult = {
      ...result,
      brokenLocalLinks: [],
      brokenExternalLinks: [],
      summary: { ...result.summary, brokenLocal: 0, brokenExternal: 0, brokenTotal: 0, valid: 135 },
    };
    const output = render(clean);

    expect(output).toContain('No broken links found.');
    expect(output).not.toContain('Broken local links');
    expect(output).not.toContain('Broken external links');
  });

  it('omits the not-checked line when everything was checked', () => {
    const output = render({ ...result, summary: { ...result.summary, notChecked: 0 } });
    expect(output).not.toContain('Not checked');
  });

  it('shows warnings', () => {
    const output = render({ ...result, warnings: ['Cannot read /project/locked.md: EACCES'] });
    expect(output).toContain('Warning: Cannot read /project/locked.md: EACCES');
  });

  it('emits no ANSI escapes when colour is disabled', () => {
    // eslint-disable-next-line no-control-regex
    expect(render()).not.toMatch(/\u001B\[[0-9;]*m/);
  });

  it('emits ANSI escapes when colour is enabled', () => {
    const output = formatReport(result, { color: true, width: 140 });
    // eslint-disable-next-line no-control-regex
    expect(output).toMatch(/\u001B\[[0-9;]*m/);
  });

  it('stays within the requested width', () => {
    for (const width of [60, 80, 100, 200]) {
      const output = formatReport(result, { color: false, width });
      const longest = Math.max(...output.split('\n').map((line) => line.length));
      expect(longest).toBeLessThanOrEqual(Math.max(width, 60));
    }
  });
});

describe('formatJson', () => {
  it('produces parseable JSON with the full result', () => {
    const parsed = JSON.parse(formatJson(result));

    expect(parsed.root).toBe('/project');
    expect(parsed.summary.brokenTotal).toBe(4);
    expect(parsed.brokenLocalLinks).toHaveLength(1);
    expect(parsed.brokenExternalLinks[0].occurrences).toHaveLength(2);
  });
});
