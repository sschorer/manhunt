import { describe, expect, it } from 'vitest';
import { contentTypeFor, DEFAULT_CONTENT_TYPE } from './contentTypes.ts';

describe('contentTypeFor', () => {
  it('types everything the built PWA ships', () => {
    expect(contentTypeFor('/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/assets/index-abc123.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/assets/index-abc123.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('/manifest.webmanifest')).toBe('application/manifest+json; charset=utf-8');
    expect(contentTypeFor('/pwa-192x192.png')).toBe('image/png');
    expect(contentTypeFor('/favicon.ico')).toBe('image/vnd.microsoft.icon');
  });

  it('reads the extension case-insensitively', () => {
    expect(contentTypeFor('/LOGO.PNG')).toBe('image/png');
  });

  it('falls back to bytes for an extension it does not know', () => {
    expect(contentTypeFor('/data.bin')).toBe(DEFAULT_CONTENT_TYPE);
  });

  it('falls back to bytes when there is no extension to read', () => {
    expect(contentTypeFor('/LICENSE')).toBe(DEFAULT_CONTENT_TYPE);
    // A dot in a directory name is not the file's extension.
    expect(contentTypeFor('/v1.2/README')).toBe(DEFAULT_CONTENT_TYPE);
  });
});
