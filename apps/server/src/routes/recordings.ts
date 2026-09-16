import { Router, raw } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import {
  estimateBytes, isRecordingConfigured, livekitToken, PRESETS, recordingBlockedReason,
  roomNameFor, startRecording, stopRecording, verifyWebhook, type Preset,
} from '../services/recording.js';
import { notify } from '../services/notifications.js';
import { emitToSession } from '../realtime/gateway.js';

export const recordingsRouter = Router();

/* ---------------- webhook (no auth middleware: LiveKit signs it) ----------------
   Mounted before express.json() so the raw bytes survive for the signature. */
export const recordingWebhookRouter = Router();

recordingWebhookRouter.post('/', raw({ type: '*/*' }), (req, res) => {
  if (!isRecordingConfigured()) {
    res.status(503).json({ error: { message: 'Recording is not configured on this server.' } });
    return;
  }
  let event: { event?: string; egressInfo?: Record<string, unknown> };
  try {
    event = verifyWebhook(req.body as Buffer, req.headers.authorization) as typeof event;
  } catch (err) {
    res.status(400).json({ error: { message: (err as Error).message } });
    return;
  }
  res.json({ received: true });
  void handleEgressEvent(event);
});

async function handleEgressEvent(event: { event?: string; egressInfo?: Record<string, unknown> }): Promise<void> {
  if (event.event !== 'egress_ended' || !event.egressInfo) return;
  const info = event.egressInfo;
  const egressId = String(info['egressId'] ?? info['egress_id'] ?? '');
  if (!egressId) return;

  const session = await prisma.classSession.findFirst({ where: { recordingEgressId: egressId } });
  if (!session) return;

  // LiveKit reports one result per configured output.
  const files = (info['fileResults'] ?? info['file_results']) as Array<Record<string, unknown>> | undefined;
  const file = files?.[0];
  const location = file ? String(file['location'] ?? file['filename'] ?? '') : '';
  const size = file ? Number(file['size'] ?? 0) : 0;
  const durationNs = file ? Number(file['duration'] ?? 0) : 0;

  await prisma.classSession.update({
    where: { id: session.id },
    data: {
      recordingUrl: location || null,
      recordingBytes: size ? BigInt(size) : null,
      recordingSeconds: durationNs ? Math.round(durationNs / 1e9) : null,
    },
  });

  emitToSession(session.id, 'classroom:recording', { status: 'ready', bytes: size });
  await notify({
    userId: session.teacherId, type: 'recording', title: 'Recording ready',
    body: `${session.topic} — ${(size / 1e9).toFixed(2)} GB.`, url: '/#/classes',
  });
}

/* ---------------- authenticated routes ---------------- */
recordingsRouter.use(requireAuth);

/** What recording would cost for a session of this length, before starting one. */
recordingsRouter.get('/estimate', validate(z.object({
  minutes: z.coerce.number().int().min(1).max(480).default(60),
  preset: z.enum(['audio', '360p', '480p', '720p', '1080p']).optional(),
}), 'query'), (req, res) => {
  const q = req.query as unknown as { minutes: number; preset?: Preset };
  const preset = q.preset ?? (env.RECORDING_PRESET as Preset);
  res.json({
    minutes: q.minutes,
    preset,
    bytes: estimateBytes(q.minutes, preset),
    perHourBytes: estimateBytes(60, preset),
    presets: Object.fromEntries(
      (Object.keys(PRESETS) as Preset[]).map((key) => [key, {
        label: PRESETS[key].label,
        bytes: estimateBytes(q.minutes, key),
      }]),
    ),
    configured: isRecordingConfigured(),
    reason: recordingBlockedReason(),
  });
});

/** Storage actually consumed, so the bill is never a surprise. */
recordingsRouter.get('/usage', requireRole('OWNER'), asyncRoute(async (_req, res) => {
  const rows = await prisma.classSession.findMany({
    where: { recordingBytes: { not: null } },
    select: { recordingBytes: true, recordingSeconds: true, startsAt: true },
  });
  const totalBytes = rows.reduce((sum, r) => sum + Number(r.recordingBytes ?? 0n), 0);
  const totalSeconds = rows.reduce((sum, r) => sum + (r.recordingSeconds ?? 0), 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
  const recent = rows.filter((r) => r.startsAt >= thirtyDaysAgo);
  const recentBytes = recent.reduce((sum, r) => sum + Number(r.recordingBytes ?? 0n), 0);

  res.json({
    recordings: rows.length,
    totalBytes,
    totalHours: totalSeconds / 3600,
    last30DaysBytes: recentBytes,
    projectedAnnualBytes: recentBytes * 12,
    preset: env.RECORDING_PRESET,
  });
}));

/**
 * A LiveKit join token. The browser uses this to publish into the SFU instead
 * of connecting peer-to-peer — recording only exists for SFU-routed media.
 */
recordingsRouter.get('/token/:sessionId', asyncRoute(async (req, res) => {
  const me = actor(req);
  const session = await prisma.classSession.findUnique({ where: { id: String(req.params['sessionId']) } });
  if (!session) throw notFound('That session no longer exists.');
  if (me.role !== 'OWNER' && session.teacherId !== me.id && session.studentId !== me.id) {
    throw forbidden('Only the teacher and student in this session can join it.');
  }
  if (!isRecordingConfigured()) {
    res.status(503).json({ error: { message: recordingBlockedReason(), code: 'not_configured' } });
    return;
  }
  res.json({
    url: env.LIVEKIT_URL,
    room: roomNameFor(session.id),
    token: livekitToken({ room: roomNameFor(session.id), identity: me.id }),
  });
}));

recordingsRouter.post('/:sessionId/start', requireRole('TEACHER', 'OWNER'), asyncRoute(async (req, res) => {
  const me = actor(req);
  const session = await prisma.classSession.findUnique({ where: { id: String(req.params['sessionId']) } });
  if (!session) throw notFound('That session no longer exists.');
  if (me.role === 'TEACHER' && session.teacherId !== me.id) throw forbidden('That is not your session.');

  const blocked = recordingBlockedReason();
  if (blocked) {
    res.status(503).json({ error: { message: blocked, code: 'not_configured' } });
    return;
  }
  if (session.recordingEgressId) throw badRequest('This session is already recording.');

  const egress = await startRecording(session.id);
  await prisma.classSession.update({
    where: { id: session.id }, data: { recordingEgressId: egress.egressId },
  });

  // Both participants are told, every time. Recording a person silently is not
  // a feature — it is a problem, and in many places it is unlawful.
  emitToSession(session.id, 'classroom:recording', { status: 'started' });
  await notify({
    userId: session.studentId, type: 'recording', title: 'This class is being recorded',
    body: `${session.topic} — recording started by your teacher.`, url: `/#/room/${session.id}`,
  });

  res.status(201).json({
    egressId: egress.egressId,
    estimatedBytes: estimateBytes(session.minutes),
    preset: env.RECORDING_PRESET,
  });
}));

recordingsRouter.post('/:sessionId/stop', requireRole('TEACHER', 'OWNER'), asyncRoute(async (req, res) => {
  const session = await prisma.classSession.findUnique({ where: { id: String(req.params['sessionId']) } });
  if (!session) throw notFound('That session no longer exists.');
  if (!session.recordingEgressId) throw badRequest('This session is not recording.');

  await stopRecording(session.recordingEgressId);
  emitToSession(session.id, 'classroom:recording', { status: 'stopping' });
  res.json({ ok: true, note: 'The file appears once the media server finishes uploading it.' });
}));
