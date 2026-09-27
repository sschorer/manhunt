/**
 * Bundle the asset Worker (server/assets/) into `dist-assets/index.js`.
 *
 * Only the Docker target needs it: on Cloudflare the platform serves the static
 * assets itself. It is a handful of dependency-free modules, so a plain esbuild
 * bundle keeps it out of the Vite/Wrangler build that produces the Worker.
 */
import { build } from 'esbuild';

const OUT_FILE = 'dist-assets/index.js';

await build({
  entryPoints: ['server/assets/assetWorker.ts'],
  outfile: OUT_FILE,
  bundle: true,
  format: 'esm',
  // Neither Node nor the browser: workerd, with web standards only.
  platform: 'neutral',
  target: 'es2024',
  minify: true,
  // Rewrite nothing at runtime; the bundle is read once when workerd starts.
  sourcemap: false,
  logLevel: 'info',
});

console.log(`asset Worker bundled into ${OUT_FILE}`);
