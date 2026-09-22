'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { ago, day, dayTime, money, time } from '@/lib/format';
import { Shell } from '@/components/shell';
import { RequestRow, TimelineItem } from '@/components/session-row';
import { Avatar, Button, Card, CardHead, Empty, Pill, Summary, SubjectPill } from '@/components/ui';
import type { ClassSession, User } from '@/lib/types';

export default function DashboardPage() {
  const store = useStore();
  const user = store.user;

  return (
    <Shell title="Dashboard" subtitle={user ? `Signed in as ${user.role} · ${user.tz}` : undefined}>
      {user?.role === 'owner' ? <OwnerHome /> : null}
      {user?.role === 'teacher' ? <TeacherHome /> : null}
      {user?.role === 'student' ? <StudentHome /> : null}
    </Shell>
  );
}

const today = (sessions: ClassSession[]): ClassSession[] => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = start.getTime() + 86_400_000;
  return sessions
    .filter((s) => {
      const t = new Date(s.startsAt).getTime();
      return t >= start.getTime() && t < end;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
};

const nextSession = (sessions: ClassSession[]): ClassSession | undefined => sessions
  .filter((s) => s.status === 'scheduled' && new Date(s.startsAt).getTime() > Date.now() - 15 * 60e3)
  .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];

function Announcements({ limit }: { limit: number }) {
  const store = useStore();
  const list = [...store.announcements]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  return (
    <Card>
      <CardHead title="Announcements">
        <Link href="/announcements"><Button size="sm">All</Button></Link>
      </CardHead>
      {list.length ? list.map((a) => (
        <div key={a.id} className="border-b border-line px-[18px] py-3.5 last:border-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold">
              {a.pinned ? <Pill tone="warn">Pinned</Pill> : null}
              {a.title}
            </div>
            <span className="font-mono text-[13px] text-ink-3">{ago(a.createdAt)}</span>
          </div>
          <p className="mt-1 text-[13px] text-ink-2">{a.body}</p>
        </div>
      )) : <Empty title="Nothing posted" body="Announcements from the admin show up here." />}
    </Card>
  );
}

function OwnerHome() {
  const store = useStore();
  const pendingUsers = store.users.filter((u) => u.status === 'pending');
  const openInvoices = store.invoices.filter((i) => i.status === 'open');
  const openTotal = openInvoices.reduce((sum, i) => sum + i.amount, 0);
  const collected = store.invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.amount, 0);
  const todays = today(store.sessions);
  const resets = store.resets.filter((r) => r.status === 'pending');

  return (
    <>
      <Summary items={[
        { k: 'Active users', v: store.users.filter((u) => u.status === 'active').length,
          s: `${store.users.filter((u) => u.role === 'teacher' && u.status === 'active').length} teachers · ${store.users.filter((u) => u.role === 'student' && u.status === 'active').length} students` },
        { k: 'Awaiting approval', v: pendingUsers.length, s: pendingUsers.length ? 'Needs your decision' : 'Queue clear' },
        { k: 'Sessions today', v: todays.length, s: 'across all teachers' },
        { k: 'Open invoices', v: money(openTotal), s: `${openInvoices.length} unpaid` },
        { k: 'Collected', v: money(collected), s: 'lifetime, paid' },
      ]} />

      <div className="grid gap-[18px] lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHead title="Registrations awaiting approval">
            <Link href="/people"><Button size="sm">All users</Button></Link>
          </CardHead>
          {pendingUsers.length ? pendingUsers.map((p) => (
            <PendingUser key={p.id} person={p} />
          )) : <Empty title="Nothing waiting" body="Every registration has been reviewed." />}
        </Card>

        <Card>
          <CardHead title="Password reset queue" />
          {resets.length ? resets.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-[18px] py-3.5 last:border-0">
              <div>
                <div className="font-semibold">{store.userById(r.userId).name}</div>
                <div className="text-[13px] text-ink-3">{r.email} · {ago(r.requestedAt)}</div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => { void store.run(() => api.resolveReset(r.id, 'reject')); }}>
                  Reject
                </Button>
                <Button size="sm" variant="primary" onClick={() => {
                  void store.run(() => api.resolveReset(r.id, 'approve'),
                    { title: 'Link sent', body: 'The account holder was notified.' });
                }}>Send link</Button>
              </div>
            </div>
          )) : <Empty title="No requests" body="Reset requests appear here for approval." />}
        </Card>
      </div>

      <Card>
        <CardHead title="Every session today" />
        {todays.length ? (
          <div className="px-[18px] py-2">
            {todays.map((s) => <TimelineItem key={s.id} session={s} as="owner" />)}
          </div>
        ) : <Empty title="No classes today" body="The schedule is clear." />}
      </Card>
    </>
  );
}

function PendingUser({ person }: { person: User }) {
  const store = useStore();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[18px] py-3.5 last:border-0">
      <div className="flex items-center gap-2.5">
        <Avatar user={person} size="lg" />
        <div>
          <div className="font-semibold">{person.name}</div>
          <div className="text-[13px] text-ink-3">
            {person.email} · {person.role} · joined {ago(person.joinedAt)}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => {
          void store.run(async () => {
            await api.setUserStatus(person.id, 'suspended');
            await api.deleteUser(person.id);
          }, { title: 'Registration rejected', body: `${person.name} was removed.` });
        }}>Reject</Button>
        <Button size="sm" variant="primary" onClick={() => {
          void store.run(() => api.approveUser(person.id),
            { title: 'Approved', body: `${person.name} can sign in now.` });
        }}>Approve</Button>
      </div>
    </div>
  );
}

