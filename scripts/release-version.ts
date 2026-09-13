import { execFileSync } from 'node:child_process';

// The release version baked into the build and reported by the Worker's
// `/health`. An explicit MANHUNT_VERSION wins; on a tag build in GitHub Actions
// it is the tag itself; locally it falls back to `git describe`.
export function releaseVersion(): string {
  if (process.env.MANHUNT_VERSION) return process.env.MANHUNT_VERSION;
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}
