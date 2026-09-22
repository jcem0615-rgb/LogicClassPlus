/** Presentation helpers. Money and durations are formatted in one place. */

export const bytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`;
  return `${(n / 1_073_741_824).toFixed(2)} GB`;
};

export const money = (n: number, currency = 'USD'): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n || 0);

export const time = (d: string | number | Date, tz?: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, ...(tz ? { timeZone: tz } : {}),
  }).format(new Date(d));

export const day = (d: string | number | Date): string =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(d));

export const dayTime = (d: string | number | Date): string => `${day(d)} · ${time(d)}`;

export function ago(d: string | number | Date): string {
  const seconds = (Date.now() - new Date(d).getTime()) / 1000;
  const future = seconds < 0;
  const s = Math.abs(seconds);
  if (s < 60) return 'just now';
  const value = s < 3600 ? `${Math.round(s / 60)}m`
    : s < 86_400 ? `${Math.round(s / 3600)}h`
    : s < 2_592_000 ? `${Math.round(s / 86_400)}d`
    : `${Math.round(s / 2_592_000)}mo`;
  return future ? `in ${value}` : `${value} ago`;
}

export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h ? `${pad(h)}:` : ''}${pad(m)}:${pad(s)}`;
}

export const initials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();

/** A stable colour per person, used for cursors and avatars. */
export const personColor = (id: string): string => {
  const palette = ['#0B6B62', '#A8452B', '#2E5AAC', '#7A3BAF', '#1C7A4B', '#845F00'];
  let sum = 0;
  for (const ch of id) sum += ch.charCodeAt(0);
  return palette[sum % palette.length]!;
};
