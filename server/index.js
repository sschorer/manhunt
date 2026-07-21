import { createServer } from './app.js';

const PORT = process.env.PORT || 3000;

const { httpServer } = createServer();

httpServer.listen(PORT, () => console.log(`manhunt server listening on :${PORT}`));
