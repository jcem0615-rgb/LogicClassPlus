import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { ALLOWED_ORIGINS, env, isPushConfigured, isS3Configured, isStripeConfigured } from './env.js';
import { HttpError } from './lib/http-error.js';
import { attachUser } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { libraryRouter } from './routes/library.js';
import { announcementsRouter } from './routes/announcements.js';
import { classesRouter } from './routes/classes.js';
import { attendanceRouter } from './routes/attendance.js';
import { payrollRouter } from './routes/payroll.js';
import { billingRouter } from './routes/billing.js';
import { notificationsRouter } from './routes/notifications.js';
import { stripeWebhookRouter } from './routes/stripe-webhook.js';
import { realtimeRouter } from './routes/realtime.js';
import { recordingsRouter, recordingWebhookRouter } from './routes/recordings.js';
import { isRecordingConfigured } from './services/recording.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin(origin, callback) {
      // Same-origin and non-browser callers send no Origin header.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) { callback(null, true); return; }
      callback(new HttpError(403, 'This origin is not allowed to call the API.', 'cors'));
    },
    credentials: true,
  }));

  // Both webhooks verify a signature over the raw body, so they must precede
  // express.json(), which would otherwise consume and re-serialise it.
  app.use('/api/stripe/webhook', stripeWebhookRouter);
  app.use('/api/recordings/webhook', recordingWebhookRouter);

  app.use(express.json({ limit: '30mb' }));
  app.use(cookieParser());
  app.use(attachUser);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'logicclass-server',
      time: new Date().toISOString(),
      integrations: {
        stripe: isStripeConfigured(),
        webPush: isPushConfigured(),
        s3: isS3Configured(),
        recording: isRecordingConfigured(),
      },
      policy: {
        uploadMaxBytes: env.UPLOAD_MAX_BYTES,
        payrollGraceMinutes: env.PAYROLL_GRACE_MINUTES,
        payrollLatePenalty: env.PAYROLL_LATE_PENALTY,
        currency: env.PAYROLL_CURRENCY,
      },
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/library', libraryRouter);
  app.use('/api/announcements', announcementsRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/payroll', payrollRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/realtime', realtimeRouter);
  app.use('/api/recordings', recordingsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: { message: `No route for ${req.method} ${req.path}`, code: 'not_found' } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { message: err.message, code: err.code, details: err.details } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: { message: err.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' } });
      return;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        res.status(409).json({ error: { message: 'That record already exists.', code: 'conflict' } });
        return;
      }
      if (err.code === 'P2025') {
        res.status(404).json({ error: { message: 'That record no longer exists.', code: 'not_found' } });
        return;
      }
    }
    // eslint-disable-next-line no-console
    console.error('[unhandled]', err);
    res.status(500).json({
      error: {
        message: env.NODE_ENV === 'production'
          ? 'Something went wrong on our side. Try again.'
          : String((err as Error)?.message ?? err),
        code: 'internal',
      },
    });
  });

  return app;
}
