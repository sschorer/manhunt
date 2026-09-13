// Usage: node measure.mjs https://manhunt-spike-web-push-cpu.<account>.workers.dev
// Streams `wrangler tail --format json`, hits each endpoint several times, and
// prints CPU time per path and execution model (Worker vs Durable Object).
import { spawn } from 'node:child_process';

const base = process.argv[2]?.replace(/\/$/, '');
if (!base) {
  console.error('usage: node measure.mjs <deployed worker URL>');
  process.exit(1);
}

const RUNS = 6;
const PATHS = [
  '/worker/noop',
  '/worker/build?n=1',
  '/worker/build?n=10',
  '/worker/send?n=1',
  '/worker/send?n=10',
  '/worker/waituntil?n=1',
  '/worker/waituntil?n=10',
  '/do/noop',
  '/do/build?n=1',
  '/do/build?n=10',
  '/do/send?n=1',
  '/do/send?n=10',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const events = [];
function parseStream(onObject) {
  let buf = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  return (chunk) => {
    for (const ch of chunk.toString()) {
      buf += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') {
        if (depth === 0) start = buf.length - 1;
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            onObject(JSON.parse(buf.slice(start)));
          } catch {
            /* not an event */
          }
          buf = '';
          start = -1;
        }
      }
    }
  };
}

const tail = spawn('npx', ['wrangler', 'tail', '--format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
tail.stdout.on('data', parseStream((e) => events.push(e)));
let connected = false;
tail.stderr.on('data', (d) => {
  if (/connected|tailing|listening/i.test(d.toString())) connected = true;
});
for (let i = 0; i < 60 && !connected; i += 1) await sleep(500);
await sleep(3_000);
console.log('tail connected; sending requests...');

for (const path of PATHS) {
  for (let i = 0; i < RUNS; i += 1) {
    const res = await fetch(base + path);
    await res.text();
    await sleep(300);
  }
}
console.log('waiting for trailing events...');
await sleep(15_000);
tail.kill();

const rows = new Map();
for (const e of events) {
  const url = e?.event?.request?.url;
  if (!url || typeof e.cpuTime !== 'number') continue;
  const u = new URL(url);
  const key = `${u.pathname}${u.search}  [${e.executionModel ?? '?'}]`;
  if (!rows.has(key)) rows.set(key, []);
  rows.get(key).push({ cpu: e.cpuTime, wall: e.wallTime, outcome: e.outcome, at: e.eventTimestamp });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
console.log(`\n${events.length} tail events captured\n`);
console.log('path [execution model]'.padEnd(42), 'n', 'first', 'median', 'max', 'outcomes');
for (const [key, list] of [...rows.entries()].sort()) {
  list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const cpus = list.map((r) => r.cpu);
  const outcomes = [...new Set(list.map((r) => r.outcome))].join(',');
  console.log(key.padEnd(42), String(list.length).padEnd(2), `${cpus[0]}ms`.padEnd(6), `${median(cpus)}ms`.padEnd(7), `${Math.max(...cpus)}ms`.padEnd(5), outcomes);
}
process.exit(0);
