import 'dotenv/config';
import { z } from 'zod';

const bool = (d: boolean) =>
  z.string().optional().transform((v) => (v == null || v === '' ? d : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4001),
  WEB_ORIGIN: z.string().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(24, 'JWT_SECRET must be at least 24 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // Sign-in attempts per IP per 15 minutes. Deliberately strict in production;
  // a looser default in development keeps local work and tests from tripping it.
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().optional(),

  SEED_OWNER_EMAIL: z.string().email().default('owner@logicclass.plus'),
  SEED_OWNER_PASSWORD: z.string().min(8).default('admin1234'),
  SEED_OWNER_NAME: z.string().default('Marisol Vega'),
  SEED_DEMO_DATA: bool(true),

  PAYROLL_GRACE_MINUTES: z.coerce.number().int().min(0).default(5),
  PAYROLL_LATE_PENALTY: z.coerce.number().min(1).default(1.5),
  PAYROLL_CURRENCY: z.string().length(3).default('USD'),

  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  LOCAL_UPLOAD_DIR: z.string().default('./var/uploads'),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  STUN_URLS: z.string().default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  TURN_URLS: z.string().default(''),
  TURN_STATIC_SECRET: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_PASSWORD: z.string().optional(),
  TURN_TTL_SECONDS: z.coerce.number().int().positive().default(6 * 3600),

  RECORDING_PROVIDER: z.enum(['none', 'livekit']).default('none'),
  RECORDING_PRESET: z.enum(['audio', '360p', '480p', '720p', '1080p']).default('720p'),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@logicclass.plus'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

export const env = parsed.data;

export const ALLOWED_ORIGINS = env.WEB_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

/** Extensions the upload pipeline accepts. Anything else is rejected before a key is issued. */
export const ALLOWED_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'mp3', 'wav', 'm4a', 'mp4', 'webm',
] as const;

export const isStripeConfigured = () => Boolean(env.STRIPE_SECRET_KEY);
export const isPushConfigured = () => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
export const isS3Configured = () =>
  Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
