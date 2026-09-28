/**
 * The notes a GitHub release publishes: the changelog of the range, how to deploy
 * each of the two targets, and the versions that decide what is compatible with
 * what.
 *
 *   node scripts/release-notes.ts                 # from the previous tag to this one
 *   node scripts/release-notes.ts v0.1.0..v0.2.0  # an explicit range
 *
 * The release workflow writes the output to a file and hands it to the release.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseManifest, type ReleaseManifest } from './cloudflare-release.ts';
import { releaseVersion } from './release-version.ts';

export interface ReleaseNotesInput {
  /** `owner/name`, for the image and the attestation commands. */
  repository: string;
  /** Markdown from `scripts/changelog.sh`, already grouped by commit type. */
  changelog: string;
  manifest: ReleaseManifest;
}

/** The GHCR tag for a release: the version without the `v` git tags carry. */
function imageTag(version: string): string {
  return version.replace(/^v/, '');
}

export function releaseNotes({ repository, changelog, manifest }: ReleaseNotesInput): string {
  const { version, protocolVersion, snapshotVersion, wranglerVersion } = manifest;
  const releaseFile = `manhunt-cloudflare-${version}.tar.gz`;
  const image = `ghcr.io/${repository}:${imageTag(version)}`;

  return `${changelog}
### Cloudflare

Deploy from your own machine: nothing in GitHub deploys to Cloudflare, so there are
no Cloudflare credentials anywhere in this repository ([ADR-0008](https://github.com/${repository}/blob/${version}/docs/adr/0008-no-cloudflare-deploys-from-github.md)).

\`\`\`bash
gh release download ${version} --repo ${repository} --pattern '${releaseFile}' --pattern SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify ${releaseFile} --repo ${repository}

tar -xzf ${releaseFile} && cd manhunt-cloudflare-${version}
cp .env.example .env && \${EDITOR:-vi} .env   # account id, domain, optional VAPID_SUBJECT
./deploy.sh
\`\`\`

The release file holds the Worker bundle, the built PWA and a Wrangler config
template with no account id and no domain in it. \`deploy.sh\` renders that
template from your \`.env\`, deploys with the pinned \`wrangler\` below, and then
checks that \`/health\` on your domain reports \`${version}\`. \`README.md\`
inside the file covers the VAPID keys and the first deploy.

### Docker image

\`\`\`bash
docker pull ${image}
gh attestation verify oci://${image} --repo ${repository}
\`\`\`

On the host: \`make pull && make up\`, then \`make health\`. There is nothing to
back up — the volume holds live Games only, each deleted within 24 h.

### Versions and compatibility

| What | Version |
| --- | --- |
| Release | \`${version}\` |
| Wire protocol | ${protocolVersion} |
| Game snapshot | ${snapshotVersion} |
| \`wrangler\` (pinned, used by \`deploy.sh\`) | ${wranglerVersion} |

A client on an older wire protocol is closed with \`4004\` and reloads into this
build on its own.

**Rolling back** to an earlier release is only safe while that release carries the
same game snapshot version (\`${snapshotVersion}\`): a Game stored by this release
cannot be read by one with a lower snapshot version, and its players lose it. Every
Game is deleted within 24 h of being created, so a day after this deploy any
rollback is safe.
`;
}

if (import.meta.main) {
  const version = releaseVersion();
  const range = process.argv[2] ?? defaultRange(version);
  const changelog = execFileSync('bash', [fileURLToPath(new URL('changelog.sh', import.meta.url)), range], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.stdout.write(
    releaseNotes({
      repository: process.env.GITHUB_REPOSITORY ?? 'sschorer/manhunt',
      changelog,
      manifest: releaseManifest(version),
    }),
  );
}

/**
 * Everything since the previous tag; all of history when this is the first tag,
 * or when the version names no revision at all — which is what a local run on an
 * untagged commit gets.
 */
function defaultRange(version: string): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    git('rev-parse', '--verify', '--quiet', `${version}^{commit}`);
  } catch {
    return '';
  }
  try {
    return `${git('describe', '--tags', '--abbrev=0', `${version}^`)}..${version}`;
  } catch {
    return version;
  }
}
