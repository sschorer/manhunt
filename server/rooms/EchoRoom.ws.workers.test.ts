import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('EchoRoom', () => {
  it('echoes messages over a hibernatable WebSocket', async () => {
    const stub = env.ECHO.get(env.ECHO.idFromName('echo-test'));

    const res = await stub.fetch('http://example.com/ws/echo', {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error('expected a WebSocket in the upgrade response');
    ws.accept();

    // Accepted through the hibernation API, so the object can sleep while the
    // socket stays open.
    const sockets = await runInDurableObject(stub, (_room, state) => state.getWebSockets().length);
    expect(sockets).toBe(1);

    const echoed = new Promise<unknown>((resolve) => {
      ws.addEventListener('message', (event) => resolve(event.data), { once: true });
    });
    ws.send('marco');
    expect(await echoed).toBe('marco');

    ws.close(1000, 'done');
  });
});
