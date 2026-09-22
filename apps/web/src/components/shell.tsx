'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { Avatar, Button, Empty } from './ui';
import type { Role } from '@/lib/types';

const ICONS: Record<string, string> = {
  home: 'M3 9.6 10 4l7 5.6V17a1 1 0 0 1-1 1h-3.5v-4.5h-5V18H4a1 1 0 0 1-1-1z',
  people: 'M7 9a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 7 9m6 0a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 13 9M2 16.4C2 13.6 4.2 11 7 11s5 2.6 5 5.4zm11.2 0c0-1.7-.5-3.2-1.4-4.3.6-.2 1.2-.3 1.8-.3 2.3 0 4.4 2 4.4 4.6z',
  video: 'M2.6 5.4h9.2a1.4 1.4 0 0 1 1.4 1.4v6.4a1.4 1.4 0 0 1-1.4 1.4H2.6a1.4 1.4 0 0 1-1.4-1.4V6.8a1.4 1.4 0 0 1 1.4-1.4M14.6 8.4 18.8 6v8l-4.2-2.4z',
  folder: 'M2.4 5.2A1.4 1.4 0 0 1 3.8 3.8h3.4l1.6 1.8h7.4a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4z',
  mega: 'M4 8.2v3.6H2.6A1.6 1.6 0 0 1 1 10.2V9.8a1.6 1.6 0 0 1 1.6-1.6zm1.4 0L15 4.2v11.6L5.4 11.8zm11 1.8a2.6 2.6 0 0 1-1.1 2.1V7.9A2.6 2.6 0 0 1 16.4 10',
  clock: 'M10 2.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2m.9 3.6v4l3 1.8-.8 1.3-3.7-2.2V6z',
  money: 'M3.4 4.6h13.2a1.2 1.2 0 0 1 1.2 1.2v8.4a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V5.8a1.2 1.2 0 0 1 1.2-1.2M10 7.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2',
  card: 'M2.4 6.2A1.4 1.4 0 0 1 3.8 4.8h12.4a1.4 1.4 0 0 1 1.4 1.4v.9H2.4zm0 2.9h15.2v5a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4zm2 3.1h4v1.4h-4z',
  gear: 'M8.7 2.2h2.6l.35 1.9 1.4.8 1.8-.7 1.3 2.2-1.45 1.25v1.6l1.45 1.25-1.3 2.25-1.8-.7-1.4.8-.35 1.9H8.7l-.35-1.9-1.4-.8-1.8.7L3.85 12.5 5.3 11.25v-1.6L3.85 8.4l1.3-2.2 1.8.7 1.4-.8zM10 7.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6',
  bell: 'M10 2.2c-2.7 0-4.6 2-4.6 4.6v3L4 12.4v1.1h12v-1.1l-1.4-2.6v-3c0-2.6-1.9-4.6-4.6-4.6M8.2 16.2a1.8 1.8 0 0 0 3.6 0z',
};

const Icon = ({ name }: { name: string }) => (
  <span className="grid w-[17px] shrink-0 place-items-center opacity-85">
    <svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true">
      <path fill="currentColor" d={ICONS[name]} />
    </svg>
  </span>
);

interface NavItem { href: string; label: string; icon: string; roles: Role[]; group?: string }

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'home', roles: ['owner', 'teacher', 'student'] },
  { href: '/people', label: 'People', icon: 'people', roles: ['owner'], group: 'Manage' },
  { href: '/classes', label: 'Classes', icon: 'video', roles: ['owner', 'teacher', 'student'], group: 'Teaching' },
  { href: '/library', label: 'Library', icon: 'folder', roles: ['owner', 'teacher', 'student'] },
  { href: '/announcements', label: 'Announcements', icon: 'mega', roles: ['owner', 'teacher', 'student'] },
  { href: '/attendance', label: 'Attendance', icon: 'clock', roles: ['owner', 'teacher'], group: 'Money' },
  { href: '/payroll', label: 'Payroll', icon: 'money', roles: ['owner', 'teacher'] },
  { href: '/billing', label: 'Billing', icon: 'card', roles: ['owner', 'student'] },
  { href: '/settings', label: 'Settings', icon: 'gear', roles: ['owner', 'teacher', 'student'], group: 'Account' },
];

