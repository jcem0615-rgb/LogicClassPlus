import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { Role } from '@prisma/client';
import { ALLOWED_ORIGINS } from '../env.js';
import { prisma } from '../prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { publicMessage } from '../lib/serialize.js';

interface SocketUser { id: string; role: Role; name: string }

let io: Server | null = null;

/** Every socket joins a private room named after its user id. */
const userRoom = (userId: string) => `user:${userId}`;
const classRoom = (sessionId: string) => `classroom:${sessionId}`;

export function initGateway(server: HttpServer): Server {
  io = new Server(server, {
    cors: { origin: ALLOWED_ORIGINS, credentials: true },
    maxHttpBufferSize: 2e6,
  });

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth?.['token'] as string | undefined)
      ?? (socket.handshake.query?.['token'] as string | undefined);
    const payload = token ? verifyToken(token) : null;
    if (!payload) { next(new Error('unauthorized')); return; }
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== 'ACTIVE') { next(new Error('unauthorized')); return; }
    (socket.data as { user: SocketUser }).user = { id: user.id, role: user.role, name: user.name };
    next();
  });

  io.on('connection', (socket) => {
    const user = (socket.data as { user: SocketUser }).user;
    void socket.join(userRoom(user.id));
    socket.emit('notification:ready', { userId: user.id });

    /* ---------------- classroom lifecycle ---------------- */
    socket.on('classroom:join', async (sessionId: string, ack?: (r: unknown) => void) => {
      const allowed = await canEnter(user, sessionId);
      if (!allowed) { ack?.({ error: 'You are not part of that session.' }); return; }
      await socket.join(classRoom(sessionId));
      socket.to(classRoom(sessionId)).emit('classroom:peer-joined', { userId: user.id, name: user.name });
      const peers = await peersIn(sessionId, socket.id);
      ack?.({ ok: true, peers });
    });

    socket.on('classroom:leave', (sessionId: string) => {
      void socket.leave(classRoom(sessionId));
      socket.to(classRoom(sessionId)).emit('classroom:peer-left', { userId: user.id });
    });

    /* ---------------- WebRTC signalling relay ----------------
       The server never touches media — it only forwards the SDP and
       ICE candidates the two browsers need to connect directly. */
    socket.on('classroom:signal', (payload: { sessionId: string; to?: string; data: unknown }) => {
      if (!payload?.sessionId) return;
      const envelope = { from: user.id, data: payload.data };
      if (payload.to) io?.to(payload.to).emit('classroom:signal', envelope);
      else socket.to(classRoom(payload.sessionId)).emit('classroom:signal', envelope);
    });

    /* ---------------- shared surfaces ---------------- */
    socket.on('classroom:board:stroke', (payload: { sessionId: string; stroke: unknown }) => {
      if (!payload?.sessionId) return;
      socket.to(classRoom(payload.sessionId)).emit('classroom:board:stroke', {
        from: user.id, stroke: payload.stroke,
      });
    });

    socket.on('classroom:board:clear', (payload: { sessionId: string }) => {
      if (!payload?.sessionId) return;
      socket.to(classRoom(payload.sessionId)).emit('classroom:board:clear', { from: user.id });
    });

    /* Tiptap + Yjs transport. Updates are opaque binary blobs to the server;
       it fans them out and the CRDT on each client merges them. */
    socket.on('classroom:doc:update', (payload: { sessionId: string; update: unknown }) => {
      if (!payload?.sessionId) return;
      socket.to(classRoom(payload.sessionId)).emit('classroom:doc:update', {
        from: user.id, update: payload.update,
      });
    });

    socket.on('classroom:presence', (payload: { sessionId: string; state: unknown }) => {
      if (!payload?.sessionId) return;
      socket.to(classRoom(payload.sessionId)).emit('classroom:presence', {
        from: user.id, name: user.name, state: payload.state,
      });
    });

    /* ---------------- chat ---------------- */
    socket.on('chat:send', async (
      payload: { sessionId: string; text: string },
      ack?: (r: unknown) => void,
    ) => {
      const text = String(payload?.text ?? '').trim();
      if (!payload?.sessionId || !text) { ack?.({ error: 'Empty message.' }); return; }
      if (text.length > 4000) { ack?.({ error: 'That message is too long.' }); return; }
      if (!(await canEnter(user, payload.sessionId))) { ack?.({ error: 'Not your session.' }); return; }

      const message = await prisma.chatMessage.create({
        data: { sessionId: payload.sessionId, senderId: user.id, body: text },
      });
      const wire = publicMessage(message);
      io?.to(classRoom(payload.sessionId)).emit('chat:message', wire);
      ack?.({ ok: true, message: wire });
    });

    socket.on('chat:typing', (payload: { sessionId: string }) => {
      if (!payload?.sessionId) return;
      socket.to(classRoom(payload.sessionId)).emit('chat:typing', { from: user.id, name: user.name });
    });

    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (room.startsWith('classroom:')) {
          socket.to(room).emit('classroom:peer-left', { userId: user.id });
        }
      }
    });
  });

  return io;
}

async function canEnter(user: SocketUser, sessionId: string): Promise<boolean> {
  if (user.role === 'OWNER') return true;
  const session = await prisma.classSession.findUnique({
    where: { id: sessionId },
    select: { teacherId: true, studentId: true },
  });
  if (!session) return false;
  return session.teacherId === user.id || session.studentId === user.id;
}

async function peersIn(sessionId: string, exceptSocketId: string) {
  if (!io) return [];
  const sockets = await io.in(classRoom(sessionId)).fetchSockets();
  return sockets
    .filter((s) => s.id !== exceptSocketId)
    .map((s) => {
      const u = (s.data as { user: SocketUser }).user;
      return { socketId: s.id, userId: u.id, name: u.name };
    });
}

/** Used by the REST layer to push a notification down an open socket. */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(userRoom(userId)).emit(event, payload);
}

export function emitToSession(sessionId: string, event: string, payload: unknown): void {
  io?.to(classRoom(sessionId)).emit(event, payload);
}
