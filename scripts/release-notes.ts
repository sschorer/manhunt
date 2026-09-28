/**
 * The notes a GitHub release publishes: the changelog of the range, how to deploy
 * each of the two targets, and the versions that decide what is compatible with
 * what — including the pinned `workerd`, whose on-disk storage is experimental and
 * whose every change has to be called out.
 *
 *   node scripts/release-notes.ts                 # from the previous tag to this one
 *   node scripts/release-notes.ts v0.1.0..v0.2.0  # an explicit range
 *
 * `MANHUNT_IMAGE_DIGEST` adds the digest of the image the release pushed. The
 * release workflow writes the output to a file and hands it to the release.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseManifest, releaseName, type ReleaseManifest } from './cloudflare-release.ts';
import { releaseVersion } from './release-version.ts';

export interface ReleaseNotesInput {
  /** `owner/name`, for the image and the attestation commands. */
  repository: string;
  /** Markdown from `scripts/changelog.sh`, already grouped by commit type. */
  changelog: string;
  manifest: ReleaseManifest;
  /** The `workerd` the image pins, and the one the previous release pinned. */
  workerd: { version?: string; previous?: string };
  /** The digest of the image this release pushed, once it is known. */
  imageDigest?: string;
}

/** The GHCR tag for a release: the version without the `v` git tags carry. */
function imageTag(version: string): string {
  return version.replace(/^v/, '');
}

/** The `workerd` a Dockerfile pins, wherever that text came from. */
export function pinnedWorkerdVersion(dockerfile: string): string | undefined {
  return /ARG WORKERD_VERSION=(\S+)/.exec(dockerfile)?.[1];
}

export function releaseNotes({ repository, changelog, manifest, workerd, imageDigest }: ReleaseNotesInput): string {
  const { version, protocolVersion, snapshotVersion, wranglerVersion } = manifest;
  const unpacked = releaseName(version);
  const releaseFile = `${unpacked}.tar.gz`;
  const image = `ghcr.io/${repository}:${imageTag(version)}`;

  // Only when it actually moved: the pin is otherwise none of an operator's
  // business, and a callout that appears every time is one nobody reads.
  const workerdChanged =
    workerd.version && workerd.previous && workerd.version !== workerd.previous
      ? `\n> [!IMPORTANT]\n> **\`workerd\` changed** from \`${workerd.previous}\` to \`${workerd.version}\` in the` +
        ' self-hosted image. Its on-disk Durable Object storage is experimental, so read the' +
        ' [workerd release notes](https://github.com/cloudflare/workerd/releases) before updating a Docker' +
        ' deployment.\n'
      : '';

  return `${changelog}
### Cloudflare

Deploy from your own machine: nothing in GitHub deploys to Cloudflare, so there are
no Cloudflare credentials anywhere in this repository ([ADR-0008](https://github.com/${repository}/blob/${version}/docs/adr/0008-no-cloudflare-deploys-from-github.md)).

\`\`\`bash
gh release download ${version} --repo ${repository} --pattern '${releaseFile}' --pattern SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify ${releaseFile} --repo ${repository}

tar -xzf ${releaseFile} && cd ${unpacked}
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
${imageDigest ? `\nImage digest: \`${imageDigest}\`\n` : ''}
On the host: \`make pull && make up\`, then \`make health\`. There is nothing to
back up — the volume holds live Games only, each deleted within 24 h.
${workerdChanged}
### Versions and compatibility

| What | Version |
| --- | --- |
| Release | \`${version}\` |
| Wire protocol | ${protocolVersion} |
| Game snapshot | ${snapshotVersion} |
| \`wrangler\` (pinned, used by \`deploy.sh\`) | ${wranglerVersion} |${
    workerd.version ? `\n| \`workerd\` (pinned, in the image) | ${workerd.version} |` : ''
  }

A client on an older wire protocol is closed with \`4004\` and reloads into this
build on its own.

**Rolling back** to an earlier release is only safe while that release carries the
same game snapshot version (\`${snapshotVersion}\`): a Game stored by this release
cannot be read by one with a lower snapshot version, and its players lose it. Every
Game is deleted within 24 h of being created, so a day after this deploy any
rollback is safe.
`;
}

/** What git says, or `undefined` when there is no such revision or tag. */
function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const version = releaseVersion();
  // An untagged commit — a local run — has no range and no previous release to
  // compare against, so the notes cover all of history.
  const tagged = git('rev-parse', '--verify', '--quiet', `${version}^{commit}`) !== undefined;
  const previous = tagged ? git('describe', '--tags', '--abbrev=0', `${version}^`) : undefined;
  const range = process.argv[2] ?? (previous ? `${previous}..${version}` : tagged ? version : '');

  const changelog = execFileSync('bash', [fileURLToPath(new URL('changelog.sh', import.meta.url)), range], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  process.stdout.write(
    releaseNotes({
      repository: process.env.GITHUB_REPOSITORY ?? 'sschorer/manhunt',
      changelog,
      manifest: releaseManifest(version),
      workerd: {
        version: pinnedWorkerdVersion(readFileSync(fileURLToPath(new URL('../deploy/Dockerfile', import.meta.url)), 'utf8')),
        previous: previous ? pinnedWorkerdVersion(git('show', `${previous}:deploy/Dockerfile`) ?? '') : undefined,
      },
      imageDigest: process.env.MANHUNT_IMAGE_DIGEST,
    }),
  );
}
