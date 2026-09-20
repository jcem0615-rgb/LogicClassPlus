/**
 * Live co-editing of the shared document.
 *
 * Yjs is a CRDT: every edit is a commutative update, so the order they arrive
 * in does not matter and there are no conflicts to resolve. The server holds
 * the authoritative Y.Doc for each open session, which buys three things a
 * pure relay cannot:
 *
 *   - someone joining late gets the current document, not an empty one;
 *   - edits survive both participants closing their tabs;
 *   - the document is persisted to Postgres, not to one participant's browser.
 *
 * Transport is the room's existing Socket.io channel, so membership is already
 * authenticated by the gateway before any of this runs.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { prisma } from '../prisma.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** How long after the last keystroke the document is written to Postgres. */
const PERSIST_DEBOUNCE_MS = 2_000;
/** How long an idle document is kept in memory after everyone leaves. */
const EVICT_AFTER_MS = 60_000;

interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<string>;
  persistTimer: NodeJS.Timeout | null;
  evictTimer: NodeJS.Timeout | null;
  loaded: Promise<void>;
  dirty: boolean;
}

const rooms = new Map<string, Room>();

export interface Broadcaster {
  toRoom(sessionId: string, message: Uint8Array, exceptSocketId?: string): void;
  toSocket(socketId: string, message: Uint8Array): void;
}

let broadcaster: Broadcaster | null = null;
export function setBroadcaster(b: Broadcaster): void { broadcaster = b; }

function getRoom(sessionId: string): Room {
  const existing = rooms.get(sessionId);
  if (existing) {
    if (existing.evictTimer) { clearTimeout(existing.evictTimer); existing.evictTimer = null; }
    return existing;
  }

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // the server is not a participant

  const room: Room = {
    doc, awareness, clients: new Set(),
    persistTimer: null, evictTimer: null, dirty: false,
    loaded: Promise.resolve(),
  };
  rooms.set(sessionId, room);

  // Seed from the last saved state before anyone's edits land.
  room.loaded = loadFromDatabase(sessionId, doc);

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    room.dirty = true;
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_SYNC);
    syncProtocol.writeUpdate(message, update);
    // `origin` is the socket the update came from; it already has it.
    broadcaster?.toRoom(sessionId, encoding.toUint8Array(message),
      typeof origin === 'string' ? origin : undefined);
    schedulePersist(sessionId, room);
  });

  awareness.on('update', (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const changed = added.concat(updated, removed);
    if (!changed.length) return;
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(message, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    broadcaster?.toRoom(sessionId, encoding.toUint8Array(message),
      typeof origin === 'string' ? origin : undefined);
  });

  return room;
}

async function loadFromDatabase(sessionId: string, doc: Y.Doc): Promise<void> {
  try {
    const saved = await prisma.sessionDocument.findUnique({
      where: { sessionId_kind: { sessionId, kind: 'DOCUMENT' } },
    });
    if (!saved?.content) return;

    // Documents saved before live editing existed are HTML, not a Yjs update.
    // Those are left alone: the editor seeds itself from them once, so a
    // teacher's earlier notes are not silently discarded.
    if (!saved.content.startsWith('y:')) return;

    Y.applyUpdate(doc, Buffer.from(saved.content.slice(2), 'base64'), 'load');
  } catch {
    // An unreadable saved state must not stop the class: start empty.
  }
}

function schedulePersist(sessionId: string, room: Room): void {
  if (room.persistTimer) return;
  room.persistTimer = setTimeout(() => {
    room.persistTimer = null;
    void persist(sessionId, room);
  }, PERSIST_DEBOUNCE_MS);
}

async function persist(sessionId: string, room: Room): Promise<void> {
  if (!room.dirty) return;
  room.dirty = false;
  const state = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64');
  try {
    await prisma.sessionDocument.upsert({
      where: { sessionId_kind: { sessionId, kind: 'DOCUMENT' } },
      create: { sessionId, kind: 'DOCUMENT', content: `y:${state}` },
      update: { content: `y:${state}` },
    });
  } catch {
    room.dirty = true; // keep it marked so the next tick tries again
  }
}

/** A client joined the document. Returns once the saved state is loaded. */
export async function join(sessionId: string, socketId: string): Promise<void> {
  const room = getRoom(sessionId);
  room.clients.add(socketId);
  await room.loaded;
}

export function leave(sessionId: string, socketId: string): void {
  const room = rooms.get(sessionId);
  if (!room) return;
  room.clients.delete(socketId);

  // Clear the cursors that socket was showing.
  const owned = ownedClients.get(socketId);
  if (owned?.size) {
    awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], socketId);
    ownedClients.delete(socketId);
  }

  if (room.clients.size > 0) return;

  void persist(sessionId, room);
  room.evictTimer = setTimeout(() => {
    const current = rooms.get(sessionId);
    if (!current || current.clients.size > 0) return;
    void persist(sessionId, current).then(() => {
      current.awareness.destroy();
      current.doc.destroy();
      rooms.delete(sessionId);
    });
  }, EVICT_AFTER_MS);
}

/** Yjs client ids announced by each socket, so a disconnect clears its cursor. */
const ownedClients = new Map<string, Set<number>>();

/**
 * One inbound protocol message. Replies go straight back to the sender; the
 * doc and awareness 'update' handlers above fan changes out to the room.
 */
export async function handleMessage(
  sessionId: string, socketId: string, payload: ArrayBuffer | Uint8Array,
): Promise<void> {
  const room = getRoom(sessionId);
  await room.loaded;

  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const decoder = decoding.createDecoder(data);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      // Passing the socket id as the transaction origin keeps the sender from
      // being sent back its own update.
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, socketId);
      if (encoding.length(encoder) > 1) {
        broadcaster?.toSocket(socketId, encoding.toUint8Array(encoder));
      }
      break;
    }
    case MESSAGE_AWARENESS: {
      const update = decoding.readVarUint8Array(decoder);
      // Remember whose socket each cursor belongs to, so it can be cleared
      // when they disconnect rather than lingering in everyone else's editor.
      const owned = ownedClients.get(socketId) ?? new Set<number>();
      for (const id of decodeClientIds(update)) owned.add(id);
      ownedClients.set(socketId, owned);
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, socketId);
      break;
    }
    default:
      break;
  }
}

/** The client ids an awareness update carries, so we know whose cursor is whose. */
function decodeClientIds(update: Uint8Array): number[] {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(decoding.readVarUint(decoder));
      decoding.readVarUint(decoder);        // clock
      decoding.readVarString(decoder);      // state json
    }
    return ids;
  } catch {
    return [];
  }
}

/** The current document's initial sync message, for a client that just joined. */
export async function syncStep1(sessionId: string): Promise<Uint8Array> {
  const room = getRoom(sessionId);
  await room.loaded;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  return encoding.toUint8Array(encoder);
}

/** Existing cursors, so a late joiner sees who else is in the document. */
export async function awarenessSnapshot(sessionId: string): Promise<Uint8Array | null> {
  const room = getRoom(sessionId);
  await room.loaded;
  const ids = [...room.awareness.getStates().keys()];
  if (!ids.length) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids));
  return encoding.toUint8Array(encoder);
}

/** Flush every open document — called on shutdown so nothing is lost. */
export async function flushAll(): Promise<void> {
  await Promise.all([...rooms.entries()].map(([sessionId, room]) => persist(sessionId, room)));
}
