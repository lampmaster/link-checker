import Table from 'cli-table3';
import pc from 'picocolors';
import type { ScanResult } from './types.js';

export interface ReportOptions {
  /** Terminal width used to size the tables. */
  width?: number;
  /** Force colours on/off; defaults to picocolors' auto-detection (respects NO_COLOR). */
  color?: boolean;
}

type Colorize = (value: string) => string;

interface Palette {
  bold: Colorize;
  dim: Colorize;
  red: Colorize;
  green: Colorize;
  yellow: Colorize;
  cyan: Colorize;
}

function palette(color: boolean | undefined): Palette {
  // `createColors` lets the caller force colours on or off; the default follows
  // picocolors' own detection, which already honours NO_COLOR and non-TTY output.
  const c = pc.createColors(color ?? pc.isColorSupported);
  return {
    bold: (v) => c.bold(v),
    dim: (v) => c.dim(v),
    red: (v) => c.red(v),
    green: (v) => c.green(v),
    yellow: (v) => c.yellow(v),
    cyan: (v) => c.cyan(v),
  };
}

/**
 * Distribute the available terminal width across flexible columns while
 * guaranteeing each a readable minimum.
 */
function columnWidths(total: number, minimums: number[], weights: number[]): number[] {
  const count = minimums.length;
  const smallest = 4;
  // cli-table3 `colWidths` include one space of padding on each side, and the
  // table draws `count + 1` vertical borders.
  const contentBudget = Math.max(total - (count + 1) - 2 * count, count * smallest);
  const minimumSum = minimums.reduce((a, b) => a + b, 0);
  const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
  const toColWidth = (content: number): number => content + 2;

  if (contentBudget <= minimumSum) {
    // Narrow terminal: shrink every column proportionally rather than overflow.
    const scale = contentBudget / minimumSum;
    const widths = minimums.map((min) => Math.max(smallest, Math.floor(min * scale)));

    for (let overflow = sum(widths) - contentBudget; overflow > 0; overflow -= 1) {
      const widest = widths.indexOf(Math.max(...widths));
      if (widths[widest]! <= smallest) break;
      widths[widest] = widths[widest]! - 1;
    }

    return widths.map(toColWidth);
  }

  const weightSum = sum(weights);
  if (weightSum === 0) return minimums.map(toColWidth);

  const spare = contentBudget - minimumSum;
  const widths = minimums.map((min, index) => min + Math.floor((spare * weights[index]!) / weightSum));

  // Hand any rounding remainder to the heaviest column.
  const heaviest = weights.indexOf(Math.max(...weights));
  widths[heaviest] = widths[heaviest]! + (contentBudget - sum(widths));

  return widths.map(toColWidth);
}

function makeTable(head: string[], colWidths: number[], colors: Palette): Table.Table {
  return new Table({
    head: head.map((cell) => colors.bold(colors.cyan(cell))),
    colWidths,
    wordWrap: true,
    wrapOnWordBoundary: false,
    style: { head: [], border: [] },
  });
}

/** Render the human-readable report. Returns the text; printing is the caller's job. */
export function formatReport(result: ScanResult, options: ReportOptions = {}): string {
  const colors = palette(options.color);
  const width = Math.max(options.width ?? 100, 60);
  const lines: string[] = [];

  lines.push('');
  lines.push(colors.bold('Markdown Link Checker'));
  lines.push('');
  lines.push(`${colors.dim('Scanning:')} ${result.root}`);
  lines.push('');

  for (const warning of result.warnings) {
    lines.push(colors.yellow(`Warning: ${warning}`));
  }
  if (result.warnings.length > 0) lines.push('');

  if (result.brokenLocalLinks.length > 0) {
    lines.push(colors.bold(colors.red('Broken local links')));
    lines.push('');

    const widths = columnWidths(width, [22, 4, 20, 24, 14], [2, 0, 3, 3, 0]);
    const table = makeTable(['File', 'Line', 'Link', 'Resolved path', 'Result'], widths, colors);

    for (const broken of result.brokenLocalLinks) {
      table.push([
        broken.relativeFile,
        String(broken.line),
        broken.link,
        colors.dim(broken.resolvedPath),
        colors.red(broken.reason),
      ]);
    }

    lines.push(table.toString());
    lines.push('');
  }

  if (result.brokenExternalLinks.length > 0) {
    lines.push(colors.bold(colors.red('Broken external links')));
    lines.push('');

    const widths = columnWidths(width, [22, 4, 28, 20], [2, 0, 4, 0]);
    const table = makeTable(['File', 'Line', 'URL', 'Result'], widths, colors);

    // Occurrences of one URL are listed together: the URL was requested once,
    // but every place it appears is reported.
    for (const broken of result.brokenExternalLinks) {
      for (const occurrence of broken.occurrences) {
        table.push([
          occurrence.relativeFile,
          String(occurrence.line),
          occurrence.link,
          colors.red(broken.reason),
        ]);
      }
    }

    lines.push(table.toString());
    lines.push('');
  }

  if (result.summary.brokenTotal === 0) {
    lines.push(colors.green('No broken links found.'));
    lines.push('');
  }

  lines.push(colors.bold('Summary'));
  lines.push('');
  lines.push(...summaryLines(result, colors));
  lines.push('');

  return lines.join('\n');
}

function summaryLines(result: ScanResult, colors: Palette): string[] {
  const { summary } = result;
  const rows: Array<[string, string, Colorize]> = [
    ['Files scanned:', String(summary.filesScanned), (v) => v],
    ['Link occurrences:', String(summary.linkOccurrences), (v) => v],
    ['Unique external URLs checked:', String(summary.uniqueExternalUrlsChecked), (v) => v],
    ['Valid:', String(summary.valid), colors.green],
  ];

  if (summary.notChecked > 0) {
    rows.push(['Not checked (fragment/other):', String(summary.notChecked), colors.dim]);
  }

  const broken: Colorize = summary.brokenTotal > 0 ? colors.red : colors.green;
  rows.push(['Broken local:', String(summary.brokenLocal), broken]);
  rows.push(['Broken external:', String(summary.brokenExternal), broken]);
  rows.push(['Broken total:', String(summary.brokenTotal), (v) => colors.bold(broken(v))]);

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const valueWidth = Math.max(...rows.map(([, value]) => value.length));

  return rows.map(
    ([label, value, color]) => `  ${label.padEnd(labelWidth + 2)}${color(value.padStart(valueWidth))}`,
  );
}

/** Machine-readable report for CI pipelines (`--json`). */
export function formatJson(result: ScanResult): string {
  return JSON.stringify(
    {
      root: result.root,
      summary: result.summary,
      brokenLocalLinks: result.brokenLocalLinks,
      brokenExternalLinks: result.brokenExternalLinks,
      warnings: result.warnings,
    },
    null,
    2,
  );
}
