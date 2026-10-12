/**
 * Email delivery, against a stand-in for the provider.
 *
 * No message is sent anywhere real. A tiny HTTP server stands in for
 * Resend's API and records exactly what the server asked it to send, which
 * is the part worth checking: the right person, a link that works, and a
 * subject a human would recognise in a crowded inbox.
 *
 * Start the stand-in, then point the API at it:
 *   EMAIL_PROVIDER=resend RESEND_API_KEY=test-key \
 *   RESEND_BASE_URL=http://127.0.0.1:45099 \
 *   WEB_APP_URL=http://localhost:4000 npm run -w apps/server dev
 *
 * Run:  node apps/server/test/email.mjs
 */
import { createServer } from 'node:http';

const API = 'http://localhost:4001/api';
const MOCK_PORT = Number(process.env.EMAIL_MOCK_PORT || 45099);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

/* ---------------- stand-in provider ---------------- */
const sent = [];
const provider = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    sent.push({ url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `msg_${sent.length}` }));
  });
});
await new Promise((r) => provider.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`stand-in email provider on http://127.0.0.1:${MOCK_PORT}\n`);

const call = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};
const login = async (email, password) =>
  (await call('/auth/login', { method: 'POST', body: { email, password } })).json;

/* The class routes send with `void sendEmail(...)`: a lesson is not held up
   because a mail server is slow, so the response can beat the delivery. */
