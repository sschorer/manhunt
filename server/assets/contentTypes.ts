/**
 * `Content-Type` by file extension. workerd's disk service deliberately serves
 * every file as `application/octet-stream`, so the asset Worker types the
 * response itself; this table covers what the Vite build emits.
 */
const CONTENT_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/vnd.microsoft.icon',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  woff2: 'font/woff2',
};

/** What an asset of an unknown kind is served as: opaque bytes. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** The `Content-Type` for an asset path, from its extension. */
export function contentTypeFor(pathname: string): string {
  const file = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  const extension = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
  return CONTENT_TYPES[extension] ?? DEFAULT_CONTENT_TYPE;
}
