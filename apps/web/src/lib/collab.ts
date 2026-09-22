/**
 * Yjs over the room's Socket.io channel.
 *
 * The server holds the authoritative document, so this speaks the standard
 * y-protocols sync and awareness frames to it rather than to the other
 * browser: a late joiner gets the current text, and it survives both tabs
 * closing.
 */
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates }
  from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { emit, on } from './socket';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export interface CollabUser { id: string; name: string; color: string }

export class SocketProvider {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  private destroyed = false;
  private synced = false;
  private unsubscribe: () => void;

  constructor(
    private readonly sessionId: string,
    user: CollabUser,
    private readonly onSynced?: () => void,
  ) {
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalStateField('user', { name: user.name, color: user.color });

    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    this.unsubscribe = on<{ sessionId: string; data: ArrayBuffer | Uint8Array }>(
      'classroom:doc:message', this.handleMessage);

    emit('classroom:doc:open', sessionId, (ack: { error?: string } | undefined) => {
      if (this.destroyed || ack?.error) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
    });
  }

  private send(bytes: Uint8Array): void {
    emit('classroom:doc:message', { sessionId: this.sessionId, data: bytes });
  }

  private handleMessage = (payload: { sessionId: string; data: ArrayBuffer | Uint8Array }): void => {
    if (this.destroyed || !payload?.data) return;
    const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
    const decoder = decoding.createDecoder(bytes);
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);

    if (type === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      // `this` as the origin stops the update handler echoing the server's
      // own changes straight back at it.
      readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
      if (!this.synced) { this.synced = true; this.onSynced?.(); }
    } else if (type === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), 'remote');
    }
  };

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (this.destroyed || origin === this) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  private handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown,
  ): void => {
    if (this.destroyed || origin === 'remote') return;
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (!changed.length) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changed));
    this.send(encoding.toUint8Array(encoder));
  };

  get isSynced(): boolean { return this.synced; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { removeAwarenessStates(this.awareness, [this.doc.clientID], 'local'); } catch { /* nothing to clear */ }
    emit('classroom:doc:close', this.sessionId);
    this.unsubscribe();
    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }
}
