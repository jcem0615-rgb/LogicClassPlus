/**
 * Cancelling a class, and moving one.
 *
 * `SessionStatus.CANCELLED` existed from the first migration and nothing in
 * the product could set it, so the tests below are mostly about the things
 * that must stop being true once a class is called off: it cannot be joined,
 * clocked into, billed, marked as a no-show, or completed. The payroll and
 * billing ones are the point — a cancelled class that can still be clocked
 * into pays a teacher for an hour nobody taught.
 *
 * Needs a server on 4001 against a seeded database:
 *   npm run -w apps/server dev
 *   node apps/server/test/scheduling.mjs
 */
const API = (process.env.API_URL || 'http://localhost:4001') + '/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
const login = async (email, password) =>
  (await call('/auth/login', { method: 'POST', body: { email, password } })).json;
const msg = (r) => r.json?.error?.message ?? JSON.stringify(r.json);
/* Only the error text. `msg` falls back to the whole body, which means a
   "why was it refused" assertion could match the topic of a class that was
   not refused at all — which is how one of these passed while the guard it
   was testing was switched off. */
const why = (r) => r.json?.error?.message ?? '';
const hours = (n) => new Date(Date.now() + n * 3600e3).toISOString();

const owner = await login('owner@logicclass.plus', 'admin1234');
const daniel = await login('daniel@logicclass.plus', 'teach1234');
const hana = await login('hana@logicclass.plus', 'teach1234');
const amira = await login('amira@logicclass.plus', 'learn1234');
const kenji = await login('kenji@logicclass.plus', 'learn1234');
const nadia = await login('nadia@logicclass.plus', 'parent1234');

/** A private lesson, the long way round: request then accept. */
async function privateLesson(topic, inHours = 48, student = amira) {
  const req = await call('/classes/requests', {
    method: 'POST', token: student.token,
    body: {
      teacherId: daniel.user.id, subject: 'math', topic,
      requestedFor: hours(inHours), minutes: 60,
    },
  });
  const accepted = await call(`/classes/requests/${req.json.request.id}`, {
    method: 'PATCH', token: daniel.token, body: { decision: 'accept' },
  });
  return { requestId: req.json.request.id, session: accepted.json.session };
}

async function groupClass(topic, inHours = 48, seats = 4) {
  const made = await call('/classes/group', {
    method: 'POST', token: daniel.token,
    body: {
      subject: 'math', topic, startsAt: hours(inHours),
      minutes: 60, capacity: seats, seatPrice: 9,
    },
  });
  return made.json.session;
}

console.log('\n1. A student calls off their own private lesson');
{
  const { requestId, session } = await privateLesson('Cancel me — private', 48);
  const other = await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: kenji.token, body: {},
  });
  ok('a student with no seat in it cannot (403/404)', other.status === 403 || other.status === 404,
    String(other.status));

  const parent = await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: nadia.token, body: {},
  });
  ok('the parent who may read it still cannot cancel it', parent.status === 403, msg(parent));

  const done = await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: amira.token, body: { reason: 'Away that week.' },
  });
  ok('the student whose lesson it is can', done.status === 200, msg(done));
  ok('it comes back cancelled, with the reason kept',
    done.json.session.status === 'cancelled' && done.json.session.cancelReason === 'Away that week.',
    JSON.stringify(done.json.session?.status));
  ok('and who cancelled it', done.json.session.cancelledById === amira.user.id);
  ok('two days ahead is not short notice', done.json.shortNotice === false,
    String(done.json.shortNotice));

  // The seats stay: a cancelled class still has to say who was in it.
  ok('the roster survives the cancellation',
    done.json.session.studentIds.includes(amira.user.id),
    JSON.stringify(done.json.session.studentIds));

  const req = (await call('/classes/requests', { token: amira.token })).json.requests
    .find((r) => r.id === requestId);
  ok('the request it grew from is closed too, not left reading "accepted"',
    req?.status === 'cancelled', JSON.stringify(req?.status));

  const again = await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: amira.token, body: {},
  });
  ok('cancelling it twice is refused', again.status === 400, msg(again));

  // The record is still readable — that is the whole reason it is a status
  // and not a delete.
  const read = await call(`/classes/sessions/${session.id}`, { token: amira.token });
  ok('the class is still there to read afterwards',
    read.status === 200 && read.json.session.status === 'cancelled', String(read.status));
}

