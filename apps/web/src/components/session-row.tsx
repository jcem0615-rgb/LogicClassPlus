'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { dayTime, time } from '@/lib/format';
import { Avatar, Button, StatusPill, SubjectPill } from './ui';
import type { ClassRequest, ClassSession } from '@/lib/types';

export const joinable = (s: ClassSession): boolean =>
  s.status === 'live' ||
  (s.status === 'scheduled' && new Date(s.startsAt).getTime() - Date.now() < 6 * 3600e3);

/**
 * Who is in a class, in words. Up to two names read better than a count —
 * "Amira and Kenji" tells a teacher what "2 students" does not — and past
 * that a count is the only thing that fits on the row.
 */
export function roomRoster(
  session: ClassSession, nameOf: (id: string) => string,
): string {
  const names = session.studentIds.map(nameOf);
  // `booked` can exceed the names on hand: a parent is told how full their
  // child's class is without being told who else is in it.
  const hidden = Math.max(0, session.booked - names.length);
  if (!names.length) return session.booked ? `${session.booked} students` : 'no seats taken yet';
  if (names.length <= 2 && !hidden) return names.join(' and ');
  if (hidden) return `${names.join(' and ')} and ${hidden} other${hidden === 1 ? '' : 's'}`;
  return `${names.length} students`;
}

/** One class on the timeline, colour-coded by subject down its left edge. */
export function TimelineItem({ session, as }: { session: ClassSession; as: 'teacher' | 'student' | 'owner' }) {
  const { userById } = useStore();
  const roster = roomRoster(session, (id) => userById(id).name);
  const teacher = userById(session.teacherId);
  const group = session.capacity > 1;
  const who = as === 'owner' ? `${teacher.name} → ${roster}`
    : as === 'teacher' ? roster
      : teacher.name;
  /* A group class has no single "other person", so there is no one timezone
     to show; how full it is, is what the viewer actually wants there. */
  const detail = group
    ? `${session.booked} of ${session.capacity} seats`
    : userById(as === 'teacher' ? session.studentIds[0] ?? '' : session.teacherId).tz;

  return (
    <div className="grid grid-cols-[62px_1fr] gap-3.5 border-b border-line py-3 last:border-0">
      <div className="font-mono text-[13px] tabular text-ink-2">
        {time(session.startsAt)}
        <span className="block text-[11px] text-ink-3">{session.minutes} min</span>
      </div>
      <div className={`border-l-2 pl-3.5 ${session.subject === 'math' ? 'border-math' : 'border-english'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">{session.topic}</div>
            <div className="text-[13px] text-ink-3">{who} · {detail}</div>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status={session.status} />
            {joinable(session) && as !== 'owner' ? (
              <Link href={`/room/${session.id}`}>
                <Button size="sm" variant="primary">Join</Button>
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function RequestRow({ request, as }: { request: ClassRequest; as: 'teacher' | 'student' }) {
  const { userById, run } = useStore();
  const who = userById(as === 'teacher' ? request.studentId : request.teacherId);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[18px] py-3.5 last:border-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar user={who} />
        <div className="min-w-0">
          <div className="font-semibold">{request.topic}</div>
          <div className="text-[13px] text-ink-3">
            {who.name} · {dayTime(request.requestedFor)} · {request.minutes} min
          </div>
          {request.note ? <div className="mt-0.5 text-[13px] text-ink-2">“{request.note}”</div> : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <SubjectPill subject={request.subject} />
        {as === 'teacher' && request.status === 'pending' ? (
          <>
            <Button size="sm" onClick={() => {
              void run(() => api.decideRequest(request.id, 'decline'),
                { title: 'Declined', body: 'The student was notified.' });
            }}>Decline</Button>
            <Button size="sm" variant="primary" onClick={() => {
              void run(() => api.decideRequest(request.id, 'accept'),
                { title: 'Accepted', body: 'The session is on your schedule.' });
            }}>Accept</Button>
          </>
        ) : <StatusPill status={request.status} />}
      </div>
    </div>
  );
}
