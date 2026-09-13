// Drives the restart scenarios against the container and prints a findings log.
import { execSync } from 'node:child_process';

const NAME = 'workerd-spike';
const VOLUME = 'workerd-spike-data';
const BASE = 'http://127.0.0.1:18080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const get = async (path) => (await fetch(BASE + path)).json();

async function waitUp() {
  const start = Date.now();
  for (;;) {
    try {
      await get('/state');
      return Date.now() - start;
    } catch {
      if (Date.now() - start > 30_000) throw new Error('container did not come up');
      await sleep(100);
    }
  }
}

function openSocket(seat) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?seat=${seat}`);
  const inbox = [];
  const waiters = [];
  ws.closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason, at: Date.now() })));
  ws.addEventListener('message', (e) => {
    inbox.push(e.data);
    waiters.splice(0).forEach((w) => w());
  });
  ws.next = async (timeout = 5_000) => {
    const deadline = Date.now() + timeout;
    while (!inbox.length) {
      if (Date.now() > deadline) throw new Error('no message');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
    return inbox.shift();
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function startContainer() {
  sh(`docker run -d --name ${NAME} -p 18080:8080 -v ${VOLUME}:/data workerd-spike`);
}

sh(`docker rm -f ${NAME} 2>/dev/null || true`);
sh(`docker volume rm ${VOLUME} 2>/dev/null || true`);
sh('docker build -q -t workerd-spike .');

startContainer();
log('cold start ms:', await waitUp());

// 1. Hibernation: socket survives eviction, attachment survives, auto-response doesn't wake the object.
await get('/put?k=roster&v=alice,bob');
const ws1 = await openSocket('seat-alice');
ws1.send('hello');
const first = JSON.parse(await ws1.next());
log('first echo:', first);
log('idle 15s so the object is evicted (default 10s)...');
await sleep(15_000);
ws1.send('ping');
log('auto-response while hibernated:', await ws1.next());
const eventsBefore = (await get('/state')).events.length;
ws1.send('after-idle');
const second = JSON.parse(await ws1.next());
log('echo after idle:', second, 'object re-constructed:', second.bootedAt !== first.bootedAt);
const afterIdle = await get('/state');
log('events since idle:', afterIdle.events.slice(eventsBefore - 1).map((e) => e.what));

// 2. Alarm fires while the socket is open and the object is hibernated.
await get('/alarm?ms=12000');
log('alarm set for +12s; idling...');
log('socket received:', await ws1.next(20_000));

// 3. Graceful restart (docker stop) with an alarm pending across the downtime.
await get('/put?k=phase&v=before-stop');
const alarmAt = (await get('/alarm?ms=8000')).at;
const stopStart = Date.now();
sh(`docker stop -t 10 ${NAME}`);
log('docker stop took ms:', Date.now() - stopStart);
log('client saw close:', await Promise.race([ws1.closed, sleep(2_000).then(() => 'no close event within 2s')]));
log('container down; waiting past the alarm time...');
await sleep(Math.max(0, alarmAt - Date.now()) + 5_000);
sh(`docker start ${NAME}`);
log('restart ms:', await waitUp());
await sleep(3_000);
const afterStop = await get('/state');
log('kv after graceful restart:', afterStop.kv);
log('pending alarm:', afterStop.alarm);
log('events tail:', afterStop.events.slice(-6).map((e) => `${e.at - alarmAt >= 0 ? '+' : ''}${e.at - alarmAt}ms ${e.what}`));

// 4. Reconnect after restart keeps working.
const ws2 = await openSocket('seat-alice');
ws2.send('back');
log('echo after reconnect:', JSON.parse(await ws2.next()));

// 5. Crash (SIGKILL) right after a write, with an alarm pending.
await get('/put?k=phase&v=before-kill');
const killAlarmAt = (await get('/alarm?ms=4000')).at;
sh(`docker kill ${NAME}`);
log('client saw close after kill:', await Promise.race([ws2.closed, sleep(2_000).then(() => 'no close event within 2s')]));
await sleep(Math.max(0, killAlarmAt - Date.now()) + 2_000);
sh(`docker start ${NAME}`);
log('restart after kill ms:', await waitUp());
await sleep(3_000);
const afterKill = await get('/state');
log('kv after kill:', afterKill.kv);
log('events tail:', afterKill.events.slice(-4).map((e) => `${e.at - killAlarmAt >= 0 ? '+' : ''}${e.at - killAlarmAt}ms ${e.what}`));

log('files on volume:\n' + sh(`docker exec ${NAME} sh -c 'find /data -type f | sort'`));
log('image size:', sh('docker image inspect workerd-spike --format "{{.Size}}"'), 'bytes');
log('container logs tail:\n' + sh(`docker logs --tail 15 ${NAME} 2>&1`));

sh(`docker rm -f ${NAME}`);
sh(`docker volume rm ${VOLUME}`);
process.exit(0);
