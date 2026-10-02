'use client';

/** Sign in, or create an account. The only screen reachable signed out. */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { api, apiCameFromLink, apiUrl, defaultApiUrl, setApiUrl } from '@/lib/api';
import { Button, Field, Flag, Modal } from '@/components/ui';
import type { Subject } from '@/lib/types';

const DEMO = [
  ['Owner / Admin', 'owner@logicclass.plus', 'admin1234'],
  ['Teacher (Math)', 'daniel@logicclass.plus', 'teach1234'],
  ['Teacher (English)', 'hana@logicclass.plus', 'teach1234'],
  ['Student', 'amira@logicclass.plus', 'learn1234'],
  ['Parent', 'nadia@logicclass.plus', 'parent1234'],
] as const;

export default function AuthPage() {
  const store = useStore();
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (store.ready && store.user) router.replace('/dashboard');
  }, [store.ready, store.user, router]);

  async function signInWith(addr: string, pass: string) {
    setError(''); setBusy(true);
    try {
      const user = await store.signIn(addr, pass);
      store.toast('ok', 'Signed in', `Welcome back, ${user.name.split(' ')[0]}.`);
      router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    await signInWith(email, password);
  }

  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_.95fr]">
      <ArtPanel />

      <section className="grid place-items-center overflow-y-auto px-6 py-9">
        <div className="flex w-[min(400px,100%)] flex-col gap-4">
            <form className="flex flex-col gap-4" onSubmit={signIn}>
              <div>
                <h1 className="text-[26px]">Welcome back</h1>
                <p className="mt-1 text-[13px] text-ink-2">Sign in to your classroom.</p>
              </div>
              <Field label="Email">
                <input id="login-email" type="email" autoComplete="username" required
                  placeholder="you@school.com" value={email}
                  onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Password">
                <input id="login-password" type="password" autoComplete="current-password" required
                  value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              {error ? <Flag title="Cannot continue">{error}</Flag> : null}
              <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => setForgot(true)}>
                Forgot your password?
              </Button>
            </form>

          <div className="rounded-sm border border-dashed border-line-2 bg-card-2 px-3.5 py-3">
            <div className="eyebrow mb-1">No account?</div>
            <p className="text-[13px] text-ink-2">
              Accounts here are created by invitation, not by signing up — which is how the
              roster stays a list of real teachers and students. Ask the administrator to send
              you a link, and opening it is all it takes.
            </p>
          </div>

          <div className="rounded-sm border border-dashed border-line-2 bg-card-2 px-3.5 py-3">
            <div className="eyebrow mb-1.5">Demo accounts — click to sign in</div>
            {DEMO.map(([label, addr, pass]) => (
              <button key={addr} type="button" data-demo={addr} disabled={busy}
                onClick={() => {
                  setEmail(addr); setPassword(pass);
                  void signInWith(addr, pass);
                }}
                className="flex w-full justify-between gap-3 py-1 font-mono text-[12.5px] text-ink-2 hover:text-brand disabled:opacity-60"
              >
                <span>{label}</span><span>{addr}</span>
              </button>
            ))}
          </div>

          <ApiPanel />
        </div>
      </section>

      {forgot ? (
        <ForgotModal onClose={() => setForgot(false)} onSent={() => {
          setForgot(false);
          store.toast('ok', 'Request sent', 'If that address has an account, the administrator will review it.');
        }} />
      ) : null}

    </div>
  );
}

/**
 * Where this browser sends its requests.
 *
 * The client is static and the API is a long-lived server, so a hosted copy of
 * this page cannot assume the two share an origin. Reading the address back —
 * and proving it answers — is the difference between "signing in is broken"
 * and "the API is not running yet".
 */
