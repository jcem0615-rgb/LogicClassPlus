'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { ago, day, money } from '@/lib/format';
import { Shell } from '@/components/shell';
import {
  Avatar, Button, Card, CardHead, Empty, StatusPill, Summary, Table, Td, Th,
} from '@/components/ui';
import type { PayrollLine } from '@/lib/types';

export default function PayrollPage() {
  const store = useStore();
  const user = store.user;
  const [lines, setLines] = useState<PayrollLine[]>([]);
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user || user.role === 'student') return;
    void api.payrollPreview()
      .then((r) => { setLines(r.lines); setPeriod({ from: r.from, to: r.to }); })
      .catch(() => undefined);
  }, [user, store.payroll.length]);

  if (user && user.role === 'student') {
    return (
      <Shell title="Payroll">
        <Empty title="Not available for your role" body="Payroll covers teacher earnings." />
      </Shell>
    );
  }

  const gross = lines.reduce((s, l) => s + l.gross, 0);
  const deductions = lines.reduce((s, l) => s + l.deductions, 0);
  const net = lines.reduce((s, l) => s + l.net, 0);
  const minutes = lines.reduce((s, l) => s + l.minutes, 0);

  return (
    <Shell
      title="Payroll"
      subtitle={user?.role === 'owner' ? 'Generate a batch from clock-in records.' : 'What you have earned, and why.'}
    >
      <Summary items={[
        { k: 'Period', v: '30d', s: period ? `${day(period.from)} → ${day(period.to)}` : '' },
        { k: 'Taught', v: `${(minutes / 60).toFixed(1)}h`, s: `${lines.reduce((s, l) => s + l.sessions, 0)} sessions` },
        { k: 'Gross', v: money(gross) },
        { k: 'Deductions', v: deductions > 0 ? `−${money(deductions)}` : money(0), s: 'lateness + no-shows' },
        { k: 'Net payable', v: money(net) },
      ]} />

      <Card>
        <CardHead title={user?.role === 'owner' ? 'Batch preview — all active teachers' : 'Your earnings'} />
        <Table>
          <thead>
            <tr>
              <Th>Teacher</Th><Th className="text-right">Sessions</Th><Th className="text-right">Minutes</Th>
              <Th className="text-right">Late</Th><Th className="text-right">No-shows</Th>
              <Th className="text-right">Gross</Th><Th className="text-right">Deductions</Th><Th className="text-right">Net</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const teacher = store.userById(l.teacherId);
              return (
                <tr key={l.teacherId} className="hover:bg-card-2">
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar user={teacher} />
                      <div>
                        <div className="font-semibold">{teacher.name}</div>
                        <div className="font-mono text-[13px] text-ink-3">{money(teacher.hourlyRate ?? 0)}/h</div>
                      </div>
                    </div>
                  </Td>
                  <Td className="text-right font-mono tabular">{l.sessions}</Td>
                  <Td className="text-right font-mono tabular">{l.minutes}</Td>
                  <Td className="text-right font-mono tabular">{l.lateMinutes} min</Td>
                  <Td className="text-right font-mono tabular">{l.noShows}</Td>
                  <Td className="text-right font-mono tabular">{money(l.gross)}</Td>
                  <Td className={`text-right font-mono tabular ${l.deductions > 0 ? 'text-crit' : 'text-ink-3'}`}>
                    {l.deductions > 0 ? `−${money(l.deductions)}` : '—'}
                  </Td>
                  <Td className="text-right font-mono font-semibold tabular">{money(l.net)}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {user?.role === 'owner' ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-md border-t border-line bg-card-2 px-[18px] py-3">
            <span className="text-[13px] text-ink-3">
              Generating a batch locks these figures and notifies each teacher.
            </span>
            <Button variant="primary" disabled={busy} onClick={() => {
              setBusy(true);
              void store.run(() => api.runPayroll(), { title: 'Batch generated', body: 'Teachers were notified.' })
                .finally(() => setBusy(false));
            }}>Generate batch</Button>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHead title="Batch history" />
        {store.payroll.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Period</Th><Th>Created</Th><Th className="text-right">Teachers</Th>
                <Th className="text-right">Net</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {store.payroll.map((b) => (
                <tr key={b.id} className="hover:bg-card-2">
                  <Td className="font-mono text-[13px]">{day(b.periodStart)} → {day(b.periodEnd)}</Td>
                  <Td className="font-mono text-[13px] text-ink-3">{ago(b.createdAt)}</Td>
                  <Td className="text-right font-mono tabular">{b.lines.length}</Td>
                  <Td className="text-right font-mono tabular">
                    {money(b.lines.reduce((s, l) => s + l.net, 0))}
                  </Td>
                  <Td><StatusPill status={b.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Empty title="No batches yet" body="Generate the first one above." />}
      </Card>
    </Shell>
  );
}
