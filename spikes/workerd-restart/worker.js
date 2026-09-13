import { DurableObject } from 'cloudflare:workers';

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.bootedAt = Date.now();
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS events (at INTEGER, what TEXT)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.log('constructed');
  }

  log(what) {
    this.ctx.storage.sql.exec('INSERT INTO events (at, what) VALUES (?, ?)', Date.now(), what);
  }

  async fetch(req) {
    const url = new URL(req.url);
    const q = url.searchParams;
    switch (url.pathname) {
      case '/put':
        this.ctx.storage.sql.exec(
          'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
          q.get('k'),
          q.get('v'),
        );
        return Response.json({ ok: true });
      case '/alarm': {
        const at = Date.now() + Number(q.get('ms'));
        await this.ctx.storage.setAlarm(at);
        this.log(`alarm set for ${at}`);
        return Response.json({ ok: true, at });
      }
      case '/state':
        return Response.json({
          bootedAt: this.bootedAt,
          kv: this.ctx.storage.sql.exec('SELECT k, v FROM kv').toArray(),
          events: this.ctx.storage.sql.exec('SELECT at, what FROM events ORDER BY rowid').toArray(),
          alarm: await this.ctx.storage.getAlarm(),
          sockets: this.ctx.getWebSockets().length,
        });
      case '/ws': {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ seat: q.get('seat') });
        this.log(`ws accepted seat=${q.get('seat')}`);
        return new Response(null, { status: 101, webSocket: client });
      }
      default:
        return new Response('not found', { status: 404 });
    }
  }

  async alarm(info) {
    this.log(`alarm fired retryCount=${info?.retryCount ?? 0}`);
    for (const ws of this.ctx.getWebSockets()) ws.send('alarm');
  }

  async webSocketMessage(ws, message) {
    const seat = ws.deserializeAttachment()?.seat;
    this.log(`ws message ${message}`);
    ws.send(JSON.stringify({ echo: message, seat, bootedAt: this.bootedAt }));
  }

  async webSocketClose(ws, code) {
    this.log(`ws closed code=${code}`);
  }
}

export default {
  fetch(req, env) {
    return env.GAME.get(env.GAME.idFromName('game-1')).fetch(req);
  },
};