export function Shell({ title, subtitle, children, bare }: {
  title: string; subtitle?: string; children: ReactNode; bare?: boolean;
}) {
  const store = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const [bellOpen, setBellOpen] = useState(false);

  useEffect(() => {
    if (store.ready && !store.user) router.replace('/');
  }, [store.ready, store.user, router]);

  if (!store.ready) {
    return <div className="grid h-full place-items-center font-mono text-[13px] text-ink-3">Loading…</div>;
  }
  if (!store.user) return null;

  const user = store.user;
  const items = NAV.filter((n) => n.roles.includes(user.role));
  const counts: Record<string, number> = {
    '/people': store.users.filter((u) => u.status === 'pending').length,
    '/classes': user.role === 'teacher' ? store.requests.filter((r) => r.status === 'pending').length : 0,
    '/billing': user.role === 'student' ? store.invoices.filter((i) => i.status === 'open').length : 0,
  };
  const seen = new Set<string>();

  return (
    <div className="grid h-full overflow-hidden max-[720px]:grid-cols-1 max-[720px]:grid-rows-[1fr_auto] min-[721px]:grid-cols-[250px_1fr]">
      <aside className="flex min-h-0 flex-col border-r border-line bg-card max-[720px]:row-start-2 max-[720px]:flex-row max-[720px]:items-center max-[720px]:border-r-0 max-[720px]:border-t">
        <div className="flex items-center gap-2.5 px-[18px] pb-3.5 pt-4 max-[720px]:hidden">
          <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-brand font-display text-[15px] font-bold text-on-brand">L</span>
          <span className="font-display text-[17px] font-semibold tracking-tight">
            LogicClass<b className="font-semibold text-brand">+</b>
          </span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-3 pt-1 max-[720px]:flex-row max-[720px]:gap-0.5 max-[720px]:p-1.5">
          {items.map((item) => {
            const showGroup = item.group && !seen.has(item.group);
            if (item.group) seen.add(item.group);
            const active = pathname === item.href;
            const count = counts[item.href] ?? 0;
            return (
              <div key={item.href} className="contents">
                {showGroup ? (
                  <div className="px-2 pb-1.5 pt-3.5 font-mono text-[10px] uppercase tracking-[.11em] text-ink-3 max-[720px]:hidden">
                    {item.group}
                  </div>
                ) : null}
                <Link
                  href={item.href}
                  className={`relative flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm font-medium no-underline max-[720px]:min-w-[62px] max-[720px]:flex-col max-[720px]:gap-1 max-[720px]:px-2.5 max-[720px]:py-1.5 max-[720px]:text-[10.5px] ${
                    active ? 'bg-brand-soft text-brand-ink' : 'text-ink-2 hover:bg-sunk hover:text-ink'}`}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {count > 0 ? (
                    <span className="ml-auto rounded-full bg-crit px-1.5 py-0.5 font-mono text-[11px] leading-none text-white max-[720px]:absolute max-[720px]:right-1 max-[720px]:top-1 max-[720px]:ml-0">
                      {count}
                    </span>
                  ) : null}
                </Link>
              </div>
            );
          })}
        </nav>

        <div className="flex items-center gap-2.5 border-t border-line p-2.5 max-[720px]:hidden">
          <Avatar user={user} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">{user.name}</div>
            <div className="font-mono text-[11px] uppercase tracking-[.07em] text-ink-3">{user.role}</div>
          </div>
          <button
            onClick={() => { void store.signOut().then(() => router.push('/')); }}
            aria-label="Sign out" title="Sign out"
            className="grid h-9 w-9 place-items-center rounded-sm text-ink-2 hover:bg-sunk hover:text-ink"
          >
            <svg width="17" height="17" viewBox="0 0 20 20">
              <path fill="currentColor" d="M11 3v2H5v10h6v2H3V3zm2.8 3.3 4.2 3.7-4.2 3.7-1.3-1.5 1.7-1.5H8V8.6h6.2l-1.7-1.5z" />
            </svg>
          </button>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col overflow-hidden max-[720px]:row-start-1">
        <header className="flex flex-none items-center gap-3 border-b border-line bg-card px-[22px] py-3 max-[720px]:px-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl max-[720px]:text-[17px]">{title}</h1>
            {subtitle ? <div className="text-[13px] text-ink-2">{subtitle}</div> : null}
          </div>
          <button
            onClick={() => setBellOpen((v) => !v)} aria-label="Notifications"
            className="relative grid h-9 w-9 place-items-center rounded-sm text-ink-2 hover:bg-sunk hover:text-ink"
          >
            <svg width="18" height="18" viewBox="0 0 20 20"><path fill="currentColor" d={ICONS.bell} /></svg>
            {store.unread > 0 ? (
              <span className="absolute right-0.5 top-0.5 min-w-[16px] rounded-full bg-crit px-1 font-mono text-[10px] leading-4 text-white">
                {store.unread}
              </span>
            ) : null}
          </button>
        </header>

        {bellOpen ? (
          <div className="absolute right-[18px] top-[52px] z-[60] flex max-h-[min(460px,70vh)] w-[min(370px,calc(100vw-2rem))] flex-col rounded-md border border-line-2 bg-card shadow-2">
            <div className="flex items-center justify-between border-b border-line px-3.5 py-3">
              <h3 className="text-base">Notifications</h3>
              <Button size="sm" variant="ghost" onClick={() => {
                void store.run(() => api.markNotificationsRead());
              }}>Mark all read</Button>
            </div>
            <div className="overflow-y-auto">
              {store.notifications.length ? store.notifications.slice(0, 12).map((n) => (
                <div key={n.id} className="flex gap-2.5 border-b border-line px-3.5 py-3 last:border-0">
                  <i className={`w-[3px] shrink-0 rounded ${n.read ? 'bg-line-2' : 'bg-brand'}`} />
                  <div>
                    <div className="text-[13.5px] font-semibold">{n.title}</div>
                    <div className="text-[13px] text-ink-2">{n.body}</div>
                    <div className="mt-1 font-mono text-[11px] text-ink-3">{ago(n.createdAt)} · {n.type}</div>
                  </div>
                </div>
              )) : <Empty title="Nothing yet" body="Notifications appear here." />}
            </div>
          </div>
        ) : null}

        <div className={bare
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden p-[22px] max-[720px]:p-4'
          : 'flex flex-1 flex-col gap-[18px] overflow-y-auto p-[22px] max-[720px]:p-4'}>
          {bare ? children : <div className="flex w-full max-w-[1180px] flex-col gap-[18px]">{children}</div>}
        </div>
      </main>
    </div>
  );
}
