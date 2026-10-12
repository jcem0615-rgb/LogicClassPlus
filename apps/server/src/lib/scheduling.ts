/**
 * When a class may be booked, and whether somebody is already busy.
 *
 * Four places gave a class a time — a student requesting one, a teacher
 * accepting it, a teacher opening a group class, and a class being moved —
 * and none of them asked whether the people involved were free. A teacher
 * could be in two classrooms at once; a student could take a group seat that
 * clashed with the private lesson they had already booked; anyone could ask
 * for 3am and the only thing in the way was a human noticing.
 *
 * The rules live here rather than at each call site, because a conflict check
 * that holds in three places out of four is worse than none: it teaches people
 * to trust a guarantee the fourth place quietly breaks.
 */
import type { ClassSession, Availability, Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { badRequest } from './http-error.js';

export interface Slot { startsAt: Date; minutes: number }

export const endOf = (slot: Slot): Date =>
  new Date(slot.startsAt.getTime() + slot.minutes * 60_000);

/**
 * Two classes clash when each starts before the other ends. Touching at the
 * edges is not a clash: a lesson ending at four and the next starting at four
 * is a normal afternoon, not a double booking.
 */
export const overlaps = (a: Slot, b: Slot): boolean =>
  a.startsAt.getTime() < endOf(b).getTime() && b.startsAt.getTime() < endOf(a).getTime();

/* ---------------- reading a clock in somebody else's country ----------------
   A recurring rule is local: "Monday 09:00" means Monday where the teacher
   is. Turning an instant into a local weekday and minute is the one piece of
   this that genuinely needs a timezone database, and the platform ships one. */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface LocalSlot { weekday: number; minute: number }

export function localSlot(at: Date, timeZone: string): LocalSlot {
  /* `hourCycle: 'h23'` rather than `hour12: false`, which reports midnight as
     hour 24 on some ICU builds and would put every midnight class on the
     wrong side of its window. */
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = WEEKDAYS.indexOf(read('weekday'));
  return {
    weekday: weekday < 0 ? at.getUTCDay() : weekday,
    minute: Number(read('hour')) * 60 + Number(read('minute')),
  };
}

/** "09:00" ⇄ 540, for a wire format a person can read. */
export const minuteOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};
export const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Just the shape the rules need, so a caller holding rows it built itself
    does not have to pretend they came out of the database. */
export type Window = Pick<Availability, 'weekday' | 'startMinute' | 'endMinute'>;

/** The teacher's hours, in words, for an error message worth reading. */
export function describeWindows(windows: Window[]): string {
  if (!windows.length) return 'no hours set';
  const byDay = new Map<number, string[]>();
  for (const w of [...windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute)) {
    const list = byDay.get(w.weekday) ?? [];
    list.push(`${hhmm(w.startMinute)}–${hhmm(w.endMinute)}`);
    byDay.set(w.weekday, list);
  }
  return [...byDay.entries()]
    .map(([day, spans]) => `${DAY_NAMES[day]} ${spans.join(', ')}`)
    .join('; ');
}

/**
 * Does this slot sit inside the teacher's hours? The whole class has to fit:
 * a teacher available until five should not be booked until half past, and
 * the far end of a lesson is as much of a commitment as the near end.
 *
 * Returns the reason it does not fit, or null when it does.
 */
export function availabilityProblem(
  teacher: { name: string; timezone: string },
  slot: Slot,
  windows: Window[],
): string | null {
  // Nothing declared means no restriction, which is how every teacher who has
  // not opened this screen keeps working exactly as before.
  if (!windows.length) return null;

  const start = localSlot(slot.startsAt, teacher.timezone);
  const end = localSlot(endOf(slot), teacher.timezone);

  const fits = windows.some((w) => w.weekday === start.weekday
    && start.minute >= w.startMinute
    // A class that runs past local midnight reports an earlier weekday at its
    // end than at its start, so no single window can contain it — which is the
    // right answer rather than an edge case to paper over.
    && end.weekday === start.weekday
    && end.minute <= w.endMinute);
  if (fits) return null;

  const first = teacher.name.split(' ')[0] ?? teacher.name;
  return `${first} teaches ${describeWindows(windows)} (${teacher.timezone}). `
    + `That slot is ${DAY_NAMES[start.weekday]} ${hhmm(start.minute)}–${hhmm(end.minute)} `
    + 'for them, which is outside those hours.';
}

