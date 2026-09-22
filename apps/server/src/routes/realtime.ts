import { createHmac } from 'node:crypto';
import { Router } from 'express';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { asyncRoute } from '../lib/validate.js';
import { forbidden, notFound } from '../lib/http-error.js';
import { actor, requireAuth } from '../middleware/auth.js';
import { isRecordingConfigured, livekitToken, recordingBlockedReason, roomNameFor } from '../services/recording.js';

export const realtimeRouter = Router();
realtimeRouter.use(requireAuth);

/**
 * ICE servers for the browser's RTCPeerConnection.
 *
 * STUN alone fails for participants behind symmetric NAT or strict corporate
 * firewalls — which, on a platform spanning these timezones, is a routine case,
 * not an edge one. TURN credentials are minted per request and expire, using
 * coturn's REST scheme (`use-auth-secret`), so the long-lived secret never
 * reaches a browser.
 */
realtimeRouter.get('/ice', (req, res) => {
  const me = actor(req);
  const iceServers: Array<{ urls: string[]; username?: string; credential?: string }> = [
    { urls: env.STUN_URLS.split(',').map((u) => u.trim()).filter(Boolean) },
  ];

  const turnUrls = env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean);
  if (turnUrls.length) {
    if (env.TURN_STATIC_SECRET) {
      const ttl = env.TURN_TTL_SECONDS;
      const username = `${Math.floor(Date.now() / 1000) + ttl}:${me.id}`;
      const credential = createHmac('sha1', env.TURN_STATIC_SECRET).update(username).digest('base64');
      iceServers.push({ urls: turnUrls, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_PASSWORD) {
      iceServers.push({ urls: turnUrls, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD });
    }
  }

  res.json({
    iceServers,
    // Without TURN, a pair that cannot connect directly simply will not connect.
    turnConfigured: turnUrls.length > 0,
    iceTransportPolicy: 'all',
  });
});

/**
 * Credentials for joining the room through the media server.
 *
 * Which transport a classroom uses is decided here: when a media server is
 * configured the browser publishes into it, and when one is not, this answers
 * 503 and the client falls back to a direct peer connection. The difference
 * matters because recording only exists for media the server can see —
 * peer-to-peer gives it nothing to capture.
 */
realtimeRouter.get('/sfu/:sessionId', asyncRoute(async (req, res) => {
  const me = actor(req);
  const session = await prisma.classSession.findUnique({
    where: { id: String(req.params['sessionId']) },
    select: { id: true, teacherId: true, studentId: true },
  });
  if (!session) throw notFound('That session no longer exists.');
  if (me.role !== 'OWNER' && session.teacherId !== me.id && session.studentId !== me.id) {
    throw forbidden('Only the teacher and student in this session can join it.');
  }

  if (!isRecordingConfigured()) {
    res.status(503).json({
      error: {
        message: recordingBlockedReason() ?? 'No media server is configured.',
        code: 'no_media_server',
      },
    });
    return;
  }

  res.json({
    url: env.LIVEKIT_URL,
    room: roomNameFor(session.id),
    token: livekitToken({ room: roomNameFor(session.id), identity: me.id }),
    identity: me.id,
    // Recording additionally needs somewhere to put the file.
    canRecord: recordingBlockedReason() === null,
  });
}));
