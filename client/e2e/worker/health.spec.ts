import { PROTOCOL_VERSION } from '../../../shared/version.ts';
import { releaseVersion } from '../../../scripts/release-version.ts';
import { expect, test } from './harness.ts';

test('/health reports ok, the build version and the protocol version', async ({ request }) => {
  const res = await request.get('/health');

  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({
    ok: true,
    version: releaseVersion(),
    protocol: PROTOCOL_VERSION,
  });
});
