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

test('a real WebSocket to the echo Durable Object gets its message echoed', async ({ page }) => {
  await page.goto('/health');

  const echoed = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/echo`);
        ws.onopen = () => ws.send('marco');
        ws.onmessage = (event) => {
          resolve(String(event.data));
          ws.close();
        };
        ws.onerror = () => reject(new Error('WebSocket to /ws/echo failed'));
      }),
  );

  expect(echoed).toBe('marco');
});
