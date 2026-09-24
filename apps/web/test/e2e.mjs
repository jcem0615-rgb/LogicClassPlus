/**
 * The Next.js client, driven through a real browser against a real API.
 *
 * Covers the flows that matter across two participants: sign-in, the screens
 * each role sees, a class request arriving live, and a classroom with chat,
 * whiteboard and a shared document crossing between two browsers.
 *
 * Needs the API on :4001 and this client on :4000 (npm run -w apps/web build
 * && npm run -w apps/web start).
 *
 * Run:  node apps/web/test/e2e.mjs
 */
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL || 'http://localhost:4000';
const API = process.env.API_URL || 'http://localhost:4001';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const errors = [];

async function open(name) {
  const page = await browser.newPage({ viewport: { width: 1340, height: 900 } });
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(text)) errors.push(`[${name}] ${text}`);
  });
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  return page;
}

async function signIn(page, email, password) {
  await page.waitForSelector('#login-email');
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard', { timeout: 20_000 });
  await page.waitForTimeout(1200);
}

console.log('1. Sign in and dashboards');
const teacher = await open('teacher');
await signIn(teacher, 'daniel@logicclass.plus', 'teach1234');
const teacherSummary = (await teacher.textContent('main')).replace(/\s+/g, ' ');
ok('teacher dashboard renders real figures',
  /Classes today/.test(teacherSummary) && /On-time rate/.test(teacherSummary), teacherSummary.slice(0, 120));
ok('demo credentials load their data', /Taught this week/.test(teacherSummary));

const student = await open('student');
await signIn(student, 'amira@logicclass.plus', 'learn1234');
ok('student dashboard differs from the teacher one',
  /Hours studied|Balance due/.test((await student.textContent('main')).replace(/\s+/g, ' ')));

console.log('\n2. Role-gated navigation');
const nav = await teacher.$$eval('nav a', (as) => as.map((a) => a.getAttribute('href')));
ok('a teacher sees payroll and attendance', nav.includes('/payroll') && nav.includes('/attendance'));
ok('a teacher does not see billing or people', !nav.includes('/billing') && !nav.includes('/people'));
const studentNav = await student.$$eval('nav a', (as) => as.map((a) => a.getAttribute('href')));
ok('a student sees billing but not payroll',
  studentNav.includes('/billing') && !studentNav.includes('/payroll'));

for (const [path, marker] of [['/classes', 'Upcoming'], ['/library', 'Folders'], ['/payroll', 'Batch history'], ['/attendance', 'Clock in']]) {
  await teacher.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
  await teacher.waitForTimeout(700);
  const body = (await teacher.textContent('main')).replace(/\s+/g, ' ');
  ok(`${path} renders`, body.includes(marker), body.slice(0, 100));
}

const owner = await open('owner');
await signIn(owner, 'owner@logicclass.plus', 'admin1234');
await owner.goto(`${WEB}/people`, { waitUntil: 'networkidle' });
await owner.waitForTimeout(800);
ok('owner sees every account', (await owner.textContent('main')).includes('All accounts'));

console.log('\n3. A request reaches the teacher live');
const requestId = await student.evaluate(async ({ api }) => {
  const token = localStorage.getItem('logicclass.token');
  const call = (path, options = {}) => fetch(api + '/api' + path, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then((r) => r.json());
  const users = (await call('/users')).users;
  const daniel = users.find((u) => u.email === 'daniel@logicclass.plus');
  const r = await call('/classes/requests', { method: 'POST', body: {
    teacherId: daniel.id, subject: 'math', topic: 'Next.js client test ' + Date.now(),
    requestedFor: new Date(Date.now() + 2 * 3600e3).toISOString(), minutes: 60,
  }});
  return r.request.id;
}, { api: API });

await teacher.goto(`${WEB}/classes`, { waitUntil: 'networkidle' });
await teacher.waitForTimeout(2500);
ok('the new request appears without a reload',
  (await teacher.textContent('main')).includes('Next.js client test'));

await teacher.click('button:has-text("Accept")');
await teacher.waitForTimeout(2000);
const sessionId = await teacher.evaluate(async ({ api, requestId }) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(api + '/api/classes/sessions', { headers: { authorization: 'Bearer ' + token } });
  const sessions = (await r.json()).sessions;
  return sessions.find((s) => s.requestId === requestId)?.id;
}, { api: API, requestId });
ok('accepting creates the session', Boolean(sessionId), String(sessionId));

