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
ok('a teacher does not see billing or the admin portal', !nav.includes('/billing') && !nav.includes('/admin'));
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
await owner.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
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

console.log('\n8. Whiteboard zoom, simpler equations, subject filter');
const t2 = await open('teacher2');
await signIn(t2, 'daniel@logicclass.plus', 'teach1234');

// Zoom: the control reports the level, and the board can be zoomed and refit.
await t2.goto(`${WEB}/room/${sessionId}`, { waitUntil: 'networkidle' });
await t2.waitForSelector('#hw-join', { timeout: 20_000 });
await t2.click('#hw-join');
await t2.waitForTimeout(3000);
await t2.click('button[data-tab="whiteboard"]');
await t2.waitForTimeout(800);
const zoomStart = await t2.textContent('[data-testid=zoom-level]');
await t2.click('[data-testid=zoom-in]');
await t2.click('[data-testid=zoom-in]');
const zoomedIn = await t2.textContent('[data-testid=zoom-level]');
ok('the whiteboard zooms in', Number(zoomedIn.replace('%','')) > Number(zoomStart.replace('%','')),
  `${zoomStart} -> ${zoomedIn}`);
await t2.click('[data-testid=zoom-fit]');
ok('and Fit returns the whole page', (await t2.textContent('[data-testid=zoom-level]')) === '100%');

// Equations: usable without typing LaTeX, and the source is optional.
await t2.click('button[data-tab="equations"]');
await t2.waitForTimeout(900);
ok('the equation editor opens without a LaTeX box',
  (await t2.$$eval('#eq-src', (els) => els.length)) === 0);
await t2.click('button:has-text("Pythagoras")');
await t2.waitForTimeout(600);
ok('a named starter renders real notation',
  (await t2.$$eval('[data-testid=eq-preview] math', (els) => els.length)) > 0);
await t2.click('[data-testid=eq-source-toggle]');
await t2.waitForTimeout(400);
ok('and the LaTeX source is still one click away',
  (await t2.inputValue('#eq-src')).includes('a^{2}'));

// Subject filter on the library.
await t2.goto(`${WEB}/library`, { waitUntil: 'networkidle' });
await t2.waitForTimeout(1500);
const allFolders = await t2.$$eval('[data-testid=subject-filter] ~ button', (els) => els.length);
await t2.click('[data-subject="math"]');
await t2.waitForTimeout(600);
const mathFolders = await t2.$$eval('[data-testid=subject-filter] ~ button', (els) => els.length);
const mathText = (await t2.textContent('[data-testid=subject-filter] ~ button')) || '';
ok('the library filters folders by subject',
  mathFolders > 0 && mathFolders <= allFolders, `all ${allFolders}, math ${mathFolders}`);
ok('and the filtered list only shows that subject',
  !/english/i.test(mathText), mathText.slice(0, 80));
await t2.close();

console.log('\n9. Admin portal');
const admin = await open('admin');
await signIn(admin, 'owner@logicclass.plus', 'admin1234');
await admin.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
await admin.waitForTimeout(2000);

const adminText = (await admin.textContent('main')).replace(/\s+/g, ' ');
ok('the portal gathers the owner-only work',
  /Awaiting approval/.test(adminText) && /All accounts/.test(adminText)
  && /Password reset requests/.test(adminText), adminText.slice(0, 160));

// The pay rate is the thing payroll multiplies by, so it has to be editable
// and it has to persist — not just redraw optimistically.
const rateBefore = await admin.textContent('[data-rate="daniel@logicclass.plus"]');
await admin.click('[data-edit="daniel@logicclass.plus"]');
await admin.waitForSelector('#rate-input');
await admin.fill('#rate-input', '41.5');
await admin.click('[data-save-account]');
await admin.waitForTimeout(2500);
const rateAfter = await admin.textContent('[data-rate="daniel@logicclass.plus"]');
ok('the owner can change a teacher pay rate', /41\.5/.test(rateAfter), `${rateBefore} -> ${rateAfter}`);

await admin.reload({ waitUntil: 'networkidle' });
await admin.waitForTimeout(2500);
ok('and the new rate survives a reload',
  /41\.5/.test(await admin.textContent('[data-rate="daniel@logicclass.plus"]')));