export const windowsFor = (teacherId: string): Promise<Availability[]> =>
  prisma.availability.findMany({
    where: { teacherId }, orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
  });

/* ---------------- who is already busy ---------------- */

/**
 * Classes this person is already committed to that overlap the slot — as the
 * teacher giving them or as a student sitting in them. A cancelled class is
 * not a commitment, so it does not block anything.
 *
 * The database window is deliberately wider than the slot and narrowed in
 * memory: Prisma cannot express "starts before this ends, and ends after it
 * begins" against a duration held in another column, and the longest class the
 * booking form offers is eight hours, so a day either side cannot miss one.
 */
export async function clashesFor(input: {
  userId: string;
  slot: Slot;
  /** The class being moved, which must not count as clashing with itself. */
  excludeSessionId?: string;
  /** A transaction client, when the answer has to hold until a write lands. */
  db?: Prisma.TransactionClient;
}): Promise<ClassSession[]> {
  const db = input.db ?? prisma;
  const from = new Date(input.slot.startsAt.getTime() - 24 * 3600_000);
  const to = new Date(endOf(input.slot).getTime() + 24 * 3600_000);

  const nearby = await db.classSession.findMany({
    where: {
      status: { not: 'CANCELLED' },
      startsAt: { gte: from, lte: to },
      ...(input.excludeSessionId ? { id: { not: input.excludeSessionId } } : {}),
      OR: [
        { teacherId: input.userId },
        { participants: { some: { studentId: input.userId } } },
      ],
    },
    orderBy: { startsAt: 'asc' },
  });
  return nearby.filter((s) => overlaps(input.slot, s));
}

/** One clash, said plainly, without naming anybody else's business. */
export function describeClash(session: ClassSession, timeZone: string): string {
  const when = session.startsAt.toLocaleString('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone,
  });
  return `${when} (${session.minutes} min)`;
}

/** Whoever must be free, and how much the message may say about them. */
export interface Attendee {
  id: string;
  name: string;
  timezone: string;
  /** 'you' names the clash; 'them' says only that the person is busy. */
  voice: 'you' | 'them';
}

export function clashError(person: Attendee, clash: ClassSession): Error {
  if (person.voice === 'them') {
    const first = person.name.split(' ')[0] ?? person.name;
    return badRequest(`${first} already has a class at that time. Pick another slot.`);
  }
  return badRequest('You already have a class then — '
    + `${describeClash(clash, person.timezone)}. Pick another slot.`);
}

/**
 * Checks the slot is free and writes the class without letting go in between.
 *
 * Checking and then writing are two operations, and two people accepting
 * requests for the same hour at the same moment both passed the check and
 * both got a class — measured, not supposed: the teacher ended up in two
 * classrooms at once, which is the exact thing this module exists to prevent.
 * Serializable makes the pair atomic; Postgres spots that each transaction
 * read a set the other then wrote into, and aborts one of them.
 */
export async function writeIntoFreeSlot<T>(input: {
  slot: Slot;
  mustBeFree: Attendee[];
  excludeSessionId?: string;
  write: (tx: Prisma.TransactionClient) => Promise<T>;
}): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      for (const person of input.mustBeFree) {
        const clashes = await clashesFor({
          userId: person.id,
          slot: input.slot,
          ...(input.excludeSessionId ? { excludeSessionId: input.excludeSessionId } : {}),
          db: tx,
        });
        if (clashes.length) throw clashError(person, clashes[0]!);
      }
      return input.write(tx);
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    /* A write conflict in this transaction can only mean somebody else took
       the slot while it was being checked — the only reads here are of the
       classes in that hour. */
    if ((err as { code?: string }).code === 'P2034') {
      throw badRequest('Somebody took that slot while this was going through. Pick another.');
    }
    throw err;
  }
}
