import { createHmac } from 'node:crypto';
import { Router } from 'express';
import { env } from '../env.js';
import { actor, requireAuth } from '../middleware/auth.js';

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
