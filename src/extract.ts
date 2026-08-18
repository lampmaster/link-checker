import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Root } from 'mdast';
import type { LinkOccurrence } from './types.js';

export interface ExtractOptions {
  /** Absolute path of the file (stored on each occurrence). */
  file: string;
  /** Display path, relative to the scan root. */
  relativeFile: string;
  /** Also check `![alt](src)` image destinations. Default: true. */
  includeImages?: boolean;
  /** Also check `[ref]: url` link reference definitions. Default: true. */
  includeDefinitions?: boolean;
}

/**
 * mdast decodes character references and backslash escapes into `node.url`, so
 * `node.url` is what we must resolve/request, but it is *not* what the author
 * typed. We capture the untouched source slice of every link destination while
 * parsing so the report can echo the link exactly as it appears in the file.
 *
 * These two handlers replace the built-in ones for the same tokens, so they
 * re-implement the built-in behaviour (`node.url = this.resume()`) verbatim and
 * only add the raw capture on top.
 */
function createRawDestinationCapture(): {
  extension: Record<string, unknown>;
  rawByNode: WeakMap<object, string>;
} {
  const rawByNode = new WeakMap<object, string>();

  function onExitDestinationString(this: any, token: unknown): void {
    const data: string = this.resume();
    const node = this.stack[this.stack.length - 1];
    node.url = data;
    rawByNode.set(node, this.sliceSerialize(token));
  }

  return {
    extension: {
      exit: {
        resourceDestinationString: onExitDestinationString,
        definitionDestinationString: onExitDestinationString,
      },
    },
    rawByNode,
  };
}

const EXTRACTABLE = new Set(['link', 'image', 'definition']);

/**
 * Parse Markdown and return every link destination it contains, in document
 * order, with 1-based line/column positions.
 *
 * Uses a CommonMark parser (not regex), so destinations inside inline code,
 * fenced code blocks, indented code blocks and escaped brackets are correctly
 * *not* reported, while titles, angle-bracket destinations, nested parentheses
 * and escaped characters are correctly handled.
 */
export function extractLinks(source: string, options: ExtractOptions): LinkOccurrence[] {
  const { includeImages = true, includeDefinitions = true } = options;
  // A leading BOM would otherwise shift the first token's offsets.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  const { extension, rawByNode } = createRawDestinationCapture();
  const tree: Root = fromMarkdown(text, { mdastExtensions: [extension as never] });

  const occurrences: LinkOccurrence[] = [];

  const visit = (node: Nodes): void => {
    if (EXTRACTABLE.has(node.type)) {
      const origin = node.type as LinkOccurrence['origin'];
      const allowed =
        origin === 'link' ||
        (origin === 'image' && includeImages) ||
        (origin === 'definition' && includeDefinitions);

      if (allowed) {
        const target = (node as { url?: string }).url ?? '';
        const start = node.position?.start;
        occurrences.push({
          file: options.file,
          relativeFile: options.relativeFile,
          line: start?.line ?? 1,
          column: start?.column ?? 1,
          // Autolinks (`<https://x>`) have no destination token; the source
          // text and the parsed value are equivalent there.
          raw: rawByNode.get(node) ?? target,
          target,
          origin,
        });
      }
    }

    const children = (node as { children?: Nodes[] }).children;
    if (children) {
      for (const child of children) visit(child);
    }
  };

  visit(tree);
  return occurrences;
}
