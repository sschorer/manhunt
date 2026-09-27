import { describe, expect, it } from 'vitest';
import { headersFor, parseHeaderRules } from './headers.ts';

const HEADERS = `
# Cache policy.
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/sw.js
  Cache-Control: no-cache
  X-Note: service worker
`;

describe('parseHeaderRules', () => {
  it('reads a rule per path with its indented headers', () => {
    expect(parseHeaderRules(HEADERS)).toHaveLength(2);
  });

  it('ignores comments, blank lines and headers before the first path', () => {
    expect(parseHeaderRules('# nothing\n\n  Cache-Control: no-cache\n')).toEqual([]);
  });

  it('ignores a path that is not absolute and the headers under it', () => {
    const rules = parseHeaderRules('https://example.com/x\n  X-A: 1\n\n/ok\n  X-B: 2\n');
    expect(headersFor(rules, '/ok')).toEqual([['X-B', '2']]);
  });

  it('ignores an indented line that is not a header', () => {
    expect(headersFor(parseHeaderRules('/x\n  nonsense\n  X-A: 1\n'), '/x')).toEqual([['X-A', '1']]);
  });
});

describe('headersFor', () => {
  const rules = parseHeaderRules(HEADERS);

  it('applies the headers of a matching wildcard rule', () => {
    expect(headersFor(rules, '/assets/index-abc123.js')).toEqual([
      ['Cache-Control', 'public, max-age=31536000, immutable'],
    ]);
  });

  it('applies every header of a matching exact rule', () => {
    expect(headersFor(rules, '/sw.js')).toEqual([
      ['Cache-Control', 'no-cache'],
      ['X-Note', 'service worker'],
    ]);
  });

  it('has nothing to say about a path no rule matches', () => {
    expect(headersFor(rules, '/index.html')).toEqual([]);
  });

  it('matches a wildcard in the middle of a path', () => {
    const middle = parseHeaderRules('/workbox-*.js\n  Cache-Control: immutable\n');
    expect(headersFor(middle, '/workbox-9c191d2f.js')).toEqual([['Cache-Control', 'immutable']]);
    expect(headersFor(middle, '/workbox-9c191d2f.js.map')).toEqual([]);
  });

  it('treats a wildcard as any run of characters, slashes included', () => {
    const deep = parseHeaderRules('/assets/*\n  X-A: 1\n');
    expect(headersFor(deep, '/assets/fonts/inter.woff2')).toEqual([['X-A', '1']]);
  });

  it('does not read a glob as a regular expression', () => {
    const dotted = parseHeaderRules('/sw.js\n  X-A: 1\n');
    expect(headersFor(dotted, '/swxjs')).toEqual([]);
  });

  it('lets a later rule override an earlier one for the same header', () => {
    const layered = parseHeaderRules('/*\n  Cache-Control: no-cache\n  X-A: 1\n\n/a.js\n  cache-control: immutable\n');
    expect(headersFor(layered, '/a.js')).toEqual([['cache-control', 'immutable'], ['X-A', '1']]);
    expect(headersFor(layered, '/b.js')).toEqual([['Cache-Control', 'no-cache'], ['X-A', '1']]);
  });
});
