/**
 * Teaching hours, and not being in two places at once.
 *
 * Four routes gave a class a time and none of them asked whether the people
 * involved were free: a teacher could be in two classrooms at the same
 * moment, a student could take a group seat clashing with the private lesson
 * they had already booked, and anyone could ask for 3am.
 *
 * Slots here are far in the future and placed mid-morning in the *teacher's*
 * own timezone, computed the same way the server does. A fixed UTC hour would
 * test something different depending on where the seeded teacher lives, and
 * the dev database already holds hundreds of classes in the near future.
 *
 * Needs a server on 4001 against a seeded database.
 * Run:  node apps/server/test/availability.mjs
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
const why = (r) => r.json?.error?.message ?? '';
const msg = (r) => why(r) || JSON.stringify(r.json);

const owner = await login('owner@logicclass.plus', 'admin1234');
const daniel = await login('daniel@logicclass.plus', 'teach1234');
const hana = await login('hana@logicclass.plus', 'teach1234');
const amira = await login('amira@logicclass.plus', 'learn1234');
const kenji = await login('kenji@logicclass.plus', 'learn1234');

const TZ = daniel.user.tz;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The same reading of a clock the server does, so the test and the rule agree. */
const localOf = (at, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const read = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    weekday: WEEKDAYS.indexOf(read('weekday')),
    minute: Number(read('hour')) * 60 + Number(read('minute')),
  };
};
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/* Far enough out that nothing seeded or left by another suite is there, one
   clear day per slot, and landed on 10:00 in the teacher's own morning. */
/* A fixed stretch of calendar, reused every run.
   The suite books real classes and cancels them at the end, and a cancelled
   class holds no slot, so the same days are free again next time. A random
   window per run would also work, but each run would leave its own handful of
   cancelled classes somewhere new and the database would fill up with them.

   Days already holding a class are skipped, so a run that crashed before its
   cleanup does not block the next one. */
const BASE = Math.floor((Date.now() + 2000 * 3600e3) / 3600e3) * 3600e3;
const takenAlready = (await call('/classes/sessions', { token: owner.token })).json.sessions
  .filter((row) => row.status !== 'cancelled')
  .map((row) => ({
    from: Date.parse(row.startsAt),
    to: Date.parse(row.startsAt) + row.minutes * 60_000,
  }));

/** 10:00 in the teacher's own morning, on the nth free day from the base. */
function slot(n) {
  let found = 0;
  for (let day = 0; day < 400; day += 1) {
    const midnight = BASE + day * 86_400_000;
    /* Quarter-hour steps rather than whole hours: not every timezone is a
       whole number of hours from UTC, and a slot landing at 10:07 would run
       past an 11:00 window and fail a test about something else entirely. */
    for (let step = 0; step < 24 * 4; step += 1) {
      const at = new Date(midnight + step * 15 * 60_000);
      if (localOf(at, TZ).minute !== 600) continue;
      const busy = takenAlready.some((b) =>
        at.getTime() < b.to && b.from < at.getTime() + 8 * 3600e3);
      if (!busy) {
        if (found === n) return at;
        found += 1;
      }
      break;                                   // one 10:00 per day
    }
  }
  throw new Error(`no free 10:00 slot found for ${TZ}`);
}
const iso = (d) => d.toISOString();
const plus = (d, minutes) => new Date(d.getTime() + minutes * 60_000);

const request = (student, startsAt, minutes = 60, topic = 'Availability probe') =>
  call('/classes/requests', { method: 'POST', token: student.token, body: {
    teacherId: daniel.user.id, subject: 'math', topic,
    requestedFor: iso(startsAt), minutes } });
const accept = (id) => call(`/classes/requests/${id}`, {
  method: 'PATCH', token: daniel.token, body: { decision: 'accept' } });
/** A booked private lesson at this instant. */
async function lessonAt(startsAt, minutes = 60, student = amira) {
  const r = await request(student, startsAt, minutes);
  if (r.status !== 201) throw new Error(`could not request: ${msg(r)}`);
  const a = await accept(r.json.request.id);
  if (a.status !== 200) throw new Error(`could not accept: ${msg(a)}`);
  return a.json.session;
}
const setHours = (token, teacherId, windows) =>
  call(`/availability/${teacherId}`, { method: 'PUT', token, body: { windows } });

