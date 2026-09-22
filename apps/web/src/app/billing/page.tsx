'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { day, money } from '@/lib/format';
import { Shell } from '@/components/shell';
import {
  Button, Card, CardHead, Empty, Flag, Modal, StatusPill, Summary, Table, Td, Th,
} from '@/components/ui';
import type { Invoice } from '@/lib/types';

export default function BillingPage() {
  const store = useStore();
  const user = store.user;
  const [paying, setPaying] = useState<Invoice | null>(null);

  if (user && user.role === 'teacher') {
    return (
      <Shell title="Billing">
        <Empty title="Not available for your role" body="Billing covers student invoices." />
      </Shell>
    );
  }

  const list = [...store.invoices].sort(
    (a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
  const open = list.filter((i) => i.status === 'open');
  const paid = list.filter((i) => i.status === 'paid');
  const nextDue = [...open].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())[0];

  return (
    <Shell
      title="Billing"
      subtitle={user?.role === 'student' ? 'Invoices for your classes, paid through Stripe.'
        : 'Invoices across all students.'}
    >
      <Summary items={[
        { k: 'Open', v: money(open.reduce((s, i) => s + i.amount, 0)),
          s: `${open.length} invoice${open.length === 1 ? '' : 's'}` },
        { k: 'Paid', v: money(paid.reduce((s, i) => s + i.amount, 0)), s: `${paid.length} settled` },
        { k: 'Next due', v: nextDue ? day(nextDue.dueAt) : '—' },
        { k: 'Currency', v: 'USD', s: 'Stripe, card + wallets' },
      ]} />

      <Card>
        <CardHead title="Invoices" />
        {list.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>{user?.role === 'owner' ? <Th>Student</Th> : null}
                <Th>Lines</Th><Th>Issued</Th><Th>Due</Th>
                <Th className="text-right">Amount</Th><Th>Status</Th><Th />
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} className="hover:bg-card-2">
                  <Td>
                    <div className="font-mono font-semibold">{i.number}</div>
                    <div className="text-[13px] text-ink-3">{i.stripeId}</div>
                  </Td>
                  {user?.role === 'owner' ? <Td className="text-[13px]">{store.userById(i.studentId).name}</Td> : null}
                  <Td className="text-[13px] text-ink-2">
                    {i.lines.map((l) => <div key={l.label}>{l.label}</div>)}
                  </Td>
                  <Td className="font-mono text-[13px]">{day(i.issuedAt)}</Td>
                  <Td className="font-mono text-[13px]">{day(i.dueAt)}</Td>
                  <Td className="text-right font-mono font-semibold tabular">{money(i.amount, i.currency)}</Td>
                  <Td><StatusPill status={i.status} /></Td>
                  <Td className="text-right">
                    {i.status === 'open' && user?.role === 'student' ? (
                      <Button size="sm" variant="primary" onClick={() => setPaying(i)}>Pay</Button>
                    ) : i.status === 'open' && user?.role === 'owner' ? (
                      <Button size="sm" onClick={() => {
                        void store.run(() => api.remindInvoice(i.id),
                          { title: 'Reminder sent', body: `${store.userById(i.studentId).name} was notified.` });
                      }}>Remind</Button>
                    ) : <span className="text-[13px] text-ink-3">—</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Empty title="No invoices" body="Invoices are raised after your classes are delivered." />}
      </Card>

      <Flag title="Stripe decides what happens next">
        With <span className="font-mono">STRIPE_SECRET_KEY</span> set, paying creates a real
        PaymentIntent and the invoice is marked paid only when the{' '}
        <span className="font-mono">payment_intent.succeeded</span> webhook arrives — never by the
        browser. Without it the server says so rather than pretending.
      </Flag>

      {paying ? (
        <Modal
          title={`Pay ${paying.number}`} onClose={() => setPaying(null)}
          footer={
            <Button variant="primary" onClick={() => {
              const invoice = paying;
              setPaying(null);
              void api.payInvoice(invoice.id).then((result) => {
                if (result.mode === 'unconfigured') {
                  store.toast('warn', 'Stripe is not configured', result.message);
                } else {
                  store.toast('ok', 'Payment started',
                    'A PaymentIntent was created. Stripe Elements collects the card next.');
                }
                void store.refresh();
              }).catch((err) => store.toast('err', 'Payment could not start', (err as Error).message));
            }}>Start payment</Button>
          }
        >
          <div className="flex flex-col gap-2 rounded-md border border-line bg-card-2 p-3.5">
            {paying.lines.map((l) => (
              <div key={l.label} className="flex justify-between">
                <span className="text-ink-2">{l.label}</span>
                <span className="font-mono">{money(l.amount, paying.currency)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-line pt-2.5 font-semibold">
              <span>Total</span><span className="font-mono">{money(paying.amount, paying.currency)}</span>
            </div>
          </div>
        </Modal>
      ) : null}
    </Shell>
  );
}
