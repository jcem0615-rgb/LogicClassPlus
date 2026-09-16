/**
 * Class recording.
 *
 * Browser-to-browser WebRTC gives the server no stream to record, so recording
 * is delegated to a media server. LiveKit is the provider wired here: it is
 * open source, self-hostable, and its Egress service composites both
 * participants into one file and uploads it straight to S3/R2 — the recording
 * never passes through this API.
 *
 * With RECORDING_PROVIDER=none every entry point below reports that recording
 * is unavailable rather than pretending a file exists.
 */
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env, isS3Configured } from '../env.js';

export type Preset = 'audio' | '360p' | '480p' | '720p' | '1080p';

/**
 * Bitrates used for both the egress settings and the size estimate, so the
 * figure shown in the UI is the one the encoder is actually told to produce.
 * Audio is Opus; video is H.264 in an MP4 container.
 */
export const PRESETS: Record<Preset, { width: number; height: number; fps: number; videoBps: number; audioBps: number; label: string }> = {
  audio:   { width: 0,    height: 0,    fps: 0,  videoBps: 0,         audioBps: 48_000, label: 'Audio only' },
  '360p':  { width: 640,  height: 360,  fps: 24, videoBps: 400_000,   audioBps: 48_000, label: '360p' },
  '480p':  { width: 854,  height: 480,  fps: 24, videoBps: 700_000,   audioBps: 48_000, label: '480p' },
  '720p':  { width: 1280, height: 720,  fps: 30, videoBps: 1_500_000, audioBps: 48_000, label: '720p' },
  '1080p': { width: 1920, height: 1080, fps: 30, videoBps: 4_000_000, audioBps: 64_000, label: '1080p' },
};

const CONTAINER_OVERHEAD = 1.03;

/** Bytes a recording of this length is expected to occupy. */
export function estimateBytes(minutes: number, preset: Preset = env.RECORDING_PRESET as Preset): number {
  const p = PRESETS[preset] ?? PRESETS['720p'];
  const bitsPerSecond = p.videoBps + p.audioBps;
  return Math.round((bitsPerSecond * minutes * 60 / 8) * CONTAINER_OVERHEAD);
}

export function isRecordingConfigured(): boolean {
  return env.RECORDING_PROVIDER === 'livekit'
    && Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

/** Why recording cannot run, in words worth showing a user. */
export function recordingBlockedReason(): string | null {
  if (env.RECORDING_PROVIDER === 'none') {
    return 'No media server is configured. Peer-to-peer WebRTC produces no server-side stream, '
      + 'so set RECORDING_PROVIDER=livekit and point LIVEKIT_URL at an SFU to enable recording.';
  }
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return 'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must all be set.';
  }
  if (!isS3Configured()) {
    return 'Recordings are uploaded straight to object storage by the media server, so S3_BUCKET '
      + 'and its credentials must be configured.';
  }
  return null;
}

interface GrantOptions {
  room: string;
  identity: string;
  canPublish?: boolean;
  roomRecord?: boolean;
  ttlSeconds?: number;
}

/**
 * A LiveKit access token. The same signing key authenticates both a
 * participant joining a room and this server calling the Egress API.
 */
export function livekitToken(opts: GrantOptions): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: env.LIVEKIT_API_KEY,
    sub: opts.identity,
    nbf: now - 10,
    exp: now + (opts.ttlSeconds ?? 6 * 3600),
    jti: `${opts.identity}-${now}`,
    video: {
      room: opts.room,
      roomJoin: opts.canPublish !== false,
      canPublish: opts.canPublish !== false,
      canSubscribe: true,
      canPublishData: true,
      roomRecord: opts.roomRecord === true,
    },
  };
  return jwt.sign(payload, env.LIVEKIT_API_SECRET!, { algorithm: 'HS256' });
}

/** Room name for a session. Stable, so a reconnecting participant lands back. */
export const roomNameFor = (sessionId: string): string => `lc-session-${sessionId}`;

async function twirp<T>(service: string, method: string, body: unknown): Promise<T> {
  const token = livekitToken({ room: '*', identity: 'logicclass-server', roomRecord: true, ttlSeconds: 600 });
  const res = await fetch(`${env.LIVEKIT_URL}/twirp/livekit.${service}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LiveKit ${method} failed (${res.status}): ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface EgressInfo { egressId: string; status?: string }

/**
 * Starts a room-composite egress: one file containing both participants,
 * written by the media server directly to the configured bucket.
 */
export async function startRecording(sessionId: string): Promise<EgressInfo> {
  const preset = (env.RECORDING_PRESET as Preset) ?? '720p';
  const p = PRESETS[preset] ?? PRESETS['720p'];
  const filepath = `recordings/${sessionId}/${Date.now()}.mp4`;

  return twirp<EgressInfo>('Egress', 'StartRoomCompositeEgress', {
    room_name: roomNameFor(sessionId),
    layout: 'speaker',
    audio_only: preset === 'audio',
    file_outputs: [{
      file_type: preset === 'audio' ? 'OGG' : 'MP4',
      filepath,
      s3: {
        access_key: env.S3_ACCESS_KEY_ID,
        secret: env.S3_SECRET_ACCESS_KEY,
        bucket: env.S3_BUCKET,
        region: env.S3_REGION,
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, force_path_style: true } : {}),
      },
    }],
    ...(preset === 'audio' ? {} : {
      preset: undefined,
      advanced: {
        width: p.width, height: p.height, framerate: p.fps,
        video_bitrate: Math.round(p.videoBps / 1000),
        audio_bitrate: Math.round(p.audioBps / 1000),
      },
    }),
  });
}

export async function stopRecording(egressId: string): Promise<EgressInfo> {
  return twirp<EgressInfo>('Egress', 'StopEgress', { egress_id: egressId });
}

/**
 * LiveKit signs webhooks with the API secret: the JWT's `sha256` claim is the
 * digest of the raw body, so a replayed body with a different payload fails.
 */
export function verifyWebhook(rawBody: Buffer, authHeader: string | undefined): unknown {
  if (!authHeader) throw new Error('Missing webhook signature.');
  const decoded = jwt.verify(authHeader, env.LIVEKIT_API_SECRET!, { algorithms: ['HS256'] });
  if (typeof decoded === 'string') throw new Error('Malformed webhook token.');
  const expected = createHash('sha256').update(rawBody).digest('base64');
  if (decoded['sha256'] !== expected) throw new Error('Webhook body does not match its signature.');
  return JSON.parse(rawBody.toString('utf8'));
}