console.log('\n2. Short notice is noticed');
{
  const { session } = await privateLesson('Cancel me — soon', 3);
  const done = await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: daniel.token, body: { reason: 'Unwell.' },
  });
  ok('three hours beforehand is short notice', done.json.shortNotice === true,
    JSON.stringify(done.json));
  ok('and the class says so on its own record', done.json.session.shortNotice === true);
}

console.log('\n3. A group class is the teacher\'s to call off, not one student\'s');
{
  const group = await groupClass('Cancel me — group', 48);
  const booked = await call(`/classes/sessions/${group.id}/book`, { method: 'POST', token: amira.token });
  ok('a student takes a seat', booked.status === 201, msg(booked));
  await call(`/classes/sessions/${group.id}/book`, { method: 'POST', token: kenji.token });

  const byStudent = await call(`/classes/sessions/${group.id}/cancel`, {
    method: 'POST', token: amira.token, body: {},
  });
  ok('one of the students cannot cancel it for everyone', byStudent.status === 403, msg(byStudent));
  ok('and is told to release their seat instead', /release your seat/i.test(why(byStudent)), msg(byStudent));

  const byOtherTeacher = await call(`/classes/sessions/${group.id}/cancel`, {
    method: 'POST', token: hana.token, body: {},
  });
  ok('nor can a teacher who is not giving it', byOtherTeacher.status === 403 || byOtherTeacher.status === 404,
    String(byOtherTeacher.status));

  const done = await call(`/classes/sessions/${group.id}/cancel`, {
    method: 'POST', token: daniel.token, body: { reason: 'Not enough interest.' },
  });
  ok('the teacher giving it can', done.status === 200 && done.json.session.status === 'cancelled',
    msg(done));

  const open = await call('/classes/group/open', { token: kenji.token });
  ok('it stops being an open class students can find',
    !open.json.sessions.some((s) => s.id === group.id));

  const late = await call(`/classes/sessions/${group.id}/book`, { method: 'POST', token: kenji.token });
  ok('and nobody can book a seat in it', late.status === 400, msg(late));
}

console.log('\n4. The things that must stop being possible');
{
  const { session } = await privateLesson('Cancelled, then poked', 48);
  await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: daniel.token, body: {},
  });

  const join = await call(`/classes/sessions/${session.id}/join`, { method: 'POST', token: daniel.token });
  ok('nobody can enter the room', join.status === 400, msg(join));
  ok('and is told it was cancelled, not that it "finished"',
    /cancelled/i.test(why(join)), msg(join));

  /* The one that costs money: payroll is built from attendance rows, and an
     attendance row cannot see that the class behind it was called off. */
  const clock = await call('/attendance/clock-in', {
    method: 'POST', token: daniel.token, body: { sessionId: session.id },
  });
  ok('the teacher cannot clock in and be paid for it', clock.status === 400, msg(clock));

  const noShow = await call('/attendance/no-show', {
    method: 'POST', token: daniel.token, body: { sessionId: session.id },
  });
  ok('it cannot be recorded as a no-show against anyone', noShow.status === 400, msg(noShow));

  const complete = await call(`/classes/sessions/${session.id}/complete`, {
    method: 'POST', token: daniel.token, body: { outcome: 'completed' },
  });
  ok('and it cannot be marked as taught', complete.status === 400, msg(complete));
}

console.log('\n5. A cancelled class cannot be billed');
{
  const group = await groupClass('Cancelled before billing', 48);
  await call(`/classes/sessions/${group.id}/book`, { method: 'POST', token: amira.token });
  await call(`/classes/sessions/${group.id}/cancel`, {
    method: 'POST', token: daniel.token, body: {},
  });
  const bill = await call(`/billing/invoices/for-class/${group.id}`, {
    method: 'POST', token: owner.token, body: {},
  });
  ok('invoicing its seats is refused', bill.status === 400, msg(bill));
  ok('for the right reason', bill.status === 400 && /cancelled/i.test(why(bill)), msg(bill));
}

