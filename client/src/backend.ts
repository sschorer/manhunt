/**
 * Temporary build-time switch for the Cloudflare migration: `VITE_BACKEND=worker`
 * points the client at the new Worker backend; anything else keeps the old
 * Socket.IO server. The cutover removes it.
 */
export const USE_WORKER_BACKEND = import.meta.env.VITE_BACKEND === 'worker';