const waitForMail = async (count, ms = 3000) => {
  const until = Date.now() + ms;
  while (sent.length < count && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return sent.length;
};

const owner = await login('owner@logicclass.plus', 'admin1234');
const health = (await call('/health')).json;

console.log('1. The server knows whether it can send');
/* Email off is the default and a legitimate way to run: it is a skip, not
   a failure, or the standard suite would go red on a correct server. */
if (!health.integrations.email) {
  console.log('  skip  email is off on this server. To exercise delivery, start it with');
  console.log('        EMAIL_PROVIDER=resend RESEND_API_KEY=test-key \\');
  console.log(`        RESEND_BASE_URL=http://127.0.0.1:${MOCK_PORT} WEB_APP_URL=http://localhost:4000`);
  console.log(`\n${pass} passed, ${fail} failed, 1 skipped`);
  provider.close();
  process.exit(fail ? 1 : 0);
}
ok('health reports email as configured', health.integrations.email === true,
  JSON.stringify(health.integrations));

console.log('\n2. An invitation reaches the person invited');
const invitee = `invited-${Date.now()}@example.test`;
const before = sent.length;
const invite = await call('/invitations', { method: 'POST', token: owner.token, body: {
  role: 'teacher', email: invitee, hourlyRate: 27, note: 'Looking forward to having you.' } });
ok('creating one reports that it was emailed', invite.json.emailed === true,
  JSON.stringify({ emailed: invite.json.emailed, reason: invite.json.emailReason }));
ok('exactly one message was sent', sent.length === before + 1, `${sent.length - before}`);

const mail = sent[sent.length - 1];
ok('to the person invited', mail.body.to?.[0] === invitee, JSON.stringify(mail.body.to));
ok('authenticated with the provider key', /^Bearer /.test(mail.auth ?? ''), String(mail.auth));
ok('from the configured sender', typeof mail.body.from === 'string' && mail.body.from.length > 0,
  String(mail.body.from));
ok('with a subject that says what it is', /invited/i.test(mail.body.subject ?? ''),
  String(mail.body.subject));
ok('the note the owner wrote is in it', /Looking forward/.test(mail.body.text ?? ''));
ok('and a plain-text part, not only HTML', typeof mail.body.text === 'string' && mail.body.text.length > 40);

const link = (mail.body.text.match(/https?:\/\/\S+\/join\/\S+/) ?? [])[0];
ok('containing a join link', Boolean(link), mail.body.text.slice(0, 160));
ok('pointing at the web app, not the API',
  Boolean(link && !link.includes(':4001')), String(link));

// The link in the email has to be the one that works.
const token = link.split('/join/')[1];
const lookup = await call(`/invitations/${token}`);
ok('and the link in the email is the one that works',
  lookup.status === 200 && lookup.json.state === 'open', JSON.stringify(lookup.json).slice(0, 120));

const accepted = await call('/auth/register', { method: 'POST', body: {
  token, name: 'Invited Teacher', email: invitee, password: 'invited1234' } });
ok('following it creates the account', accepted.status === 201 && accepted.json.user.role === 'teacher',
  String(accepted.status));

console.log('\n3. An invitation with no address has nobody to go to');
const anon = await call('/invitations', { method: 'POST', token: owner.token, body: { role: 'student' } });
ok('nothing is sent', anon.json.emailed === false, JSON.stringify(anon.json.emailReason));
ok('and the owner is told why', typeof anon.json.emailReason === 'string');

console.log('\n4. A password reset link is delivered, not read out');
const student = await login('amira@logicclass.plus', 'learn1234');
await call('/auth/password-reset', { method: 'POST', body: { email: 'amira@logicclass.plus' } });
const queue = (await call('/users/reset-requests', { token: owner.token })).json.resets;
const pending = queue.find((r) => r.status === 'pending');
ok('the request reached the queue', Boolean(pending), JSON.stringify(queue.slice(0, 2)));

const sentBefore = sent.length;
const approved = await call(`/users/reset-requests/${pending.id}`, {
  method: 'PATCH', token: owner.token, body: { decision: 'approve' } });
ok('approving it sends the email', approved.json.emailed === true,
  JSON.stringify({ emailed: approved.json.emailed, reason: approved.json.emailReason }));
ok('one message, to the person who asked', sent.length === sentBefore + 1
  && sent[sent.length - 1].body.to?.[0] === 'amira@logicclass.plus',
  JSON.stringify(sent[sent.length - 1]?.body?.to));
ok('with a reset link in it', /\/#\/reset\?token=/.test(sent[sent.length - 1].body.text ?? ''),
  sent[sent.length - 1].body.text?.slice(0, 120));
void student;

console.log('\n5. An invoice reminder goes to the inbox');
const invoices = (await call('/billing/invoices', { token: owner.token })).json.invoices;
const open = invoices.find((i) => i.status === 'open');
if (open) {
  const n = sent.length;
  const reminded = await call(`/billing/invoices/${open.id}/remind`, { method: 'POST', token: owner.token });
  ok('the reminder is emailed as well as shown in the app',
    reminded.json.emailed === true && sent.length === n + 1,
    JSON.stringify({ emailed: reminded.json?.emailed, delta: sent.length - n }));
  ok('and names the invoice', sent[sent.length - 1].body.subject?.includes(open.number),
    String(sent[sent.length - 1].body.subject));
} else {
  console.log('  (no open invoice to remind about — skipped)');
}

console.log('\n6. A cancelled class reaches the inbox, not just the bell');
const teacher = await login('daniel@logicclass.plus', 'teach1234');
const learner = await login('amira@logicclass.plus', 'learn1234');
const hours = (n) => new Date(Date.now() + n * 3600e3).toISOString();

/* A booked hour now blocks the next booking, so a fixed offset is only free
   the first time anybody asks for it. The slot is chosen against the real
   timetable; the search steps forward from the offset, so "+3h" stays inside
   the short-notice window and "+72h" stays outside it. */
const teacherForLessons = await login('daniel@logicclass.plus', 'teach1234');
const learnerForLessons = await login('amira@logicclass.plus', 'learn1234');
/* Only the two people these lessons involve. A clash is per-person, so
   treating every teacher's hour as busy would call the whole calendar full —
   which is exactly what happened, and left no gap inside the notice window. */
const busySlots = (await call('/classes/sessions', { token: owner.token })).json.sessions
  .filter((row) => row.status !== 'cancelled')
  .filter((row) => row.teacherId === teacherForLessons.user.id
    || row.studentIds.includes(learnerForLessons.user.id))
  .map((row) => ({ from: Date.parse(row.startsAt), to: Date.parse(row.startsAt) + row.minutes * 60_000 }));
function freeAt(aboutHours, { minutes = 60, stepMinutes = 15, withinHours = Infinity } = {}) {
  const limit = Date.now() + withinHours * 3600e3;
  for (let step = 0; step < 24 * 60; step += 1) {
    const from = Date.now() + aboutHours * 3600e3 + step * stepMinutes * 60_000;
    const to = from + minutes * 60_000;
    /* `withinHours` matters for the short-notice test: a slot found by
       stepping forward past the notice window is a perfectly good slot and
       the wrong one to test short notice with. */
    if (to > limit) break;
    if (!busySlots.some((b) => from < b.to && b.from < to)) {
      busySlots.push({ from, to });
      return new Date(from).toISOString();
    }
  }
  throw new Error(`no free ${minutes}-minute slot near +${aboutHours}h`
    + (withinHours === Infinity ? '' : ` inside +${withinHours}h`));
}

/** Request, accept — the accept itself sends the booking confirmation. */
const makeLesson = async (topic, inHours, slotOptions = {}) => {
  const minutes = slotOptions.minutes ?? 60;
  const req = await call('/classes/requests', { method: 'POST', token: learner.token, body: {
    teacherId: teacher.user.id, subject: 'math', topic,
    requestedFor: freeAt(inHours, slotOptions), minutes } });
  const acc = await call(`/classes/requests/${req.json.request.id}`, {
    method: 'PATCH', token: teacher.token, body: { decision: 'accept' } });
  return acc.json.session;
};

{
  const lesson = await makeLesson('Email me when cancelled', 2,
    { minutes: 30, stepMinutes: 5, withinHours: 10 });
  await waitForMail(sent.length + 1);           // the booking confirmation
  const before = sent.length;

  const done = await call(`/classes/sessions/${lesson.id}/cancel`, {
    method: 'POST', token: teacher.token, body: { reason: 'I have lost my voice.' } });
  ok('the class is cancelled', done.status === 200, JSON.stringify(done.json).slice(0, 120));
  await waitForMail(before + 1);
  ok('one message goes out', sent.length === before + 1, `${sent.length - before}`);

  const mail = sent[sent.length - 1];
  ok('to the student, not to whoever cancelled it',
    mail.body.to?.[0] === 'amira@logicclass.plus', JSON.stringify(mail.body.to));
  ok('the subject says it is off', /^Cancelled:/.test(mail.body.subject ?? ''),
    String(mail.body.subject));
  ok('and names the class', /Email me when cancelled/.test(mail.body.subject ?? ''));
  ok('the reason the teacher typed is in it', /lost my voice/.test(mail.body.text ?? ''),
    String(mail.body.text).slice(0, 160));
  ok('three hours notice is called short notice in the message',
    /short notice/i.test(mail.body.text ?? ''), String(mail.body.text).slice(0, 300));
  ok('and it tells them nothing is expected of them',
    /nothing is expected of you/i.test(mail.body.text ?? ''));
}

console.log('\n7. A class with plenty of notice does not cry short notice');
{
  const lesson = await makeLesson('Cancelled well ahead', 72);
  await waitForMail(sent.length + 1);
  const before = sent.length;
  await call(`/classes/sessions/${lesson.id}/cancel`, {
    method: 'POST', token: teacher.token, body: {} });
  await waitForMail(before + 1);
  const mail = sent[sent.length - 1];
  ok('the message goes out', sent.length === before + 1);
  ok('with no short-notice line', !/short notice/i.test(mail.body.text ?? ''),
    String(mail.body.text).slice(0, 200));
  ok('and no empty quotation marks where a reason would be',
    !/Reason given/.test(mail.body.text ?? ''));
}

console.log('\n8. A moved class says the new time in the subject');
{
  const lesson = await makeLesson('Email me when moved', 48);
  await waitForMail(sent.length + 1);
  const before = sent.length;

  const moved = await call(`/classes/sessions/${lesson.id}/schedule`, {
    method: 'PATCH', token: teacher.token,
    body: { startsAt: freeAt(96, { minutes: 90 }), minutes: 90 } });
  ok('the class is moved', moved.status === 200, JSON.stringify(moved.json).slice(0, 120));
  await waitForMail(before + 1);
  ok('one message goes out', sent.length === before + 1, `${sent.length - before}`);

  const mail = sent[sent.length - 1];
  ok('to the student', mail.body.to?.[0] === 'amira@logicclass.plus');
  /* The new time in the subject: somebody scanning an inbox should not have
     to open the message to learn the one thing that changed. */
  ok('the subject leads with the new time', /^Moved to /.test(mail.body.subject ?? ''),
    String(mail.body.subject));
  ok('the body gives both times', /was booked for/i.test(mail.body.text ?? ''),
    String(mail.body.text).slice(0, 300));
  ok('and the new length', /90 minutes/.test(mail.body.text ?? ''),
    String(mail.body.text).slice(0, 300));
}

console.log('\n9. A provider that fails does not take the request down');
provider.close();
await new Promise((r) => setTimeout(r, 200));
const whenDown = await call('/invitations', { method: 'POST', token: owner.token, body: {
  role: 'student', email: `down-${Date.now()}@example.test` } });
ok('the invitation is still created', whenDown.status === 201, String(whenDown.status));
ok('it reports that the email did not go out', whenDown.json.emailed === false,
  JSON.stringify(whenDown.json.emailReason));
ok('and the link is still returned so it can be sent by hand',
  typeof whenDown.json.token === 'string' && whenDown.json.token.length > 20);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
