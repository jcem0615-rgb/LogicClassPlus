/**
 * Bundle entry for the shared document.
 *
 * Tiptap and Yjs are real npm packages, so they are bundled into
 * vendor/editor.bundle.js and served from this app. A self-hosted install
 * pulls nothing from a CDN, which is the whole point of shipping the client
 * as static files.
 *
 * Build:  npm run -w apps/pwa build
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { writeSyncStep1, writeSyncStep2, writeUpdate, readSyncMessage } from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

window.LCEditor = {
  Editor, StarterKit, Collaboration, CollaborationCursor,
  Y, Awareness,
  awareness: { encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates },
  sync: { writeSyncStep1, writeSyncStep2, writeUpdate, readSyncMessage },
  encoding, decoding,
};
