'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { ago, day } from '@/lib/format';
import { Shell } from '@/components/shell';
import { Button, Card, CardHead, Empty, Field, Pill } from '@/components/ui';

export default function AnnouncementsPage() {
  const store = useStore();
  const owner = store.user?.role === 'owner';
  const [busy, setBusy] = useState(false);

  const list = [...store.announcements].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned)
      || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  async function post(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    await store.run(() => api.postAnnouncement({
      title: String(data.get('title')),
      body: String(data.get('body')),
      audience: data.get('audience') as 'all' | 'teachers' | 'students',
      pinned: data.get('pinned') === 'yes',
    }), { title: 'Posted', body: 'Everyone in the audience was notified.' });
    form.reset();
    setBusy(false);
  }

  return (
    <Shell
      title="Announcements"
      subtitle={owner ? 'Post to everyone, teachers only, or students only.' : 'Notices from the platform admin.'}
    >
      {owner ? (
        <Card>
          <CardHead title="New announcement" />
          <form className="flex flex-col gap-3.5 p-[18px]" onSubmit={post}>
            <Field label="Title">
              <input name="title" required placeholder="What do people need to know?" />
            </Field>
            <Field label="Message">
              <textarea name="body" required rows={3} placeholder="Keep it short and specific." />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Audience">
                <select name="audience" defaultValue="all">
                  <option value="all">Everyone</option>
                  <option value="teachers">Teachers only</option>
                  <option value="students">Students only</option>
                </select>
              </Field>
              <Field label="Pin to top">
                <select name="pinned" defaultValue="no">
                  <option value="no">No</option><option value="yes">Yes</option>
                </select>
              </Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={busy}>Post announcement</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {list.length ? list.map((a) => (
        <Card key={a.id} className="p-[18px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {a.pinned ? <Pill tone="warn">Pinned</Pill> : null}
              <Pill>{a.audience === 'all' ? 'Everyone' : a.audience === 'teachers' ? 'Teachers' : 'Students'}</Pill>
            </div>
            <span className="font-mono text-[13px] text-ink-3">{day(a.createdAt)} · {ago(a.createdAt)}</span>
          </div>
          <h2 className="mb-1.5 mt-2.5 text-[19px]">{a.title}</h2>
          <p className="text-ink-2">{a.body}</p>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[13px] text-ink-3">{store.userById(a.authorId).name}</span>
            {owner ? (
              <Button size="sm" variant="ghost" onClick={() => {
                void store.run(() => api.deleteAnnouncement(a.id));
              }}>Delete</Button>
            ) : null}
          </div>
        </Card>
      )) : <Empty title="No announcements" body="Nothing has been posted yet." />}
    </Shell>
  );
}
