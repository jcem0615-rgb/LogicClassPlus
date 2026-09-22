'use client';

import { useEffect, useState } from 'react';
import { api, apiUrl } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Shell } from '@/components/shell';
import { Avatar, Button, Card, CardHead, Field, Flag, Pill } from '@/components/ui';
import type { Health } from '@/lib/types';

type Theme = 'system' | 'light' | 'dark';

export default function SettingsPage() {
  const store = useStore();
  const user = store.user;
  const [theme, setTheme] = useState<Theme>('system');
  const [health, setHealth] = useState<Health | null>(null);
  const [swState, setSwState] = useState('checking…');
  const [installEvent, setInstallEvent] = useState<Event & { prompt?: () => void } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try { setTheme((localStorage.getItem('lc.theme') as Theme) ?? 'system'); } catch { /* blocked */ }
    void api.health().then(setHealth).catch(() => undefined);

    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.getRegistration()
        .then((r) => setSwState(r ? 'registered' : 'not registered in development'))
        .catch(() => setSwState('unavailable'));
    } else {
      setSwState('not supported by this browser');
    }

    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvent(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  function applyTheme(next: Theme) {
    setTheme(next);
    try { localStorage.setItem('lc.theme', next); } catch { /* blocked */ }
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
  }

  if (!user) return null;

  return (
    <Shell title="Settings" subtitle="Profile, notifications, install and integrations.">
      <div className="grid gap-[18px] lg:grid-cols-2">
        <Card>
          <CardHead title="Profile" />
          <form className="flex flex-col gap-3.5 p-[18px]" onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setBusy(true);
            void store.run(() => api.saveProfile({
              name: String(data.get('name')),
              locale: String(data.get('locale')),
              timezone: String(data.get('tz')),
              ...(user.role === 'teacher' ? { hourlyRate: Number(data.get('rate')) } : {}),
            }), { title: 'Profile saved', body: 'Your changes are live.' }).finally(() => setBusy(false));
          }}>
            <div className="flex items-center gap-2.5">
              <Avatar user={user} size="lg" />
              <div>
                <div className="font-semibold">{user.name}</div>
                <div className="text-[13px] text-ink-3">{user.email} · {user.role}</div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Display name"><input name="name" defaultValue={user.name} /></Field>
              <Field label="Locale">
                <select name="locale" defaultValue={user.locale}>
                  {['en-US', 'en-GB', 'es-CL', 'pt-BR', 'it-IT', 'ja-JP', 'ar-AE'].map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </Field>
              <Field label="Timezone"><input name="tz" defaultValue={user.tz} /></Field>
              {user.role === 'teacher' ? (
                <Field label="Hourly rate (USD)">
                  <input name="rate" type="number" min={0} step={1} defaultValue={user.hourlyRate ?? 0} />
                </Field>
              ) : null}
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={busy}>Save profile</Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHead title="Notifications & install" />
          <div className="flex flex-col gap-3.5 p-[18px]">
            <Row label="Browser push" hint={`Permission: ${typeof Notification === 'undefined' ? 'unsupported' : Notification.permission}`}>
              <Button onClick={() => {
                if (typeof Notification === 'undefined') {
                  store.toast('err', 'Not supported', 'This browser has no Notification API.');
                  return;
                }
                void Notification.requestPermission().then(async (permission) => {
                  if (permission !== 'granted') {
                    store.toast('warn', 'Push not enabled', 'You can turn it on later in browser settings.');
                    return;
                  }
                  const key = await api.pushKey();
                  if (!key.configured || !key.publicKey) {
                    store.toast('warn', 'Server has no VAPID keys',
                      'Run npx web-push generate-vapid-keys and set them in apps/server/.env.');
                    return;
                  }
                  const registration = await navigator.serviceWorker.ready;
                  const sub = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(key.publicKey),
                  });
                  const json = sub.toJSON();
                  await api.subscribePush(json.endpoint!, json.keys as { p256dh: string; auth: string });
                  store.toast('ok', 'Push enabled', "Subscribed with the server's VAPID key.");
                });
              }}>Enable push</Button>
            </Row>

            <Row label="Install as an app" hint="Adds LogicClass+ to your home screen or dock.">
              <Button variant="primary" onClick={() => {
                if (installEvent?.prompt) { installEvent.prompt(); setInstallEvent(null); return; }
                store.toast('warn', 'No install prompt yet',
                  'Chrome shows an install icon in the address bar; iOS Safari uses Share → Add to Home Screen.');
              }}>Install</Button>
            </Row>

            <Row label="Service worker" hint={swState} />

            <Row label="Appearance" hint="Follows your system theme by default.">
              <Button onClick={() => {
                const order: Theme[] = ['system', 'light', 'dark'];
                applyTheme(order[(order.indexOf(theme) + 1) % order.length]!);
              }}>{theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}</Button>
            </Row>
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="Server">
          <span className="font-mono text-[13px] text-ink-3">{apiUrl()}</span>
        </CardHead>
        <div className="flex flex-wrap gap-2 p-[18px]">
          {health ? Object.entries(health.integrations).map(([name, on]) => (
            <Pill key={name} tone={on ? 'ok' : 'neutral'} dot>
              {name}: {on ? 'on' : 'not configured'}
            </Pill>
          )) : <span className="text-[13px] text-ink-3">Checking…</span>}
        </div>
      </Card>

      <Flag tone="info" title="What each switch does">
        Stripe takes payments, S3 stores uploads and recordings, Web Push delivers notifications when
        you are not looking, LiveKit routes the class so it can be recorded, and Azure Speech scores
        pronunciation. Each is off until its keys are present, and the app says so rather than faking
        a result.
      </Flag>
    </Shell>
  );
}

const Row = ({ label, hint, children }: { label: string; hint: string; children?: React.ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-3">
    <div>
      <div className="font-semibold">{label}</div>
      <div className="text-[13px] text-ink-3">{hint}</div>
    </div>
    {children}
  </div>
);

/** VAPID keys are base64url; the subscribe API wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
