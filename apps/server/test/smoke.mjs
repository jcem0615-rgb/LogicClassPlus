import { io } from 'socket.io-client';

const API = 'http://localhost:4001/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); } };

async function call(path, { method='GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const login = async (email, password) => (await call('/auth/login', { method:'POST', body:{ email, password } })).json;

console.log('\n1. Auth');
const owner = await login('owner@logicclass.plus', 'admin1234');
ok('owner signs in', owner?.token && owner.user.role === 'owner');
const daniel = await login('daniel@logicclass.plus', 'teach1234');
const hana = await login('hana@logicclass.plus', 'teach1234');
const amira = await login('amira@logicclass.plus', 'learn1234');
ok('teacher signs in', daniel?.token && daniel.user.role === 'teacher');
ok('student signs in', amira?.token && amira.user.role === 'student');

const bad = await call('/auth/login', { method:'POST', body:{ email:'owner@logicclass.plus', password:'wrong' } });
ok('wrong password rejected 401', bad.status === 401, JSON.stringify(bad.json));
const pending = await call('/auth/login', { method:'POST', body:{ email:'paolo@logicclass.plus', password:'teach1234' } });
ok('pending account blocked', pending.status === 401 && /approval/i.test(pending.json?.error?.message ?? ''));
ok('no password hash in payload', !JSON.stringify(owner).includes('scrypt$'));

console.log('\n2. Registration is teacher/student only');
const asOwner = await call('/auth/register', { method:'POST', body:{
  name:'Sneaky Admin', email:`sneak${Date.now()}@x.com`, password:'password123', role:'owner' } });
ok('role=owner rejected', asOwner.status === 400, JSON.stringify(asOwner.json));
const email = `newteach${Date.now()}@x.com`;
const reg = await call('/auth/register', { method:'POST', body:{
  name:'New Teacher', email, password:'password123', role:'teacher', subjects:['math'] } });
ok('registration created as pending', reg.status === 201 && reg.json.user.status === 'pending');
const preApproval = await call('/auth/login', { method:'POST', body:{ email, password:'password123' } });
ok('cannot sign in before approval', preApproval.status === 401);
const approve = await call(`/users/${reg.json.user.id}/approve`, { method:'PATCH', token: owner.token });
ok('owner approves', approve.status === 200 && approve.json.user.status === 'active');
const postApproval = await call('/auth/login', { method:'POST', body:{ email, password:'password123' } });
ok('signs in after approval', postApproval.status === 200);
const studentApprove = await call(`/users/${reg.json.user.id}/approve`, { method:'PATCH', token: amira.token });
ok('student cannot approve (403)', studentApprove.status === 403);

console.log('\n3. Library + multi-tenant isolation');
const folders = await call('/library/folders', { token: daniel.token });
ok('teacher lists own folders', folders.json.folders.length === 2, JSON.stringify(folders.json.folders.map(f=>f.name)));
ok('only own folders returned', folders.json.folders.every(f => f.teacherId === daniel.user.id));
const danielFolder = folders.json.folders[0];
const crossRead = await call(`/library/folders/${danielFolder.id}/resources`, { token: hana.token });
ok('other teacher gets 404 on the folder id', crossRead.status === 404, JSON.stringify(crossRead.json));
const newFolder = await call('/library/folders', { method:'POST', token: daniel.token, body:{ name:'Trigonometry', subject:'math' } });
ok('creates folder', newFolder.status === 201);
const studentFolder = await call('/library/folders', { method:'POST', token: amira.token, body:{ name:'Nope', subject:'math' } });
ok('student cannot create folder (403)', studentFolder.status === 403);

console.log('\n4. Upload validation');
const badExt = await call('/library/uploads', { method:'POST', token: daniel.token,
  body:{ folderId: danielFolder.id, filename:'payload.exe', bytes: 1000 } });
ok('.exe rejected', badExt.status === 400, JSON.stringify(badExt.json?.error?.message));
const tooBig = await call('/library/uploads', { method:'POST', token: daniel.token,
  body:{ folderId: danielFolder.id, filename:'huge.pdf', bytes: 21 * 1024 * 1024 } });
ok('over 20MB rejected 413', tooBig.status === 413, JSON.stringify(tooBig.json?.error?.message));
const ticket = await call('/library/uploads', { method:'POST', token: daniel.token,
  body:{ folderId: danielFolder.id, filename:'notes.pdf', bytes: 120000 } });
ok('valid upload issues a ticket', ticket.status === 200 && ticket.json.ticket.storageKey.startsWith(`teachers/${daniel.user.id}/`));
const foreignKey = await call('/library/resources', { method:'POST', token: daniel.token,
  body:{ folderId: danielFolder.id, filename:'notes.pdf', bytes: 120000, storageKey: `teachers/${hana.user.id}/x.pdf` } });
ok('foreign storage key rejected', foreignKey.status === 403);
const commit = await call('/library/resources', { method:'POST', token: daniel.token,
  body:{ folderId: danielFolder.id, filename:'notes.pdf', bytes: 120000, storageKey: ticket.json.ticket.storageKey } });
ok('resource recorded', commit.status === 201 && commit.json.resource.ext === 'pdf');

console.log('\n5. Class request -> accept -> session');
const teachers = (await call('/users', { token: amira.token })).json.users.filter(u => u.role === 'teacher');
ok('student sees active teachers only', teachers.length >= 2 && teachers.every(t => t.status === 'active'));
const req = await call('/classes/requests', { method:'POST', token: amira.token, body:{
  teacherId: daniel.user.id, subject:'math', topic:'Quadratic inequalities revision',
  requestedFor: new Date(Date.now() + 3*3600e3).toISOString(), minutes: 60, note:'Test run' } });
ok('student creates request', req.status === 201 && req.json.request.status === 'pending');
const past = await call('/classes/requests', { method:'POST', token: amira.token, body:{
  teacherId: daniel.user.id, subject:'math', topic:'In the past',
  requestedFor: new Date(Date.now() - 3600e3).toISOString(), minutes: 60 } });
ok('past time rejected', past.status === 400);
const wrongTeacher = await call(`/classes/requests/${req.json.request.id}`, { method:'PATCH', token: hana.token, body:{ decision:'accept' } });
ok('other teacher cannot accept (403)', wrongTeacher.status === 403);
const accept = await call(`/classes/requests/${req.json.request.id}`, { method:'PATCH', token: daniel.token, body:{ decision:'accept' } });
ok('teacher accepts -> session created', accept.status === 200 && accept.json.session?.status === 'scheduled');
const sessionId = accept.json.session.id;
const outsider = await call(`/classes/sessions/${sessionId}`, { method:'GET', token: hana.token });
ok('non-participant cannot open session (403)', outsider.status === 403);
const join = await call(`/classes/sessions/${sessionId}/join`, { method:'POST', token: daniel.token });
ok('teacher joins -> live', join.status === 200 && join.json.session.status === 'live');
const saveDoc = await call(`/classes/sessions/${sessionId}/documents`, { method:'PUT', token: daniel.token,
  body:{ kind:'board', content: JSON.stringify([{ tool:'pen', points:[{x:1,y:2}] }]) } });
ok('whiteboard persists', saveDoc.status === 200);

console.log('\n6. Attendance + payroll');
const clockIn = await call('/attendance/clock-in', { method:'POST', token: daniel.token, body:{ sessionId } });
ok('clock-in records lateness', clockIn.status === 201 && typeof clockIn.json.attendance.minutesLate === 'number');
const twice = await call('/attendance/clock-in', { method:'POST', token: daniel.token, body:{ sessionId } });
ok('double clock-in rejected 409', twice.status === 409);
const clockOut = await call(`/attendance/${clockIn.json.attendance.id}/clock-out`, { method:'POST', token: daniel.token });
ok('clock-out closes the record', clockOut.status === 200 && clockOut.json.attendance.clockOut);
const studentAtt = await call('/attendance', { token: amira.token });
ok('student blocked from attendance (403)', studentAtt.status === 403);

const preview = await call('/payroll/preview', { token: owner.token });
ok('owner payroll preview covers all teachers', preview.json.lines.length >= 2);
const danielLine = preview.json.lines.find(l => l.teacherId === daniel.user.id);
ok('gross is positive', danielLine.gross > 0, JSON.stringify(danielLine));
ok('net = gross - deductions', Math.abs(danielLine.net - (danielLine.gross - danielLine.deductions)) < 0.011, JSON.stringify(danielLine));
const ownPreview = await call('/payroll/preview', { token: daniel.token });
ok('teacher sees only own line', ownPreview.json.lines.length === 1 && ownPreview.json.lines[0].teacherId === daniel.user.id);
const batch = await call('/payroll/batches', { method:'POST', token: owner.token, body:{} });
ok('batch generated', batch.status === 201 && batch.json.batch.lines.length >= 2);
const teacherBatch = await call('/payroll/batches', { method:'POST', token: daniel.token, body:{} });
ok('teacher cannot generate a batch', teacherBatch.status === 403);

console.log('\n7. Billing');
const invoices = await call('/billing/invoices', { token: amira.token });
ok('student sees only own invoices', invoices.json.invoices.every(i => i.studentId === amira.user.id));
const allInvoices = await call('/billing/invoices', { token: owner.token });
ok('owner sees all invoices', allInvoices.json.invoices.length >= 3);
const teacherBilling = await call('/billing/invoices', { token: daniel.token });
ok('teacher has no billing access', teacherBilling.status === 403);
const newInv = await call('/billing/invoices', { method:'POST', token: owner.token, body:{
  studentId: amira.user.id, dueAt: new Date(Date.now() + 7*864e5).toISOString(),
  lines: [{ label:'2 × Math, 60 min', amount: 52 }] } });
ok('invoice raised', newInv.status === 201 && newInv.json.invoice.amount === 52);
const payAttempt = await call(`/billing/invoices/${newInv.json.invoice.id}/pay`, { method:'POST', token: amira.token });
ok('pay says stripe unconfigured, does not fake it', payAttempt.json.mode === 'unconfigured');
const settle = await call(`/billing/invoices/${newInv.json.invoice.id}/settle`, { method:'POST', token: owner.token });
ok('owner can settle manually', settle.json.invoice.status === 'paid');

console.log('\n8. Announcements + notifications');
const post = await call('/announcements', { method:'POST', token: owner.token, body:{
  title:'Smoke test notice', body:'Posted by the end-to-end test.', audience:'teachers', pinned:false } });
ok('owner posts, teachers notified', post.status === 201 && post.json.notified >= 2);
const studentPost = await call('/announcements', { method:'POST', token: amira.token, body:{ title:'Nope', body:'Nope' } });
ok('student cannot post (403)', studentPost.status === 403);
const studentFeed = await call('/announcements', { token: amira.token });
ok('teachers-only notice hidden from student', !studentFeed.json.announcements.some(a => a.title === 'Smoke test notice'));
const teacherFeed = await call('/announcements', { token: daniel.token });
ok('teacher sees it', teacherFeed.json.announcements.some(a => a.title === 'Smoke test notice'));
const notes = await call('/notifications', { token: daniel.token });
ok('notification delivered to the bell', notes.json.unread > 0);
await call('/notifications/read', { method:'POST', token: daniel.token });
const after = await call('/notifications', { token: daniel.token });
ok('mark-all-read clears unread', after.json.unread === 0);

console.log('\n9. Socket.io gateway');
await new Promise((resolve) => {
  const a = io('http://localhost:4001', { auth: { token: daniel.token }, transports: ['websocket'] });
  const b = io('http://localhost:4001', { auth: { token: amira.token }, transports: ['websocket'] });
  const bad = io('http://localhost:4001', { auth: { token: 'garbage' }, transports: ['websocket'] });
  let peerSeen = false, chatSeen = false, strokeSeen = false;

  bad.on('connect_error', (e) => ok('bad token rejected at handshake', e.message === 'unauthorized'));
  a.on('connect', () => a.emit('classroom:join', sessionId, () => {
    b.emit('classroom:join', sessionId, (r) => {
      ok('second peer sees the first in the room', r.peers?.length === 1, JSON.stringify(r));
      b.emit('chat:send', { sessionId, text: 'Hello from the smoke test' });
      b.emit('classroom:board:stroke', { sessionId, stroke: { tool: 'pen' } });
      b.emit('classroom:signal', { sessionId, data: { type: 'offer', sdp: 'v=0' } });
    });
  }));
  a.on('classroom:peer-joined', () => { peerSeen = true; });
  a.on('chat:message', (m) => { chatSeen = m.text === 'Hello from the smoke test'; });
  a.on('classroom:board:stroke', () => { strokeSeen = true; });
  a.on('classroom:signal', (p) => { ok('WebRTC offer relayed to the peer', p.data?.type === 'offer'); });

  setTimeout(() => {
    ok('peer-joined broadcast', peerSeen);
    ok('chat message persisted and broadcast', chatSeen);
    ok('whiteboard stroke relayed', strokeSeen);
    a.close(); b.close(); bad.close();
    resolve();
  }, 2200);
});

const stored = await call(`/classes/sessions/${sessionId}/messages`, { token: daniel.token });
ok('socket chat was written to postgres', stored.json.messages.some(m => m.text === 'Hello from the smoke test'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