console.log('\n6. Cancelling a class that was already invoiced says so');
{
  const group = await groupClass('Invoiced, then cancelled', 48);
  await call(`/classes/sessions/${group.id}/book`, { method: 'POST', token: amira.token });
  const bill = await call(`/billing/invoices/for-class/${group.id}`, {
    method: 'POST', token: owner.token, body: {},
  });
  ok('the seat is invoiced first', bill.status === 201, msg(bill));

  const done = await call(`/classes/sessions/${group.id}/cancel`, {
    method: 'POST', token: owner.token, body: { reason: 'Double-booked the room.' },
  });
  ok('the owner can cancel any class', done.status === 200, msg(done));
  /* Reported rather than voided: cancelling a class must not quietly cancel
     money owed, and leaving the Owner to find it at month end is worse. */
  ok('and is told money has already been raised against it',
    done.json.invoicedLines >= 1, JSON.stringify(done.json.invoicedLines));
}

console.log('\n7. A class in progress is ended, not cancelled');
{
  const { session } = await privateLesson('Live, then cancelled', 1);
  const joined = await call(`/classes/sessions/${session.id}/join`, {
    method: 'POST', token: daniel.token,
  });
  ok('the teacher is in the room', joined.json.session.status === 'live', msg(joined));
  const cancel = await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: daniel.token, body: {},
  });
  ok('cancelling it is refused while it is running', cancel.status === 400, msg(cancel));
  ok('and points at the classroom instead', /in progress/i.test(why(cancel)), msg(cancel));

  await call(`/classes/sessions/${session.id}/complete`, {
    method: 'POST', token: daniel.token, body: { outcome: 'completed' },
  });
  const after = await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: daniel.token, body: {},
  });
  ok('a class that already happened cannot be cancelled', after.status === 400, msg(after));
}

console.log('\n8. Moving a class');
{
  const { session } = await privateLesson('Move me', 48);
  const was = session.startsAt;

  const byStudent = await call(`/classes/sessions/${session.id}/schedule`, {
    method: 'PATCH', token: amira.token, body: { startsAt: hours(72) },
  });
  ok('a student cannot move it', byStudent.status === 403, msg(byStudent));
  ok('and is pointed at cancelling and asking again', /cancel it/i.test(why(byStudent)), msg(byStudent));

  const byOther = await call(`/classes/sessions/${session.id}/schedule`, {
    method: 'PATCH', token: hana.token, body: { startsAt: hours(72) },
  });
  ok('nor can another teacher', byOther.status === 403 || byOther.status === 404, String(byOther.status));

  const backwards = await call(`/classes/sessions/${session.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: hours(-2) },
  });
  ok('it cannot be moved into the past', backwards.status === 400, msg(backwards));

  const nowhere = await call(`/classes/sessions/${session.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: was, minutes: 60 },
  });
  ok('moving it to the time it is already at is refused', nowhere.status === 400, msg(nowhere));

  const odd = await call(`/classes/sessions/${session.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: hours(72), minutes: 37 },
  });
  ok('an off-the-quarter-hour length is refused', odd.status === 400, msg(odd));

  const moved = await call(`/classes/sessions/${session.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: hours(72), minutes: 90 },
  });
  ok('the teacher giving it can move it', moved.status === 200, msg(moved));
  ok('the new time and length are what was asked for',
    moved.json.session.minutes === 90
    && Math.abs(Date.parse(moved.json.session.startsAt) - Date.parse(hours(72))) < 5000,
    JSON.stringify({ at: moved.json.session.startsAt, min: moved.json.session.minutes }));
  ok('and it remembers where it came from',
    moved.json.session.rescheduledFrom === was,
    JSON.stringify({ from: moved.json.session.rescheduledFrom, was }));
  ok('it is still a scheduled class, not a new one',
    moved.json.session.status === 'scheduled' && moved.json.session.id === session.id);
  ok('the student still has their seat',
    moved.json.session.studentIds.includes(amira.user.id));
}

