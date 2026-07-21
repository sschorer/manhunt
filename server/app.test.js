import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { createServer } from './app.js';

describe('http server', () => {
  // Serve from a throwaway static dir so the tests don't depend on a built
  // client or the checked-in preview.
  let staticDir;
  let app;

  beforeAll(() => {
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>shell</title>');
    ({ app } = createServer({ staticDir }));
  });

  afterAll(() => {
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  it('reports healthy at /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('serves the SPA shell for unknown routes', async () => {
    const res = await request(app).get('/lobby/ABCD');
    expect(res.status).toBe(200);
    expect(res.text).toContain('shell');
  });

  it('does not swallow unknown /api routes with the SPA fallback', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
  });
});

describe('socket.io', () => {
  let httpServer;
  let io;
  let url;

  beforeAll(async () => {
    ({ httpServer, io } = createServer({ staticDir: path.join(os.tmpdir(), 'nope') }));
    httpServer.listen(0);
    await once(httpServer, 'listening');
    const { port } = httpServer.address();
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    io.close();
    httpServer.close();
    await once(httpServer, 'close');
  });

  it('accepts a client connection', async () => {
    const client = ioClient(url, { transports: ['websocket'], reconnection: false });
    await once(client, 'connect');
    expect(client.connected).toBe(true);
    client.close();
  });
});
