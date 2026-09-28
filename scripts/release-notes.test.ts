/**
 * The notes a release publishes. They are the only place a deployer is told how
 * to deploy this release and whether rolling back to the previous one is safe, so
 * what has to be in them is pinned down here.
 */
import { describe, expect, it } from 'vitest';
import { pinnedWorkerdVersion, releaseNotes } from './release-notes.ts';

const manifest = { version: 'v0.2.0', protocolVersion: 3, snapshotVersion: 2, wranglerVersion: '4.131.1' };
const workerd = { version: '1.20260911.1', previous: '1.20260911.1' };

const notes = releaseNotes({
  repository: 'sschorer/manhunt',
  changelog: '### Features\n\n- something new (abc1234)\n',
  manifest,
  workerd,
});

describe('the release notes', () => {
  it('open with the changelog of the range', () => {
    expect(notes).toContain('### Features\n\n- something new (abc1234)');
  });

  it('tell a deployer how to deploy the Cloudflare release file', () => {
    expect(notes).toContain('manhunt-cloudflare-v0.2.0.tar.gz');
    expect(notes).toContain('./deploy.sh');
    // The two things that make the download trustworthy.
    expect(notes).toContain('SHA256SUMS');
    expect(notes).toContain('gh attestation verify');
  });

  it('say that no deploy comes out of GitHub', () => {
    expect(notes).toMatch(/nothing in GitHub deploys to Cloudflare/i);
  });

  it('give the image for the self-hosted target, by this version', () => {
    // GHCR tags carry no leading `v`, which is what docker/metadata-action wrote.
    expect(notes).toContain('docker pull ghcr.io/sschorer/manhunt:0.2.0');
  });

  it('carry both versions that decide compatibility, and the pinned wrangler', () => {
    expect(notes).toMatch(/protocol[^|]*\| *3/i);
    expect(notes).toMatch(/snapshot[^|]*\| *2/i);
    expect(notes).toContain('4.131.1');
  });

  it('say when rolling back is safe', () => {
    expect(notes).toMatch(/roll(ing)? back/i);
    expect(notes).toMatch(/snapshot version/i);
  });

  it('are the same notes for a pre-release tag', () => {
    const rc = releaseNotes({
      repository: 'sschorer/manhunt',
      changelog: '',
      manifest: { ...manifest, version: 'v0.2.0-rc.1' },
      workerd,
    });
    expect(rc).toContain('manhunt-cloudflare-v0.2.0-rc.1.tar.gz');
    expect(rc).toContain('docker pull ghcr.io/sschorer/manhunt:0.2.0-rc.1');
  });

  it('name the release file the packager actually wrote', () => {
    // Semver build metadata is legal in a tag but not in a file name, so the
    // packager rewrites it — and the notes have to point at the file that exists.
    const odd = releaseNotes({
      repository: 'sschorer/manhunt',
      changelog: '',
      manifest: { ...manifest, version: 'v0.2.0+1' },
      workerd,
    });
    expect(odd).toContain('manhunt-cloudflare-v0.2.0-1.tar.gz');
    expect(odd).toContain('cd manhunt-cloudflare-v0.2.0-1');
    expect(odd).not.toContain('v0.2.0+1.tar.gz');
  });

  it('name the pinned workerd, and call it out only when it changed', () => {
    expect(notes).toContain('1.20260911.1');
    expect(notes).not.toMatch(/workerd. changed/);

    const bumped = releaseNotes({
      repository: 'sschorer/manhunt',
      changelog: '',
      manifest,
      workerd: { version: '1.20270101.0', previous: '1.20260911.1' },
    });
    expect(bumped).toMatch(/`workerd` changed.*1\.20260911\.1.*1\.20270101\.0/s);
    expect(bumped).toMatch(/experimental/);
  });

  it('carry the digest of the image the release pushed, when it is known', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const signed = releaseNotes({ repository: 'sschorer/manhunt', changelog: '', manifest, workerd, imageDigest: digest });
    expect(signed).toContain(digest);
    expect(notes).not.toContain('Image digest');
  });
});

describe('the workerd pin', () => {
  it('is read from the Dockerfile that carries it', () => {
    expect(pinnedWorkerdVersion('ARG WORKERD_VERSION=1.20260911.1\nRUN npm install')).toBe('1.20260911.1');
    expect(pinnedWorkerdVersion('FROM debian:bookworm-slim')).toBeUndefined();
  });
});
