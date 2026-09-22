/**
 * Bundle entry for the LiveKit client.
 *
 * Bundled and committed for the same reason as Tiptap and the Socket.io
 * client: a self-hosted install should not depend on a CDN. Loaded only when
 * a room actually uses the SFU.
 *
 * Build:  npm run -w apps/pwa build
 */
import {
  Room, RoomEvent, Track, ConnectionState, DisconnectReason,
  createLocalTracks, LocalAudioTrack, LocalVideoTrack, setLogLevel,
} from 'livekit-client';

window.LCLiveKit = {
  Room, RoomEvent, Track, ConnectionState, DisconnectReason,
  createLocalTracks, LocalAudioTrack, LocalVideoTrack, setLogLevel,
};
