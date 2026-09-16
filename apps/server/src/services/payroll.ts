import type { Attendance, ClassSession, User } from '@prisma/client';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { minuteRateCents } from '../lib/money.js';

export interface PayrollFigures {
  teacherId: string;
  sessions: number;
  minutes: number;
  lateMinutes: number;
  noShows: number;
  grossCents: number;
  deductionCents: number;
  netCents: number;
}

/**
 * Deduction policy, applied identically here and on the attendance record:
 *   billable_late = max(0, minutes_late − grace)
 *   deduction     = billable_late × minute_rate × late_penalty
 *   no-show       = whole session fee forfeited
 */
export function deductionForCents(
  attendance: Pick<Attendance, 'minutesLate' | 'noShow'>,
  sessionMinutes: number,
  hourlyRateCents: number,
): number {
  const rate = minuteRateCents(hourlyRateCents);
  if (attendance.noShow) return Math.round(sessionMinutes * rate);
  const billableLate = Math.max(0, attendance.minutesLate - env.PAYROLL_GRACE_MINUTES);
  return Math.round(billableLate * rate * env.PAYROLL_LATE_PENALTY);
}

export function figuresFor(
  teacher: Pick<User, 'id' | 'hourlyRateCents'>,
  rows: Array<Attendance & { session: Pick<ClassSession, 'minutes'> | null }>,
): PayrollFigures {
  const hourly = teacher.hourlyRateCents ?? 0;
  const rate = minuteRateCents(hourly);
  let minutes = 0, lateMinutes = 0, deductionCents = 0, noShows = 0;

  for (const row of rows) {
    const planned = row.session?.minutes ?? 60;
    if (row.noShow) {
      noShows += 1;
      deductionCents += deductionForCents(row, planned, hourly);
      continue;
    }
    minutes += planned;
    lateMinutes += row.minutesLate;
    deductionCents += deductionForCents(row, planned, hourly);
  }

  const grossCents = Math.round(minutes * rate);
  return {
    teacherId: teacher.id,
    sessions: rows.length,
    minutes,
    lateMinutes,
    noShows,
    grossCents,
    deductionCents,
    netCents: Math.max(0, grossCents - deductionCents),
  };
}

export async function runPayroll(from: Date, to: Date): Promise<PayrollFigures[]> {
  const teachers = await prisma.user.findMany({ where: { role: 'TEACHER', status: 'ACTIVE' } });
  const rows = await prisma.attendance.findMany({
    where: { scheduledStart: { gte: from, lte: to }, teacherId: { in: teachers.map((t) => t.id) } },
    include: { session: { select: { minutes: true } } },
  });
  return teachers.map((t) => figuresFor(t, rows.filter((r) => r.teacherId === t.id)));
}