console.log('\n9. A class is not moved out from under a timesheet');
{
  const { session } = await privateLesson('Clocked in, then moved', 1);
  const clock = await call('/attendance/clock-in', {
    method: 'POST', token: daniel.token, body: { sessionId: session.id },
  });
  ok('the teacher clocks in', clock.status === 201, msg(clock));
  /* Lateness was measured against the old start time. Moving the class would
     either orphan that measurement or recompute the deduction away. */
  const moved = await call(`/classes/sessions/${session.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: hours(72) },
  });
  ok('moving it afterwards is refused', moved.status === 400, msg(moved));
  ok('and says why', /timesheet/i.test(why(moved)), msg(moved));
}

console.log('\n10. A cancelled class is not moved either');
{
  const { session } = await privateLesson('Cancelled, then moved', 48);
  await call(`/classes/sessions/${session.id}/cancel`, { method: 'POST', token: daniel.token, body: {} });
  const moved = await call(`/classes/sessions/${session.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: hours(72) },
  });
  ok('moving a cancelled class is refused', moved.status === 400, msg(moved));
  ok('and suggests opening a new one', /open a new one/i.test(why(moved)), msg(moved));
}

console.log('\n11. A teacher with a long history still sees what is next');
{
  /* The session list is a 200-row window. Ordered oldest-first it filled with
     the oldest classes on the books, so a teacher with 200 lessons behind
     them was sent none of their upcoming ones and their dashboard said
     "nothing scheduled". Daniel has hundreds of classes in a seeded-and-
     tested database, which is what made this visible. */
  const far = await groupClass('Furthest in the future', 500);
  const mine = (await call('/classes/sessions', { token: daniel.token })).json.sessions;
  ok('the newest class is in the list the client is given',
    mine.some((s) => s.id === far.id), `${mine.length} sessions returned`);
  ok('and the list is capped rather than unbounded', mine.length <= 200, String(mine.length));

  const moved = await call(`/classes/sessions/${far.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: hours(520) },
  });
  const after = (await call('/classes/sessions', { token: daniel.token })).json.sessions
    .find((s) => s.id === far.id);
  ok('a class moved further out is still returned', Boolean(after), msg(moved));
  ok('with the move recorded on it', Boolean(after?.rescheduledFrom),
    JSON.stringify(after?.rescheduledFrom));
}

console.log('\n12. Withdrawing a request nobody has answered yet');
{
  const req = await call('/classes/requests', {
    method: 'POST', token: amira.token,
    body: {
      teacherId: daniel.user.id, subject: 'english', topic: 'Withdraw me',
      requestedFor: hours(50), minutes: 60,
    },
  });
  const id = req.json.request.id;

  const byOther = await call(`/classes/requests/${id}`, { method: 'DELETE', token: kenji.token });
  ok('another student cannot withdraw it', byOther.status === 403, msg(byOther));
  const byTeacher = await call(`/classes/requests/${id}`, { method: 'DELETE', token: daniel.token });
  ok('the teacher uses decline, not this', byTeacher.status === 403, String(byTeacher.status));

  const done = await call(`/classes/requests/${id}`, { method: 'DELETE', token: amira.token });
  ok('the student who asked can withdraw it',
    done.status === 200 && done.json.request.status === 'cancelled', msg(done));

  const accept = await call(`/classes/requests/${id}`, {
    method: 'PATCH', token: daniel.token, body: { decision: 'accept' },
  });
  ok('and it can no longer be accepted', accept.status === 400, msg(accept));

  // An accepted request is the class's business now.
  const { requestId } = await privateLesson('Already accepted', 50);
  const tooLate = await call(`/classes/requests/${requestId}`, { method: 'DELETE', token: amira.token });
  ok('withdrawing an accepted request is refused', tooLate.status === 400, msg(tooLate));
  ok('and points at cancelling the class', /cancel the class/i.test(why(tooLate)), msg(tooLate));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
