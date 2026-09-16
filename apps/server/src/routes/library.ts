import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { env, isS3Configured } from '../env.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';
import { publicFolder, publicResource } from '../lib/serialize.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { assertUploadAllowed, createDownloadUrl, createUploadTicket } from '../services/storage.js';

export const libraryRouter = Router();
libraryRouter.use(requireAuth);

const subject = z.enum(['math', 'english']);
const toSubject = (s: z.infer<typeof subject>) => (s === 'math' ? 'MATH' as const : 'ENGLISH' as const);

/**
 * Multi-tenant isolation. A teacher's queries are always narrowed to their own
 * teacherId; a student only ever sees folders belonging to a teacher they have
 * a session or request with. This is the security boundary, not a filter for
 * convenience — nothing below widens it.
 */
async function visibleTeacherIds(userId: string, role: string): Promise<string[] | 'all'> {
  if (role === 'OWNER') return 'all';
  if (role === 'TEACHER') return [userId];
  const sessions = await prisma.classSession.findMany({
    where: { studentId: userId }, select: { teacherId: true }, distinct: ['teacherId'],
  });
  const requests = await prisma.classRequest.findMany({
    where: { studentId: userId, status: 'ACCEPTED' }, select: { teacherId: true }, distinct: ['teacherId'],
  });
  return [...new Set([...sessions, ...requests].map((r) => r.teacherId))];
}

libraryRouter.get('/folders', asyncRoute(async (req, res) => {
  const me = actor(req);
  const scope = await visibleTeacherIds(me.id, me.role);
  const folders = await prisma.folder.findMany({
    where: scope === 'all' ? {} : { teacherId: { in: scope } },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { resources: true } } },
  });
  res.json({
    folders: folders.map((f) => ({ ...publicFolder(f), fileCount: f._count.resources })),
  });
}));

libraryRouter.post('/folders', requireRole('TEACHER'),
  validate(z.object({ name: z.string().trim().min(1, 'A folder needs a name.').max(80), subject })),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const input = req.body as { name: string; subject: z.infer<typeof subject> };
    const folder = await prisma.folder.create({
      data: { teacherId: me.id, name: input.name, subject: toSubject(input.subject) },
    });
    res.status(201).json({ folder: { ...publicFolder(folder), fileCount: 0 } });
  }));

libraryRouter.delete('/folders/:id', requireRole('TEACHER', 'OWNER'),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const folder = await prisma.folder.findUnique({ where: { id: String(req.params['id']) } });
    if (!folder) throw notFound('That folder no longer exists.');
    if (me.role === 'TEACHER' && folder.teacherId !== me.id) throw forbidden('That folder is not yours.');
    await prisma.folder.delete({ where: { id: folder.id } });
    res.json({ ok: true });
  }));

libraryRouter.get('/folders/:id/resources', asyncRoute(async (req, res) => {
  const me = actor(req);
  const folderId = String(req.params['id']);
  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder) throw notFound('That folder no longer exists.');

  const scope = await visibleTeacherIds(me.id, me.role);
  if (scope !== 'all' && !scope.includes(folder.teacherId)) {
    // Same answer as a folder that does not exist: knowing the id proves nothing.
    throw notFound('That folder no longer exists.');
  }
  const resources = await prisma.resource.findMany({
    where: { folderId }, orderBy: { createdAt: 'desc' },
  });
  res.json({ resources: resources.map(publicResource) });
}));

/* ---------------- uploads ----------------
   Two steps: ask for a ticket (validated server-side), then send the bytes
   straight to S3 with the presigned PUT. With no bucket configured the API
   accepts the bytes itself and writes them under LOCAL_UPLOAD_DIR. */
const uploadRequest = z.object({
  folderId: z.string().min(1),
  filename: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  mimeType: z.string().max(120).optional(),
});

libraryRouter.post('/uploads', requireRole('TEACHER'), validate(uploadRequest),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const input = req.body as z.infer<typeof uploadRequest>;
    const folder = await prisma.folder.findUnique({ where: { id: input.folderId } });
    if (!folder) throw notFound('That folder no longer exists.');
    if (folder.teacherId !== me.id) throw forbidden('That folder is not yours.');

    const ticket = await createUploadTicket(me.id, folder.id, input.filename, input.bytes, input.mimeType);
    res.json({ ticket, maxBytes: env.UPLOAD_MAX_BYTES });
  }));

/** Records the resource once the bytes are in storage. */
const commitUpload = z.object({
  folderId: z.string().min(1),
  filename: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  storageKey: z.string().min(1),
  mimeType: z.string().max(120).optional(),
});

libraryRouter.post('/resources', requireRole('TEACHER'), validate(commitUpload),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const input = req.body as z.infer<typeof commitUpload>;
    const ext = assertUploadAllowed(input.filename, input.bytes); // re-checked, never trusted
    const folder = await prisma.folder.findUnique({ where: { id: input.folderId } });
    if (!folder) throw notFound('That folder no longer exists.');
    if (folder.teacherId !== me.id) throw forbidden('That folder is not yours.');
    if (!input.storageKey.startsWith(`teachers/${me.id}/`)) {
      throw forbidden('That storage key does not belong to your account.');
    }

    const resource = await prisma.resource.create({
      data: {
        folderId: folder.id, teacherId: me.id, name: input.filename, ext,
        bytes: input.bytes, storageKey: input.storageKey, mimeType: input.mimeType ?? null,
      },
    });
    res.status(201).json({ resource: publicResource(resource) });
  }));

/** Local-disk fallback target for the ticket when S3 is not configured. */
libraryRouter.post('/uploads/local', requireRole('TEACHER'),
  validate(z.object({ storageKey: z.string().min(1), dataBase64: z.string().min(1) })),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const { storageKey, dataBase64 } = req.body as { storageKey: string; dataBase64: string };
    if (isS3Configured()) throw badRequest('This installation uploads to S3. Use the presigned URL.');
    if (!storageKey.startsWith(`teachers/${me.id}/`)) throw forbidden('That storage key is not yours.');

    const root = resolve(env.LOCAL_UPLOAD_DIR);
    const target = resolve(join(root, storageKey));
    if (!target.startsWith(root + '/')) throw badRequest('Invalid storage key.');

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.byteLength > env.UPLOAD_MAX_BYTES) throw badRequest('That file is over the size limit.');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);
    res.json({ ok: true, bytes: buffer.byteLength });
  }));

libraryRouter.get('/resources/:id/url', asyncRoute(async (req, res) => {
  const me = actor(req);
  const resource = await prisma.resource.findUnique({ where: { id: String(req.params['id']) } });
  if (!resource) throw notFound('That file no longer exists.');

  const scope = await visibleTeacherIds(me.id, me.role);
  if (scope !== 'all' && !scope.includes(resource.teacherId)) throw notFound('That file no longer exists.');

  const url = await createDownloadUrl(resource.storageKey);
  res.json({ url, storageKey: resource.storageKey, expiresIn: url ? 300 : 0 });
}));

libraryRouter.delete('/resources/:id', requireRole('TEACHER', 'OWNER'),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const resource = await prisma.resource.findUnique({ where: { id: String(req.params['id']) } });
    if (!resource) throw notFound('That file no longer exists.');
    if (me.role === 'TEACHER' && resource.teacherId !== me.id) throw forbidden('That file is not yours.');
    await prisma.resource.delete({ where: { id: resource.id } });
    res.json({ ok: true });
  }));
