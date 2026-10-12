'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { dayTime, time } from '@/lib/format';
import { Avatar, Button, Field, Modal, StatusPill, SubjectPill } from './ui';
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

/** A datetime-local value for a date, which the input needs in local time. */
const localValue = (iso: string): string => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

type Role = 'teacher' | 'student' | 'owner' | 'parent';

/**
 * Who may call a class off, mirrored from the server's `canCancel`. The
 * server decides; this only decides whether to offer the button, because an
 * action that is always visible and sometimes refused is worse than one that
 * appears when it applies.
 */
function mayCancel(session: ClassSession, as: Role, mine: boolean): boolean {
  if (session.status !== 'scheduled') return false;
  if (as === 'owner') return true;
  if (as === 'teacher') return mine;
  // A student cancels their own private lesson; a seat in a group class is
  // released from the open-classes list instead. A parent may read their
  // child's class and ask for it to be moved, but not do either themselves —
  // the server refuses, so offering the button would only mislead them.
  return as === 'student' && session.capacity === 1;
}

/**
 * Cancelling and moving, as two small dialogs rather than two confirm boxes.
 * A reason is worth asking for — "called off by your teacher" with nothing
 * after it is the kind of notification that generates a phone call — and a
 * new time needs a real date input, which `confirm()` cannot give.
 */
