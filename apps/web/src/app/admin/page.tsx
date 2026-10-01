'use client';

/**
 * The administrator's portal: everything only the Owner can do, in one place.
 *
 * Approvals first, because an unapproved teacher cannot work; then the roster
 * with the fields the Owner actually changes — pay rate above all, since
 * payroll multiplies it by every minute taught; then the reset queue.
 */
import { useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { ago, money } from '@/lib/format';
import { Shell } from '@/components/shell';
import {
  Avatar, Button, Card, CardHead, Empty, Field, Flag, Modal, Pill, StatusPill,
  SubjectPill, Summary, Table, Td, Th,
} from '@/components/ui';
import type { Subject, User } from '@/lib/types';

export default function AdminPage() {
  const store = useStore();
  const [editing, setEditing] = useState<User | null>(null);

  if (store.user && store.user.role !== 'owner') {
    return (
      <Shell title="Admin">
        <Empty title="Not available for your role" body="Only the administrator manages accounts." />
      </Shell>
    );
  }

  const pendingResets = store.resets.filter((r) => r.status === 'pending');
  const awaiting = store.users.filter((u) => u.status === 'pending');
  const teachers = store.users.filter((u) => u.role === 'teacher');
  const rated = teachers.filter((t) => (t.hourlyRate ?? 0) > 0);
  const averageRate = rated.length
    ? rated.reduce((sum, t) => sum + (t.hourlyRate ?? 0), 0) / rated.length
    : 0;

  return (
    <Shell title="Admin" subtitle="Approvals, accounts, pay rates and reset requests.">
      <Summary items={[
        { k: 'Awaiting approval', v: awaiting.length, s: awaiting.length ? 'cannot sign in yet' : 'all clear' },
        { k: 'Teachers', v: teachers.length, s: `${rated.length} with a rate set` },
        { k: 'Students', v: store.users.filter((u) => u.role === 'student').length },
        { k: 'Average rate', v: rated.length ? `${money(averageRate)}/h` : '—', s: 'across rated teachers' },
      ]} />

      {awaiting.length ? (
        <Card>
          <CardHead title={`Waiting for approval · ${awaiting.length}`} />
          {awaiting.map((u) => (
            <div key={u.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[18px] py-3.5 last:border-0">
              <div className="flex items-center gap-2.5">
                <Avatar user={u} />
                <div>
                  <div className="font-semibold">{u.name}</div>
                  <div className="text-[13px] text-ink-3">{u.email} · {u.role}</div>
                </div>
              </div>
              <Button size="sm" variant="primary" data-approve={u.email} onClick={() => {
                void store.run(() => api.approveUser(u.id),
                  { title: 'Approved', body: `${u.name} can sign in now.` });
              }}>Approve</Button>
            </div>
          ))}
        </Card>
      ) : null}

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
                <Td data-rate={u.email} className="text-right font-mono tabular">
                  {u.role === 'teacher'
                    ? (u.hourlyRate ? `${money(u.hourlyRate)}/h` : <span className="text-crit">not set</span>)
                    : '—'}
                </Td>
                <Td><StatusPill status={u.status} /></Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" data-edit={u.email} onClick={() => setEditing(u)}>Edit</Button>
                    {u.seeded ? null
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
                  </div>
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

      {editing ? (
        <EditAccount
          user={editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await store.run(() => api.updateUser(editing.id, input),
              { title: 'Account updated', body: `${editing.name}'s record was changed.` });
            setEditing(null);
          }}
        />
      ) : null}
    </Shell>
  );
}

function EditAccount({ user, onClose, onSave }: {
  user: User;
  onClose: () => void;
  onSave: (input: { name: string; subjects: Subject[]; hourlyRate?: number; gradeLevel?: string | null }) => void;
}) {
  const [name, setName] = useState(user.name);
  const [subjects, setSubjects] = useState<Subject[]>(user.subjects);
  const [rate, setRate] = useState(String(user.hourlyRate ?? ''));
  const [grade, setGrade] = useState(user.gradeLevel ?? '');

  const isTeacher = user.role === 'teacher';
  const toggle = (s: Subject) =>
    setSubjects((all) => (all.includes(s) ? all.filter((x) => x !== s) : [...all, s]));

  return (
    <Modal
      title={`Edit ${user.name}`}
      onClose={onClose}
      footer={
        <Button variant="primary" data-save-account onClick={() => onSave({
          name: name.trim(),
          subjects,
          ...(isTeacher && rate !== '' ? { hourlyRate: Number(rate) } : {}),
          ...(user.role === 'student' ? { gradeLevel: grade.trim() || null } : {}),
        })}>Save changes</Button>
      }
    >
      <Field label="Full name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Subjects">
        <div className="flex gap-1.5">
          {(['math', 'english'] as const).map((s) => (
            <Button key={s} size="sm" variant={subjects.includes(s) ? 'primary' : 'default'}
              onClick={() => toggle(s)}>{s === 'math' ? 'Math' : 'English'}</Button>
          ))}
        </div>
      </Field>

      {isTeacher ? (
        <Field label="Pay rate per hour">
          <input
            id="rate-input" type="number" min={0} max={1000} step="0.5" value={rate}
            onChange={(e) => setRate(e.target.value)} placeholder="e.g. 24"
          />
        </Field>
      ) : null}

      {user.role === 'student' ? (
        <Field label="Grade level">
          <input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="e.g. Year 9" />
        </Field>
      ) : null}

      <p className="text-[13px] text-ink-3">
        {isTeacher
          ? 'Payroll multiplies this rate by the minutes actually taught, so a change applies to batches generated from now on — figures already frozen in an approved batch do not move.'
          : 'Role and account status are changed from the table, not here.'}
      </p>
    </Modal>
  );
}
