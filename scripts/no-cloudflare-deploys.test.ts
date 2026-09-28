/**
 * ADR-0008 as something that fails rather than something we remember: nothing in
 * GitHub deploys to Cloudflare, and there is no credential in this repository that
 * could. The repo is public, so a token in a workflow would be a token in the open.
 *
 * The one wrangler command CI is allowed to run against a deployment config is
 * `deploy --dry-run`, which stops before it would need an account. The release
 * check runs it to prove the release file carries a config wrangler accepts, and
 * the last test here is what keeps it a dry run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = '.github/workflows';

const workflows = readdirSync(WORKFLOWS).map((name) => ({
  name,
  text: readFileSync(join(WORKFLOWS, name), 'utf8'),
}));

describe('nothing in GitHub deploys to Cloudflare', () => {
  it('so no workflow deploys a Worker', () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const { name, text } of workflows) {
      expect(text, name).not.toMatch(/wrangler(@[^\s]+)? (deploy|versions)/);
      expect(text, name).not.toMatch(/cloudflare\/wrangler-action/);
    }
  });

  it('and no workflow reads a Cloudflare credential', () => {
    for (const { name, text } of workflows) {
      expect(text, name).not.toMatch(/CLOUDFLARE_(API_TOKEN|API_KEY|EMAIL)/);
      expect(text, name).not.toMatch(/secrets\.CLOUDFLARE/i);
    }
  });

  it('and the only secret any workflow uses is the built-in GITHUB_TOKEN', () => {
    const used = new Set(
      workflows.flatMap(({ text }) => [...text.matchAll(/secrets\.([A-Z_]+)/g)].map(([, name]) => name)),
    );
    expect([...used]).toEqual(['GITHUB_TOKEN']);
  });

  it('and the deploy the release check runs is a dry run, the only one CI may run', () => {
    const releaseCheck = readFileSync('scripts/release-e2e.ts', 'utf8');
    const deploys = [...releaseCheck.matchAll(/wranglerCommand\([^)]*'deploy'[^)]*\)/g)].map(([call]) => call);
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toContain('--dry-run');
  });
});
