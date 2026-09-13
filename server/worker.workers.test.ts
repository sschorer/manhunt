import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';

describe('worker', () => {
  it('reports ok, the build version and the protocol version on /health', async () => {
    const res = await SELF.fetch('http://example.com/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: __MANHUNT_VERSION__,
      protocol: PROTOCOL_VERSION,
    });
    expect(__MANHUNT_VERSION__).not.toBe('');
  });

  it('rejects /ws/echo without a WebSocket upgrade', async () => {
    const res = await SELF.fetch('http://example.com/ws/echo');

    expect(res.status).toBe(426);
  });

  it('answers unknown Worker routes with 404', async () => {
    const res = await SELF.fetch('http://example.com/api/nope');

    expect(res.status).toBe(404);
  });
});
