import { DurableObject } from 'cloudflare:workers';

// Tracer Durable Object for the Workers toolchain: accepts a hibernating
// WebSocket and echoes every message back. GameRoom replaces it.
export class EchoRoom extends DurableObject<Cloudflare.Env> {
  override async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    // acceptWebSocket (not server.accept()) lets the object hibernate while
    // the socket stays open.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(message);
  }
}
