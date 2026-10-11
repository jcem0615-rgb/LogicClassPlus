/**
 * Email delivery, against a stand-in for the provider.
 *
 * No message is sent anywhere real. A tiny HTTP server stands in for
 * Resend's API and records exactly what the server asked it to send, which
 * is the part worth checking: the right person, a link that works, and a
 * subject a human would recognise in a crowded inbox.
 *
 * Start the stand-in, then point the API at it:
 *   EMAIL_PROVIDER=resend RESEND_API_KEY=test-key \
 *   RESEND_BASE_URL=http://127.0.0.1:45099 \
 *   WEB_APP_URL=http://localhost:4000 npm run -w apps/server dev
 *
 * Run:  node apps/server/test/email.mjs
 */
import { createServer } from 'node:http';

const API = 'http://localhost:4001/api';
const MOCK_PORT = Number(process.env.EMAIL_MOCK_PORT || 45099);

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

/* ---------------- stand-in provider ---------------- */
const sent = [];
const provider = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    sent.push({ url: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `msg_${sent.length}` }));
  });
});
await new Promise((r) => provider.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`stand-in email provider on http://127.0.0.1:${MOCK_PORT}\n`);

const call = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};
const login = async (email, password) =>
  (await call('/auth/login', { method: 'POST', body: { email, password } })).json;

const owner = await login('owner@logicclass.plus', 'admin1234');
const health = (await call('/health')).json;

console.log('1. The server knows whether it can send');
/* Email off is the default and a legitimate way to run: it is a skip, not
   a failure, or the standard suite would go red on a correct server. */
if (!health.integrations.email) {
  console.log('  skip  email is off on this server. To exercise delivery, start it with');
  console.log('        EMAIL_PROVIDER=resend RESEND_API_KEY=test-key \\');
  console.log(`        RESEND_BASE_URL=http://127.0.0.1:${MOCK_PORT} WEB_APP_URL=http://localhost:4000`);
  console.log(`\n${pass} passed, ${fail} failed, 1 skipped`);
  provider.close();
  process.exit(fail ? 1 : 0);
}
ok('health reports email as configured', health.integrations.email === true,
  JSON.stringify(health.integrations));

console.log('\n2. An invitation reaches the person invited');
const invitee = `invited-${Date.now()}@example.test`;
const before = sent.length;
const invite = await call('/invitations', { method: 'POST', token: owner.token, body: {
  role: 'teacher', email: invitee, hourlyRate: 27, note: 'Looking forward to having you.' } });
ok('creating one reports that it was emailed', invite.json.emailed === true,
  JSON.stringify({ emailed: invite.json.emailed, reason: invite.json.emailReason }));
ok('exactly one message was sent', sent.length === before + 1, `${sent.length - before}`);

const mail = sent[sent.length - 1];
ok('to the person invited', mail.body.to?.[0] === invitee, JSON.stringify(mail.body.to));
ok('authenticated with the provider key', /^Bearer /.test(mail.auth ?? ''), String(mail.auth));
ok('from the configured sender', typeof mail.body.from === 'string' && mail.body.from.length > 0,
  String(mail.body.from));
ok('with a subject that says what it is', /invited/i.test(mail.body.subject ?? ''),
  String(mail.body.subject));
ok('the note the owner wrote is in it', /Looking forward/.test(mail.body.text ?? ''));
ok('and a plain-text part, not only HTML', typeof mail.body.text === 'string' && mail.body.text.length > 40);

const link = (mail.body.text.match(/https?:\/\/\S+\/join\/\S+/) ?? [])[0];
ok('containing a join link', Boolean(link), mail.body.text.slice(0, 160));
ok('pointing at the web app, not the API',
  Boolean(link && !link.includes(':4001')), String(link));

// The link in the email has to be the one that works.
const token = link.split('/join/')[1];
const lookup = await call(`/invitations/${token}`);
ok('and the link in the email is the one that works',
  lookup.status === 200 && lookup.json.state === 'open', JSON.stringify(lookup.json).slice(0, 120));

const accepted = await call('/auth/register', { method: 'POST', body: {
  token, name: 'Invited Teacher', email: invitee, password: 'invited1234' } });
ok('following it creates the account', accepted.status === 201 && accepted.json.user.role === 'teacher',
  String(accepted.status));

console.log('\n3. An invitation with no address has nobody to go to');
const anon = await call('/invitations', { method: 'POST', token: owner.token, body: { role: 'student' } });
ok('nothing is sent', anon.json.emailed === false, JSON.stringify(anon.json.emailReason));
ok('and the owner is told why', typeof anon.json.emailReason === 'string');

console.log('\n4. A password reset link is delivered, not read out');
const student = await login('amira@logicclass.plus', 'learn1234');
await call('/auth/password-reset', { method: 'POST', body: { email: 'amira@logicclass.plus' } });
const queue = (await call('/users/reset-requests', { token: owner.token })).json.resets;
const pending = queue.find((r) => r.status === 'pending');
ok('the request reached the queue', Boolean(pending), JSON.stringify(queue.slice(0, 2)));

const sentBefore = sent.length;
const approved = await call(`/users/reset-requests/${pending.id}`, {
  method: 'PATCH', token: owner.token, body: { decision: 'approve' } });
ok('approving it sends the email', approved.json.emailed === true,
  JSON.stringify({ emailed: approved.json.emailed, reason: approved.json.emailReason }));
ok('one message, to the person who asked', sent.length === sentBefore + 1
  && sent[sent.length - 1].body.to?.[0] === 'amira@logicclass.plus',
  JSON.stringify(sent[sent.length - 1]?.body?.to));
ok('with a reset link in it', /\/#\/reset\?token=/.test(sent[sent.length - 1].body.text ?? ''),
  sent[sent.length - 1].body.text?.slice(0, 120));
void student;

console.log('\n5. An invoice reminder goes to the inbox');
const invoices = (await call('/billing/invoices', { token: owner.token })).json.invoices;
const open = invoices.find((i) => i.status === 'open');
if (open) {
  const n = sent.length;
  const reminded = await call(`/billing/invoices/${open.id}/remind`, { method: 'POST', token: owner.token });
  ok('the reminder is emailed as well as shown in the app',
    reminded.json.emailed === true && sent.length === n + 1,
    JSON.stringify({ emailed: reminded.json?.emailed, delta: sent.length - n }));
  ok('and names the invoice', sent[sent.length - 1].body.subject?.includes(open.number),
    String(sent[sent.length - 1].body.subject));
} else {
  console.log('  (no open invoice to remind about — skipped)');
}

console.log('\n6. A provider that fails does not take the request down');
provider.close();
await new Promise((r) => setTimeout(r, 200));
const whenDown = await call('/invitations', { method: 'POST', token: owner.token, body: {
  role: 'student', email: `down-${Date.now()}@example.test` } });
ok('the invitation is still created', whenDown.status === 201, String(whenDown.status));
ok('it reports that the email did not go out', whenDown.json.emailed === false,
  JSON.stringify(whenDown.json.emailReason));
ok('and the link is still returned so it can be sent by hand',
  typeof whenDown.json.token === 'string' && whenDown.json.token.length > 20);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
