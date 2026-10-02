'use client';

/**
 * The administrator's portal: everything only the Owner can do, in one place.
 *
 * Approvals first, because an unapproved teacher cannot work; then the roster
 * with the fields the Owner actually changes — pay rate above all, since
 * payroll multiplies it by every minute taught; then the reset queue.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { ago, day, money, time } from '@/lib/format';
import { Shell } from '@/components/shell';
import {
  Avatar, Button, Card, CardHead, Empty, Field, Flag, Modal, Pill, StatusPill,
  SubjectPill, Summary, Table, Td, Th,
} from '@/components/ui';
import type { Invitation, Subject, User } from '@/lib/types';

/** Midnight this morning, in the viewer's own timezone. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export default function AdminPage() {
  const store = useStore();
  const [editing, setEditing] = useState<User | null>(null);
  const [linking, setLinking] = useState<User | null>(null);
  const [childrenOf, setChildrenOf] = useState<Record<string, User[]>>({});

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

      <ClassMonitor />

      <InviteCard />

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
        <CardHead title="Parents and their students" />
        {store.users.filter((u) => u.role === 'parent').length ? (
          store.users.filter((u) => u.role === 'parent').map((p) => {
            const linked = childrenOf[p.id];
            return (
              <div key={p.id} data-parent={p.email}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[18px] py-3.5 last:border-0">
                <div className="flex items-center gap-2.5">
                  <Avatar user={p} />
                  <div>
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-[13px] text-ink-3">
                      {linked === undefined
                        ? p.email
                        : linked.length
                          ? `Linked to ${linked.map((c) => c.name).join(', ')}`
                          : 'No students linked yet'}
                    </div>
                  </div>
                </div>
                <Button size="sm" data-link={p.email} onClick={() => setLinking(p)}>
                  Assign students
                </Button>
              </div>
            );
          })
        ) : (
          <Empty title="No parent accounts"
            body="Parents register like anyone else, then you approve them and attach their children here." />
        )}
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

      {linking ? (
        <AssignStudents
          parent={linking}
          students={store.users.filter((u) => u.role === 'student')}
          onClose={() => setLinking(null)}
          onLoaded={(list) => setChildrenOf((m) => ({ ...m, [linking.id]: list }))}
        />
      ) : null}

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

/**
 * Every class on the platform, and what actually happened in it.
 *
 * The Owner could see a count of sessions and nothing else: not who taught
 * which one, not who sat in it, not whether it started when it was meant to
 * or ran over. Those are the questions asked when a parent complains, when
 * payroll looks wrong, or when someone wants to know whether a class
 * happened at all — so they are the columns.
 */
