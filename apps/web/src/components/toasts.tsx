'use client';

import { useStore } from '@/lib/store';

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  if (!toasts.length) return null;

  const edge: Record<string, string> = {
    ok: 'border-l-ok', warn: 'border-l-warn', err: 'border-l-crit',
  };

  return (
    <div className="fixed bottom-4 right-4 z-[90] flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismissToast(t.id)}
          className={`rounded-sm border border-line-2 border-l-[3px] bg-card p-3 text-left shadow-2 ${edge[t.kind]}`}
        >
          <div className="text-[13.5px] font-semibold">{t.title}</div>
          {t.body ? <div className="text-[13px] text-ink-2">{t.body}</div> : null}
        </button>
      ))}
    </div>
  );
}
