/**
 * The cache-header file both targets read: `_headers` in the built PWA.
 * Cloudflare's Workers Static Assets applies it by itself; on Docker the asset
 * Worker applies it with the rules parsed here, so one file decides the cache
 * policy on both targets.
 *
 * The supported subset of Cloudflare's format: a rule is an absolute path
 * pattern at the start of a line, followed by indented `Name: value` headers.
 * `*` in a pattern stands for any run of characters, slashes included. `#`
 * starts a comment. Placeholders (`/:id/`) and header removal (`! Name`) are not
 * used by this project and are ignored.
 */

/** One `_headers` rule: the paths it matches and the headers it sets on them. */
export interface HeaderRule {
  readonly matches: RegExp;
  readonly headers: readonly (readonly [string, string])[];
}

/** A path glob as an anchored regular expression, with `*` the only metacharacter. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** The rules in a `_headers` file, in the order they appear. */
export function parseHeaderRules(text: string): HeaderRule[] {
  const rules: { matches: RegExp; headers: [string, string][] }[] = [];
  // A path line with an unsupported pattern drops the headers under it too.
  let current: { matches: RegExp; headers: [string, string][] } | undefined;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;
    if (/^\s/.test(raw)) {
      const header = /^([^:\s]+)\s*:\s*(.*)$/.exec(line.trim());
      if (header && current) current.headers.push([header[1]!, header[2]!]);
      continue;
    }
    current = undefined;
    if (!line.startsWith('/')) continue;
    current = { matches: globToRegExp(line), headers: [] };
    rules.push(current);
  }

  return rules.filter((rule) => rule.headers.length > 0);
}

/**
 * The headers every matching rule sets on `pathnames`. A later rule wins over an
 * earlier one for the same header, which keeps a specific rule below a catch-all
 * meaningful; each header keeps the position it was first set in.
 *
 * More than one path is for the SPA fallback, where the path that was asked for
 * and the document actually served are different: pass the asked-for path first
 * and the served one second, so the served document's own headers win.
 */
export function headersFor(rules: readonly HeaderRule[], ...pathnames: string[]): [string, string][] {
  const headers = new Map<string, [string, string]>();
  for (const pathname of pathnames) {
    for (const rule of rules) {
      if (!rule.matches.test(pathname)) continue;
      for (const [name, value] of rule.headers) headers.set(name.toLowerCase(), [name, value]);
    }
  }
  return [...headers.values()];
}
