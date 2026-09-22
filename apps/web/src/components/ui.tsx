'use client';

/** The shared vocabulary: one definition per repeated thing. */
import type { ReactNode } from 'react';
import { initials } from '@/lib/format';
import type { Subject, User } from '@/lib/types';

type Tone = 'ok' | 'warn' | 'crit' | 'neutral' | 'math' | 'english';

const toneClass: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok border-ok/30',
  warn: 'bg-warn-soft text-warn border-warn/30',
  crit: 'bg-crit-soft text-crit border-crit/30',
  neutral: 'bg-sunk text-ink-2 border-line',
  math: 'bg-math-soft text-math border-math/25',
  english: 'bg-english-soft text-english border-english/25',
};

export function Pill({ tone = 'neutral', dot, children }: {
  tone?: Tone; dot?: boolean; children: ReactNode;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${toneClass[tone]}`}>
      {dot && <i className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const statusTone: Record<string, Tone> = {
  active: 'ok', pending: 'warn', suspended: 'crit', scheduled: 'neutral', live: 'ok',
  completed: 'neutral', no_show: 'crit', accepted: 'ok', declined: 'crit',
  paid: 'ok', open: 'warn', void: 'neutral', draft: 'neutral', approved: 'ok', rejected: 'crit',
};
const statusLabel: Record<string, string> = { no_show: 'No-show' };

export function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={statusTone[status] ?? 'neutral'} dot>
      {statusLabel[status] ?? status.charAt(0).toUpperCase() + status.slice(1)}
    </Pill>
  );
}

export const SubjectPill = ({ subject }: { subject: Subject }) => (
  <Pill tone={subject === 'math' ? 'math' : 'english'}>
    {subject === 'math' ? 'Math' : 'English'}
  </Pill>
);

export function Avatar({ user, size = 'md' }: { user: Pick<User, 'name'>; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-11 w-11 text-[15px]' : 'h-8 w-8 text-xs';
  return (
    <span className={`${box} shrink-0 grid place-items-center rounded-full bg-brand-soft text-brand-ink font-semibold`}>
      {initials(user.name)}
    </span>
  );
}

export function Button({
  variant = 'default', size = 'md', className = '', ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: 'sm' | 'md';
}) {
  const variants = {
    default: 'bg-card border-line-2 text-ink hover:bg-card-2 hover:border-ink-3',
    primary: 'bg-brand border-brand text-on-brand hover:bg-brand-ink hover:border-brand-ink',
    danger: 'bg-card border-crit text-crit hover:bg-crit-soft',
    ghost: 'bg-transparent border-transparent text-ink-2 hover:bg-sunk hover:text-ink',
  };
  const sizes = { sm: 'px-2.5 py-1 text-[13px]', md: 'px-3.5 py-2 text-sm' };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-sm border font-medium whitespace-nowrap transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}

export const Card = ({ className = '', children }: { className?: string; children: ReactNode }) => (
  <section className={`bg-card border border-line rounded-md shadow-1 ${className}`}>{children}</section>
);

export const CardHead = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-[18px] py-3.5">
    <h2 className="text-[19px]">{title}</h2>
    {children ? <div className="flex items-center gap-2">{children}</div> : null}
  </div>
);

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink-2">
    {label}
    {children}
  </label>
);

export interface SummaryItem { k: string; v: ReactNode; s?: ReactNode }

export function Summary({ items }: { items: SummaryItem[] }) {
  return (
    <div className="grid gap-px overflow-hidden rounded-md border border-line bg-line"
      style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(158px,1fr))' }}>
      {items.map((item) => (
        <div key={item.k} className="flex flex-col gap-0.5 bg-card px-4 py-3">
          <span className="eyebrow">{item.k}</span>
          <span className="font-mono text-[22px] font-medium tabular tracking-tight">{item.v}</span>
          {item.s ? <span className="text-xs text-ink-2">{item.s}</span> : null}
        </div>
      ))}
    </div>
  );
}

export const Empty = ({ title, body }: { title: string; body: string }) => (
  <div className="px-5 py-8 text-center text-sm text-ink-3">
    <h3 className="mb-1 text-ink-2">{title}</h3>
    <p>{body}</p>
  </div>
);

export const Table = ({ children }: { children: ReactNode }) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-sm">{children}</table>
  </div>
);

export const Th = ({ className = '', children }: { className?: string; children?: ReactNode }) => (
  <th className={`border-b border-line px-3.5 py-2.5 text-left font-mono text-[11px] uppercase tracking-[.08em] text-ink-3 whitespace-nowrap ${className}`}>
    {children}
  </th>
);

export const Td = ({ className = '', children }: { className?: string; children?: ReactNode }) => (
  <td className={`border-b border-line px-3.5 py-2.5 align-middle ${className}`}>{children}</td>
);

export const Flag = ({ tone = 'warn', title, children }: {
  tone?: 'warn' | 'info'; title: string; children: ReactNode;
}) => (
  <div className={`flex gap-2.5 rounded-sm border px-3.5 py-3 text-[13px] ${
    tone === 'info' ? 'bg-brand-soft border-brand/25' : 'bg-warn-soft border-warn/25'}`}>
    <b className={tone === 'info' ? 'text-brand-ink' : 'text-warn'}>{title}</b>
    <div className="text-ink">{children}</div>
  </div>
);

export function Modal({ title, onClose, footer, children }: {
  title: string; onClose: () => void; footer?: ReactNode; children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(9,18,21,.55)] p-4 backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[88vh] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-line-2 bg-card shadow-2">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="text-[19px]">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-2 hover:text-ink">✕</button>
        </div>
        <div className="flex flex-col gap-3.5 overflow-y-auto p-5">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2.5 border-t border-line bg-card-2 px-5 py-3.5">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export const Bar = ({ value, tone }: { value: number; tone?: string }) => (
  <div className="h-2 min-w-[70px] flex-1 overflow-hidden rounded bg-sunk">
    <div className="h-full rounded" style={{
      width: `${Math.max(0, Math.min(100, value))}%`, background: tone ?? 'var(--brand)',
    }} />
  </div>
);
