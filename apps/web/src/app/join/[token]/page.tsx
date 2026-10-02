'use client';

/**
 * Accepting an invitation.
 *
 * The only way to create an account. What kind of account it is was decided
 * by the Owner when they sent the link, so this page tells you rather than
 * asks you — there is no role picker to be wrong about, and nothing here
 * creates an account that somebody did not mean to create.
 */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Button, Field, Flag } from '@/components/ui';

type Invite = Awaited<ReturnType<typeof api.invitation>>;

const ROLE_WORDS: Record<string, { title: string; blurb: string }> = {
  teacher: {
    title: 'Teaching invitation',
    blurb: 'You have been invited to teach on LogicClass+. Your classes, library and payroll are '
      + 'waiting once you set a password.',
  },
  student: {
    title: 'Student invitation',
    blurb: 'You have been invited to learn on LogicClass+. Set a password and you can request a '
      + 'class or take a seat in an open one.',
  },
  parent: {
    title: 'Parent invitation',
    blurb: 'You have been invited to follow a student on LogicClass+. The administrator links '
      + 'your children to the account once it exists.',
  },
};

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';
  const router = useRouter();
  const store = useStore();

  const [invite, setInvite] = useState<Invite | null>(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    void api.invitation(token)
      .then(setInvite)
      .catch((err: Error) => setFailed(err.message));
  }, [token]);

  async function accept(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setError(''); setBusy(true);
    try {
      await api.register({
        token,
        name: String(data.get('name')),
        email: String(data.get('email')),
        password: String(data.get('password')),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(invite?.role === 'student' ? { gradeLevel: String(data.get('grade') || '') } : {}),
      });
      // Invited accounts are already approved, so the next step is simply
      // being signed in.
      await store.signIn(String(data.get('email')), String(data.get('password')));
      router.replace('/dashboard');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const words = ROLE_WORDS[invite?.role ?? 'student']!;

  return (
    <div className="grid min-h-full place-items-center px-6 py-10">
      <div className="flex w-[min(460px,100%)] flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-brand font-display text-[15px] font-bold text-on-brand">L</span>
          <span className="font-display text-[17px] font-semibold tracking-tight">
            LogicClass<b className="font-semibold text-brand">+</b>
          </span>
        </div>

        {failed ? (
          <Flag title="This link does not work">
            {failed} Ask the administrator for a new invitation.
          </Flag>
        ) : !invite ? (
          <p className="font-mono text-[13px] text-ink-3">Checking the invitation…</p>
        ) : invite.state !== 'open' ? (
          <Flag title={
            invite.state === 'accepted' ? 'This invitation has already been used'
              : invite.state === 'expired' ? 'This invitation has expired'
                : 'This invitation was withdrawn'
          } data-testid="invite-closed">
            Ask the administrator for a new one.
          </Flag>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={accept} data-testid="join-form">
            <div>
              <h1 className="text-[22px]">{words.title}</h1>
              <p className="mt-1 text-[13.5px] text-ink-2">{words.blurb}</p>
              {invite.note ? (
                <p className="mt-2 rounded-sm border border-line bg-card-2 px-3 py-2 text-[13px]">
                  “{invite.note}”
                </p>
              ) : null}
            </div>

            <Field label="Full name">
              <input name="name" required placeholder="Your name" />
            </Field>
            <Field label="Email">
              <input
                name="email" type="email" required autoComplete="username"
                defaultValue={invite.email ?? ''}
                readOnly={Boolean(invite.email)}
                placeholder="you@school.com"
              />
            </Field>
            {invite.email ? (
              <p className="-mt-2 text-[13px] text-ink-3">
                This invitation is addressed to {invite.email}.
              </p>
            ) : null}
            <Field label="Choose a password">
              <input name="password" type="password" required autoComplete="new-password"
                placeholder="At least 8 characters" />
            </Field>
            {invite.role === 'student' ? (
              <Field label="Grade level">
                <input name="grade" defaultValue={invite.gradeLevel ?? ''} placeholder="e.g. Year 9" />
              </Field>
            ) : null}

            {error ? <Flag title="Cannot continue">{error}</Flag> : null}
            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? 'Creating your account…' : 'Create my account'}
            </Button>
            <p className="text-[13px] text-ink-3">
              The administrator invited you, so there is nothing to wait for — you are signed in
              as soon as this is done.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