// Start from a clean slate, so a previous run cannot decide this one.
await setHours(owner.token, daniel.user.id, []);
await setHours(owner.token, hana.user.id, []);

console.log('\n1. A teacher who has set no hours works exactly as before');
{
  const read = await call(`/availability/${daniel.user.id}`, { token: amira.token });
  ok('their hours read as open', read.status === 200 && read.json.open === true,
    JSON.stringify(read.json));
  ok('and the timezone they are read in is theirs', read.json.timezone === TZ, read.json.timezone);

  const any = await request(amira, slot(1));
  ok('a slot at any hour is accepted', any.status === 201, msg(any));
  await call(`/classes/requests/${any.json.request.id}`, { method: 'DELETE', token: amira.token });
}

console.log('\n2. Setting the hours');
{
  const byStudent = await setHours(amira.token, daniel.user.id, []);
  ok('a student cannot set a teacher’s hours', byStudent.status === 403, msg(byStudent));
  const byOtherTeacher = await setHours(hana.token, daniel.user.id, []);
  ok('nor can another teacher', byOtherTeacher.status === 403, msg(byOtherTeacher));

  const backwards = await setHours(daniel.token, daniel.user.id,
    [{ weekday: 1, start: '17:00', end: '09:00' }]);
  ok('a span that ends before it starts is refused', backwards.status === 400, msg(backwards));

  const overlapping = await setHours(daniel.token, daniel.user.id, [
    { weekday: 1, start: '09:00', end: '13:00' },
    { weekday: 1, start: '12:00', end: '17:00' },
  ]);
  ok('two spans on one day that overlap are refused', overlapping.status === 400, msg(overlapping));

  const nonsense = await setHours(daniel.token, daniel.user.id,
    [{ weekday: 1, start: '9am', end: '17:00' }]);
  ok('a time that is not HH:MM is refused', nonsense.status === 400, msg(nonsense));

  const split = await setHours(daniel.token, daniel.user.id, [
    { weekday: 1, start: '09:00', end: '12:00' },
    { weekday: 1, start: '13:00', end: '17:00' },
  ]);
  ok('a morning and an afternoon with a lunch break is fine', split.status === 200, msg(split));
  ok('and reads back as two spans on one day',
    split.json.summary === 'Monday 09:00–12:00, 13:00–17:00', split.json.summary);
  ok('no longer open', split.json.open === false);
}

console.log('\n3. A slot outside the hours is refused, and says what they are');
{
  // Every day 09:00–11:00 in the teacher's own timezone: 10:00 is inside it.
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
    ({ weekday, start: '09:00', end: '11:00' }));
  await setHours(daniel.token, daniel.user.id, everyDay);

  const inside = await request(amira, slot(2));
  ok('10:00 their time, inside the window, is accepted', inside.status === 201, msg(inside));
  await call(`/classes/requests/${inside.json.request.id}`, { method: 'DELETE', token: amira.token });

  // 10:00 + a two-hour class runs to 12:00, past the window.
  const spills = await request(amira, slot(3), 120);
  ok('a class that starts inside but ends after they finish is refused',
    spills.status === 400, msg(spills));
  ok('and the message gives their hours and their timezone',
    /09:00–11:00/.test(why(spills)) && why(spills).includes(TZ), why(spills));
  ok('and says what the slot was in their local time',
    /10:00–12:00/.test(why(spills)), why(spills));

  // Four hours earlier is 06:00 their time.
  const early = await request(amira, plus(slot(4), -240));
  ok('a slot before they open is refused', early.status === 400, msg(early));

  const byOwner = await setHours(owner.token, daniel.user.id, everyDay);
  ok('the owner can set a teacher’s hours for them', byOwner.status === 200, msg(byOwner));
}