function TeacherHome() {
  const store = useStore();
  const user = store.user!;
  const todays = today(store.sessions);
  const pending = store.requests.filter((r) => r.status === 'pending');
  const weekAgo = Date.now() - 7 * 86_400_000;
  const weekSessions = store.sessions.filter(
    (s) => s.status === 'completed' && new Date(s.startsAt).getTime() > weekAgo);
  const weekMinutes = weekSessions.reduce((sum, s) => sum + s.minutes, 0);
  const onTime = store.attendance.filter(
    (a) => !a.noShow && (a.minutesLate ?? 0) <= store.policy.graceMinutes).length;
  const rate = store.attendance.length ? Math.round((onTime / store.attendance.length) * 100) : 100;
  // Gross for the minutes actually taught, less the deductions already
  // computed on each attendance row by the server.
  const taughtMinutes = store.attendance
    .filter((a) => !a.noShow)
    .reduce((sum, a) => sum + (a.sessionMinutes ?? 60), 0);
  const deductions = store.attendance.reduce((sum, a) => sum + a.deduction, 0);
  const earned = Math.max(0, ((user.hourlyRate ?? 0) / 60) * taughtMinutes - deductions);
  const next = nextSession(store.sessions);

  return (
    <>
      <Summary items={[
        { k: 'Classes today', v: todays.length, s: next ? `next ${time(next.startsAt)}` : 'nothing scheduled' },
        { k: 'Taught this week', v: `${(weekMinutes / 60).toFixed(1)}h`, s: `${weekSessions.length} sessions` },
        { k: 'On-time rate', v: `${rate}%`, s: `${store.policy.graceMinutes} min grace window` },
        { k: 'Earned, 30 days', v: money(earned),
          s: deductions > 0 ? `${money(deductions)} deducted` : 'no deductions' },
        { k: 'Requests waiting', v: pending.length, s: pending.length ? 'reply today' : 'all answered' },
      ]} />

      <div className="grid gap-[18px] lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHead title="Your teaching day">
            <Link href="/classes"><Button size="sm">All classes</Button></Link>
          </CardHead>
          {todays.length ? (
            <div className="px-[18px] py-2">
              {todays.map((s) => <TimelineItem key={s.id} session={s} as="teacher" />)}
            </div>
          ) : <Empty title="No classes today" body="Accepted requests land here automatically." />}
        </Card>

        <Card>
          <CardHead title="Class requests" />
          {pending.length ? pending.map((r) => <RequestRow key={r.id} request={r} as="teacher" />)
            : <Empty title="Inbox clear" body="New requests notify you instantly." />}
        </Card>
      </div>

      <Announcements limit={2} />
    </>
  );
}

function StudentHome() {
  const store = useStore();
  const next = nextSession(store.sessions);
  const done = store.sessions.filter((s) => s.status === 'completed');
  const minutes = done.reduce((sum, s) => sum + s.minutes, 0);
  const open = store.invoices.filter((i) => i.status === 'open');
  const due = open.reduce((sum, i) => sum + i.amount, 0);
  const pending = store.requests.filter((r) => r.status === 'pending');

  return (
    <>
      <Summary items={[
        { k: 'Next class', v: next ? time(next.startsAt) : '—',
          s: next ? `${day(next.startsAt)} · ${store.userById(next.teacherId).name}` : 'none booked' },
        { k: 'Hours studied', v: `${(minutes / 60).toFixed(1)}h`, s: `${done.length} classes finished` },
        { k: 'Balance due', v: money(due), s: open.length ? `${open.length} open` : 'nothing owing' },
        { k: 'Requests pending', v: pending.length, s: pending.length ? 'waiting on a teacher' : 'all answered' },
      ]} />

      {next ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[18px] py-3.5">
            <div>
              <span className="eyebrow">Your next class</span>
              <h2 className="mt-1 text-[19px]">{next.topic}</h2>
            </div>
            <SubjectPill subject={next.subject} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 p-[18px]">
            <div className="flex items-center gap-2.5">
              <Avatar user={store.userById(next.teacherId)} size="lg" />
              <div>
                <div className="font-semibold">{store.userById(next.teacherId).name}</div>
                <div className="font-mono text-[13px] text-ink-3">
                  {dayTime(next.startsAt)} · {next.minutes} min · {ago(next.startsAt)}
                </div>
              </div>
            </div>
            <Link href={`/room/${next.id}`}><Button variant="primary">Enter classroom</Button></Link>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-[18px] lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHead title="Your requests">
            <Link href="/classes"><Button size="sm" variant="primary">Request a class</Button></Link>
          </CardHead>
          {store.requests.length ? store.requests.slice(0, 5).map((r) => (
            <RequestRow key={r.id} request={r} as="student" />
          )) : <Empty title="No requests yet" body="Ask a teacher for a class from the Classes screen." />}
        </Card>
        <Announcements limit={3} />
      </div>
    </>
  );
}
