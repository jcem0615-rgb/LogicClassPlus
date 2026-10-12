/**
 * Sending email.
 *
 * Until now the Owner was the mail system: an invitation produced a link
 * they had to copy into a message themselves, and an approved password
 * reset produced one they had to relay by hand. Everything the platform
 * "notified" someone about reached them only if a person carried it.
 *
 * With no provider configured this still behaves that way, deliberately.
 * `EMAIL_PROVIDER=none` writes the message and its link to the server log
 * and reports that it was not delivered, so the Owner sees "copy this link"
 * in the interface rather than a confident lie about an email nobody will
 * receive. Local development and the demo keep working exactly as before;
 * setting a key is what changes the behaviour, not a code path.
 */
import { env, isEmailConfigured, webAppUrl } from '../env.js';

export interface Mail {
  to: string;
  subject: string;
  /** Plain text is the message. HTML is a nicety some clients render. */
  text: string;
  html?: string;
}

export interface Delivery {
  delivered: boolean;
  /** Why it was not delivered, in words worth showing someone. */
  reason?: string;
  id?: string;
}

/** Why email is off, if it is. */
export function emailBlockedReason(): string | null {
  if (env.EMAIL_PROVIDER === 'none') {
    return 'No email provider is configured, so links have to be sent by hand. '
      + 'Set EMAIL_PROVIDER=resend and RESEND_API_KEY to have them delivered.';
  }
  if (!env.RESEND_API_KEY) return 'RESEND_API_KEY is not set.';
  return null;
}

export async function sendEmail(mail: Mail): Promise<Delivery> {
  const blocked = emailBlockedReason();
  if (blocked) {
    // Not an error: this is the configured behaviour. The link is logged so
    // it can be recovered from the server's output if the Owner lost it.
    console.info(
      `[email] not sent (${env.EMAIL_PROVIDER}) → ${mail.to}: ${mail.subject}\n`
      + mail.text.split('\n').map((line) => `         ${line}`).join('\n'),
    );
    return { delivered: false, reason: blocked };
  }

  try {
    const res = await fetch(`${env.RESEND_BASE_URL.replace(/\/$/, '')}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(env.EMAIL_REPLY_TO ? { reply_to: env.EMAIL_REPLY_TO } : {}),
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(`[email] provider refused (${res.status}): ${body.slice(0, 300)}`);
      return { delivered: false, reason: `The email provider refused it (${res.status}).` };
    }
    let id: string | undefined;
    try { id = (JSON.parse(body) as { id?: string }).id; } catch { /* no id is fine */ }
    return { delivered: true, ...(id ? { id } : {}) };
  } catch (err) {
    // A class does not stop because an email did not go out.
    console.error('[email] could not be sent:', (err as Error).message);
    return { delivered: false, reason: `The email could not be sent: ${(err as Error).message}` };
  }
}

/* ---------------- what the messages say ----------------
   Plain, short, and the link on its own line — the thing the reader needs
   is the first thing they can act on. */

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One house style, so every message looks like it came from the same place. */
function layout(heading: string, lines: string[], action?: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#F4F7F6;padding:24px;
  font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#13201F">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E2E9E7;
    border-radius:10px;padding:28px">
    <div style="font-weight:600;font-size:17px;color:#0B6B5B;margin-bottom:18px">LogicClass+</div>
    <h1 style="font-size:19px;margin:0 0 12px">${escape(heading)}</h1>
    ${lines.map((l) => `<p style="margin:0 0 12px;color:#3C4C4A">${escape(l)}</p>`).join('')}
    ${action ? `<p style="margin:22px 0 10px">
      <a href="${action.url}" style="display:inline-block;background:#0B6B5B;color:#fff;
        text-decoration:none;padding:11px 18px;border-radius:7px;font-weight:600">
        ${escape(action.label)}</a></p>
      <p style="margin:0;color:#6B7D7A;font-size:13px">
        Or paste this into your browser:<br>
        <span style="font-family:ui-monospace,monospace;word-break:break-all">${action.url}</span>
      </p>` : ''}
  </div></body></html>`;
}

export function invitationEmail(input: {
  to: string; role: string; token: string; note?: string | null; invitedBy: string;
  expiresAt: Date;
}): Mail {
  const url = `${webAppUrl()}/join/${input.token}`;
  const what = input.role === 'teacher' ? 'teach on LogicClass+'
    : input.role === 'parent' ? 'follow a student on LogicClass+'
      : 'learn on LogicClass+';
  const expires = input.expiresAt.toDateString();
  const lines = [
    `${input.invitedBy} has invited you to ${what}.`,
    ...(input.note ? [`“${input.note}”`] : []),
    'Open the link below to choose a password. There is nothing to approve afterwards —'
    + ' you can sign in straight away.',
    `The link works until ${expires}, and only once.`,
  ];
  return {
    to: input.to,
    subject: `You have been invited to LogicClass+`,
    text: `${lines.join('\n\n')}\n\n${url}\n`,
    html: layout('You have been invited to LogicClass+', lines, { label: 'Create my account', url }),
  };
}

export function passwordResetEmail(input: { to: string; token: string; name: string }): Mail {
  const url = `${webAppUrl()}/#/reset?token=${encodeURIComponent(input.token)}`;
  const lines = [
    `${input.name}, your request to reset your LogicClass+ password was approved.`,
    'Open the link below to choose a new one. If you did not ask for this, tell your'
    + ' administrator — the link can be ignored and it will expire on its own.',
  ];
  return {
    to: input.to,
    subject: 'Reset your LogicClass+ password',
    text: `${lines.join('\n\n')}\n\n${url}\n`,
    html: layout('Reset your password', lines, { label: 'Choose a new password', url }),
  };
}

export function classBookedEmail(input: {
  to: string; name: string; topic: string; startsAt: Date; teacher: string; timezone: string;
}): Mail {
  const when = input.startsAt.toLocaleString('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: input.timezone,
  });
  const lines = [
    `${input.name}, your class is booked.`,
    `${input.topic} with ${input.teacher}`,
    `${when} (${input.timezone})`,
    'You can join from your Classes page a few minutes before it starts.',
  ];
  return {
    to: input.to,
    subject: `Booked: ${input.topic}`,
    text: `${lines.join('\n\n')}\n\n${webAppUrl()}/classes\n`,
    html: layout('Your class is booked', lines, { label: 'See my classes', url: `${webAppUrl()}/classes` }),
  };
}

/**
 * A class that is not happening. This one matters more than the booking
 * confirmation did: somebody is otherwise going to sit in front of a camera
 * at four o'clock waiting for a lesson that was called off.
 */
export function classCancelledEmail(input: {
  to: string; name: string; topic: string; startsAt: Date; timezone: string;
  cancelledBy: string; reason?: string | null; shortNotice: boolean;
  /** A teacher is not told to go and book another lesson with themselves. */
  audience: 'student' | 'teacher';
}): Mail {
  const when = input.startsAt.toLocaleString('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: input.timezone,
  });
  const lines = [
    `${input.name}, your class on ${when} has been cancelled.`,
    `${input.topic} — cancelled by ${input.cancelledBy}.`,
    ...(input.reason ? [`Reason given: “${input.reason}”`] : []),
    ...(input.shortNotice
      ? ['This was cancelled at short notice. If that is a problem, reply to this'
        + ' message and the school will see it.']
      : []),
    input.audience === 'teacher'
      ? 'That slot is free on your schedule again.'
      : 'Nothing is expected of you — there is no class to join. You can book another'
        + ' time whenever suits.',
  ];
  return {
    to: input.to,
    subject: `Cancelled: ${input.topic}`,
    text: `${lines.join('\n\n')}\n\n${webAppUrl()}/classes\n`,
    html: layout('Your class has been cancelled', lines, {
      label: input.audience === 'teacher' ? 'See my schedule' : 'Book another time',
      url: `${webAppUrl()}/classes`,
    }),
  };
}