// Only the owner. A teacher calling the endpoint directly must be refused.
const refused = await teacher.evaluate(async (api) => {
  const res = await fetch(`${api}/api/users/00000000/`.replace(/\/$/, ''), {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${localStorage.getItem('logicclass.token')}`,
    },
    body: JSON.stringify({ hourlyRate: 999 }),
  });
  return res.status;
}, API);
ok('a teacher cannot edit accounts through the API', refused === 403, `status ${refused}`);
await admin.close();

console.log('\n10. Parents');
const parent = await open('parent');
await signIn(parent, 'nadia@logicclass.plus', 'parent1234');
await parent.waitForTimeout(2500);
const parentMain = (await parent.textContent('main')).replace(/\s+/g, ' ');
ok('a parent sees their child by name',
  /Amira/.test(parentMain) && /Children/.test(parentMain), parentMain.slice(0, 180));
// The first tile reads "Next class" normally and "In class now" while a
// child is in one, so either wording counts as the figure being there.
ok('and the figures that matter to them',
  /Next class|In class now/.test(parentMain) && /Balance due/.test(parentMain),
  parentMain.slice(0, 160));

// Whatever that tile says has to match the cards underneath it: the summary
// claimed nothing was booked while four classes were listed below.
const agree = await parent.evaluate(() => {
  const text = document.querySelector('main').textContent.replace(/\s+/g, ' ');
  const upcoming = Number(/Upcoming\s*(\d+)/i.exec(text)?.[1] ?? '-1');
  const rows = document.querySelectorAll('main .border-l-2').length;
  const quiet = /none booked|Nothing booked/.test(text);
  return { upcoming, rows, quiet };
});
ok('and the headline agrees with the classes listed below it',
  (agree.upcoming > 0) === (agree.rows > 0) && (agree.upcoming === 0 || !agree.quiet),
  JSON.stringify(agree));

const parentNav = await parent.$$eval('nav a', (as) => as.map((a) => a.getAttribute('href')));
ok('a parent gets billing but not payroll, attendance or admin',
  parentNav.includes('/billing') && !parentNav.includes('/payroll')
  && !parentNav.includes('/attendance') && !parentNav.includes('/admin'),
  parentNav.join(','));

// The point of the whole feature: one family cannot see another's.
const leak = await parent.evaluate(async (api) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/classes/sessions`, { headers: { authorization: `Bearer ${token}` } });
  const { sessions } = await r.json();
  return [...new Set(sessions.flatMap((s) => s.studentIds))];
}, API);
const amiraId = await parent.evaluate(async (api) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/users/children`, { headers: { authorization: `Bearer ${token}` } });
  const { children } = await r.json();
  return children.map((c) => c.id);
}, API);
ok('a parent only ever sees their own children\'s sessions',
  leak.length > 0 && leak.every((id) => amiraId.includes(id)),
  `sessions for ${leak.length} student(s), linked to ${amiraId.length}`);

// A group class puts other families' children in the same record. A parent is
// told how full it is and nothing about who else is in it.
const shared = await parent.evaluate(async (api) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/classes/sessions`, { headers: { authorization: `Bearer ${token}` } });
  const { sessions } = await r.json();
  return sessions.filter((s) => s.capacity > 1).map((s) => ({ seen: s.studentIds.length, booked: s.booked }));
}, API);
ok('a parent sees a group class without its other children',
  shared.length > 0 && shared.some((s) => s.booked > s.seen) && shared.every((s) => s.seen <= s.booked),
  JSON.stringify(shared));