console.log('\n4. The classroom, across two browsers');
for (const page of [teacher, student]) {
  await page.goto(`${WEB}/room/${sessionId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#hw-join', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.click('#hw-join');
  await page.waitForTimeout(3000);
}
await teacher.waitForTimeout(4000);

const transport = await teacher.textContent('#transport-tag');
ok('a transport was chosen and shown', /media server|peer to peer/.test(transport || ''), transport);

await student.fill('#chat-input', 'Does this cross to the teacher?');
await student.click('form button[type=submit]');
await student.waitForTimeout(2000);
ok('chat crosses between the two browsers',
  (await teacher.textContent('main')).includes('Does this cross to the teacher?'));

const box = await teacher.locator('canvas').first().boundingBox();
await teacher.mouse.move(box.x + 60, box.y + 60);
await teacher.mouse.down();
await teacher.mouse.move(box.x + 240, box.y + 160, { steps: 10 });
await teacher.mouse.up();
await teacher.waitForTimeout(2000);
const ink = await student.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 200 && data[i + 1] < 200) count++;
  return count;
});
ok('a whiteboard stroke reaches the other board', ink > 100, 'ink=' + ink);

for (const page of [teacher, student]) {
  await page.click('button[data-tab="document"]');
  await page.waitForTimeout(2000);
}
await teacher.click('.ProseMirror');
await teacher.keyboard.type('Vectors resolve into components.');
await teacher.waitForTimeout(2500);
const studentDoc = await student.textContent('.ProseMirror');
ok('the shared document co-edits live', (studentDoc || '').includes('resolve into components'), studentDoc);

await student.click('.ProseMirror');
await student.keyboard.press('End');
await student.keyboard.type(' Then find the magnitude.');
await student.waitForTimeout(2500);
const teacherDoc = await teacher.textContent('.ProseMirror');
ok('edits converge both ways', (teacherDoc || '').includes('find the magnitude'), teacherDoc);

await teacher.click('button[data-tab="equations"]');
await teacher.waitForTimeout(1200);
ok('the equation editor renders MathML',
  (await teacher.$$eval('math', (els) => els.length)) > 0);

await teacher.click('button[data-tab="notes"]');
await teacher.waitForTimeout(2000);
const notes = (await teacher.textContent('main')).replace(/\s+/g, ' ');
ok('the session panel sizes a recording', /This session/.test(notes) && /min →/.test(notes), notes.slice(0, 160));

// Saving a whiteboard re-hydrates the store, which hands back a fresh session
// object. That used to re-run the room's cleanup and tear the class down:
// camera off, peer closed, classroom:leave emitted. The class must survive it.
await teacher.click('button[data-tab="whiteboard"]');
await teacher.waitForTimeout(1200);
const liveBefore = await teacher.evaluate(() => {
  const v = document.querySelector('video');
  const s = v && v.srcObject;
  return s ? s.getTracks().filter((t) => t.readyState === 'live').length : 0;
});
await teacher.click('button:has-text("Save to library")');
await teacher.waitForTimeout(5000);
const liveAfter = await teacher.evaluate(() => {
  const v = document.querySelector('video');
  const s = v && v.srcObject;
  return s ? s.getTracks().filter((t) => t.readyState === 'live').length : 0;
});
ok('saving to the library does not stop the camera',
  liveBefore > 0 && liveAfter === liveBefore, `live tracks ${liveBefore} -> ${liveAfter}`);
ok('and does not drop the other participant',
  /peer to peer|media server/.test((await teacher.textContent('#transport-tag')) || '')
  && !/Reconnecting|left the room/i.test((await student.textContent('main')).replace(/\s+/g, ' ')));

// The class clock is what a teacher watches to know how much of a booked hour
// is left, and what the business bills against. Both properties matter: it has
// to count against the booking, and it must not restart when a tab closes.
const clock = (await teacher.textContent('[data-testid=class-clock]')).replace(/\s+/g, ' ');
ok('the class clock counts against the booked length',
  /Class time/.test(clock) && /\/ \d\d:\d\d/.test(clock) && /left of \d+ minutes/.test(clock), clock);

const before = await teacher.textContent('[data-testid=class-elapsed]');
const seconds = (t) => t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);

// Closing the tab mid-class and coming back is the accident this guards: the
// clock is anchored to the server's joinedAt, so it continues rather than
// restarting at zero.
await teacher.goto(`${WEB}/classes`, { waitUntil: 'networkidle' });
await teacher.waitForTimeout(4000);
await teacher.goto(`${WEB}/room/${sessionId}`, { waitUntil: 'networkidle' });
await teacher.waitForSelector('#hw-join', { timeout: 20_000 });
await teacher.click('#hw-join');
await teacher.waitForTimeout(3500);
const after = await teacher.textContent('[data-testid=class-elapsed]');
ok('leaving and re-entering continues the class rather than restarting it',
  seconds(after) >= seconds(before), `${before} -> ${after}`);

await teacher.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/web-room.png' });
await teacher.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
await teacher.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/web-dashboard.png' });

console.log('\n5. The API address is set in the browser, not baked in');
const visitor = await open('visitor');
const panel = (await visitor.textContent('[data-panel=api]')).replace(/\s+/g, ' ');
ok('the sign-in page names the API it is using',
  panel.includes(API) && /answering/.test(panel), panel.slice(-200));

// A hosted client cannot know where the reader's API runs, so the address has
// to survive being handed over in a link.
await visitor.goto(`${WEB}/?api=http://127.0.0.1:4001`, { waitUntil: 'networkidle' });
await visitor.waitForTimeout(1500);
ok('?api= is adopted and dropped from the address bar',
  !visitor.url().includes('api=')
  && (await visitor.evaluate(() => localStorage.getItem('logicclass.api'))) === 'http://127.0.0.1:4001');
ok('the adopted address is the one shown and probed',
  (await visitor.textContent('[data-panel=api]')).includes('http://127.0.0.1:4001'));

// And a wrong address has to say so rather than looking like a broken sign-in.
await visitor.goto(`${WEB}/?api=http://127.0.0.1:4999`, { waitUntil: 'networkidle' });
await visitor.waitForTimeout(2500);
ok('an API that is not there is reported, not silently failed',
  /not reachable/.test((await visitor.textContent('[data-panel=api]')).replace(/\s+/g, ' ')));
await visitor.close();

console.log('\n6. A saved API address that dies does not brick the browser');
// The exact failure this guards: a browser holds an address for a host that
// has since gone away. Without a fallback that browser can never sign in
// again, however healthy the real API is.
const stranded = await open('stranded');
await stranded.evaluate(() => localStorage.setItem('logicclass.api', 'https://gone.invalid.example'));
await stranded.goto(WEB, { waitUntil: 'networkidle' });
await stranded.waitForTimeout(6000);
const healed = (await stranded.textContent('[data-panel=api]')).replace(/\s+/g, ' ');
ok('a dead saved address falls back to the build default',
  healed.includes(API) && /answering/.test(healed), healed.slice(0, 200));
ok('and says so rather than silently changing under you',
  /stopped answering/.test(healed), healed.slice(0, 200));

// A bad address typed by hand is a different case: say so, do not undo it.
await stranded.click('[data-panel=api] button');
await stranded.fill('[data-panel=api] input', 'http://127.0.0.1:4999');
await stranded.click('[data-panel=api] button[type=submit]');
await stranded.waitForTimeout(3000);
const typed = (await stranded.textContent('[data-panel=api]')).replace(/\s+/g, ' ');
ok('an address typed by hand is reported, not quietly reverted',
  /not reachable/.test(typed) && typed.includes('127.0.0.1:4999'), typed.slice(0, 200));
await stranded.close();

console.log('\n7. Demo accounts sign in on click');
const demo = await open('demo');
await demo.click('[data-demo="daniel@logicclass.plus"]');
await demo.waitForURL('**/dashboard', { timeout: 20_000 });
await demo.waitForTimeout(1500);
ok('one click on a demo row signs that account in',
  /Classes today|Taught this week/.test((await demo.textContent('main')).replace(/\s+/g, ' ')));
await demo.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log('ERRORS:', errors.length ? JSON.stringify([...new Set(errors)].slice(0, 8), null, 1) : 'none');
await browser.close();
process.exit(fail ? 1 : 0);
