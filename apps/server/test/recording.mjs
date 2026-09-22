/**
 * Recording control plane, against a stand-in for LiveKit.
 *
 * The egress worker is a separate service (Docker, with Chrome and ffmpeg), so
 * no MP4 is produced here. What this covers is everything either side of it:
 * starting egress and storing the id, the signed webhook that fills in the
 * file when egress finishes, rejection of forged webhooks, and the storage
 * accounting. For proof that a real LiveKit accepts our token and our egress
 * request, see test/sfu.mjs.
 *
 * Start the stand-in, then point the API at it:
 *   RECORDING_PROVIDER=livekit LIVEKIT_URL=http://127.0.0.1:45098 \
 *   LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret \
 *   S3_BUCKET=x S3_ACCESS_KEY_ID=x S3_SECRET_ACCESS_KEY=x npm run -w apps/server dev
 *
 * Run:  node apps/server/test/recording.mjs
 */
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';

const API = 'http://localhost:4001/api';
const KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const SECRET = process.env.LIVEKIT_API_SECRET || 'devsecretdevsecretdevsecretdevsecret';
const MOCK_PORT = Number(process.env.LIVEKIT_MOCK_PORT || 45098);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

/* ---------------- stand-in LiveKit ---------------- */
let lastEgressRequest = null;
const EGRESS_ID = 'EG_teststandin001';
const livekit = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    lastEgressRequest = { url: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ egressId: EGRESS_ID, status: 'EGRESS_STARTING' }));
  });
});
await new Promise((r) => livekit.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`stand-in LiveKit listening on http://127.0.0.1:${MOCK_PORT}\n`);

/* ---------------- helpers ---------------- */
async function call(path, { method = 'GET', body, token, headers = {}, raw } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(raw ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const login = async (email, password) =>
  (await call('/auth/login', { method: 'POST', body: { email, password } })).json;

/** A LiveKit webhook token: signed with the API secret, carrying the body digest. */
function webhookToken(rawBody) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    iss: KEY, nbf: now - 10, exp: now + 600,
    sha256: createHash('sha256').update(rawBody).digest('base64'),
  });
  const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const teacher = await login('daniel@logicclass.plus', 'teach1234');
const student = await login('amira@logicclass.plus', 'learn1234');
const owner = await login('owner@logicclass.plus', 'admin1234');

const sessions = (await call('/classes/sessions', { token: teacher.token })).json.sessions;
const session = sessions.find((s) => s.status === 'scheduled' || s.status === 'live') ?? sessions[0];
console.log('session:', session.id, `(${session.minutes} min)`);

console.log('\n1. Size estimates match the encoder settings');
const est = (await call(`/recordings/estimate?minutes=180`, { token: teacher.token })).json;
ok('a 3-hour class at 720p is about 2.15 GB',
  Math.abs(est.presets['720p'].bytes / 1e9 - 2.15) < 0.02, String(est.presets['720p'].bytes));
ok('audio only is two orders of magnitude smaller',
  est.presets.audio.bytes * 30 < est.presets['720p'].bytes, String(est.presets.audio.bytes));
ok('every preset is offered', Object.keys(est.presets).length === 5);

console.log('\n2. Permissions');
const studentStart = await call(`/recordings/${session.id}/start`, { method: 'POST', token: student.token, body: {} });
ok('a student cannot start a recording', studentStart.status === 403, String(studentStart.status));
const anonStart = await call(`/recordings/${session.id}/start`, { method: 'POST', body: {} });
ok('an anonymous caller cannot start a recording', anonStart.status === 401);
const usageAsTeacher = await call('/recordings/usage', { token: teacher.token });
ok('storage usage is owner-only', usageAsTeacher.status === 403);

console.log('\n3. Starting egress');
const started = await call(`/recordings/${session.id}/start`, { method: 'POST', token: teacher.token, body: {} });
if (started.status === 503) {
  console.log('  (recording not configured on this server — skipping the rest)');
  console.log(`\n${pass} passed, ${fail} failed`);
  livekit.close();
  process.exit(fail ? 1 : 0);
}
ok('the teacher can start it', started.status === 201, JSON.stringify(started.json).slice(0, 140));
ok('the egress id is returned', started.json.egressId === EGRESS_ID);
ok('the expected size is reported up front', started.json.estimatedBytes > 0);

