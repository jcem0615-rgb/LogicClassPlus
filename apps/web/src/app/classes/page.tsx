'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { day, money } from '@/lib/format';
import { Shell } from '@/components/shell';
import { RequestRow, TimelineItem, roomRoster } from '@/components/session-row';
import {
  Button, Card, CardHead, Empty, Field, StatusPill, SubjectPill, Summary, Table, Td, Th,
} from '@/components/ui';
import type { ClassSession, Subject } from '@/lib/types';

/** Tomorrow at 16:00 local, formatted for a datetime-local input. */
function defaultSlot(): string {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(16, 0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function ClassesPage() {
  const store = useStore();
  const user = store.user;
  const [busy, setBusy] = useState(false);
  const [openClasses, setOpenClasses] = useState<ClassSession[]>([]);

  /* The open list is not part of the store's refresh: it is a different
     question from "my classes" — it is deliberately full of classes that are
     nobody's yet. */
  const loadOpen = useCallback(async () => {
    try {
      const { sessions: rows } = await api.openClasses();
      setOpenClasses(rows);
    } catch { /* an empty list is the right fallback for a browse */ }
  }, []);

  useEffect(() => { if (user) void loadOpen(); }, [user, loadOpen]);

  const sessions = useMemo(
    () => [...store.sessions].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
    [store.sessions]);
  const upcoming = sessions.filter((s) => s.status === 'scheduled' || s.status === 'live');
  const past = sessions.filter((s) => s.status === 'completed' || s.status === 'no_show').reverse();
  const teachers = store.users.filter((u) => u.role === 'teacher' && u.status === 'active');
  const as = user?.role === 'teacher' ? 'teacher' : user?.role === 'owner' ? 'owner' : 'student';

  async function createRequest(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const when = String(data.get('when'));
    if (new Date(when).getTime() < Date.now()) {
      store.toast('err', 'That time has passed', 'Choose a slot in the future.');
      return;
    }
    setBusy(true);
    const teacherId = String(data.get('teacherId'));
    const created = await store.run(() => api.createRequest({
      teacherId,
      subject: data.get('subject') as Subject,
      topic: String(data.get('topic')),
      note: String(data.get('note') || '') || undefined,
      requestedFor: new Date(when).toISOString(),
      minutes: Number(data.get('minutes')),
    }), { title: 'Request sent', body: `${store.userById(teacherId).name} has been notified.` });
    if (created) form.reset();
    setBusy(false);
  }

  async function openGroupClass(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const when = String(data.get('when'));
    if (new Date(when).getTime() < Date.now()) {
      store.toast('err', 'That time has passed', 'Choose a slot in the future.');
      return;
    }
    setBusy(true);
    const made = await store.run(() => api.openGroupClass({
      subject: data.get('subject') as Subject,
      topic: String(data.get('topic')),
      startsAt: new Date(when).toISOString(),
      minutes: Number(data.get('minutes')),
      capacity: Number(data.get('capacity')),
      seatPrice: Number(data.get('seatPrice')),
    }), { title: 'Class opened', body: 'Students can book a seat from their Classes page.' });
    if (made) { form.reset(); await loadOpen(); }
    setBusy(false);
  }

  async function book(id: string, taken: boolean) {
    setBusy(true);
    const done = await store.run(
      () => (taken ? api.releaseSeat(id) : api.bookSeat(id)),
      taken
        ? { title: 'Seat released', body: 'Somebody else can take it now.' }
        : { title: 'Seat booked', body: 'The class is on your timetable.' },
    );
    if (done) await loadOpen();
    setBusy(false);
  }

  return (
    <Shell
      title="Classes"
      subtitle={user?.role === 'student' ? 'Request a class, then join when your teacher accepts.'
        : user?.role === 'teacher' ? 'Answer requests and enter your classrooms.'
        : 'Every request and session on the platform.'}
    >
      <Summary items={[
        { k: 'Upcoming', v: upcoming.length },
        { k: 'Pending requests', v: store.requests.filter((r) => r.status === 'pending').length },
        { k: 'Completed', v: past.filter((s) => s.status === 'completed').length },
        { k: 'Total hours',
          v: `${(sessions.filter((s) => s.status === 'completed').reduce((sum, s) => sum + s.minutes, 0) / 60).toFixed(1)}h` },
      ]} />

      {user?.role === 'student' ? (
        <Card>
          <CardHead title="Request a class">
            <span className="text-[13px] text-ink-3">Your teacher is notified immediately</span>
          </CardHead>
          <form className="flex flex-col gap-3.5 p-[18px]" onSubmit={createRequest}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Teacher">
                <select name="teacherId" required>
                  {teachers.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} — {t.subjects.join(', ')}</option>
                  ))}
                </select>
              </Field>
              <Field label="Subject">
                <select name="subject" defaultValue="math">
                  <option value="math">Math</option><option value="english">English</option>
                </select>
              </Field>
              <Field label="Length">
                <select name="minutes" defaultValue="60">
                  <option value="30">30 minutes</option>
                  <option value="45">45 minutes</option>
                  <option value="60">60 minutes</option>
                  <option value="90">90 minutes</option>
                  <option value="120">2 hours</option>
                  <option value="180">3 hours</option>
                  <option value="240">4 hours</option>
                </select>
              </Field>
              <Field label="Date & time">
                <input name="when" type="datetime-local" required defaultValue={defaultSlot()} />
              </Field>
            </div>
            <Field label="Topic">
              <input name="topic" required placeholder="e.g. Completing the square — homework 4" />
            </Field>
            <Field label="Anything your teacher should prepare?">
              <textarea name="note" rows={2} placeholder="Optional" />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={busy}>Send request</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {user?.role === 'teacher' || user?.role === 'owner' ? (
        <Card>
          <CardHead title="Open a group class">
            <span className="text-[13px] text-ink-3">Students book the seats themselves</span>
          </CardHead>
          <form className="flex flex-col gap-3.5 p-[18px]" onSubmit={openGroupClass} data-testid="open-group">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Subject">
                <select name="subject" defaultValue="math">
                  <option value="math">Math</option><option value="english">English</option>
                </select>
              </Field>
              <Field label="Length">
                <select name="minutes" defaultValue="60">
                  <option value="45">45 minutes</option>
                  <option value="60">60 minutes</option>
                  <option value="90">90 minutes</option>
                  <option value="120">2 hours</option>
                </select>
              </Field>
              <Field label="Seats">
                <input name="capacity" type="number" min={2} max={12} defaultValue={6} required />
              </Field>
              <Field label="Price per seat">
                <input name="seatPrice" type="number" min={0} step="0.5" defaultValue={9} required />
              </Field>
              <Field label="Date & time">
                <input name="when" type="datetime-local" required defaultValue={defaultSlot()} />
              </Field>
            </div>
            <Field label="Title">
              <input name="topic" required placeholder="e.g. Quadratics clinic — group" />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-ink-3">
                Each student is invoiced the seat price, which is why a group is cheaper for them
                than the same hour alone.
              </span>
              <Button type="submit" variant="primary" disabled={busy}>Open the class</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {user?.role === 'student' ? (
        <Card>
          <CardHead title="Open group classes">
            <span className="text-[13px] text-ink-3">No request needed — take a seat</span>
          </CardHead>
          {openClasses.length ? (
            <Table>
              <thead><tr><Th>Class</Th><Th>Teacher</Th><Th>When</Th><Th>Seats</Th><Th>Price</Th><Th /></tr></thead>
              <tbody>
                {openClasses.map((s) => {
                  const taken = Boolean(user && s.studentIds.includes(user.id));
                  return (
                    <tr key={s.id} className="hover:bg-card-2" data-open-class={s.id}>
                      <Td className="font-medium">
                        {s.topic} <SubjectPill subject={s.subject} />
                      </Td>
                      <Td className="text-[13px]">{store.userById(s.teacherId).name}</Td>
                      <Td className="font-mono text-[13px]">{day(s.startsAt)}</Td>
                      <Td className="font-mono text-[13px]" data-seats={s.seatsLeft}>
                        {s.booked} / {s.capacity}
                      </Td>
                      <Td className="font-mono text-[13px]">
                        {s.seatPrice == null ? '—' : money(s.seatPrice)}
                      </Td>
                      <Td>
                        <Button size="sm" variant={taken ? 'default' : 'primary'} disabled={busy}
                          data-book={s.id} onClick={() => void book(s.id, taken)}>
                          {taken ? 'Leave' : 'Book a seat'}
                        </Button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <Empty title="No open classes"
              body="When a teacher opens a group class, it appears here for you to join." />
          )}
        </Card>
      ) : null}

      <Card>
        <CardHead title={user?.role === 'teacher' ? 'Requests from students' : 'Requests'} />
        {store.requests.length ? [...store.requests]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((r) => <RequestRow key={r.id} request={r} as={as === 'teacher' ? 'teacher' : 'student'} />)
          : <Empty title="No requests"
              body={user?.role === 'student' ? 'Use the form above to ask for your first class.'
                : 'Students have not requested anything yet.'} />}
      </Card>

      <div className="grid gap-[18px] lg:grid-cols-2">
        <Card>
          <CardHead title="Upcoming sessions" />
          {upcoming.length ? (
            <div className="px-[18px] py-2">
              {upcoming.map((s) => <TimelineItem key={s.id} session={s} as={as} />)}
            </div>
          ) : <Empty title="Nothing scheduled" body="Accepted requests become sessions." />}
        </Card>

        <Card>
          <CardHead title="History" />
          {past.length ? (
            <Table>
              <thead><tr><Th>Topic</Th><Th>With</Th><Th>When</Th><Th>Status</Th></tr></thead>
              <tbody>
                {past.slice(0, 12).map((s) => (
                  <tr key={s.id} className="hover:bg-card-2">
                    <Td className="font-medium">{s.topic}</Td>
                    <Td className="text-[13px]">
                      {as === 'teacher'
                        ? roomRoster(s, (id) => store.userById(id).name)
                        : store.userById(s.teacherId).name}
                    </Td>
                    <Td className="font-mono text-[13px]">{day(s.startsAt)}</Td>
                    <Td><StatusPill status={s.status} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <Empty title="No history yet" body="Finished classes are listed here." />}
        </Card>
      </div>
    </Shell>
  );
}
