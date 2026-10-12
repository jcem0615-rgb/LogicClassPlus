/**
 * The scheduling rules themselves, with no server and no database.
 *
 * Overlap arithmetic and "is this inside the teacher's hours" are pure
 * functions over a timezone database, and the cases worth pinning down are
 * the ones a running server makes awkward to reach: a class that starts
 * inside a window and ends outside it, the same clock time on two sides of a
 * daylight-saving change, and midnight — which some ICU builds report as hour
 * 24 and would put every midnight class on the wrong side of its window.
 *
 * Needs a build first:  npm run -w apps/server build
 * Run:  node apps/server/test/scheduling-rules.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const m = await import(pathToFileURL(join(here, '../dist/lib/scheduling.js')).href);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

// 2026-10-12 is a Monday. 00:00 UTC.
const utcMidnightMon = new Date('2026-10-12T00:00:00Z');
let s = m.localSlot(utcMidnightMon, 'UTC');
ok('UTC midnight Monday reads as Monday minute 0', s.weekday === 1 && s.minute === 0, JSON.stringify(s));

// Tokyo is UTC+9 — same instant is Monday 09:00 there.
s = m.localSlot(utcMidnightMon, 'Asia/Tokyo');
ok('the same instant is Monday 09:00 in Tokyo', s.weekday === 1 && s.minute === 540, JSON.stringify(s));

// Los Angeles is UTC-7 in October — Sunday 17:00 there.
s = m.localSlot(utcMidnightMon, 'America/Los_Angeles');
ok('and Sunday 17:00 in Los Angeles — a different weekday',
  s.weekday === 0 && s.minute === 1020, JSON.stringify(s));

// The midnight-as-24 trap.
s = m.localSlot(new Date('2026-10-12T15:00:00Z'), 'Asia/Tokyo');
ok('Tokyo midnight reads as minute 0, not 1440', s.weekday === 2 && s.minute === 0, JSON.stringify(s));

ok('hhmm round-trips', m.hhmm(540) === '09:00' && m.minuteOf('09:00') === 540
  && m.hhmm(1050) === '17:30' && m.minuteOf('17:30') === 1050);

// Overlap: touching edges are not a clash.
const slot = (iso, min) => ({ startsAt: new Date(iso), minutes: min });
ok('back-to-back classes do not clash',
  !m.overlaps(slot('2026-10-12T10:00:00Z', 60), slot('2026-10-12T11:00:00Z', 60)));
ok('a one-minute overlap does clash',
  m.overlaps(slot('2026-10-12T10:00:00Z', 60), slot('2026-10-12T10:59:00Z', 60)));
ok('a class fully inside another clashes',
  m.overlaps(slot('2026-10-12T10:00:00Z', 120), slot('2026-10-12T10:30:00Z', 30)));
ok('a class entirely before does not',
  !m.overlaps(slot('2026-10-12T08:00:00Z', 60), slot('2026-10-12T10:00:00Z', 60)));

// Availability.
const win = (weekday, a, b) => ({ weekday, startMinute: m.minuteOf(a), endMinute: m.minuteOf(b) });
const tokyoTeacher = { name: 'Hana Sato', timezone: 'Asia/Tokyo' };
const monday9to17 = [win(1, '09:00', '17:00')];

ok('no windows means no restriction',
  m.availabilityProblem(tokyoTeacher, slot('2026-10-12T19:00:00Z', 60), []) === null);
// 2026-10-12T01:00Z is Monday 10:00 in Tokyo.
ok('a class inside the window is allowed',
  m.availabilityProblem(tokyoTeacher, slot('2026-10-12T01:00:00Z', 60), monday9to17) === null);
// Monday 08:00 Tokyo = Sunday 23:00 UTC.
ok('an hour before opening is refused',
  m.availabilityProblem(tokyoTeacher, slot('2026-10-11T23:00:00Z', 60), monday9to17) !== null);
// Monday 16:30 Tokyo, 60 min -> ends 17:30, past the window.
const spill = m.availabilityProblem(tokyoTeacher, slot('2026-10-12T07:30:00Z', 60), monday9to17);
ok('a class that starts inside but ends outside is refused', spill !== null, String(spill));
ok('and the message says what the hours are and what was asked for',
  /Monday 09:00–17:00/.test(spill ?? '') && /Asia\/Tokyo/.test(spill ?? '')
  && /16:30–17:30/.test(spill ?? ''), String(spill));
// Exactly filling the window is fine.
ok('a class that exactly fills the window is allowed',
  m.availabilityProblem(tokyoTeacher, slot('2026-10-12T00:00:00Z', 480), monday9to17) === null);
// Tuesday is not Monday.
ok('the same clock time on another day is refused',
  m.availabilityProblem(tokyoTeacher, slot('2026-10-13T01:00:00Z', 60), monday9to17) !== null);

// A window the teacher keeps on two days, and the description.
ok('the description groups spans by day',
  m.describeWindows([win(1, '09:00', '12:00'), win(1, '13:00', '17:00'), win(3, '10:00', '15:00')])
  === 'Monday 09:00–12:00, 13:00–17:00; Wednesday 10:00–15:00',
  m.describeWindows([win(1, '09:00', '12:00'), win(1, '13:00', '17:00'), win(3, '10:00', '15:00')]));

// Daylight saving: London loses BST on 2026-10-25. A teacher available
// Sunday 09:00-17:00 London should accept 10:00 local on both sides of it.
const london = { name: 'Ada', timezone: 'Europe/London' };
const sunday = [win(0, '09:00', '17:00')];
ok('a local 10:00 is inside the window before the clocks change',
  m.availabilityProblem(london, slot('2026-10-18T09:00:00Z', 60), sunday) === null, 'BST: 10:00 local');
ok('and still inside it after the clocks change',
  m.availabilityProblem(london, slot('2026-11-01T10:00:00Z', 60), sunday) === null, 'GMT: 10:00 local');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
