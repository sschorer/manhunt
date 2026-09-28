/**
 * The notes a release publishes. They are the only place a deployer is told how
 * to deploy this release and whether rolling back to the previous one is safe, so
 * what has to be in them is pinned down here.
 */
import { describe, expect, it } from 'vitest';
import { releaseNotes } from './release-notes.ts';

const manifest = { version: 'v0.2.0', protocolVersion: 3, snapshotVersion: 2, wranglerVersion: '4.131.1' };

const notes = releaseNotes({
  repository: 'sschorer/manhunt',
  changelog: '### Features\n\n- something new (abc1234)\n',
  manifest,
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
    });
    expect(rc).toContain('manhunt-cloudflare-v0.2.0-rc.1.tar.gz');
    expect(rc).toContain('docker pull ghcr.io/sschorer/manhunt:0.2.0-rc.1');
  });
});
