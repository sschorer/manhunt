import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

// Authoritative game loop lives here. This is a stub — the real handlers
// (join, position_update, claim_catch, game_state) are tracked in the backlog.
io.on('connection', (socket) => {
  console.log(`socket connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`socket disconnected: ${socket.id}`));
});

server.listen(PORT, () => console.log(`manhunt server listening on :${PORT}`));
