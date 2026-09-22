'use client';

import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { ago, money } from '@/lib/format';
import { Shell } from '@/components/shell';
import {
  Avatar, Button, Card, CardHead, Empty, Flag, Pill, StatusPill, SubjectPill,
  Summary, Table, Td, Th,
} from '@/components/ui';

export default function PeoplePage() {
  const store = useStore();
  if (store.user && store.user.role !== 'owner') {
    return (
      <Shell title="People">
        <Empty title="Not available for your role" body="Only the administrator manages accounts." />
      </Shell>
    );
  }

  const pendingResets = store.resets.filter((r) => r.status === 'pending');

  return (
    <Shell title="People" subtitle="Approve registrations, manage roles, handle reset requests.">
      <Summary items={[
        { k: 'Teachers', v: store.users.filter((u) => u.role === 'teacher').length },
        { k: 'Students', v: store.users.filter((u) => u.role === 'student').length },
        { k: 'Pending', v: store.users.filter((u) => u.status === 'pending').length, s: 'awaiting approval' },
        { k: 'Reset requests', v: pendingResets.length, s: 'awaiting a link' },
      ]} />

      <Card>
        <CardHead title="All accounts" />
        <Table>
          <thead>
            <tr>
              <Th>Person</Th><Th>Role</Th><Th>Subjects</Th><Th>Timezone</Th>
              <Th className="text-right">Rate</Th><Th>Status</Th><Th />
            </tr>
          </thead>
          <tbody>
            {store.users.map((u) => (
              <tr key={u.id} className="hover:bg-card-2">
                <Td>
                  <div className="flex items-center gap-2.5">
                    <Avatar user={u} />
                    <div>
                      <div className="flex items-center gap-1.5 font-semibold">
                        {u.name}{u.seeded ? <Pill>seeded</Pill> : null}
                      </div>
                      <div className="text-[13px] text-ink-3">{u.email}</div>
                    </div>
                  </div>
                </Td>
                <Td className="capitalize">{u.role}</Td>
                <Td><div className="flex gap-1">{u.subjects.map((s) => <SubjectPill key={s} subject={s} />)}</div></Td>
                <Td className="font-mono text-[13px]">{u.tz}</Td>
                <Td className="text-right font-mono tabular">
                  {u.role === 'teacher' ? `${money(u.hourlyRate ?? 0)}/h` : '—'}
                </Td>
                <Td><StatusPill status={u.status} /></Td>
                <Td className="text-right">
                  {u.seeded ? <span className="text-[13px] text-ink-3">—</span>
                    : u.status === 'pending' ? (
                      <Button size="sm" variant="primary" onClick={() => {
                        void store.run(() => api.approveUser(u.id),
                          { title: 'Approved', body: `${u.name} can sign in now.` });
                      }}>Approve</Button>
                    ) : (
                      <Button size="sm" onClick={() => {
                        void store.run(() => api.setUserStatus(
                          u.id, u.status === 'suspended' ? 'active' : 'suspended'));
                      }}>{u.status === 'suspended' ? 'Reinstate' : 'Suspend'}</Button>
                    )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHead title="Password reset requests" />
        {store.resets.length ? (
          <Table>
            <thead><tr><Th>Person</Th><Th>Requested</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {store.resets.map((r) => (
                <tr key={r.id} className="hover:bg-card-2">
                  <Td>
                    {store.userById(r.userId).name}
                    <div className="text-[13px] text-ink-3">{r.email}</div>
                  </Td>
                  <Td className="font-mono text-[13px]">{ago(r.requestedAt)}</Td>
                  <Td><StatusPill status={r.status} /></Td>
                  <Td className="text-right">
                    {r.status === 'pending' ? (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => {
                          void store.run(() => api.resolveReset(r.id, 'reject'));
                        }}>Reject</Button>
                        <Button size="sm" variant="primary" onClick={() => {
                          void store.run(() => api.resolveReset(r.id, 'approve'),
                            { title: 'Link sent', body: 'The account holder was notified.' });
                        }}>Send link</Button>
                      </div>
                    ) : <span className="text-[13px] text-ink-3">handled</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Empty title="No requests" body="Approving one emails a single-use reset link." />}
      </Card>

      <Flag title="Note">
        Approving a reset sends the email through the server&apos;s mailer. Without one configured it
        marks the request approved and notifies the account holder in-app instead.
      </Flag>
    </Shell>
  );
}
