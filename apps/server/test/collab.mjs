import { chromium } from 'playwright';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],
});
const errs = [];
let pass = 0, fail = 0;
const ok = (n, c, extra='') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + extra); } };

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
// Read the CRDT's own content. The rendered DOM also carries the other
// person's cursor label, which is a decoration, not document text.
const text = p => p.evaluate(() => window.LC.roomEditor()?.getText().trim());

const teacher = await mk('teacher'), student = await mk('student');
await signIn(teacher, 'daniel@logicclass.plus', 'teach1234');
await signIn(student, 'amira@logicclass.plus', 'learn1234');
ok('editor bundle is not loaded before it is needed', await teacher.evaluate(() => !window.LCEditor));

// Create a session for exactly these two, so the document starts empty.
const sid = await student.evaluate(async () => {
  const token = localStorage.getItem('logicclass.plus.token');
  const api = (path, opts = {}) => fetch('http://localhost:4001/api' + path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(r => r.json());
  const users = (await api('/users')).users;
  const daniel = users.find(u => u.email === 'daniel@logicclass.plus');
  const req = await api('/classes/requests', { method: 'POST', body: {
    teacherId: daniel.id, subject: 'math', topic: 'Co-editing test ' + Date.now(),
    requestedFor: new Date(Date.now() + 2 * 3600e3).toISOString(), minutes: 60,
  }});
  return req.request.id;
});
const sessionId = await teacher.evaluate(async (requestId) => {
  const token = localStorage.getItem('logicclass.plus.token');
  const r = await fetch('http://localhost:4001/api/classes/requests/' + requestId, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ decision: 'accept' }),
  });
  return (await r.json()).session.id;
}, sid);
console.log('session:', sessionId);

for (const p of [teacher, student]) {
  await p.goto('http://localhost:4000/#/room/' + sessionId);
  await p.waitForTimeout(1400);
  await p.click('#hw-join');
  await p.waitForTimeout(1600);
  await p.click('[data-tab="document"]');
  await p.waitForTimeout(1500);
}
ok('bundle loads from the app, not a CDN', await teacher.evaluate(() =>
  !!window.LCEditor?.Editor && [...document.scripts].some(s => s.src.includes('/vendor/editor.bundle.js'))));
ok('editor mounts for both', Boolean(await teacher.evaluate(() => !!document.querySelector('.editor-host .ProseMirror'))
  && await student.evaluate(() => !!document.querySelector('.editor-host .ProseMirror'))));

// teacher types
await teacher.click('.editor-host .ProseMirror');
await teacher.keyboard.type('Vectors: resolve into components.');
await teacher.waitForTimeout(1500);
const s1 = await text(student);
ok('teacher keystrokes reach the student', (s1||'').includes('resolve into components'), JSON.stringify(s1));

// student types at the same time
await student.click('.editor-host .ProseMirror');
await student.keyboard.press('End');
await student.keyboard.type(' And then find the magnitude.');
await student.waitForTimeout(1500);
const t1 = await text(teacher), s2 = await text(student);
ok('student keystrokes reach the teacher', (t1||'').includes('find the magnitude'), JSON.stringify(t1));
ok('both documents converge', t1 === s2, JSON.stringify({ t1, s2 }));

// simultaneous typing — the real CRDT test
await Promise.all([
  (async () => { await teacher.click('.editor-host .ProseMirror'); await teacher.keyboard.press('End'); await teacher.keyboard.type(' AAAA'); })(),
  (async () => { await student.click('.editor-host .ProseMirror'); await student.keyboard.press('End'); await student.keyboard.type(' BBBB'); })(),
]);
await teacher.waitForTimeout(2500);
const t2 = await text(teacher), s3 = await text(student);
ok('simultaneous edits converge, nothing lost', t2 === s3 && t2.includes('AAAA') && t2.includes('BBBB'), JSON.stringify({ t2, s3 }));

// presence: each sees the other's cursor label
const presence = await teacher.textContent('#doc-presence');
ok('teacher sees the student in the document', /Amira/.test(presence), JSON.stringify(presence));
const caret = await teacher.evaluate(() => document.querySelectorAll('.collaboration-cursor__caret').length);
ok('remote caret is rendered', caret > 0, 'carets=' + caret);

await teacher.screenshot({ path: 'c1-teacher-doc.png' });
await student.screenshot({ path: 'c2-student-doc.png' });

// persistence: both leave, a third party opens it later
await teacher.waitForTimeout(2600);   // let the debounce write
const owner = await mk('owner');
await signIn(owner, 'owner@logicclass.plus', 'admin1234');
const stored = await owner.evaluate(async (sid) => {
  const token = localStorage.getItem('logicclass.plus.token');
  const r = await fetch('http://localhost:4001/api/classes/sessions/' + sid, { headers: { authorization: 'Bearer ' + token } });
  return (await r.json()).documents?.document || '';
}, sessionId);
ok('document persisted to postgres as a Yjs state', stored.startsWith('y:'), stored.slice(0, 24));

await teacher.close(); await student.close();
await new Promise(r => setTimeout(r, 1200));
const rejoin = await mk('rejoin');
await signIn(rejoin, 'daniel@logicclass.plus', 'teach1234');
await rejoin.goto('http://localhost:4000/#/room/' + sessionId);
await rejoin.waitForTimeout(1400); await rejoin.click('#hw-join'); await rejoin.waitForTimeout(1600);
await rejoin.click('[data-tab="document"]'); await rejoin.waitForTimeout(2000);
const restored = await text(rejoin);
ok('reopening restores the document from the server', (restored||'').includes('AAAA') && (restored||'').includes('BBBB'), JSON.stringify(restored));
await rejoin.screenshot({ path: 'c3-restored.png' });

console.log(`\n${pass} passed, ${fail} failed`);
console.log('ERRORS:', errs.length ? JSON.stringify([...new Set(errs)].slice(0,6), null, 1) : 'none');
await b.close();
process.exit(fail ? 1 : 0);
