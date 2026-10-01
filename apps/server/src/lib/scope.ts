/**
 * Which students an actor is allowed to see.
 *
 * Every list that is "about a student" — classes, invoices — has to answer
 * this the same way, or a parent ends up seeing one thing on the dashboard
 * and another on the billing page. Keeping it in one place is the point.
 */
import { prisma } from '../prisma.js';
import type { Role } from '@prisma/client';

export interface Actor { id: string; role: Role }

/** The ids this actor may see, or `null` meaning "no restriction". */
export async function visibleStudentIds(me: Actor): Promise<string[] | null> {
  if (me.role === 'OWNER') return null;
  if (me.role === 'PARENT') {
    const links = await prisma.guardian.findMany({
      where: { parentId: me.id },
      select: { studentId: true },
    });
    return links.map((l) => l.studentId);
  }
  return [me.id];
}

/** True when this actor may read the given student's records. */
export async function canSeeStudent(me: Actor, studentId: string): Promise<boolean> {
  const ids = await visibleStudentIds(me);
  return ids === null || ids.includes(studentId);
}

/** The children of a parent, in a shape the client can render directly. */
export async function childrenOf(parentId: string) {
  const links = await prisma.guardian.findMany({
    where: { parentId },
    include: { student: true },
    orderBy: { createdAt: 'asc' },
  });
  return links.map((l) => l.student);
}
