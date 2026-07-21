import { createServer } from './app.js';
import { migrate } from './db/migrate.ts';

const PORT = process.env.PORT || 3000;

// Optionally apply database migrations on boot. Opt-in via RUN_MIGRATIONS=true
// so a bare dev checkout without PostgreSQL still starts; the same runner is
// available on demand via `npm run db:migrate`.
if (process.env.RUN_MIGRATIONS === 'true') {
  try {
    await migrate();
  } catch (err) {
    console.error('failed to apply migrations on boot:', err.message);
    process.exit(1);
  }
}

const { httpServer } = createServer();

httpServer.listen(PORT, () => console.log(`manhunt server listening on :${PORT}`));
