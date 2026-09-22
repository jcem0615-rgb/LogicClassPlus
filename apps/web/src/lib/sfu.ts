/**
 * Media through LiveKit.
 *
 * The alternative to a direct peer connection, and the only transport that can
 * be recorded: peer-to-peer media never reaches the server.
 */
import {
  Room, RoomEvent, Track,
  type LocalTrackPublication, type RemoteTrack, type RemoteParticipant,
} from 'livekit-client';

type Events = {
  'remote-track': { track: RemoteTrack; participant: RemoteParticipant };
  'remote-track-gone': { track: RemoteTrack };
  peer: { identity: string; present: boolean };
  state: { state: string };
  recording: { active: boolean };
};

export class SfuSession {
  private room: Room | null = null;
  private published: LocalTrackPublication[] = [];
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn as (payload: never) => void);
  }

  private fire<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners.get(event)?.forEach((fn) => (fn as (p: Events[K]) => void)(payload));
  }

  async connect(url: string, token: string, stream: MediaStream | null): Promise<Room> {
    if (this.room) return this.room;

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // A class is two people and a shared surface; 720p is the ceiling worth
      // paying for, and it matches the recording preset.
      videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
    });
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      this.fire('remote-track', { track, participant });
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      this.fire('remote-track-gone', { track });
    });
    room.on(RoomEvent.ParticipantConnected, (p) => {
      this.fire('peer', { identity: p.identity, present: true });
    });
    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      this.fire('peer', { identity: p.identity, present: false });
    });
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      this.fire('state', { state: String(state) });
    });
    room.on(RoomEvent.Disconnected, () => this.fire('state', { state: 'disconnected' }));
    // The server tells every participant when egress starts or stops.
    room.on(RoomEvent.RecordingStatusChanged, (active) => {
      this.fire('recording', { active });
    });

    await room.connect(url, token);
    this.fire('state', { state: 'connected' });

    if (stream) {
      this.published = await Promise.all(stream.getTracks().map((track) =>
        room.localParticipant.publishTrack(track, {
          name: track.kind === 'video' ? 'camera' : 'microphone',
          source: track.kind === 'video' ? Track.Source.Camera : Track.Source.Microphone,
        })));
    }
    return room;
  }

  async replaceTracks(stream: MediaStream): Promise<boolean> {
    if (!this.room) return false;
    await Promise.all(stream.getTracks().map(async (track) => {
      const publication = this.published.find((p) => p.track?.kind === track.kind);
      if (publication?.track) return publication.track.replaceTrack(track);
      await this.room!.localParticipant.publishTrack(track);
      return undefined;
    }));
    return true;
  }

  setEnabled(kind: 'audio' | 'video', enabled: boolean): void {
    this.published.forEach((publication) => {
      if (publication.track?.kind !== kind) return;
      void (enabled ? publication.track.unmute() : publication.track.mute());
    });
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.published = [];
    await room?.disconnect().catch(() => undefined);
  }

  get current(): Room | null { return this.room; }
  get recording(): boolean { return Boolean(this.room?.isRecording); }
}
