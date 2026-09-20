import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, forbidden, notFound, payloadTooLarge } from '../lib/http-error.js';
import { actor, requireAuth } from '../middleware/auth.js';
import { assess, isSpeechConfigured, speechBlockedReason } from '../services/speech.js';

export const speechRouter = Router();
speechRouter.use(requireAuth);

/** Scoring is a paid upstream call, so it is capped per user. */
const assessLimit = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'production' ? 20 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anonymous',
  message: { error: { message: 'Too many attempts in a row. Wait a moment and try again.' } },
});

speechRouter.get('/status', (_req, res) => {
  res.json({
    configured: isSpeechConfigured(),
    reason: speechBlockedReason(),
    language: env.AZURE_SPEECH_LANGUAGE,
    provider: 'azure',
    maxAudioBytes: env.SPEECH_MAX_AUDIO_BYTES,
  });
});

const assessBody = z.object({
  referenceText: z.string().trim().min(1, 'A phrase to read is required.').max(1000),
  audioBase64: z.string().min(1, 'No audio was sent.'),
  sessionId: z.string().min(1).optional(),
  language: z.string().max(12).optional(),
});

speechRouter.post('/assess', assessLimit, validate(assessBody), asyncRoute(async (req, res) => {
  const me = actor(req);
  const input = req.body as z.infer<typeof assessBody>;

  const audio = Buffer.from(input.audioBase64, 'base64');
  if (audio.byteLength > env.SPEECH_MAX_AUDIO_BYTES) {
    throw payloadTooLarge(
      `That recording is ${(audio.byteLength / 1e6).toFixed(1)} MB, over the `
      + `${(env.SPEECH_MAX_AUDIO_BYTES / 1e6).toFixed(0)} MB limit. Record a shorter attempt.`,
    );
  }
  if (!audio.byteLength) throw badRequest('That recording is empty.');

  // A session is optional — a student can practise alone — but if one is named
  // it must be theirs.
  if (input.sessionId) {
    const session = await prisma.classSession.findUnique({ where: { id: input.sessionId } });
    if (!session) throw notFound('That session no longer exists.');
    if (me.role !== 'OWNER' && session.teacherId !== me.id && session.studentId !== me.id) {
      throw forbidden('That session is not yours.');
    }
  }

  const result = await assess(audio, input.referenceText, input.language ?? env.AZURE_SPEECH_LANGUAGE);

  // Attributed to the student: in a lesson the teacher may press the button,
  // but the attempt belongs to whoever is being assessed.
  let studentId = me.id;
  if (input.sessionId && me.role !== 'STUDENT') {
    const session = await prisma.classSession.findUnique({ where: { id: input.sessionId } });
    if (session) studentId = session.studentId;
  }

  const attempt = await prisma.pronunciationAttempt.create({
    data: {
      studentId,
      sessionId: input.sessionId ?? null,
      referenceText: input.referenceText,
      language: input.language ?? env.AZURE_SPEECH_LANGUAGE,
      recognizedText: result.recognizedText,
      accuracyScore: result.scores.accuracy,
      fluencyScore: result.scores.fluency,
      completenessScore: result.scores.completeness,
      pronunciationScore: result.scores.pronunciation,
      prosodyScore: result.scores.prosody,
      durationSeconds: result.durationSeconds,
      words: result.words as unknown as Prisma.InputJsonValue,
      provider: result.provider,
    },
  });

  res.json({ attempt: { id: attempt.id, createdAt: attempt.createdAt.toISOString() }, ...result });
}));

/** Past attempts, so progress on a sound is visible over weeks. */
speechRouter.get('/attempts', validate(z.object({
  studentId: z.string().optional(),
  sessionId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
}), 'query'), asyncRoute(async (req, res) => {
  const me = actor(req);
  const q = req.query as unknown as { studentId?: string; sessionId?: string; limit: number };

  const where: Prisma.PronunciationAttemptWhereInput = {};
  if (me.role === 'STUDENT') {
    where.studentId = me.id;
  } else if (q.studentId) {
    where.studentId = q.studentId;
  } else if (me.role === 'TEACHER') {
    // A teacher sees attempts from their own sessions only.
    where.session = { teacherId: me.id };
  }
  if (q.sessionId) where.sessionId = q.sessionId;

  const rows = await prisma.pronunciationAttempt.findMany({
    where, orderBy: { createdAt: 'desc' }, take: q.limit,
  });

  res.json({
    attempts: rows.map((a) => ({
      id: a.id,
      studentId: a.studentId,
      sessionId: a.sessionId,
      referenceText: a.referenceText,
      recognizedText: a.recognizedText,
      scores: {
        accuracy: a.accuracyScore, fluency: a.fluencyScore,
        completeness: a.completenessScore, pronunciation: a.pronunciationScore,
        prosody: a.prosodyScore,
      },
      words: a.words,
      durationSeconds: a.durationSeconds,
      createdAt: a.createdAt.toISOString(),
    })),
  });
}));