/** A class that is still happening, at a different time. */
export function classMovedEmail(input: {
  to: string; name: string; topic: string; from: Date; to_: Date; timezone: string;
  movedBy: string; minutes: number;
}): Mail {
  const fmt = (d: Date) => d.toLocaleString('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: input.timezone,
  });
  const lines = [
    `${input.name}, your class has been moved.`,
    `${input.topic} — now ${fmt(input.to_)} (${input.timezone}), ${input.minutes} minutes.`,
    `It was booked for ${fmt(input.from)}.`,
    `Moved by ${input.movedBy}. If the new time does not work, say so and it can be`
    + ' moved again or cancelled.',
  ];
  return {
    to: input.to,
    // The new time in the subject line: a reader scanning their inbox should
    // not have to open the message to learn the one thing that changed.
    subject: `Moved to ${fmt(input.to_)}: ${input.topic}`,
    text: `${lines.join('\n\n')}\n\n${webAppUrl()}/classes\n`,
    html: layout('Your class has moved', lines,
      { label: 'See my classes', url: `${webAppUrl()}/classes` }),
  };
}

export function invoiceEmail(input: {
  to: string; name: string; number: string; amount: string; dueAt: Date;
}): Mail {
  const lines = [
    `${input.name}, invoice ${input.number} for ${input.amount} is now open.`,
    `It is due by ${input.dueAt.toDateString()}.`,
  ];
  return {
    to: input.to,
    subject: `Invoice ${input.number} — ${input.amount}`,
    text: `${lines.join('\n\n')}\n\n${webAppUrl()}/billing\n`,
    html: layout(`Invoice ${input.number}`, lines, { label: 'View and pay', url: `${webAppUrl()}/billing` }),
  };
}

export const emailStatus = () => ({
  configured: isEmailConfigured(),
  provider: env.EMAIL_PROVIDER,
  from: env.EMAIL_FROM,
  reason: emailBlockedReason(),
});
