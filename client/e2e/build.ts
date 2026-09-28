/**
 * Playwright's global setup: produce the artifacts every spec runs against —
 * the PWA in `dist/` and the Worker bundle (plus its generated `wrangler.json`)
 * in `dist-worker/`. The specs then run that bundle in local workerd through
 * `createTestHarness()` (see `harness.ts`), so there is no server to start.
 *
 * Skipped with `E2E_SKIP_BUILD=1`, for a quick re-run against an existing build.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));

export default function build(): void {
  if (process.env.E2E_SKIP_BUILD) return;
  execFileSync('npm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
}