// Linking is the Owner's job, not something a parent can grant themselves.
const selfLink = await parent.evaluate(async (api) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/users/x/children`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ studentId: 'y' }),
  });
  return r.status;
}, API);
ok('a parent cannot link a child to themselves', selfLink === 403, `status ${selfLink}`);
await parent.close();

// The Owner assigns from the admin portal.
const owner2 = await open('owner2');
await signIn(owner2, 'owner@logicclass.plus', 'admin1234');
await owner2.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
await owner2.waitForTimeout(2000);
ok('the admin portal lists parents and what they are linked to',
  /Parents and their students/.test((await owner2.textContent('main')).replace(/\s+/g, ' ')));
await owner2.click('[data-link="nadia@logicclass.plus"]');
await owner2.waitForSelector('[data-child="kenji@logicclass.plus"]');
await owner2.click('[data-child="kenji@logicclass.plus"]');
await owner2.waitForTimeout(2500);
ok('the owner can link another student',
  (await owner2.textContent('[data-child="kenji@logicclass.plus"]')).includes('Linked'));
await owner2.click('[data-child="kenji@logicclass.plus"]');
await owner2.waitForTimeout(2500);
ok('and unlink them again',
  (await owner2.textContent('[data-child="kenji@logicclass.plus"]')).includes('Link')
  && !(await owner2.textContent('[data-child="kenji@logicclass.plus"]')).includes('Linked'));
// Registering as a parent has to actually produce a parent. The role was
// mapped with a `=== 'teacher' ? TEACHER : STUDENT` ternary, so every parent
// who signed up became a student — invisible until they saw someone's
// timetable. Signing up through the form is the only way to catch that.
const signup = await open('signup');
const addr = `guardian-${Date.now()}@example.test`;
await signup.click('[data-mode="register"]');
await signup.waitForSelector('input[name="name"]');
await signup.fill('input[name="name"]', 'Priya Raman');
await signup.fill('input[name="email"]', addr);
await signup.fill('input[name="password"]', 'guardian1234');
await signup.selectOption('select[name="role"]', 'parent');
ok('the subject field goes away for a parent',
  await signup.locator('select[name="subject"]').count() === 0);
await signup.click('button[type="submit"]');
await signup.waitForTimeout(2500);
await signup.close();

const owner3 = await open('owner3');
await signIn(owner3, 'owner@logicclass.plus', 'admin1234');
const created = await owner3.evaluate(async ([api, email]) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/users`, { headers: { authorization: `Bearer ${token}` } });
  const { users } = await r.json();
  return users.find((u) => u.email === email) ?? null;
}, [API, addr]);
ok('a parent who signs up is a parent, awaiting approval',
  created?.role === 'parent' && created?.status === 'pending',
  JSON.stringify(created && { role: created.role, status: created.status }));
await owner3.close();

console.log('\n11. Group classes');

// The teacher opens a class with seats; the browser does it, because the form
// is half the feature.
const tutor = await open('tutor');
await signIn(tutor, 'daniel@logicclass.plus', 'teach1234');
await tutor.goto(`${WEB}/classes`, { waitUntil: 'networkidle' });
await tutor.waitForSelector('[data-testid=open-group]');
const title = `Group e2e ${Date.now()}`;
const slot = new Date(Date.now() + 3 * 3600e3);
const localSlot = new Date(slot.getTime() - slot.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
await tutor.fill('[data-testid=open-group] input[name=topic]', title);
await tutor.fill('[data-testid=open-group] input[name=when]', localSlot);
await tutor.fill('[data-testid=open-group] input[name=capacity]', '2');
await tutor.fill('[data-testid=open-group] input[name=seatPrice]', '9');
await tutor.click('[data-testid=open-group] button[type=submit]');
await tutor.waitForTimeout(2500);

const classId = await tutor.evaluate(async ([api, topic]) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/classes/sessions`, { headers: { authorization: `Bearer ${token}` } });
  const { sessions } = await r.json();
  return sessions.find((s) => s.topic === topic)?.id ?? null;
}, [API, title]);
ok('a teacher can open a group class from the page', Boolean(classId), String(classId));

// Two students book it from their own browsers, and the second one fills it.
const s1 = await open('student1');
await signIn(s1, 'amira@logicclass.plus', 'learn1234');
await s1.goto(`${WEB}/classes`, { waitUntil: 'networkidle' });
await s1.waitForSelector(`[data-book="${classId}"]`, { timeout: 15_000 });
ok('an open class is offered to students', true);
await s1.click(`[data-book="${classId}"]`);
await s1.waitForTimeout(2500);
ok('booking a seat changes the button to Leave',
  (await s1.textContent(`[data-book="${classId}"]`)).includes('Leave'),
  await s1.textContent(`[data-book="${classId}"]`));

const s2 = await open('student2');
await signIn(s2, 'kenji@logicclass.plus', 'learn1234');
await s2.goto(`${WEB}/classes`, { waitUntil: 'networkidle' });
await s2.waitForSelector(`[data-book="${classId}"]`, { timeout: 15_000 });
await s2.click(`[data-book="${classId}"]`);
await s2.waitForTimeout(2500);

// Full, so it drops off the third student's list rather than offering a seat
// that is not there.
const s3 = await open('student3');
await signIn(s3, 'lucia@logicclass.plus', 'learn1234');
await s3.goto(`${WEB}/classes`, { waitUntil: 'networkidle' });
await s3.waitForTimeout(2500);
ok('a full class is not offered to anyone else',
  await s3.locator(`[data-book="${classId}"]`).count() === 0);
const seatRefused = await s3.evaluate(async ([api, id]) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/classes/sessions/${id}/book`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  return { status: r.status, body: await r.json() };
}, [API, classId]);
ok('and the API refuses the seat too', seatRefused.status === 400
  && /full/i.test(seatRefused.body.error?.message ?? ''), JSON.stringify(seatRefused));

