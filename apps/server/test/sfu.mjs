/**
 * Two browsers through a real LiveKit SFU.
 *
 * This is the transport recording depends on: peer-to-peer media never reaches
 * the server, so there is nothing to capture. Here both participants publish
 * into the media server, subscribe to each other, and the room is then asked to
 * record — which proves LiveKit accepts our token and our egress request. The
 * egress worker itself is a separate service (Docker, Chrome, ffmpeg), so the
 * final MP4 is not produced by this test.
 *
 * Needs the client on :4000, the API on :4001, and a LiveKit server:
 *
 *   curl -sL https://github.com/livekit/livekit/releases/download/v1.12.0/\
 *     livekit_1.12.0_linux_amd64.tar.gz | tar xz
 *   ./livekit-server --dev            # devkey / secret, port 7880
 *
 *   RECORDING_PROVIDER=livekit LIVEKIT_URL=http://127.0.0.1:7880 \
 *   LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
 *   S3_BUCKET=x S3_ACCESS_KEY_ID=x S3_SECRET_ACCESS_KEY=x npm run -w apps/server dev
 *
 * The client SDK and the server speak a versioned signalling path, so keep
 * livekit-server reasonably current: 1.8 answers 404 to livekit-client 2.2x.
 *
 * Run:  node apps/server/test/sfu.mjs
 */
import { chromium } from 'playwright';
let pass = 0, fail = 0;
const ok = (n, c, x='') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

const b = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],
});
const errs = [];
async function mk(name) {
  const p = await b.newPage({ viewport: { width: 1340, height: 900 } });
  p.on('pageerror', e => errs.push(`[${name}] ${e.message}`));
  p.on('console', m => { if (m.type()==='error' && !/Failed to load resource/.test(m.text())) errs.push(`[${name}] ${m.text()}`); });
  await p.goto('http://localhost:4000/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('logicclass.plus.server','http://localhost:4001'); });
  await p.goto('http://localhost:4000/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  return p;
}
async function signIn(p, e, pw) {
  await p.fill('#login-email', e); await p.fill('#login-password', pw);
  await p.click('button[type=submit]'); await p.waitForTimeout(1900);
}

const teacher = await mk('teacher'), student = await mk('student');
await signIn(teacher, 'daniel@logicclass.plus', 'teach1234');
await signIn(student, 'amira@logicclass.plus', 'learn1234');

// fresh session for these two
const reqId = await student.evaluate(async () => {
  const t = localStorage.getItem('logicclass.plus.token');
  const api = (p, o={}) => fetch('http://localhost:4001/api'+p, { method:o.method||'GET',
    headers:{'content-type':'application/json',authorization:'Bearer '+t}, body:o.body?JSON.stringify(o.body):undefined }).then(r=>r.json());
  const users = (await api('/users')).users;
  const daniel = users.find(u => u.email === 'daniel@logicclass.plus');
  const r = await api('/classes/requests', { method:'POST', body:{ teacherId: daniel.id, subject:'math',
    topic:'SFU recording test '+Date.now(), requestedFor:new Date(Date.now()+2*3600e3).toISOString(), minutes:60 }});
  return r.request.id;
});
const sid = await teacher.evaluate(async (id) => {
  const t = localStorage.getItem('logicclass.plus.token');
  const r = await fetch('http://localhost:4001/api/classes/requests/'+id, { method:'PATCH',
    headers:{'content-type':'application/json',authorization:'Bearer '+t}, body: JSON.stringify({decision:'accept'}) });
  return (await r.json()).session.id;
}, reqId);
console.log('session:', sid);

for (const p of [teacher, student]) {
  await p.goto('http://localhost:4000/#/room/' + sid);
  await p.waitForTimeout(1400);
  await p.click('#hw-join');
  await p.waitForTimeout(2500);
}
await teacher.waitForTimeout(4000);

const transport = p => p.evaluate(() => document.getElementById('transport-tag')?.innerText.trim());
ok('teacher routed through the media server', /media server/.test(await transport(teacher) || ''), await transport(teacher));
ok('student routed through the media server', /media server/.test(await transport(student) || ''), await transport(student));

const probe = p => p.evaluate(() => {
  const room = LC.sfu.current();
  const v = document.getElementById('remote-video');
  return {
    state: room ? String(room.state) : 'none',
    remotes: room ? room.remoteParticipants.size ?? room.participants?.size ?? 0 : 0,
    published: room ? room.localParticipant.trackPublications.size : 0,
    videoVisible: v ? !v.classList.contains('hide') : false,
    videoW: v ? v.videoWidth : 0,
    tracks: (v && v.srcObject) ? v.srcObject.getTracks().length : 0,
  };
});
const t = await probe(teacher), s = await probe(student);
console.log('teacher:', JSON.stringify(t));
console.log('student:', JSON.stringify(s));
ok('both connected to the SFU', t.state === 'connected' && s.state === 'connected');
ok('both published their tracks', t.published >= 2 && s.published >= 2);
ok('each sees the other as a remote participant', t.remotes === 1 && s.remotes === 1);
ok('remote video is playing real frames', t.videoW > 0 && s.videoW > 0 && t.videoVisible && s.videoVisible);

await teacher.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/lk1-teacher-sfu.png' });

// the whole point: with media in the SFU, can it be recorded?
console.log('\nasking LiveKit to record the room');
const rec = await teacher.evaluate(async (sid) => {
  const t = localStorage.getItem('logicclass.plus.token');
  const r = await fetch('http://localhost:4001/api/recordings/' + sid + '/start', {
    method: 'POST', headers: { 'content-type':'application/json', authorization: 'Bearer ' + t }, body: '{}' });
  return { status: r.status, body: await r.text() };
}, sid);
console.log('  ->', rec.status, rec.body.slice(0, 260));
ok('LiveKit knows the room, so there is media to record',
  !/room does not exist/.test(rec.body), rec.body.slice(0, 120));
ok('the only thing missing is the egress worker',
  rec.status === 201 || /no response from servers|egress/i.test(rec.body),
  rec.body.slice(0, 160));
if (rec.status !== 201) {
  console.log('  note: no egress worker is running, so no file is produced.');
  console.log('        run livekit/egress (Docker, needs Redis) for an actual MP4.');
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('ERRORS:', errs.length ? JSON.stringify([...new Set(errs)].slice(0,6), null, 1) : 'none');
await b.close();
