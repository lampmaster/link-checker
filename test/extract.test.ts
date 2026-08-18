import { describe, expect, it } from 'vitest';
import { extractLinks } from '../src/extract.js';

const extract = (source: string, options: Partial<Parameters<typeof extractLinks>[1]> = {}) =>
  extractLinks(source, {
    file: '/repo/docs/guide.md',
    relativeFile: 'docs/guide.md',
    ...options,
  });

const targets = (source: string): string[] => extract(source).map((o) => o.target);

describe('extractLinks', () => {
  it('extracts inline links with their line numbers', () => {
    const source = ['# Title', '', 'Intro text.', '', 'See [the guide](./guide.md).'].join('\n');
    const [link] = extract(source);

    expect(link).toMatchObject({
      target: './guide.md',
      raw: './guide.md',
      line: 5,
      origin: 'link',
      relativeFile: 'docs/guide.md',
      file: '/repo/docs/guide.md',
    });
  });

  it('reports the line of each link in a multi-link document', () => {
    const source = ['[a](./a.md)', '', '[b](./b.md)', '[c](./c.md)'].join('\n');
    expect(extract(source).map((o) => [o.target, o.line])).toEqual([
      ['./a.md', 1],
      ['./b.md', 3],
      ['./c.md', 4],
    ]);
  });

  describe('constructs that only a real parser gets right', () => {
    it('ignores links inside inline code', () => {
      expect(targets('Use `[a](./nope.md)` in Markdown.')).toEqual([]);
    });

    it('ignores links inside fenced code blocks', () => {
      expect(targets('```md\n[a](./nope.md)\n```')).toEqual([]);
    });

    it('ignores links inside indented code blocks', () => {
      expect(targets('    [a](./nope.md)')).toEqual([]);
    });

    it('ignores escaped brackets', () => {
      expect(targets('\\[a\\](./nope.md)')).toEqual([]);
    });

    it('ignores raw HTML anchors', () => {
      expect(targets('<a href="./nope.md">x</a>')).toEqual([]);
    });

    it('handles balanced parentheses inside a URL', () => {
      expect(targets('[a](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
        'https://en.wikipedia.org/wiki/Foo_(bar)',
      ]);
    });

    it('handles nested brackets in the link text', () => {
      expect(targets('[a [b] c](./d.md)')).toEqual(['./d.md']);
    });

    it('strips double- and single-quoted titles', () => {
      expect(targets('[a](./b.md "Title")')).toEqual(['./b.md']);
      expect(targets("[a](./b.md 'Title')")).toEqual(['./b.md']);
    });

    it('supports angle-bracket destinations containing spaces', () => {
      expect(targets('[a](<./my file.md>)')).toEqual(['./my file.md']);
    });

    it('trims whitespace around the destination', () => {
      expect(targets('[a]( ./b.md )')).toEqual(['./b.md']);
    });

    it('handles links whose text spans multiple lines', () => {
      const [link] = extract('[link\ntext](./b.md)');
      expect(link?.target).toBe('./b.md');
      expect(link?.line).toBe(1);
    });

    it('extracts autolinks', () => {
      expect(targets('<https://example.com/x>')).toEqual(['https://example.com/x']);
    });

    it('does not treat a bare URL in prose as a link', () => {
      expect(targets('see https://example.com/bare here')).toEqual([]);
    });

    it('handles CRLF line endings without shifting line numbers', () => {
      const [link] = extract('# t\r\n\r\n[a](./b.md)\r\n');
      expect(link?.line).toBe(3);
    });

    it('handles a leading byte-order mark', () => {
      const [link] = extract('﻿[a](./b.md)');
      expect(link?.target).toBe('./b.md');
      expect(link?.line).toBe(1);
    });
  });

  describe('raw versus decoded destinations', () => {
    it('decodes backslash escapes but keeps the raw spelling for the report', () => {
      const [link] = extract('[a](./foo\\(1\\).md)');
      expect(link?.target).toBe('./foo(1).md');
      expect(link?.raw).toBe('./foo\\(1\\).md');
    });

    it('decodes character references but keeps the raw spelling', () => {
      const [link] = extract('[a](https://x.com/?a=1&amp;b=2)');
      expect(link?.target).toBe('https://x.com/?a=1&b=2');
      expect(link?.raw).toBe('https://x.com/?a=1&amp;b=2');
    });

    it('leaves percent-encoding untouched at parse time', () => {
      const [link] = extract('[a](./my%20file.md)');
      expect(link?.target).toBe('./my%20file.md');
      expect(link?.raw).toBe('./my%20file.md');
    });
  });

  describe('images and reference definitions', () => {
    it('extracts image destinations by default', () => {
      expect(extract('![alt](./img.png)')[0]).toMatchObject({
        target: './img.png',
        origin: 'image',
      });
    });

    it('can skip images', () => {
      expect(extract('![alt](./img.png)', { includeImages: false })).toEqual([]);
    });

    it('extracts the definition of a reference link, not the reference itself', () => {
      const source = 'See [the docs][ref].\n\n[ref]: ./ref.md';
      const found = extract(source);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ target: './ref.md', origin: 'definition', line: 3 });
    });

    it('can skip definitions', () => {
      expect(extract('[ref]: ./ref.md', { includeDefinitions: false })).toEqual([]);
    });

    it('keeps an image nested inside a link separate from the link', () => {
      expect(extract('[![alt](./img.png)](./target.md)').map((o) => [o.origin, o.target])).toEqual([
        ['link', './target.md'],
        ['image', './img.png'],
      ]);
    });
  });

  it('records empty destinations so they can be classified later', () => {
    expect(targets('[a]()')).toEqual(['']);
  });
});
