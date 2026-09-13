// Follow-up checks: SIGTERM handling with/without --init, an alarm due during a
// graceful stop, and whether the "ping" auto-response wakes a hibernated object.
import { execSync } from 'node:child_process';

const NAME = 'workerd-spike2';
const VOLUME = 'workerd-spike2-data';
const BASE = 'http://127.0.0.1:18081';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const get = async (path) => (await fetch(BASE + path)).json();
const log = (...a) => console.log(...a);

async function waitUp() {
  const start = Date.now();
  for (;;) {
    try { await get('/state'); return Date.now() - start; } catch { await sleep(100); }
  }
}

const run = (flags) => sh(`docker run -d ${flags} --name ${NAME} -p 18081:8080 -v ${VOLUME}:/data workerd-spike`);
sh(`docker rm -f ${NAME} 2>/dev/null || true`);
sh(`docker volume rm ${VOLUME} 2>/dev/null || true`);

// A. SIGTERM without --init
run('');
await waitUp();
let t = Date.now();
sh(`docker stop -t 10 ${NAME}`);
log('A. docker stop without --init took ms:', Date.now() - t, 'exit code:', sh(`docker inspect ${NAME} --format '{{.State.ExitCode}}'`));
sh(`docker rm ${NAME}`);

// B. SIGTERM with --init, alarm due during the downtime
run('--init');
await waitUp();
const alarmAt = (await get('/alarm?ms=3000')).at;
t = Date.now();
sh(`docker stop -t 10 ${NAME}`);
const stoppedAt = Date.now();
log('B. docker stop with --init took ms:', stoppedAt - t, 'exit code:', sh(`docker inspect ${NAME} --format '{{.State.ExitCode}}'`));
log('   container stopped before alarm time:', stoppedAt < alarmAt);
await sleep(Math.max(0, alarmAt - Date.now()) + 4_000);
sh(`docker start ${NAME}`);
const startedAt = Date.now();
await waitUp();
await sleep(2_000);
const events = (await get('/state')).events;
const fired = events.filter((e) => e.what.startsWith('alarm fired') && e.at > alarmAt);
log('   alarm fired after restart:', fired.map((e) => `${e.what} at restart+${e.at - startedAt}ms`));

// C. Does the auto-response wake a hibernated object?
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?seat=seat-bob`);
const inbox = [];
ws.addEventListener('message', (e) => inbox.push({ data: e.data, at: Date.now() }));
await new Promise((r) => ws.addEventListener('open', r));
await sleep(15_000);
const pingAt = Date.now();
for (let i = 0; i < 3; i++) { ws.send('ping'); await sleep(200); }
await sleep(3_000);
const stateAt = Date.now();
const after = (await get('/state')).events.filter((e) => e.at > pingAt - 1_000);
log('C. pongs received:', inbox.filter((m) => m.data === 'pong').length);
log('   events after pinging (ms relative to first ping):', after.map((e) => `${e.at - pingAt}ms ${e.what}`));
log('   /state requested at', stateAt - pingAt, 'ms — a "constructed" near that time means the pings did NOT wake the object');

ws.close();
sh(`docker rm -f ${NAME}`);
sh(`docker volume rm ${VOLUME}`);
process.exit(0);