console.log('\n4. A teacher is not booked into two classes at once');
{
  /* A full working day from here on. The narrow two-hour window above was for
     testing the edges of a window; everything below is about clashes, and a
     back-to-back pair needs room to be back-to-back in. */
  await setHours(daniel.token, daniel.user.id,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })));

  const at = slot(5);
  const first = await lessonAt(at);
  ok('the first lesson is booked', Boolean(first?.id), JSON.stringify(first?.id));

  const same = await request(kenji, at);
  ok('another student cannot have the same slot', same.status === 400, msg(same));
  ok('and is told the teacher is busy without being shown their timetable',
    /already has a class/i.test(why(same)) && !/Amira/.test(why(same)), why(same));

  const halfway = await request(kenji, plus(at, 30));
  ok('a slot overlapping it by half an hour is refused', halfway.status === 400, msg(halfway));

  const justBefore = await request(kenji, plus(at, -30));
  ok('and one that runs into its start is refused too', justBefore.status === 400, msg(justBefore));

  /* Touching at the edges is a normal afternoon, not a double booking. */
  const after = await request(kenji, plus(at, 60));
  ok('a class starting exactly as that one ends is allowed', after.status === 201, msg(after));
  const accepted = await accept(after.json.request.id);
  ok('and can be accepted', accepted.status === 200, msg(accepted));
}

console.log('\n5. A student is not booked into two classes at once');
{
  const at = slot(7);
  await lessonAt(at, 60, amira);

  // Same student, different teacher, same hour.
  const clash = await call('/classes/requests', { method: 'POST', token: amira.token, body: {
    teacherId: hana.user.id, subject: 'english', topic: 'Clashes with my own class',
    requestedFor: iso(plus(at, 15)), minutes: 60 } });
  ok('a student cannot book over their own class, even with another teacher',
    clash.status === 400, msg(clash));
  ok('and is told when their own clash is, since it is their own diary',
    /already have a class/i.test(why(clash)) && /\d{2}:\d{2}/.test(why(clash)), why(clash));

  // A group class in the same hour, opened by the other teacher.
  const group = await call('/classes/group', { method: 'POST', token: hana.token, body: {
    subject: 'english', topic: 'Group over a private lesson', startsAt: iso(plus(at, 15)),
    minutes: 60, capacity: 4, seatPrice: 9 } });
  ok('the other teacher can open a group class then — it is not their clash',
    group.status === 201, msg(group));

  const seat = await call(`/classes/sessions/${group.json.session.id}/book`, {
    method: 'POST', token: amira.token });
  ok('but the student with a class then cannot take a seat in it',
    seat.status === 400, msg(seat));
  const free = await call(`/classes/sessions/${group.json.session.id}/book`, {
    method: 'POST', token: kenji.token });
  ok('while a student who is free can', free.status === 201, msg(free));
}

console.log('\n6. Opening a group class obeys the same rules');
{
  const at = slot(9);
  await lessonAt(at);
  const over = await call('/classes/group', { method: 'POST', token: daniel.token, body: {
    subject: 'math', topic: 'Over my own lesson', startsAt: iso(at),
    minutes: 60, capacity: 4, seatPrice: 9 } });
  ok('a teacher cannot open one over a class they are already giving',
    over.status === 400, msg(over));

  const outside = await call('/classes/group', { method: 'POST', token: daniel.token, body: {
    subject: 'math', topic: 'Outside my hours', startsAt: iso(plus(slot(10), -240)),
    minutes: 60, capacity: 4, seatPrice: 9 } });
  ok('nor outside their own declared hours', outside.status === 400, msg(outside));
  ok('for the stated reason', /outside those hours/.test(why(outside)), why(outside));

  const fine = await call('/classes/group', { method: 'POST', token: daniel.token, body: {
    subject: 'math', topic: 'A free morning', startsAt: iso(slot(11)),
    minutes: 60, capacity: 4, seatPrice: 9 } });
  ok('and a free slot inside them is accepted', fine.status === 201, msg(fine));
}

console.log('\n7. Moving a class obeys them too');
{
  const taken = slot(12);
  await lessonAt(taken);
  const movable = await lessonAt(slot(13), 60, kenji);

  const onto = await call(`/classes/sessions/${movable.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: iso(taken) } });
  ok('it cannot be moved onto another of the teacher’s classes', onto.status === 400, msg(onto));

  const away = await call(`/classes/sessions/${movable.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: iso(plus(slot(14), -240)) } });
  ok('nor outside their hours', away.status === 400, msg(away));

  /* The class must not count as clashing with itself: shortening it in place
     is the simplest way for that bug to show up. */
  const shorter = await call(`/classes/sessions/${movable.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: iso(slot(13)), minutes: 45 } });
  ok('a class does not block its own move', shorter.status === 200, msg(shorter));

  const free = await call(`/classes/sessions/${movable.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: iso(slot(15)) } });
  ok('and a free slot inside the hours is accepted', free.status === 200, msg(free));
}