// The class belongs to both students' timetables now.
for (const [who, page] of [['amira', s1], ['kenji', s2]]) {
  const mine = await page.evaluate(async ([api, id]) => {
    const token = localStorage.getItem('logicclass.token');
    const r = await fetch(`${api}/api/classes/sessions`, { headers: { authorization: `Bearer ${token}` } });
    const { sessions } = await r.json();
    return sessions.some((s) => s.id === id);
  }, [API, classId]);
  ok(`the class is on ${who}'s timetable`, mine);
}

// Two students and a teacher in one room: each should see the other two.
await Promise.all([
  tutor.goto(`${WEB}/room/${classId}`, { waitUntil: 'networkidle' }),
  s1.goto(`${WEB}/room/${classId}`, { waitUntil: 'networkidle' }),
  s2.goto(`${WEB}/room/${classId}`, { waitUntil: 'networkidle' }),
]);
for (const page of [tutor, s1, s2]) {
  await page.waitForSelector('#hw-join', { timeout: 20_000 }).catch(() => undefined);
}
for (const page of [tutor, s1, s2]) {
  await page.click('#hw-join').catch(() => undefined);
  await page.waitForTimeout(1500);
}
await tutor.waitForTimeout(6000);
const tiles = await Promise.all([tutor, s1, s2].map(async (page) => {
  const el = page.locator('[data-testid=remote-tiles]');
  return (await el.count()) ? Number(await el.getAttribute('data-count')) : 0;
}));
ok('all three see the other two in the room', tiles.every((n) => n === 2), JSON.stringify(tiles));

const connected = await tutor.evaluate(() => {
  const pills = [...document.querySelectorAll('[data-testid=remote-tiles] span')];
  return pills.filter((p) => /connected/i.test(p.textContent ?? '')).length;
});
ok('and the media actually connects between them', connected >= 2, `connected tiles: ${connected}`);

const attended = await tutor.evaluate(async ([api, id]) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/classes/sessions/${id}`, { headers: { authorization: `Bearer ${token}` } });
  const { session } = await r.json();
  return session.attendedIds.length;
}, [API, classId]);
ok('the class records which students turned up', attended === 2, `attended: ${attended}`);

for (const page of [s1, s2]) await page.close();
await s3.close();

// The Owner bills each seat separately, and pressing it twice bills nobody twice.
const owner4 = await open('owner4');
await signIn(owner4, 'owner@logicclass.plus', 'admin1234');
await owner4.goto(`${WEB}/billing`, { waitUntil: 'networkidle' });
await owner4.waitForSelector(`[data-bill="${classId}"]`, { timeout: 15_000 });
await owner4.click(`[data-bill="${classId}"]`);
await owner4.waitForTimeout(3000);
const billed = await owner4.evaluate(async (api) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/billing/invoices`, { headers: { authorization: `Bearer ${token}` } });
  const { invoices } = await r.json();
  return invoices.filter((i) => i.lines.some((l) => l.label.includes('group seat')));
}, API);
const forThis = billed.filter((i) => i.lines.some((l) => l.label.startsWith(title)));
ok('each seat is invoiced to its own student',
  forThis.length === 2 && forThis.every((i) => i.amount === 9)
  && new Set(forThis.map((i) => i.studentId)).size === 2,
  JSON.stringify(forThis.map((i) => [i.studentId.slice(0, 5), i.amount])));

await owner4.click(`[data-bill="${classId}"]`);
await owner4.waitForTimeout(3000);
const billedAgain = await owner4.evaluate(async ([api, t]) => {
  const token = localStorage.getItem('logicclass.token');
  const r = await fetch(`${api}/api/billing/invoices`, { headers: { authorization: `Bearer ${token}` } });
  const { invoices } = await r.json();
  return invoices.filter((i) => i.lines.some((l) => l.label.startsWith(t))).length;
}, [API, title]);
ok('and invoicing the class again does not bill anyone twice',
  billedAgain === 2, `invoices: ${billedAgain}`);
await owner4.close();
await tutor.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log('ERRORS:', errors.length ? JSON.stringify([...new Set(errors)].slice(0, 8), null, 1) : 'none');
await browser.close();
process.exit(fail ? 1 : 0);