const sent = lastEgressRequest?.body ?? {};
ok('room composite egress requested for this session',
  /StartRoomCompositeEgress/.test(lastEgressRequest?.url || '') && sent.room_name === `lc-session-${session.id}`,
  JSON.stringify({ url: lastEgressRequest?.url, room: sent.room_name }));
ok('the file goes straight to object storage, not through this API',
  Boolean(sent.file_outputs?.[0]?.s3?.bucket), JSON.stringify(sent.file_outputs?.[0] ?? {}));
ok('the request is authenticated with a bearer token',
  /^Bearer /.test(lastEgressRequest?.headers?.authorization || ''));
ok('encoder settings match the preset used for the estimate',
  sent.advanced?.width === 1280 && sent.advanced?.height === 720 && sent.advanced?.video_bitrate === 1500,
  JSON.stringify(sent.advanced ?? {}));

const twice = await call(`/recordings/${session.id}/start`, { method: 'POST', token: teacher.token, body: {} });
ok('starting twice is refused', twice.status === 400, String(twice.status));

// Recording someone without telling them is unlawful in much of the world.
const notices = (await call('/notifications', { token: student.token })).json.notifications;
ok('the student is told the class is being recorded',
  notices.some((n) => n.type === 'recording' && /being recorded/i.test(n.title)),
  JSON.stringify(notices.slice(0, 2).map((n) => n.title)));

console.log('\n4. The webhook that lands when egress finishes');
const payload = JSON.stringify({
  event: 'egress_ended',
  egressInfo: {
    egressId: EGRESS_ID, status: 'EGRESS_COMPLETE',
    fileResults: [{
      filename: `recordings/${session.id}/final.mp4`,
      location: `https://storage.example.com/recordings/${session.id}/final.mp4`,
      size: 2_150_000_000, duration: 10_800 * 1e9,
    }],
  },
});

const forged = await call('/recordings/webhook', { method: 'POST', raw: true, body: payload,
  headers: { authorization: webhookToken('{"event":"something-else"}'), 'content-type': 'application/json' } });
ok('a body that does not match its signature is rejected', forged.status === 400, forged.text.slice(0, 90));

const wrongKeyToken = (() => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: KEY, exp: now + 600, sha256: createHash('sha256').update(payload).digest('base64') });
  const sig = createHmac('sha256', 'not-the-real-secret').update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
})();
const wrongKey = await call('/recordings/webhook', { method: 'POST', raw: true, body: payload,
  headers: { authorization: wrongKeyToken, 'content-type': 'application/json' } });
ok('a webhook signed with the wrong secret is rejected', wrongKey.status === 400, wrongKey.text.slice(0, 90));

const unsigned = await call('/recordings/webhook', { method: 'POST', raw: true, body: payload,
  headers: { 'content-type': 'application/json' } });
ok('an unsigned webhook is rejected', unsigned.status === 400);

const accepted = await call('/recordings/webhook', { method: 'POST', raw: true, body: payload,
  headers: { authorization: webhookToken(payload), 'content-type': 'application/json' } });
ok('a correctly signed webhook is accepted', accepted.status === 200, accepted.text.slice(0, 90));

await new Promise((r) => setTimeout(r, 700));   // the handler answers first, then works
const after = (await call('/classes/sessions', { token: teacher.token })).json.sessions
  .find((s) => s.id === session.id);
ok('the recording url is stored on the session',
  after.recordingUrl === `https://storage.example.com/recordings/${session.id}/final.mp4`,
  String(after.recordingUrl));

console.log('\n5. Storage accounting');
const usage = (await call('/recordings/usage', { token: owner.token })).json;
ok('the owner sees what has been stored', usage.recordings >= 1 && usage.totalBytes >= 2_150_000_000,
  JSON.stringify({ recordings: usage.recordings, gb: (usage.totalBytes / 1e9).toFixed(2) }));
ok('hours recorded are tracked', usage.totalHours >= 3, String(usage.totalHours));
ok('an annual projection is offered', usage.projectedAnnualBytes >= usage.last30DaysBytes);

console.log(`\n${pass} passed, ${fail} failed`);
livekit.close();
process.exit(fail ? 1 : 0);