console.log('\n8. A student who now clashes is reported, not used to block the move');
{
  const group = await call('/classes/group', { method: 'POST', token: daniel.token, body: {
    subject: 'math', topic: 'Group to be moved', startsAt: iso(slot(16)),
    minutes: 60, capacity: 4, seatPrice: 9 } });
  await call(`/classes/sessions/${group.json.session.id}/book`, { method: 'POST', token: kenji.token });

  // Kenji is busy at slot(17) with somebody else entirely.
  const other = await call('/classes/group', { method: 'POST', token: hana.token, body: {
    subject: 'english', topic: 'Kenji is here', startsAt: iso(slot(17)),
    minutes: 60, capacity: 4, seatPrice: 9 } });
  await call(`/classes/sessions/${other.json.session.id}/book`, { method: 'POST', token: kenji.token });

  const moved = await call(`/classes/sessions/${group.json.session.id}/schedule`, {
    method: 'PATCH', token: daniel.token, body: { startsAt: iso(slot(17)) } });
  ok('the move goes through', moved.status === 200, msg(moved));
  ok('and names the student who can no longer make it',
    Array.isArray(moved.json.studentClashes) && moved.json.studentClashes.some((n) => /Kenji/.test(n)),
    JSON.stringify(moved.json.studentClashes));
}

console.log('\n9. A cancelled class stops holding its slot');
{
  const at = slot(18);
  const lesson = await lessonAt(at);
  const blocked = await request(kenji, at);
  ok('while it stands, the slot is taken', blocked.status === 400, msg(blocked));

  await call(`/classes/sessions/${lesson.id}/cancel`, {
    method: 'POST', token: daniel.token, body: { reason: 'Freeing the slot.' } });
  const now = await request(kenji, at);
  ok('once it is cancelled, the slot is free again', now.status === 201, msg(now));
  const taken = await accept(now.json.request.id);
  ok('and someone else can have it', taken.status === 200, msg(taken));
}

console.log('\n10. Two accepts for the same slot at the same moment');
{
  /* A teacher with a list of pending requests can click Accept twice before
     the first answer comes back. Check-then-create is not one operation, and
     before the serializable transaction went in both accepts passed the
     conflict check and the teacher ended up in two classrooms at once —
     measured, not supposed.

     One pair could come out right by luck, so this is several rounds. */
  const ROUNDS = 6;
  let bothWon = 0, doubled = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const at = slot(19 + round);
    const [a, b] = await Promise.all([request(amira, at), request(kenji, at)]);
    if (a.status !== 201 || b.status !== 201) {
      ok(`round ${round + 1}: both students could ask`, false, `${a.status}/${b.status}`);
      continue;
    }
    const [ra, rb] = await Promise.all([accept(a.json.request.id), accept(b.json.request.id)]);
    const wins = [ra, rb].filter((r) => r.status === 200).length;
    if (wins !== 1) bothWon += 1;

    const held = (await call('/classes/sessions', { token: daniel.token })).json.sessions
      .filter((s) => s.status !== 'cancelled'
        && Math.abs(Date.parse(s.startsAt) - at.getTime()) < 60_000);
    if (held.length !== 1) doubled += 1;
  }
  ok(`exactly one accept wins, every time (${ROUNDS} rounds)`, bothWon === 0,
    `${bothWon}/${ROUNDS} rounds let both through`);
  ok('and the teacher is never left with two classes in one hour', doubled === 0,
    `${doubled}/${ROUNDS} rounds double-booked`);
}

/* Put the calendar back. Everything this suite created sits after BASE, and
   a cancelled class holds no slot (section 9), so cancelling them all leaves
   the next run a clear week — and the dev database without a few dozen
   classes in 2031 that nobody booked. */
const mine = (await call('/classes/sessions', { token: owner.token })).json.sessions
  .filter((s) => Date.parse(s.startsAt) >= BASE && s.status !== 'cancelled');
for (const session of mine) {
  await call(`/classes/sessions/${session.id}/cancel`, {
    method: 'POST', token: owner.token, body: { reason: 'Test cleanup.' } });
}
console.log(`\ncleaned up ${mine.length} classes this run created`);

// Leave the seeded teachers' hours as they were found.
await setHours(owner.token, daniel.user.id, []);
await setHours(owner.token, hana.user.id, []);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
