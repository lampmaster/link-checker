import { describe, expect, it } from 'vitest';
import { classifyLink, normalizeExternalUrl, percentDecode } from '../src/classify.js';

describe('classifyLink', () => {
  it('classifies http and https URLs as external', () => {
    expect(classifyLink('https://example.com/a')).toEqual({
      kind: 'external',
      url: 'https://example.com/a',
    });
    expect(classifyLink('http://example.com')).toMatchObject({ kind: 'external' });
  });

  it('normalises the scheme and host casing of external URLs', () => {
    expect(classifyLink('HTTPS://EXAMPLE.COM/Path')).toEqual({
      kind: 'external',
      url: 'https://example.com/Path',
    });
  });

  it('treats protocol-relative URLs as https', () => {
    expect(classifyLink('//example.com/x')).toEqual({
      kind: 'external',
      url: 'https://example.com/x',
    });
  });

  it('reports malformed URLs instead of throwing', () => {
    expect(classifyLink('https://')).toMatchObject({ kind: 'malformed' });
    expect(classifyLink('http://exa mple.com')).toMatchObject({ kind: 'malformed' });
    expect(classifyLink('https://:8080')).toMatchObject({ kind: 'malformed' });
  });

  it('classifies fragment-only links without a filesystem check', () => {
    expect(classifyLink('#installation')).toEqual({ kind: 'fragment', fragment: 'installation' });
    expect(classifyLink('#')).toEqual({ kind: 'fragment', fragment: '' });
  });

  it('classifies query-only links as nothing to check', () => {
    expect(classifyLink('?tab=readme')).toMatchObject({ kind: 'fragment' });
  });

  it('classifies an empty destination', () => {
    expect(classifyLink('')).toEqual({ kind: 'empty' });
    expect(classifyLink('   ')).toEqual({ kind: 'empty' });
  });

  it('recognises but does not check other schemes', () => {
    expect(classifyLink('mailto:a@b.com')).toEqual({ kind: 'unsupported', scheme: 'mailto' });
    expect(classifyLink('tel:+123')).toEqual({ kind: 'unsupported', scheme: 'tel' });
    expect(classifyLink('data:text/plain,x')).toEqual({ kind: 'unsupported', scheme: 'data' });
    expect(classifyLink('ftp://host/file')).toEqual({ kind: 'unsupported', scheme: 'ftp' });
  });

  describe('local paths', () => {
    it('splits fragments off the path', () => {
      expect(classifyLink('./guide.md#installation')).toMatchObject({
        kind: 'local',
        path: './guide.md',
        fragment: 'installation',
      });
    });

    it('splits query strings off the path', () => {
      expect(classifyLink('./guide.md?raw=1#frag')).toMatchObject({
        kind: 'local',
        path: './guide.md',
        query: 'raw=1',
        fragment: 'frag',
      });
    });

    it('percent-decodes the path but keeps the raw spelling', () => {
      expect(classifyLink('./my%20file.md')).toMatchObject({
        kind: 'local',
        path: './my file.md',
        rawPath: './my%20file.md',
      });
    });

    it('keeps a percent-encoded hash as part of the filename', () => {
      const classified = classifyLink('./weird%23name.md');
      expect(classified).toMatchObject({ kind: 'local', path: './weird#name.md' });
      expect(classified).not.toHaveProperty('fragment');
    });

    it('survives invalid percent-encoding', () => {
      expect(classifyLink('./100%_done.md')).toMatchObject({
        kind: 'local',
        path: './100%_done.md',
      });
    });

    it('marks root-absolute paths', () => {
      expect(classifyLink('/docs/x.md')).toMatchObject({
        kind: 'local',
        anchor: 'root-absolute',
      });
    });

    it('does not mistake a Windows drive letter for a URL scheme', () => {
      expect(classifyLink('C:/docs/x.md')).toMatchObject({ kind: 'local', path: 'C:/docs/x.md' });
    });

    it('treats file:// URLs as absolute filesystem paths', () => {
      expect(classifyLink('file:///tmp/x.md')).toMatchObject({
        kind: 'local',
        path: '/tmp/x.md',
        anchor: 'filesystem-absolute',
      });
    });

    it('decodes and strips fragments from file:// URLs', () => {
      expect(classifyLink('file:///tmp/my%20doc.md#section')).toMatchObject({
        kind: 'local',
        path: '/tmp/my doc.md',
        fragment: 'section',
      });
    });

    it('reports an unusable file:// URL as malformed', () => {
      expect(classifyLink('file://remote-host/share/x.md')).toMatchObject({ kind: 'malformed' });
    });
  });
});

describe('normalizeExternalUrl', () => {
  it('drops the fragment, which is never sent to the server', () => {
    expect(normalizeExternalUrl('https://example.com/a#one')).toBe('https://example.com/a');
    expect(normalizeExternalUrl('https://example.com/a#two')).toBe('https://example.com/a');
  });

  it('adds the implicit root path', () => {
    expect(normalizeExternalUrl('https://example.com')).toBe('https://example.com/');
  });

  it('removes default ports and lowercases the host', () => {
    expect(normalizeExternalUrl('https://Example.COM:443/a')).toBe('https://example.com/a');
    expect(normalizeExternalUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('keeps a non-default port', () => {
    expect(normalizeExternalUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('keeps the query string, which does change the response', () => {
    expect(normalizeExternalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeExternalUrl('https://example.com/a?b=1')).not.toBe(
      normalizeExternalUrl('https://example.com/a?b=2'),
    );
  });

  it('preserves path case, which servers may be sensitive to', () => {
    expect(normalizeExternalUrl('https://example.com/Path')).toBe('https://example.com/Path');
  });
});

describe('percentDecode', () => {
  it('decodes valid sequences', () => {
    expect(percentDecode('a%20b')).toBe('a b');
    expect(percentDecode('%D0%B4%D0%BE%D0%BA.md')).toBe('док.md');
  });

  it('returns the input unchanged when it is not valid encoding', () => {
    expect(percentDecode('100%_done')).toBe('100%_done');
    expect(percentDecode('plain')).toBe('plain');
  });

  it('does not turn a plus into a space', () => {
    expect(percentDecode('a+b.md')).toBe('a+b.md');
  });
});
