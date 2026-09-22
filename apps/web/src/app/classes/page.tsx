'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { day } from '@/lib/format';
import { Shell } from '@/components/shell';
import { RequestRow, TimelineItem } from '@/components/session-row';
import {
  Button, Card, CardHead, Empty, Field, StatusPill, Summary, Table, Td, Th,
} from '@/components/ui';
import type { Subject } from '@/lib/types';

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
                      {store.userById(as === 'teacher' ? s.studentId : s.teacherId).name}
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
