'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { dayTime, duration, money, time } from '@/lib/format';
import { Shell } from '@/components/shell';
import { Button, Card, CardHead, Empty, Flag, Pill, Summary, Table, Td, Th } from '@/components/ui';

export default function AttendancePage() {
  const store = useStore();
  const user = store.user;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (user && user.role === 'student') {
    return (
      <Shell title="Attendance">
        <Empty title="Not available for your role" body="Attendance covers teacher clock-ins." />
      </Shell>
    );
  }

  const rows = [...store.attendance].sort(
    (a, b) => new Date(b.scheduledStart).getTime() - new Date(a.scheduledStart).getTime());
  const late = rows.filter((a) => !a.noShow && (a.minutesLate ?? 0) > store.policy.graceMinutes).length;
  const noShows = rows.filter((a) => a.noShow).length;
  const onTimePct = rows.length ? Math.round(((rows.length - late - noShows) / rows.length) * 100) : 100;

  const openRecord = rows.find((a) => a.clockIn && !a.clockOut);
  const next = store.sessions
    .filter((s) => s.status === 'scheduled' || s.status === 'live')
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];

  return (
    <Shell
      title="Attendance"
      subtitle={user?.role === 'owner' ? 'Clock-in records for every teacher.'
        : `Your clock-in record. ${store.policy.graceMinutes}-minute grace, then a deduction applies.`}
    >
      <Summary items={[
        { k: 'Records', v: rows.length },
        { k: 'On time', v: `${onTimePct}%`, s: 'within the grace window' },
        { k: 'Late arrivals', v: late, s: 'deduction applied' },
        { k: 'No-shows', v: noShows, s: 'full fee forfeited' },
      ]} />

      {user?.role === 'teacher' ? (
        <Card>
          <CardHead title="Clock in / out">
            <span className="font-mono text-[13px] text-ink-3">{time(now)}</span>
          </CardHead>
          <div className="p-[18px]">
            {openRecord ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">Clocked in at {time(openRecord.clockIn!)}</div>
                  <div className="text-[13px] text-ink-3">
                    Running for <span className="font-mono">
                      {duration(now - new Date(openRecord.clockIn!).getTime())}
                    </span>
                  </div>
                </div>
                <Button variant="primary" onClick={() => {
                  void store.run(() => api.clockOut(openRecord.id),
                    { title: 'Clocked out', body: 'This session is closed for payroll.' });
                }}>Clock out</Button>
              </div>
            ) : next ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">{next.topic}</div>
                  <div className="text-[13px] text-ink-3">
                    Scheduled {dayTime(next.startsAt)} · with {store.userById(next.studentId).name}
                  </div>
                </div>
                <Button variant="primary" onClick={() => {
                  void store.run(async () => {
                    const result = await api.clockIn(next.id);
                    const over = Math.max(0, (result.attendance.minutesLate ?? 0) - result.graceMinutes);
                    store.toast(over > 0 ? 'warn' : 'ok', 'Clocked in', over > 0
                      ? `${result.attendance.minutesLate} minutes late — ${money(result.attendance.deduction)} deducted.`
                      : `On time, inside the ${result.graceMinutes}-minute grace window.`);
                    return result;
                  });
                }}>Clock in now</Button>
              </div>
            ) : (
              <Empty title="Nothing to clock into" body="Clock-in unlocks when you have a scheduled session." />
            )}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHead title="Record" />
        {rows.length ? (
          <Table>
            <thead>
              <tr>
                {user?.role === 'owner' ? <Th>Teacher</Th> : null}
                <Th>Session</Th><Th>Scheduled</Th><Th>Clock in</Th><Th>Clock out</Th>
                <Th className="text-right">Late</Th><Th className="text-right">Deduction</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="hover:bg-card-2">
                  {user?.role === 'owner' ? <Td className="text-[13px]">{store.userById(a.teacherId).name}</Td> : null}
                  <Td className="font-medium">{a.topic ?? '—'}</Td>
                  <Td className="font-mono text-[13px]">{dayTime(a.scheduledStart)}</Td>
                  <Td className="font-mono text-[13px]">
                    {a.clockIn ? time(a.clockIn) : <Pill tone="crit">missed</Pill>}
                  </Td>
                  <Td className="font-mono text-[13px]">{a.clockOut ? time(a.clockOut) : '—'}</Td>
                  <Td className="text-right font-mono tabular">
                    {a.noShow ? '—' : `${a.minutesLate ?? 0} min`}
                  </Td>
                  <Td className={`text-right font-mono tabular ${a.deduction > 0 ? 'text-crit' : 'text-ink-3'}`}>
                    {a.deduction > 0 ? `−${money(a.deduction)}` : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Empty title="No records" body="Clock-in records appear here after your first session." />}
      </Card>

      <Flag tone="info" title="How a deduction is worked out">
        <div className="mt-1.5 font-mono text-[13px]">
          late_minutes = clock_in − scheduled_start<br />
          billable_late = max(0, late_minutes − {store.policy.graceMinutes})<br />
          deduction = billable_late × (hourly_rate ÷ 60) × {store.policy.latePenalty}<br />
          no_show → deduction = session_minutes × (hourly_rate ÷ 60)
        </div>
      </Flag>
    </Shell>
  );
}
