/**
 * Socket.io connection, shared by the whole app.
 *
 * Handlers are registered against this module rather than the socket, so they
 * survive a reconnect — a class does not lose its chat because the wifi
 * blinked.
 */
import { io, type Socket } from 'socket.io-client';
import { apiUrl, getToken } from './api';

type Handler = (payload: unknown) => void;

let socket: Socket | null = null;
const handlers = new Map<string, Set<Handler>>();

function bind(event: string): void {
  if (!socket) return;
  socket.on(event, (payload: unknown) => {
    handlers.get(event)?.forEach((fn) => fn(payload));
  });
}

export function connectSocket(): Socket | null {
  const token = getToken();
  if (!token) return null;
  if (socket?.connected) return socket;
  socket?.close();

  socket = io(apiUrl(), { auth: { token }, transports: ['websocket', 'polling'] });
  handlers.forEach((_set, event) => bind(event));
  return socket;
}

export function on<T>(event: string, fn: (payload: T) => void): () => void {
  if (!handlers.has(event)) {
    handlers.set(event, new Set());
    bind(event);
  }
  const handler = fn as Handler;
  handlers.get(event)!.add(handler);
  return () => { handlers.get(event)?.delete(handler); };
}

export function emit(event: string, ...args: unknown[]): void {
  socket?.emit(event, ...args);
}

export function disconnectSocket(): void {
  socket?.close();
  socket = null;
}

export const socketId = (): string | undefined => socket?.id;