function ApiPanel() {
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [probe, setProbe] = useState<'checking' | 'up' | 'down'>('checking');

  const [fellBack, setFellBack] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Falling back is for an address this browser inherited from an earlier
  // visit and that has since died. An address someone typed, or put in the
  // link they are opening, is a deliberate choice: report that it is not
  // answering rather than quietly substituting something else.
  const allowFallback = useRef(!apiCameFromLink());

  useEffect(() => {
    let alive = true;

    const show = () => { setUrl(apiUrl()); setDraft(apiUrl()); };
    const reachable = () => api.health().then(() => true).catch(() => false);

    void (async () => {
      setProbe('checking');
      show();

      if (await reachable()) { if (alive) setProbe('up'); return; }
      if (!alive) return;

      // A stored address outlives whatever it pointed at. When it stops
      // answering, this browser would otherwise be stuck on a dead host
      // forever, with a perfectly good default sitting unused in the build.
      if (allowFallback.current && apiUrl() !== defaultApiUrl()) {
        setApiUrl('');
        show();
        if (await reachable()) {
          if (alive) { setFellBack(true); setProbe('up'); }
          return;
        }
        if (!alive) return;
      }

      setProbe('down');
    })();

    return () => { alive = false; };
  }, [attempt]);

  const tone = probe === 'up' ? 'text-ok' : probe === 'down' ? 'text-crit' : 'text-ink-3';
  const label = probe === 'up' ? 'answering' : probe === 'down' ? 'not reachable' : 'checking…';

  return (
    <div data-panel="api" className="rounded-sm border border-line-2 bg-card-2 px-3.5 py-3 text-[12.5px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">API server</span>
        <button type="button" className="text-ink-3 hover:text-brand"
          onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Change'}
        </button>
      </div>

      {open ? (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setApiUrl(draft);
            setOpen(false);
            setFellBack(false);
            allowFallback.current = false;
            setAttempt((n) => n + 1);
          }}
        >
          <input
            className="flex-1 font-mono text-[12px]" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={defaultApiUrl()} aria-label="API base URL"
          />
          <Button type="submit" variant="primary">Use</Button>
        </form>
      ) : (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-ink-2">{url}</span>
          <span className={tone}>· {label}</span>
        </div>
      )}

      {fellBack ? (
        <p className="mt-1.5 text-ink-3">
          The address this browser had saved stopped answering, so it is back on
          the one this build ships with.
        </p>
      ) : null}

      {probe === 'down' ? (
        <p className="mt-1.5 text-ink-3">
          Nothing is answering there. Start the API (<span className="font-mono">npm run dev</span> in
          <span className="font-mono"> apps/server</span>), then point this at it — its address can also
          be passed as <span className="font-mono">?api=</span> in the link.
        </p>
      ) : null}
    </div>
  );
}

function ForgotModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [value, setValue] = useState('');
  return (
    <Modal
      title="Reset your password" onClose={onClose}
      footer={
        <Button variant="primary" onClick={() => {
          void api.requestPasswordReset(value).catch(() => undefined).then(onSent);
        }}>Send request</Button>
      }
    >
      <Field label="Email">
        <input type="email" placeholder="you@school.com" value={value}
          onChange={(e) => setValue(e.target.value)} />
      </Field>
      <p className="text-[13px] text-ink-2">
        The administrator approves reset requests, then a single-use link is emailed to you.
      </p>
    </Modal>
  );
}

/** A parabola and a speech wave: the two subjects, drawn rather than decorated. */
function ArtPanel() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    let raf = 0;
    let t = 0;
    const draw = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const { width, height } = parent.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const g = canvas.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, width, height);

      g.strokeStyle = 'rgba(255,255,255,.10)';
      g.lineWidth = 1;
      for (let x = 0; x < width; x += 42) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke(); }
      for (let y = 0; y < height; y += 42) { g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke(); }

      g.strokeStyle = 'rgba(255,255,255,.55)';
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i <= width; i += 4) {
        const nx = (i - width / 2) / (width / 4);
        const ny = height * 0.62 - nx * nx * height * 0.1;
        i === 0 ? g.moveTo(i, ny) : g.lineTo(i, ny);
      }
      g.stroke();

      g.strokeStyle = 'rgba(143,216,204,.85)';
      g.beginPath();
      for (let j = 0; j <= width; j += 3) {
        const a = Math.sin(j / 46 + t) * 16 * Math.sin(j / 190 + t / 2) + Math.sin(j / 13 + t * 1.7) * 5;
        const y = height * 0.82 + a;
        j === 0 ? g.moveTo(j, y) : g.lineTo(j, y);
      }
      g.stroke();

      t += 0.02;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <section className="relative flex flex-col justify-between gap-8 overflow-hidden bg-brand p-11 text-[#EAF6F3] max-lg:hidden">
      <canvas ref={ref} aria-hidden className="absolute inset-0 h-full w-full opacity-40" />
      <div className="relative z-10 flex items-center gap-2.5">
        <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-white font-display text-[15px] font-bold text-brand">L</span>
        <span className="font-display text-[17px] font-semibold text-white">
          LogicClass<b className="font-semibold text-[#8FD8CC]">+</b>
        </span>
      </div>
      <div className="relative z-10">
        <h2 className="max-w-[15ch] font-display text-[34px] leading-[1.15] text-white">
          English and Math, one student at a time.
        </h2>
        <p className="mt-3 max-w-[44ch] text-[15px] text-[#C9E7E1]">
          Live 1-on-1 classrooms with a shared whiteboard, PDF annotation, LaTeX and a pronunciation
          studio — plus the attendance, payroll and billing that keep a tutoring business running.
        </p>
      </div>
      <div className="relative z-10 flex flex-wrap gap-6">
        {[['1:1', 'Class format'], ['7', 'Timezones'], ['2', 'Subject suites']].map(([v, k]) => (
          <div key={k}>
            <div className="font-mono text-[21px] text-white">{v}</div>
            <div className="font-mono text-[11px] uppercase tracking-[.09em] text-[#A9D6CE]">{k}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
