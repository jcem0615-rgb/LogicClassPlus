/**
 * A teacher's teaching hours.
 *
 * Declaring none keeps the old behaviour exactly — any time is bookable —
 * which is why this is opt-in rather than a wall every existing teacher would
 * have woken up behind.
 *
 * Students can read a teacher's hours, because a booking form that refuses a
 * slot without having said which slots are allowed is a guessing game.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';
import { DAY_NAMES, describeWindows, hhmm, minuteOf, windowsFor } from '../lib/scheduling.js';
import { actor, requireAuth } from '../middleware/auth.js';

export const availabilityRouter = Router();
availabilityRouter.use(requireAuth);

const publicWindows = (
  teacher: { id: string; name: string; timezone: string },
  windows: Array<{ id: string; weekday: number; startMinute: number; endMinute: number }>,
) => ({
  teacherId: teacher.id,
  teacherName: teacher.name,
  timezone: teacher.timezone,
  windows: windows.map((w) => ({
    id: w.id, weekday: w.weekday, day: DAY_NAMES[w.weekday],
    start: hhmm(w.startMinute), end: hhmm(w.endMinute),
  })),
  /** The same thing in a sentence, so every screen says it the same way. */
  summary: describeWindows(windows),
  /** No hours declared: bookable whenever, which is the default. */
  open: windows.length === 0,
});

async function teacherOr404(id: string) {
  const teacher = await prisma.user.findUnique({ where: { id } });
  if (!teacher || teacher.role !== 'TEACHER') throw notFound('That teacher does not exist.');
  return teacher;
}

availabilityRouter.get('/:teacherId', asyncRoute(async (req, res) => {
  const teacher = await teacherOr404(String(req.params['teacherId']));
  res.json(publicWindows(teacher, await windowsFor(teacher.id)));
}));

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const setWindows = z.object({
  windows: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    start: z.string().regex(TIME, 'Use HH:MM, e.g. 09:00.'),
    end: z.string().regex(TIME, 'Use HH:MM, e.g. 17:00.'),
  })).max(21, 'Three spans a day is already more than anybody needs.'),
});

availabilityRouter.put('/:teacherId', validate(setWindows), asyncRoute(async (req, res) => {
  const me = actor(req);
  const teacher = await teacherOr404(String(req.params['teacherId']));
  if (me.role !== 'OWNER' && me.id !== teacher.id) {
    throw forbidden('Only the teacher themselves, or an administrator, can set these hours.');
  }

  const input = req.body as z.infer<typeof setWindows>;
  const rows = input.windows.map((w) => ({
    weekday: w.weekday, startMinute: minuteOf(w.start), endMinute: minuteOf(w.end),
  }));

  for (const row of rows) {
    if (row.endMinute <= row.startMinute) {
      throw badRequest(`${DAY_NAMES[row.weekday]} ends at or before it starts.`);
    }
  }
  /* Overlapping spans on one day are not wrong so much as meaningless — two
     windows covering the same hour answer the same question twice — and they
     make the summary read like a mistake. */
  for (const day of new Set(rows.map((r) => r.weekday))) {
    const spans = rows.filter((r) => r.weekday === day)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < spans.length; i += 1) {
      if (spans[i]!.startMinute < spans[i - 1]!.endMinute) {
        throw badRequest(`Two of the ${DAY_NAMES[day]} spans overlap.`);
      }
    }
  }

  /* Replace rather than merge: the screen sends the whole week, so a window
     the teacher deleted has to actually disappear. One transaction, so a
     failure cannot leave them with no hours at all. */
  await prisma.$transaction(async (tx) => {
    await tx.availability.deleteMany({ where: { teacherId: teacher.id } });
    if (rows.length) {
      await tx.availability.createMany({
        data: rows.map((r) => ({ ...r, teacherId: teacher.id })),
      });
    }
  });

  res.json(publicWindows(teacher, await windowsFor(teacher.id)));
}));
