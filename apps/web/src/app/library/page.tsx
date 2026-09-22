'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { ago, bytes, dayTime } from '@/lib/format';
import { Shell } from '@/components/shell';
import {
  Button, Card, CardHead, Empty, Field, Flag, Modal, Pill, SubjectPill, Summary, Table, Td, Th,
} from '@/components/ui';
import type { Resource, Subject } from '@/lib/types';

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp3', 'wav', 'm4a', 'mp4', 'webm'];

/** Checked here for a fast, specific message; the server checks again. */
function validate(file: File): string | null {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!ALLOWED.includes(ext)) return `.${ext || '?'} files are not allowed. Accepted: ${ALLOWED.join(', ')}.`;
  if (!file.size) return 'That file is empty.';
  if (file.size > MAX_BYTES) return `${bytes(file.size)} is over the 20 MB limit.`;
  return null;
}

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result ?? '');
    resolve(result.slice(result.indexOf(',') + 1));
  };
  reader.onerror = () => reject(new Error('Could not read that file.'));
  reader.readAsDataURL(file);
});

export default function LibraryPage() {
  const store = useStore();
  const user = store.user;
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<{ resource: Resource; url: string | null } | null>(null);

  const folders = store.folders;
  const folderId = openId ?? folders[0]?.id ?? null;
  const resources = useMemo(
    () => store.resources.filter((r) => r.folderId === folderId), [store.resources, folderId]);
  const totalBytes = store.resources.reduce((sum, r) => sum + r.bytes, 0);
  const isTeacher = user?.role === 'teacher';

  async function upload(file: File) {
    const problem = validate(file);
    if (problem) { store.toast('err', 'Upload rejected', problem); return; }
    if (!folderId) return;

    store.toast('ok', 'Uploading', `${file.name} · ${bytes(file.size)}`);
    await store.run(async () => {
      const { ticket } = await api.uploadTicket({
        folderId, filename: file.name, bytes: file.size, mimeType: file.type || undefined,
      });
      if (ticket.driver === 's3' && ticket.uploadUrl) {
        const res = await fetch(ticket.uploadUrl, {
          method: 'PUT', body: file,
          headers: file.type ? { 'content-type': file.type } : {},
        });
        if (!res.ok) throw new Error(`The storage service rejected the upload (${res.status}).`);
      } else {
        await api.uploadLocal(ticket.storageKey, await toBase64(file));
      }
      return api.commitResource({
        folderId, filename: file.name, bytes: file.size,
        storageKey: ticket.storageKey, mimeType: file.type || undefined,
      });
    }, { title: 'Uploaded', body: `${file.name} · ${bytes(file.size)}` });
  }

  return (
    <Shell
      title="Library"
      subtitle={isTeacher ? 'Your folders and materials — visible only to you and your students.'
        : user?.role === 'owner' ? "Every teacher's materials, listed with their owner."
        : 'Material shared by teachers you study with.'}
    >
      <Summary items={[
        { k: 'Folders', v: folders.length },
        { k: 'Files', v: store.resources.length },
        { k: 'Storage used', v: bytes(totalBytes), s: 'S3 presigned uploads' },
        { k: 'Per-file limit', v: '20 MB', s: `${ALLOWED.length} allowed types` },
      ]} />

      <div className="grid gap-[18px] lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHead title={folders.find((f) => f.id === folderId)?.name ?? 'Files'}>
            {isTeacher && folderId ? (
              <>
                <label htmlFor="upload" className="cursor-pointer">
                  <span className="inline-flex items-center rounded-sm border border-brand bg-brand px-2.5 py-1 text-[13px] font-medium text-on-brand">
                    Upload file
                  </span>
                </label>
                <input id="upload" type="file" className="hidden" onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void upload(file);
                }} />
              </>
            ) : null}
          </CardHead>

          {resources.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>File</Th><Th>Type</Th><Th className="text-right">Size</Th><Th>Added</Th>
                  {user?.role === 'owner' ? <Th>Owner</Th> : null}<Th />
                </tr>
              </thead>
              <tbody>
                {resources.map((r) => (
                  <tr key={r.id} className="hover:bg-card-2">
                    <Td className="font-medium">{r.name}</Td>
                    <Td><Pill>.{r.ext}</Pill></Td>
                    <Td className="text-right font-mono tabular">{bytes(r.bytes)}</Td>
                    <Td className="font-mono text-[13px] text-ink-3">{ago(r.uploadedAt)}</Td>
                    {user?.role === 'owner' ? <Td className="text-[13px]">{store.userById(r.teacherId).name}</Td> : null}
                    <Td className="text-right">
                      {isTeacher ? (
                        <Button size="sm" variant="ghost" onClick={() => {
                          void store.run(() => api.deleteResource(r.id));
                        }}>Delete</Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => {
                          void api.resourceUrl(r.id)
                            .then((res) => setDetail({ resource: r, url: res.url }))
                            .catch(() => setDetail({ resource: r, url: null }));
                        }}>Open</Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Empty title="This folder is empty"
              body={isTeacher ? 'Upload a PDF, image or audio file to get started.'
                : 'Your teacher has not added anything here yet.'} />
          )}
        </Card>

        <Card>
          <CardHead title="Folders">
            {isTeacher ? <Button size="sm" onClick={() => setCreating(true)}>New</Button> : null}
          </CardHead>
          {folders.length ? folders.map((f) => {
            const count = store.resources.filter((r) => r.folderId === f.id).length;
            return (
              <button key={f.id} onClick={() => setOpenId(f.id)}
                className={`flex w-full items-center justify-between gap-3 border-b border-line px-[18px] py-3.5 text-left last:border-0 ${
                  f.id === folderId ? 'bg-brand-soft' : 'hover:bg-card-2'}`}>
                <div>
                  <div className="font-semibold">{f.name}</div>
                  <div className="text-[13px] text-ink-3">
                    {count} file{count === 1 ? '' : 's'}
                    {!isTeacher ? ` · ${store.userById(f.teacherId).name}` : ''}
                  </div>
                </div>
                <SubjectPill subject={f.subject} />
              </button>
            );
          }) : <Empty title="No folders" body="Create one to organise your materials." />}
        </Card>
      </div>

      {isTeacher ? (
        <Flag tone="info" title="Isolation">
          Every query filters by your teacher ID. The server enforces it: another teacher requesting
          this folder by ID gets the same 404 as one that does not exist.
        </Flag>
      ) : null}

      {creating ? (
        <NewFolder onClose={() => setCreating(false)} onCreate={async (name, subject) => {
          const created = await store.run(() => api.createFolder(name, subject),
            { title: 'Folder created', body: `${name} is ready for uploads.` });
          if (created) setOpenId(created.folder.id);
          setCreating(false);
        }} />
      ) : null}

      {detail ? (
        <Modal title={detail.resource.name} onClose={() => setDetail(null)}>
          <div className="flex flex-col gap-2 rounded-md border border-line bg-card-2 p-3.5">
            {[['Type', `.${detail.resource.ext}`], ['Size', bytes(detail.resource.bytes)],
              ['Uploaded', dayTime(detail.resource.uploadedAt)],
              ['Teacher', store.userById(detail.resource.teacherId).name]].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-ink-2">{k}</span><span className="font-mono">{v}</span>
              </div>
            ))}
          </div>
          {detail.url ? (
            <a href={detail.url} target="_blank" rel="noopener noreferrer">
              <Button variant="primary">Open file</Button>
            </a>
          ) : (
            <p className="text-[13px] text-ink-3">
              No object storage is configured on the server, so the bytes are on its local disk.
            </p>
          )}
        </Modal>
      ) : null}
    </Shell>
  );
}

function NewFolder({ onClose, onCreate }: {
  onClose: () => void; onCreate: (name: string, subject: Subject) => void;
}) {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState<Subject>('math');
  return (
    <Modal title="New folder" onClose={onClose}
      footer={<Button variant="primary" disabled={!name.trim()}
        onClick={() => onCreate(name.trim(), subject)}>Create folder</Button>}>
      <Field label="Folder name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Trigonometry" />
      </Field>
      <Field label="Subject">
        <select value={subject} onChange={(e) => setSubject(e.target.value as Subject)}>
          <option value="math">Math</option><option value="english">English</option>
        </select>
      </Field>
    </Modal>
  );
}
