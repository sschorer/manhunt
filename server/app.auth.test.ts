import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createServer } from './app.ts';
import {
  createMemoryAccountStore,
  createSessionCodec,
  type Account,
  type AccountStore,
} from './auth/index.ts';

describe('auth HTTP routes', () => {
  let app: Express;
  let accounts: AccountStore;
  let staticDir: string;

  beforeEach(() => {
    // An empty static dir: no index.html, so there is no SPA fallback to shadow
    // the API 404s we assert on.
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-auth-'));
    accounts = createMemoryAccountStore();
    ({ app } = createServer({
      staticDir,
      accounts,
      sessions: createSessionCodec({ secret: 'test-secret' }),
    }));
  });

  afterEach(() => {
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  it('registers an account, sets a session cookie, and answers /me', async () => {
    const agent = request.agent(app);
    const res = await agent
      .post('/api/auth/register')
      .send({ name: 'Alice', username: 'Alice', password: 'hunter2' });

    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({ name: 'Alice', username: 'alice', trusted: false });
    expect(res.body.account).not.toHaveProperty('passwordHash');
    // httpOnly session cookie was set.
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/session=/);
    expect(cookie.toLowerCase()).toContain('httponly');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({ username: 'alice' });
  });

  it('rejects a duplicate username', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'A', username: 'dup', password: 'p' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'B', username: 'DUP', password: 'p' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('username_taken');
  });

  it('rejects blank registration fields', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: '', username: 'u', password: 'p' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('name_required');
  });

  it('signs in with correct credentials and rejects wrong ones', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Alice', username: 'alice', password: 'hunter2' });

    const bad = await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('invalid_credentials');

    const ok = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ALICE', password: 'hunter2' });
    expect(ok.status).toBe(200);
    expect(ok.body.account).toMatchObject({ username: 'alice' });
  });

  it('requires authentication for /me and clears the session on logout', async () => {
    const anon = await request(app).get('/api/auth/me');
    expect(anon.status).toBe(401);

    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ name: 'A', username: 'a', password: 'p' });
    expect((await agent.get('/api/auth/me')).status).toBe(200);

    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  describe('vouch', () => {
    // Seed a root with known credentials so a test can sign in as it.
    let root: Account;
    beforeEach(async () => {
      root = await accounts.createAccount({
        name: 'Root',
        username: 'root',
        password: 'rootpw',
        isRoot: true,
      });
    });

    it('lets the root vouch, making the vouchee trusted', async () => {
      // A fresh, untrusted member.
      const member = await request(app)
        .post('/api/auth/register')
        .send({ name: 'Mem', username: 'mem', password: 'p' });
      expect(member.body.account.trusted).toBe(false);

      // Sign in as root and vouch for the member by username.
      const rootAgent = request.agent(app);
      await rootAgent.post('/api/auth/login').send({ username: 'root', password: 'rootpw' });
      const vouch = await rootAgent.post('/api/auth/vouch').send({ username: 'mem' });

      expect(vouch.status).toBe(200);
      expect(vouch.body.vouchee).toMatchObject({ username: 'mem', trusted: true });
      expect(await accounts.isTrusted(root.id)).toBe(true);
    });

    it('requires authentication to vouch', async () => {
      const res = await request(app).post('/api/auth/vouch').send({ username: 'root' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthenticated');
    });

    it('404s on an unknown vouchee', async () => {
      const rootAgent = request.agent(app);
      await rootAgent.post('/api/auth/login').send({ username: 'root', password: 'rootpw' });
      const res = await rootAgent.post('/api/auth/vouch').send({ username: 'ghost' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('account_not_found');
    });

    it('rejects a self-vouch', async () => {
      const rootAgent = request.agent(app);
      await rootAgent.post('/api/auth/login').send({ username: 'root', password: 'rootpw' });
      const res = await rootAgent.post('/api/auth/vouch').send({ username: 'root' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('self_vouch');
    });
  });
});