function ClassMonitor() {
  const store = useStore();
  const [when, setWhen] = useState<'today' | 'week' | 'all'>('week');
  const [who, setWho] = useState('');

  const since = when === 'today' ? startOfToday()
    : when === 'week' ? Date.now() - 7 * 86_400_000
      : 0;

  const rows = [...store.sessions]
    .filter((s) => new Date(s.startsAt).getTime() >= since)
    .filter((s) => {
      if (!who) return true;
      const names = [store.userById(s.teacherId).name, ...s.studentIds.map((id) => store.userById(id).name)];
      return names.some((n) => n.toLowerCase().includes(who.toLowerCase()))
        || s.topic.toLowerCase().includes(who.toLowerCase());
    })
    .sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());

  const live = rows.filter((s) => s.status === 'live');
  const taught = rows.filter((s) => s.status === 'completed');
  const missed = rows.filter((s) => s.status === 'no_show');

  return (
    <Card>
      <CardHead title="Classes">
        <span className="text-[13px] text-ink-3">
          {live.length ? `${live.length} in progress · ` : ''}
          {taught.length} finished · {missed.length} missed
        </span>
      </CardHead>

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-[18px] py-3">
        {([['today', 'Today'], ['week', 'Last 7 days'], ['all', 'Everything']] as const).map(([id, label]) => (
          <Button key={id} size="sm" variant={when === id ? 'primary' : 'default'}
            data-range={id} onClick={() => setWhen(id)}>{label}</Button>
        ))}
        <input
          value={who} onChange={(e) => setWho(e.target.value)} id="class-search"
          placeholder="Filter by teacher, student or topic"
          className="ml-auto w-[260px] max-w-full"
        />
      </div>

      {rows.length ? (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th><Th>Started</Th><Th>Ended</Th><Th>Length</Th>
              <Th>Teacher</Th><Th>Students</Th><Th>Class</Th><Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 60).map((s) => {
              const started = s.joinedAt ? new Date(s.joinedAt) : null;
              const ended = s.endedAt ? new Date(s.endedAt) : null;
              const ran = started && ended
                ? Math.round((ended.getTime() - started.getTime()) / 60000)
                : null;
              const lateBy = started
                ? Math.round((started.getTime() - new Date(s.startsAt).getTime()) / 60000)
                : null;
              return (
                <tr key={s.id} className="hover:bg-card-2" data-class-row={s.id}>
                  <Td className="font-mono text-[13px]">{day(s.startsAt)}</Td>
                  <Td className="font-mono text-[13px]">
                    {started ? time(started.toISOString()) : <span className="text-ink-3">—</span>}
                    {/* Scheduled against actual: a class that began late is
                        the thing an attendance dispute turns on. */}
                    {lateBy != null && lateBy > 2 ? (
                      <span className="block text-[11px] text-warn">{lateBy} min late</span>
                    ) : null}
                  </Td>
                  <Td className="font-mono text-[13px]">
                    {ended ? time(ended.toISOString())
                      : s.status === 'live' ? <span className="text-ok">in progress</span>
                        : <span className="text-ink-3">—</span>}
                  </Td>
                  <Td className="font-mono text-[13px]">
                    {ran != null ? `${ran} min` : `${s.minutes} min booked`}
                  </Td>
                  <Td className="text-[13px]">{store.userById(s.teacherId).name}</Td>
                  <Td className="text-[13px]">
                    {s.studentIds.length
                      ? s.studentIds.map((id) => store.userById(id).name).join(', ')
                      : <span className="text-ink-3">nobody booked</span>}
                    {s.capacity > 1 ? (
                      <span className="block text-[11px] text-ink-3">
                        group · {s.booked} of {s.capacity} seats
                        {s.attendedIds.length ? ` · ${s.attendedIds.length} turned up` : ''}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-[13px]">{s.topic}</Td>
                  <Td><StatusPill status={s.status} /></Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <Empty title="No classes in that range"
          body="Widen the range, or clear the filter." />
      )}
    </Card>
  );
}

/**
 * Inviting people in.
 *
 * This is how an account comes to exist: there is no sign-up form any more,
 * so the roster only ever contains people the Owner decided to let in. The
 * link is shown once, right after it is made — the server keeps only a hash
 * of it, so it cannot be shown again and a copy of the database is not a
 * pile of working invitations.
 */
function InviteCard() {
  const store = useStore();
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [fresh, setFresh] = useState<{ link: string; role: string; email: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<'teacher' | 'student' | 'parent'>('teacher');

  const load = useCallback(async () => {
    try { setInvites((await api.invitations()).invitations); } catch { /* shown empty */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    const made = await store.run(() => api.createInvitation({
      role,
      email: String(data.get('email') || '').trim() || undefined,
      subjects: role === 'parent' ? [] : [data.get('subject') as Subject],
      ...(role === 'teacher' && data.get('rate')
        ? { hourlyRate: Number(String(data.get('rate')).replace(',', '.')) } : {}),
      ...(role === 'student' && data.get('grade')
        ? { gradeLevel: String(data.get('grade')) } : {}),
      note: String(data.get('note') || '').trim() || undefined,
      expiresInDays: Number(data.get('days') || 14),
    }));
    if (made) {
      setFresh({
        link: `${window.location.origin}/join/${made.token}`,
        role,
        email: made.invitation.email,
      });
      form.reset();
      await load();
    }
    setBusy(false);
  }

  const open = invites.filter((i) => i.state === 'open');

  return (
    <Card>
      <CardHead title="Invite people">
        <span className="text-[13px] text-ink-3">
          {open.length} link{open.length === 1 ? '' : 's'} outstanding
        </span>
      </CardHead>

      <form className="flex flex-col gap-3.5 p-[18px]" onSubmit={create} data-testid="invite-form">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="They will be a">
            <select name="role" value={role} data-testid="invite-role"
              onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="teacher">Teacher</option>
              <option value="student">Student</option>
              <option value="parent">Parent or guardian</option>
            </select>
          </Field>
          <Field label="Email (optional)">
            <input name="email" type="email" placeholder="locks the link to one person" />
          </Field>
          {role === 'parent' ? null : (
            <Field label="Subject">
              <select name="subject" defaultValue="math">
                <option value="math">Math</option><option value="english">English</option>
              </select>
            </Field>
          )}
          {role === 'teacher' ? (
            <Field label="Pay rate per hour">
              <input name="rate" inputMode="decimal" placeholder="e.g. 26" />
            </Field>
          ) : null}
          {role === 'student' ? (
            <Field label="Grade level">
              <input name="grade" placeholder="e.g. Year 9" />
            </Field>
          ) : null}
          <Field label="Link valid for">
            <select name="days" defaultValue="14">
              <option value="2">2 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </Field>
        </div>
        <Field label="Note for them (optional)">
          <input name="note" placeholder="e.g. Looking forward to having you with the Year 10 group" />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-3">
            Whoever opens the link sets their own password and is active immediately — inviting
            them is the approval.
          </span>
          <Button type="submit" variant="primary" disabled={busy}>Create invitation</Button>
        </div>
      </form>

      {fresh ? (
        <div className="mx-[18px] mb-[18px] flex flex-col gap-2 rounded-sm border border-line bg-warn-soft p-3.5"
          data-testid="fresh-invite">
          <div className="text-[13px]">
            Send this to your new {fresh.role}{fresh.email ? ` at ${fresh.email}` : ''}. It is shown
            once — the server keeps only a hash of it, so this is the only time it can be read.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input readOnly value={fresh.link} id="invite-link"
              className="min-w-0 flex-1 font-mono text-[12.5px]"
              onFocus={(e) => e.currentTarget.select()} />
            <Button size="sm" onClick={() => {
              void navigator.clipboard?.writeText(fresh.link)
                .then(() => store.toast('ok', 'Link copied', 'Paste it into an email or a message.'))
                .catch(() => store.toast('warn', 'Could not copy', 'Select the link and copy it.'));
            }}>Copy</Button>
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>Done</Button>
          </div>
        </div>
      ) : null}

      {invites.length ? (
        <Table>
          <thead>
            <tr><Th>For</Th><Th>Role</Th><Th>Sent</Th><Th>Expires</Th><Th>State</Th><Th /></tr>
          </thead>
          <tbody>
            {invites.slice(0, 12).map((i) => (
              <tr key={i.id} className="hover:bg-card-2" data-invite={i.id}>
                <Td className="text-[13px]">{i.email ?? <span className="text-ink-3">anyone with the link</span>}</Td>
                <Td><Pill>{i.role}</Pill></Td>
                <Td className="font-mono text-[13px]">{ago(i.createdAt)}</Td>
                <Td className="font-mono text-[13px]">{day(i.expiresAt)}</Td>
                <Td>
                  <Pill tone={i.state === 'open' ? 'ok' : i.state === 'accepted' ? 'neutral' : 'crit'}>
                    {i.state === 'accepted' && i.acceptedBy ? `used by ${i.acceptedBy}` : i.state}
                  </Pill>
                </Td>
                <Td>
                  {i.state === 'open' ? (
                    <Button size="sm" variant="danger" data-revoke={i.id} onClick={() => {
                      void store.run(() => api.revokeInvitation(i.id),
                        { title: 'Invitation withdrawn', body: 'That link no longer works.' })
                        .then(load);
                    }}>Withdraw</Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
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
  const [rateError, setRateError] = useState('');

  const isTeacher = user.role === 'teacher';
  const toggle = (s: Subject) =>
    setSubjects((all) => (all.includes(s) ? all.filter((x) => x !== s) : [...all, s]));

  /**
   * A rate as typed. Half the world writes 26,50 and a `type=number` input
   * discards it silently — the field simply empties and the save goes through
   * without the rate, which looks exactly like "I cannot edit this".
   */
  const parseRate = (raw: string): number | null => {
    const cleaned = raw.trim().replace(',', '.').replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
  };

  function save() {
    const trimmed = rate.trim();
    let hourlyRate: number | undefined;
    if (isTeacher && trimmed !== '') {
      const parsed = parseRate(trimmed);
      if (parsed === null || parsed < 0 || parsed > 1000) {
        setRateError('Enter a rate between 0 and 1000, like 26 or 26.50.');
        return;
      }
      hourlyRate = parsed;
    }
    setRateError('');
    onSave({
      name: name.trim(),
      subjects,
      ...(hourlyRate === undefined ? {} : { hourlyRate }),
      ...(user.role === 'student' ? { gradeLevel: grade.trim() || null } : {}),
    });
  }

  return (
    <Modal
      title={`Edit ${user.name}`}
      onClose={onClose}
      // Half-typed values live in here; a missed click should not bin them.
      dismissOnBackdrop={false}
      footer={
        <Button variant="primary" data-save-account onClick={save}>Save changes</Button>
      }
    >
      <Field label="Full name">
        <input value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
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
          {/* Text rather than number: a number input rejects a comma decimal
              by blanking itself, swallows a stray scroll over the field, and
              gives no way to say what is wrong with what was typed. */}
          <input
            id="rate-input" type="text" inputMode="decimal" value={rate}
            onChange={(e) => { setRate(e.target.value); setRateError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
            placeholder="e.g. 26 or 26.50" aria-invalid={rateError ? true : undefined}
          />
          {rateError
            ? <span className="text-[13px] text-crit" data-testid="rate-error">{rateError}</span>
            : null}
        </Field>
      ) : null}

      {user.role === 'student' ? (
        <Field label="Grade level">
          <input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="e.g. Year 9" />
        </Field>
      ) : null}

      <p className="text-[13px] text-ink-3">
        {isTeacher
          ? 'Press Enter or Save changes to apply it. Payroll multiplies this rate by the minutes '
            + 'actually taught, so a change applies to batches generated from now on — figures '
            + 'already frozen in an approved batch do not move. Leaving the box empty keeps the '
            + 'current rate.'
          : 'Role and account status are changed from the table, not here.'}
      </p>
    </Modal>
  );
}

/**
 * Attaching students to a parent.
 *
 * The link is read back from the server after every change rather than
 * guessed at locally — this is an access-control edge, and the only version
 * worth showing the Owner is the one the server actually stored.
 */
function AssignStudents({ parent, students, onClose, onLoaded }: {
  parent: User;
  students: User[];
  onClose: () => void;
  onLoaded: (children: User[]) => void;
}) {
  const store = useStore();
  const [linked, setLinked] = useState<User[] | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let alive = true;
    void api.childrenOfParent(parent.id)
      .then((r) => { if (alive) { setLinked(r.children); onLoaded(r.children); } })
      .catch(() => { if (alive) setLinked([]); });
    return () => { alive = false; };
  }, [parent.id, onLoaded]);

  const apply = async (studentId: string, attach: boolean) => {
    setBusy(studentId);
    const result = await store.run(() => (attach
      ? api.linkChild(parent.id, studentId)
      : api.unlinkChild(parent.id, studentId)));
    if (result) { setLinked(result.children); onLoaded(result.children); }
    setBusy('');
  };

  return (
    <Modal title={`Students for ${parent.name}`} onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {linked === null ? <p className="text-[13px] text-ink-3">Loading…</p> : null}
      {linked !== null && !students.length
        ? <p className="text-[13px] text-ink-3">There are no student accounts yet.</p>
        : null}
      {linked !== null ? students.map((child) => {
        const on = linked.some((c) => c.id === child.id);
        return (
          <div key={child.id}
            className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-0">
            <div>
              <div className="font-semibold">{child.name}</div>
              <div className="text-[13px] text-ink-3">{child.email}</div>
            </div>
            <Button size="sm" variant={on ? 'primary' : 'default'} disabled={busy === child.id}
              data-child={child.email}
              onClick={() => void apply(child.id, !on)}>
              {busy === child.id ? '…' : on ? 'Linked' : 'Link'}
            </Button>
          </div>
        );
      }) : null}
      <p className="mt-2 text-[13px] text-ink-3">
        A linked parent can see that student&apos;s classes and invoices. They cannot join a
        classroom, book a class, or see anything belonging to another family.
      </p>
    </Modal>
  );
}
