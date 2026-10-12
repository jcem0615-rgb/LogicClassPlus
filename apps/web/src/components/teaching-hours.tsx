'use client';

/**
 * A teacher's teaching hours.
 *
 * A list of spans rather than a seven-row grid of from/to boxes, because a
 * tutor's week is not one span a day: a morning, a lunch break and an
 * afternoon is the normal shape, and a grid that allows one row per day
 * quietly makes that unsayable.
 *
 * Setting nothing keeps the old behaviour — any hour is bookable — so this
 * screen is an opt-in, and says so rather than looking broken when empty.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Button, Card, CardHead, Field, Flag } from '@/components/ui';
import type { AvailabilityWindow, TeacherHours } from '@/lib/types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const sortWindows = (windows: AvailabilityWindow[]): AvailabilityWindow[] =>
  [...windows].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));

export function TeachingHours({ teacherId }: { teacherId: string }) {
  const store = useStore();
  const [hours, setHours] = useState<TeacherHours | null>(null);
  const [windows, setWindows] = useState<AvailabilityWindow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const got = await api.teacherHours(teacherId);
      setHours(got);
      setWindows(sortWindows(got.windows));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [teacherId]);

  useEffect(() => { void load(); }, [load]);

  function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const next: AvailabilityWindow = {
      weekday: Number(data.get('weekday')),
      start: String(data.get('start')),
      end: String(data.get('end')),
    };
    if (next.end <= next.start) {
      store.toast('err', 'Those times are the wrong way round',
        `${DAYS[next.weekday]} would end before it started.`);
      return;
    }
    // Caught here as well as on the server: being told after pressing Save,
    // about a row added five minutes ago, is a worse way to find out.
    const clash = windows.find((w) => w.weekday === next.weekday
      && next.start < w.end && w.start < next.end);
    if (clash) {
      store.toast('err', 'That overlaps a span you already have',
        `${DAYS[next.weekday]} ${clash.start}–${clash.end}.`);
      return;
    }
    setWindows(sortWindows([...windows, next]));
  }

  async function save() {
    setBusy(true);
    const saved = await store.run(() => api.saveTeacherHours(teacherId, windows),
      windows.length
        ? { title: 'Teaching hours saved', body: 'Classes can only be booked inside them now.' }
        : { title: 'Teaching hours cleared', body: 'Any time is bookable again.' });
    if (saved) { setHours(saved); setWindows(sortWindows(saved.windows)); }
    setBusy(false);
  }

  if (error) {
    return (
      <Card>
        <CardHead title="Teaching hours" />
        <div className="p-[18px]"><Flag title="Could not load these">{error}</Flag></div>
      </Card>
    );
  }

  const dirty = hours ? JSON.stringify(sortWindows(hours.windows).map(
    (w) => [w.weekday, w.start, w.end])) !== JSON.stringify(windows.map(
    (w) => [w.weekday, w.start, w.end])) : false;

  return (
    <Card>
      <CardHead title="Teaching hours">
        <span className="text-[13px] text-ink-3" data-testid="hours-timezone">
          {hours ? hours.timezone : '…'}
        </span>
      </CardHead>

      <div className="flex flex-col gap-3.5 p-[18px]">
        <p className="text-[13.5px] text-ink-2">
          {windows.length
            ? 'A class can only be booked inside these hours, and the whole class has to fit '
              + 'inside one of them. The times are in your own timezone.'
            : 'You have set no hours, so any time can be booked — including three in the '
              + 'morning. Add a span to close that off.'}
        </p>

        {windows.length ? (
          <div className="overflow-hidden rounded-sm border border-line" data-testid="hours-list">
            {windows.map((w, i) => (
              <div
                key={`${w.weekday}-${w.start}-${w.end}`}
                className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-0"
                data-hours-row={`${w.weekday}-${w.start}`}
              >
                <span className="text-[13.5px]">
                  <b className="font-semibold">{DAYS[w.weekday]}</b>
                  <span className="ml-2 font-mono text-[13px] text-ink-2">{w.start}–{w.end}</span>
                </span>
                <Button size="sm" data-remove-hours={i}
                  onClick={() => setWindows(windows.filter((_, at) => at !== i))}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        <form className="grid items-end gap-3 sm:grid-cols-[1fr_auto_auto_auto]" onSubmit={add}
          data-testid="add-hours">
          <Field label="Day">
            <select name="weekday" defaultValue="1" id="hours-weekday">
              {DAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}
            </select>
          </Field>
          <Field label="From">
            <input name="start" type="time" required defaultValue="09:00" id="hours-start" />
          </Field>
          <Field label="To">
            <input name="end" type="time" required defaultValue="17:00" id="hours-end" />
          </Field>
          <Button type="submit">Add</Button>
        </form>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-3" data-testid="hours-summary">
            {windows.length ? `${windows.length} span${windows.length === 1 ? '' : 's'}`
              : 'Bookable at any hour'}
          </span>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}
            data-testid="save-hours">
            {busy ? 'Saving…' : dirty ? 'Save hours' : 'Saved'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
