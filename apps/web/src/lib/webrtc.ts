/**
 * Direct peer connection, used when no media server is configured.
 *
 * Perfect negotiation, with two decisions that were arrived at the hard way:
 * only the impolite peer offers (a simultaneous offer forces a rollback, and
 * the rollback restarts ICE gathering, leaving neither side with a usable
 * candidate pair), and ICE candidates are queued until the remote description
 * exists (added early they are rejected and lost, and the call then fails with
 * nothing in the console).
 */
import { api } from './api';
import { emit as socketEmit } from './socket';

export interface SignalMessage {
  from: string;
  fromSocket?: string;
  data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
}

type Events = {
  'remote-stream': MediaStream;
  state: { state: string; turn: boolean };
  error: Error;
};

export class PeerConnection {
  private pc: RTCPeerConnection | null = null;
  private creating: Promise<RTCPeerConnection> | null = null;
  private remoteStream = new MediaStream();
  private pending: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private peerSocket: string | undefined;
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();
  private turnConfigured = false;

  constructor(
    private readonly sessionId: string,
    private readonly polite: boolean,
    private readonly stream: MediaStream | null,
  ) {}

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn as (payload: never) => void);
  }

  private fire<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners.get(event)?.forEach((fn) => (fn as (p: Events[K]) => void)(payload));
  }

  private signal(data: SignalMessage['data']): void {
    socketEmit('classroom:signal', {
      sessionId: this.sessionId, to: this.peerSocket, data,
    });
  }

  /** Idempotent: both the peer-joined broadcast and an early offer open it. */
  async open(peerSocket?: string): Promise<RTCPeerConnection> {
    if (peerSocket) this.peerSocket = peerSocket;
    if (this.pc) return this.pc;
    if (this.creating) return this.creating;

    this.creating = (async () => {
      let iceServers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
      try {
        const ice = await api.iceServers();
        iceServers = ice.iceServers;
        this.turnConfigured = ice.turnConfigured;
      } catch { /* a public STUN server still connects most pairs */ }

      const pc = new RTCPeerConnection({ iceServers });
      this.pc = pc;
      this.fire('state', { state: 'connecting', turn: this.turnConfigured });

      if (this.stream) {
        this.stream.getTracks().forEach((track) => pc.addTrack(track, this.stream!));
      } else {
        // With no camera we still negotiate, so we can receive the other side.
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => {
          if (!this.remoteStream.getTrackById(track.id)) this.remoteStream.addTrack(track);
        });
        this.fire('remote-stream', this.remoteStream);
      };
      pc.onicecandidate = (event) => {
        if (event.candidate) this.signal({ candidate: event.candidate.toJSON() });
      };
      pc.onnegotiationneeded = async () => {
        if (this.polite) return;           // one side drives negotiation
        try {
          this.makingOffer = true;
          await pc.setLocalDescription();
          this.signal({ description: pc.localDescription! });
        } catch (err) {
          this.fire('error', err as Error);
        } finally {
          this.makingOffer = false;
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
          pc.restartIce();
          this.fire('state', { state: 'reconnecting', turn: this.turnConfigured });
        }
      };
      pc.onconnectionstatechange = () => {
        this.fire('state', { state: pc.connectionState, turn: this.turnConfigured });
      };
      this.creating = null;
      return pc;
    })();

    return this.creating;
  }

  async handleSignal(message: SignalMessage): Promise<void> {
    if (message.fromSocket) this.peerSocket = message.fromSocket;
    const pc = this.pc ?? await this.open(message.fromSocket);
    const { description, candidate } = message.data;

    if (description) {
      const collision = description.type === 'offer'
        && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;

      try {
        await pc.setRemoteDescription(description);
        this.flushCandidates();
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.signal({ description: pc.localDescription! });
        }
      } catch (err) {
        this.fire('error', err as Error);
      }
      return;
    }

    if (candidate) {
      // Candidates routinely arrive before the offer they belong to.
      if (!pc.remoteDescription?.type) { this.pending.push(candidate); return; }
      void this.addCandidate(candidate);
    }
  }

  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try { await this.pc?.addIceCandidate(candidate); }
    catch (err) { if (!this.ignoreOffer) this.fire('error', err as Error); }
  }

  private flushCandidates(): void {
    const queued = this.pending;
    this.pending = [];
    queued.forEach((candidate) => void this.addCandidate(candidate));
  }

  /** Device switch without renegotiating: the far side sees nothing. */
  async replaceTracks(stream: MediaStream): Promise<boolean> {
    if (!this.pc) return false;
    const senders = this.pc.getSenders();
    await Promise.all(stream.getTracks().map(async (track) => {
      const sender = senders.find((s) => s.track?.kind === track.kind);
      if (sender) return sender.replaceTrack(track);
      this.pc!.addTrack(track, stream);
      return undefined;
    }));
    return true;
  }

  close(): void {
    this.pc?.close();
    this.pc = null;
    this.creating = null;
    this.pending = [];
    this.fire('state', { state: 'closed', turn: this.turnConfigured });
  }

  get connection(): RTCPeerConnection | null { return this.pc; }
}