function SessionActions({ session, as }: { session: ClassSession; as: Role }) {
  const store = useStore();
  const [open, setOpen] = useState<'cancel' | 'move' | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  if (as === 'parent') return null;
  const mine = session.teacherId === store.user?.id;
  const canMove = session.status === 'scheduled' && (as === 'owner' || (as === 'teacher' && mine));
  const canCall = mayCancel(session, as, mine);
  if (!canMove && !canCall) return null;

  async function cancel() {
    setBusy(true);
    const done = await store.run(() => api.cancelSession(session.id, reason.trim() || undefined));
    setBusy(false);
    if (!done) return;
    setOpen(null);
    setReason('');
    /* What it cost, said plainly. An invoice already raised against a class
       that is not happening is the Owner's to void, and nobody would think to
       look for it unless told here. */
    const notes = [
      ...(done.shortNotice ? ['This was short notice.'] : []),
      ...(done.invoicedLines
        ? [`${done.invoicedLines} invoice line${done.invoicedLines === 1 ? '' : 's'} already exist`
          + ' for it — void them from Billing if they should not stand.']
        : []),
      ...(done.teacherClockedIn ? ['The teacher had already clocked in for it.'] : []),
    ];
    store.toast(notes.length ? 'warn' : 'ok', 'Class cancelled',
      notes.length ? notes.join(' ') : 'Everyone in it has been told.');
  }

  async function move(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const when = String(data.get('when'));
    if (new Date(when).getTime() < Date.now()) {
      store.toast('err', 'That time has passed', 'Choose a slot in the future.');
      return;
    }
    setBusy(true);
    const done = await store.run(
      () => api.rescheduleSession(session.id, {
        startsAt: new Date(when).toISOString(),
        minutes: Number(data.get('minutes')),
      }),
      { title: 'Class moved', body: 'Everyone in it has been told the new time.' },
    );
    setBusy(false);
    if (done) setOpen(null);
  }

  return (
    <>
      {canMove ? (
        <Button size="sm" data-move={session.id} onClick={() => setOpen('move')}>Move</Button>
      ) : null}
      {canCall ? (
        <Button size="sm" data-cancel={session.id} onClick={() => setOpen('cancel')}>Cancel</Button>
      ) : null}

      {open === 'cancel' ? (
        <Modal
          title={`Cancel “${session.topic}”?`}
          onClose={() => setOpen(null)}
          dismissOnBackdrop={false}
          footer={
            <>
              <Button onClick={() => setOpen(null)} disabled={busy}>Keep the class</Button>
              <Button variant="primary" data-confirm-cancel disabled={busy}
                onClick={() => void cancel()}>
                {busy ? 'Cancelling…' : 'Cancel the class'}
              </Button>
            </>
          }
        >
          <p className="text-[13.5px] text-ink-2">
            {dayTime(session.startsAt)} · {session.minutes} min.
            {session.booked > 1
              ? ` All ${session.booked} students who booked a seat will be told, by email as well
                  as in the app.`
              : ' Everyone in it will be told, by email as well as in the app.'}
          </p>
          <Field label="Reason (optional, but they will read it)">
            <textarea
              name="reason" rows={2} id="cancel-reason"
              value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. I am unwell — I will offer a replacement slot tomorrow."
            />
          </Field>
          <p className="text-[13px] text-ink-3">
            The class stays on the record as cancelled rather than disappearing, so its chat,
            board and any invoice raised against it are still there.
          </p>
        </Modal>
      ) : null}

      {open === 'move' ? (
        <Modal title={`Move “${session.topic}”`} onClose={() => setOpen(null)} dismissOnBackdrop={false}>
          <form className="flex flex-col gap-3.5" onSubmit={move} data-testid="move-form">
            <p className="text-[13.5px] text-ink-2">
              Booked for {dayTime(session.startsAt)}.
              {session.booked > 1
                ? ` ${session.booked} students have a seat; each one is emailed the new time and
                    can release their seat if it does not suit.`
                : ' The student is emailed the new time.'}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="New date & time">
                <input name="when" type="datetime-local" required id="move-when"
                  defaultValue={localValue(session.startsAt)} />
              </Field>
              <Field label="Length">
                <select name="minutes" defaultValue={String(session.minutes)}>
                  {[30, 45, 60, 90, 120, 180, 240].map((m) => (
                    <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex justify-end gap-2.5">
              <Button type="button" onClick={() => setOpen(null)} disabled={busy}>Never mind</Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Moving…' : 'Move the class'}
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}

/** One class on the timeline, colour-coded by subject down its left edge. */
export function TimelineItem({ session, as }: { session: ClassSession; as: Role }) {
  const { userById } = useStore();
  const roster = roomRoster(session, (id) => userById(id).name);
  const teacher = userById(session.teacherId);
  const group = session.capacity > 1;
  const who = as === 'owner' || as === 'parent' ? `${teacher.name} → ${roster}`
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
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={session.status} />
            {/* A cancelled class offers no way in, whatever the clock says. */}
            {joinable(session) && session.status !== 'cancelled'
              && (as === 'teacher' || as === 'student') ? (
              <Link href={`/room/${session.id}`}>
                <Button size="sm" variant="primary">Join</Button>
              </Link>
            ) : null}
            <SessionActions session={session} as={as} />
          </div>
        </div>

        {/* Why it is not happening, or where it moved from. Both are the first
            thing the person looking at the row wants to know, so neither is
            left to a notification they may already have dismissed. */}
        {session.status === 'cancelled' ? (
          <div className="mt-1.5 text-[13px] text-ink-3" data-cancelled={session.id}>
            Cancelled{session.cancelledById ? ` by ${userById(session.cancelledById).name}` : ''}
            {session.shortNotice ? <span className="text-warn"> · short notice</span> : null}
            {session.cancelReason ? <span className="block text-ink-2">“{session.cancelReason}”</span> : null}
          </div>
        ) : session.rescheduledFrom ? (
          <div className="mt-1.5 text-[13px] text-ink-3" data-moved={session.id}>
            Moved from {dayTime(session.rescheduledFrom)}
          </div>
        ) : null}
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
        ) : as === 'student' && request.status === 'pending' ? (
          /* The other half of cancelling. Waiting for a teacher to accept a
             class you no longer want, so that you can then ask them to call
             it off, is not a workflow — it is an apology. */
          <>
            <StatusPill status={request.status} />
            <Button size="sm" data-withdraw={request.id} onClick={() => {
              void run(() => api.withdrawRequest(request.id),
                { title: 'Request withdrawn', body: 'Your teacher has been told.' });
            }}>Withdraw</Button>
          </>
        ) : <StatusPill status={request.status} />}
      </div>
    </div>
  );
}
