import { PROTOCOL_VERSION } from '../shared/protocol.ts';

export { EchoRoom } from './rooms/EchoRoom.ts';

// Worker entry. Only the routes in `run_worker_first` (deploy/wrangler.jsonc)
// reach this handler; everything else is served from the static assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, version: __MANHUNT_VERSION__, protocol: PROTOCOL_VERSION });
    }

    if (url.pathname === '/ws/echo') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      return env.ECHO.get(env.ECHO.idFromName('echo')).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
