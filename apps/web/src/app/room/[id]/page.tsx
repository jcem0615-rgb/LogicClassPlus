'use client';

/**
 * The classroom.
 *
 * Two media paths, and the server picks: through LiveKit when one is
 * configured (so the class can be recorded), otherwise a direct peer
 * connection. The transport is decided when the class starts and shown next to
 * the timer — switching mid-call would renegotiate both browsers and drop the
 * class for several seconds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { emit, on, socketId } from '@/lib/socket';
import { PeerConnection, type SignalMessage } from '@/lib/webrtc';
import { SfuSession } from '@/lib/sfu';
import {
  deviceSpace, listDeviceRecordings, readDeviceRecording, discardDeviceRecording,
  saveBlob, startDeviceRecording, estimatedBytesFor,
  type DeviceRecording, type DeviceRecordingMeta,
} from '@/lib/device-recording';
import { bytes, duration, initials, time } from '@/lib/format';
import { Shell } from '@/components/shell';
import { Button, Card, Empty, Pill } from '@/components/ui';
import { HardwareCheck, type DeviceChoice } from '@/components/classroom/hardware-check';
import { Whiteboard, type Stroke } from '@/components/classroom/whiteboard';
import { Annotator } from '@/components/classroom/annotator';
import { Equations } from '@/components/classroom/equations';
import { SharedDoc } from '@/components/classroom/shared-doc';
import { Pronunciation } from '@/components/classroom/pronunciation';
import { SessionPanel } from '@/components/classroom/session-panel';
import { roomRoster } from '@/components/session-row';
import type { ChatMessage, ClassSession } from '@/lib/types';

type Tab = 'whiteboard' | 'annotate' | 'equations' | 'document' | 'speech' | 'notes';
const TABS: Array<[Tab, string, 'math' | 'english' | null]> = [
  ['whiteboard', 'Whiteboard', 'math'],
  ['annotate', 'PDF / image', 'math'],
  ['equations', 'Equations', 'math'],
  ['document', 'Shared document', 'english'],
  ['speech', 'Pronunciation', 'english'],
  ['notes', 'Session', null],
];

/**
 * One other person in the room, whichever transport brought them. A direct
 * connection keys them by socket (the same user in two tabs is two tiles,
 * which is what you see on screen too); the media server keys them by
 * identity.
 */
interface Remote {
  key: string;
  userId: string;
  name: string;
  stream: MediaStream | null;
  state: string;
}

function RemoteTile({ remote, name, tone }: {
  remote: Remote; name: string; tone: 'ok' | 'warn' | 'crit' | 'neutral';
}) {
  const connected = remote.state === 'connected' && remote.stream;
  return (
    <div className="relative grid aspect-[16/10] place-items-center overflow-hidden rounded-md border border-line bg-[#0A1214]">
      <video
        autoPlay playsInline
        // srcObject cannot be set from JSX, and the element is remounted
        // whenever the grid reflows, so it is assigned on every ref call.
        ref={(el) => {
          if (el && remote.stream && el.srcObject !== remote.stream) {
            el.srcObject = remote.stream;
            void el.play().catch(() => undefined);
          }
        }}
        className={`h-full w-full object-cover ${connected ? '' : 'hidden'}`}
      />
      {!connected ? (
        <div className="grid h-14 w-14 place-items-center rounded-full bg-brand font-ui text-[18px] font-semibold text-on-brand">
          {initials(name)}
        </div>
      ) : null}
      <span className="absolute bottom-2 left-2 rounded bg-[rgba(8,16,18,.72)] px-2 py-1 font-mono text-[11px] text-[#E8F2EF]">
        {name}
      </span>
      <span className="absolute right-2 top-2">
        <Pill tone={tone} dot>
          {remote.state === 'closed' ? 'Ended'
            : remote.state.charAt(0).toUpperCase() + remote.state.slice(1)}
        </Pill>
      </span>
    </div>
  );
}

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const router = useRouter();
  const store = useStore();

  const [session, setSession] = useState<ClassSession | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [joined, setJoined] = useState(false);
  const [tab, setTab] = useState<Tab>('whiteboard');
  const [stream, setStream] = useState<MediaStream | null>(null);
  /** The live stream, readable without making callbacks depend on render state. */
  const streamRef = useRef<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ cams: [], mics: [] });
  const [choice, setChoice] = useState<DeviceChoice>({ cam: '', mic: '' });
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  /** server clock − this browser's clock, so both sides read the same elapsed time. */
  const [skew, setSkew] = useState(0);
  const [transport, setTransport] = useState<'sfu' | 'p2p' | null>(null);
  const [canRecord, setCanRecord] = useState(false);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  /** The media server's recording: one, started by the teacher. */
  const [roomRecording, setRoomRecording] = useState(false);
  /**
   * Everyone recording on their own device, by name. A set rather than a
   * flag because several people record at once — a teacher keeping the class
   * and a student keeping their own copy — and one of them stopping must not
   * tell the room the recording has ended when it has not.
   */
  const [recorders, setRecorders] = useState<string[]>([]);
  const [localRecording, setLocalRecording] = useState(false);
  const [recordedBytes, setRecordedBytes] = useState(0);
  /** The server's ceiling, so a device recording stops where a hosted one would. */
  const [recordingCap, setRecordingCap] = useState(180);
  const [orphans, setOrphans] = useState<DeviceRecordingMeta[]>([]);
  /* Firefox and Safari have no save dialog, so the second button is simply
     not offered there rather than offered and then failing. */
  const [canWriteFiles, setCanWriteFiles] = useState(false);
  useEffect(() => {
    setCanWriteFiles(typeof (window as unknown as { showSaveFilePicker?: unknown })
      .showSaveFilePicker === 'function');
  }, []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [documents, setDocuments] = useState<Record<string, string>>({});

  const localVideo = useRef<HTMLVideoElement>(null);
  /* One connection per peer, keyed by their socket. A private lesson has a
     map of one; the code does not need to know which kind of class it is. */
  const peers = useRef(new Map<string, PeerConnection>());
  const sfu = useRef<SfuSession | null>(null);
  const deviceRecorder = useRef<DeviceRecording | null>(null);
  const chatLog = useRef<HTMLDivElement>(null);

  const me = store.user;
  const isTeacher = Boolean(me && session && me.id === session.teacherId);
  const group = Boolean(session && session.capacity > 1);
  /* Who the chat box and the empty-room caption talk about. In a group there
     is no "the other person", so it addresses the class instead. */
  const audience = !session ? 'the class'
    : group ? 'the class'
      : store.userById(isTeacher ? session.studentIds[0] ?? '' : session.teacherId).name;
  /* The line under the class title. A private lesson names the one other
     person and their timezone; a group names who booked and how full it is,
     because there is no single timezone to report. */
  const withWhom = !session ? ''
    : group
      ? `${roomRoster(session, (id) => store.userById(id).name)} · ${session.booked} of ${session.capacity} seats`
      : (() => {
        const u = store.userById(isTeacher ? session.studentIds[0] ?? '' : session.teacherId);
        return `${u.name} · ${u.tz}`;
      })();

  const upsertRemote = useCallback((key: string, patch: Partial<Remote>) => {
    setRemotes((all) => {
      const found = all.find((r) => r.key === key);
      if (!found) {
        return [...all, {
          key, userId: '', name: 'Joining…', stream: null, state: 'connecting', ...patch,
        }];
      }
      return all.map((r) => (r.key === key ? { ...r, ...patch } : r));
    });
  }, []);

  const dropRemote = useCallback((key: string) => {
    peers.current.get(key)?.close();
    peers.current.delete(key);
    setRemotes((all) => all.filter((r) => r.key !== key));
  }, []);

  /**
   * Open a connection to one peer.
   *
   * Politeness has to be agreed without talking: both sides compare the two
   * socket ids and the lower one waits. The old rule — the student is polite —
   * worked only because there was exactly one of each. Put two students in a
   * room and they would both be polite, both wait, and nothing would ever be
   * offered.
   */
  const connectToPeer = useCallback((info: { socketId: string; userId?: string; name?: string }) => {
    if (!session || peers.current.has(info.socketId)) return;
    const mine = socketId() ?? '';
    const connection = new PeerConnection(session.id, mine < info.socketId, streamRef.current);
    peers.current.set(info.socketId, connection);
    upsertRemote(info.socketId, {
      userId: info.userId ?? '',
      ...(info.name ? { name: info.name } : {}),
    });
    connection.on('remote-stream', (incoming) => upsertRemote(info.socketId, { stream: incoming }));
    connection.on('state', (st) => {
      upsertRemote(info.socketId, { state: st.state });
      if (st.state === 'failed') {
        store.toast('err', 'Could not connect to a participant', st.turn
          ? 'The connection failed even through TURN. Ask them to rejoin.'
          : 'No TURN server is configured. Set TURN_URLS for participants behind strict NAT.');
      }
    });
    void connection.open(info.socketId);
  }, [session, store, upsertRemote]);

  /* ---------- find the session, even if this tab predates it ---------- */
  useEffect(() => {
    if (!store.ready || !me) return;
    const found = store.sessions.find((s) => s.id === sessionId);
    if (found) { setSession(found); return; }
    if (lookupFailed) return;
    setLookupFailed(true);
    void api.session(sessionId)
      .then((r) => { setSession(r.session); setDocuments(r.documents); setMessages(r.messages); })
      .catch(() => store.refresh());
  }, [store, store.ready, store.sessions, sessionId, me, lookupFailed]);

  /* ---------- camera and microphone ---------- */
  const openStream = useCallback(async (pick: DeviceChoice): Promise<MediaStream | null> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaError('Media devices are unavailable in this browser.');
      return null;
    }
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: pick.cam ? { deviceId: { exact: pick.cam } } : true,
        audio: pick.mic ? { deviceId: { exact: pick.mic } } : true,
      });
      // Stopping tracks is a side effect, so it cannot live inside the updater:
      // React is free to call updaters more than once, and a replay would stop
      // the very stream it had just returned.
      const previous = streamRef.current;
      streamRef.current = next;
      setStream(next);
      /* Push the new camera down the connections that are already open.
         PeerConnection has had replaceTracks since the start and nothing ever
         called it, so switching devices mid-class changed the picture in the
         corner of your own screen and nowhere else. */
      peers.current.forEach((connection) => { void connection.replaceTracks(next); });
      void sfu.current?.replaceTracks(next);
      if (previous && previous !== next) previous.getTracks().forEach((t) => t.stop());
      setMediaError(null);
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        cams: list.filter((d) => d.kind === 'videoinput'),
        mics: list.filter((d) => d.kind === 'audioinput'),
      });
      return next;
    } catch (err) {
      const name = (err as Error).name;
      setMediaError(
        name === 'NotAllowedError'
          ? 'The browser denied access. Allow camera and microphone for this page, then reload.'
          : name === 'NotFoundError' ? 'No camera or microphone was found on this device.'
          : name === 'NotReadableError' ? 'Another application is already using the camera.'
          : `Media devices are unavailable here (${name}).`);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!session || joined) return;
    void openStream({ cam: '', mic: '' });
  }, [session, joined, openStream]);

  useEffect(() => {
    if (joined && localVideo.current && stream) localVideo.current.srcObject = stream;
  }, [joined, stream]);

  useEffect(() => {
    if (!startedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // The class clock counts from a timestamp the server owns, so it has to be
  // read against the server's clock. A laptop running ten minutes fast would
  // otherwise bill ten minutes that nobody taught.
  useEffect(() => {
    let alive = true;
    void api.health()
      .then((h) => { if (alive && h.time) setSkew(Date.parse(h.time) - Date.now()); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  /* ---------- the device's own recordings ---------- */
  useEffect(() => {
    void api.recordingEstimate(session?.minutes ?? 60)
      .then((e) => setRecordingCap(e.maxMinutes))
      .catch(() => undefined);
  }, [session?.minutes]);

  // A tab that died mid-recording left its chunks in the browser's store.
  // They are still a playable file up to the moment it went.
  useEffect(() => {
    if (!session) return;
    void listDeviceRecordings(session.id)
      .then((all) => setOrphans(all.filter((r) => !r.complete)))
      .catch(() => undefined);
  }, [session]);

  /* ---------- room events ---------- */
  useEffect(() => {
    if (!joined || !session) return undefined;

    const offMessage = on<ChatMessage>('chat:message', (message) => {
      if (message.sessionId !== session.id) return;
      setMessages((all) => all.some((m) => m.id === message.id) ? all : [...all, message]);
    });
    const offStroke = on<{ stroke: Stroke }>('classroom:board:stroke', (payload) => {
      setStrokes((all) => [...all, payload.stroke]);
    });
    const offClear = on('classroom:board:clear', () => setStrokes([]));
    const offSignal = on<SignalMessage>('classroom:signal', (message) => {
      const key = message.fromSocket;
      if (!key) return;
      // An offer can arrive before the peer-joined that announces its sender,
      // so the connection is opened here too rather than assuming one exists.
      if (!peers.current.has(key)) connectToPeer({ socketId: key, userId: message.from });
      void peers.current.get(key)?.handleSignal(message);
    });
    const offJoined = on<{ userId: string; name: string; socketId: string }>(
      'classroom:peer-joined', (info) => {
        connectToPeer(info);
        // They arrived after the announcement, so make it again. Walking into
        // a room that is already being recorded and not being told is the
        // same failure as not being told at all.
        if (deviceRecorder.current) {
          emit('classroom:recording:device', { sessionId: session.id, active: true });
        }
      },
    );
    const offLeft = on<{ userId: string; socketId?: string }>('classroom:peer-left', (info) => {
      if (info.socketId) { dropRemote(info.socketId); return; }
      // An older server sends only the user id; drop every socket they hold.
      remotes.filter((r) => r.userId === info.userId).forEach((r) => dropRemote(r.key));
    });
    const offRecording = on<{ status: string; bytes?: number; device?: boolean; by?: string }>(
      'classroom:recording', (info) => {
        const who = info.by ?? 'Someone';
        if (info.status === 'started') {
          if (info.device) {
            setRecorders((all) => (all.includes(who) ? all : [...all, who]));
            store.toast('warn', 'This class is being recorded',
              `${who} is recording the class on their own device.`);
          } else {
            setRoomRecording(true);
            store.toast('warn', 'This class is being recorded',
              'Everyone in the class is told whenever recording starts.');
          }
        } else if (info.status === 'ready') {
          setRoomRecording(false);
          store.toast('ok', 'Recording saved', `${bytes(info.bytes ?? 0)} uploaded by the media server.`);
        } else if (info.device) {
          // Knowing when it stopped matters as much as knowing when it
          // started: it is the difference between "watch what you say" and
          // "we are off the record now". Only for the person who stopped —
          // anyone else still recording keeps the room on the record.
          setRecorders((all) => all.filter((name) => name !== who));
          store.toast('ok', `${who} stopped recording`, '');
        } else {
          setRoomRecording(false);
        }
      });

    return () => {
      offMessage(); offStroke(); offClear(); offSignal(); offJoined(); offLeft(); offRecording();
    };
  }, [joined, session, store, connectToPeer, dropRemote, remotes]);

  useEffect(() => {
    if (chatLog.current) chatLog.current.scrollTop = chatLog.current.scrollHeight;
  }, [messages]);

  /* ---------- joining ---------- */
  async function join() {
    if (!session) return;
    // Subscribe before joining: the server announces our arrival the moment we
    // join the room, and their offer can land before this resolves.
    setJoined(true);

    try {
      // joinedAt is set once, on the first entry, and survives leaving. Closing
      // the tab and coming back continues the class instead of restarting it.
      const { session: live } = await api.joinSession(session.id);
      setStartedAt(live.joinedAt ? Date.parse(live.joinedAt) : Date.now());
      const loaded = await api.session(session.id);
      setMessages(loaded.messages);
      setDocuments(loaded.documents);
    } catch (err) {
      store.toast('err', 'Could not enter the classroom', (err as Error).message);
      setJoined(false);
      return;
    }

    const creds = await api.sfu(session.id);
    if (creds.available && creds.url && creds.token) {
      setTransport('sfu');
      setCanRecord(Boolean(creds.canRecord));
      const media = new SfuSession();
      sfu.current = media;
      media.on('remote-track', ({ track, participant }) => {
        // One tile per publisher, the same shape the mesh produces, so the
        // grid below does not care which transport it is looking at.
        const key = participant.identity;
        const raw = track.mediaStreamTrack;
        setRemotes((all) => {
          const found = all.find((r) => r.key === key);
          const stream = found?.stream ?? new MediaStream();
          if (raw && !stream.getTrackById(raw.id)) stream.addTrack(raw);
          const next = {
            key, userId: key, name: participant.name || store.userById(key).name,
            stream, state: 'connected',
          };
          return found ? all.map((r) => (r.key === key ? { ...r, ...next } : r)) : [...all, next];
        });
      });
      media.on('remote-track-gone', () => undefined);
      media.on('peer', (info) => {
        if (!info.present) setRemotes((all) => all.filter((r) => r.key !== info.identity));
      });
      media.on('recording', (info) => setRoomRecording(info.active));
      try {
        await media.connect(creds.url, creds.token, stream);
      } catch (err) {
        setTransport('p2p');
        setCanRecord(false);
        store.toast('warn', 'Media server unavailable',
          `${(err as Error).message} Falling back to a direct connection — this class cannot be recorded.`);
      }
    } else {
      setTransport('p2p');
      setCanRecord(false);
    }

    emit('classroom:join', session.id, (
      ack: { peers?: Array<{ socketId: string; userId: string; name: string }> } | undefined,
    ) => {
      if (sfu.current) return;
      // Everyone already in the room, not just the first of them.
      for (const info of ack?.peers ?? []) connectToPeer(info);
    });
  }

  const leave = useCallback(() => {
    peers.current.forEach((connection) => connection.close());
    peers.current.clear();
    setRemotes([]);
    void sfu.current?.disconnect();
    sfu.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void deviceRecorder.current?.stop();
    deviceRecorder.current = null;
    if (session) { emit('classroom:leave', session.id); void api.leaveSession(session.id); }
  }, [session]);

  // `leave` changes identity whenever the session object or the stream does,
  // and a re-hydration hands back a fresh session on every mutation. Keying the
  // cleanup on it meant saving a whiteboard tore the class down: peer closed,
  // tracks stopped, classroom:leave emitted. Only leaving should leave.
  const leaveRef = useRef(leave);
  useEffect(() => { leaveRef.current = leave; }, [leave]);
  useEffect(() => () => leaveRef.current(), []);

  /* ---------- actions ---------- */
  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !session) return;
    setDraft('');
    emit('chat:send', { sessionId: session.id, text });
  }

  function pushStroke(stroke: Stroke) {
    setStrokes((all) => [...all, stroke]);
    if (session) emit('classroom:board:stroke', { sessionId: session.id, stroke });
  }

  async function saveBoard(canvas: HTMLCanvasElement, name: string) {
    if (!session || !isTeacher) {
      store.toast('warn', 'Teacher only', 'Only the teacher can file material into the library.');
      return;
    }
    const folder = store.folders.find((f) => f.teacherId === session.teacherId);
    if (!folder) {
      store.toast('warn', 'No folder yet', 'Create a folder in the Library first.');
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `${name}-${new Date().toISOString().slice(0, 10)}.jpg`,
        { type: 'image/jpeg' });
      void store.run(async () => {
        const { ticket } = await api.uploadTicket({
          folderId: folder.id, filename: file.name, bytes: file.size, mimeType: file.type });
        if (ticket.driver === 's3' && ticket.uploadUrl) {
          await fetch(ticket.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
        } else {
          const base64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = String(reader.result ?? '');
              resolve(result.slice(result.indexOf(',') + 1));
            };
            reader.readAsDataURL(file);
          });
          await api.uploadLocal(ticket.storageKey, base64);
        }
        return api.commitResource({
          folderId: folder.id, filename: file.name, bytes: file.size,
          storageKey: ticket.storageKey, mimeType: file.type });
      }, { title: 'Saved to library', body: `${bytes(file.size)} filed under “${folder.name}”.` });
    }, 'image/jpeg', 0.7);
  }

  /**
   * Record the class, on this device.
   *
   * The media-server path composites the room on a server and uploads the
   * file to a bucket; this one composites it here and keeps it here. Every
   * stream in the room is already decoded in this tab, so the only thing the
   * server was adding was somewhere to put the result — and the teacher's
   * own disk is somewhere to put the result.
   *
   * Chunks are written out as they are produced, into a file the teacher
   * picked or into the browser's on-disk store, so a three-hour class costs
   * a few megabytes of memory instead of two gigabytes of it.
   */
  async function toggleDeviceRecording(target: 'device' | 'file' = 'device') {
    if (deviceRecorder.current) {
      const handle = deviceRecorder.current;
      deviceRecorder.current = null;
      const result = await handle.stop();
      setLocalRecording(false);
      setRecordedBytes(0);
      emit('classroom:recording:device', { sessionId: session?.id, active: false });

      if (result.blob) {
        saveBlob(result.blob, result.filename);
        store.toast('ok', 'Recording saved to this device',
          `${bytes(result.bytes)} over ${duration(result.seconds * 1000)}. `
          + 'It was kept in this browser as the class ran and has now been downloaded.');
      } else {
        store.toast('ok', 'Recording saved', `${bytes(result.bytes)} written to the file you chose.`);
      }
      return;
    }

    if (!session) return;
    if (!stream && remotes.every((r) => !r.stream)) {
      store.toast('err', 'Nothing to record', 'Recording needs at least one camera in the room.');
      return;
    }

    const space = await deviceSpace();
    const needed = estimatedBytesFor(session.minutes);
    if (space.free != null && space.free < needed) {
      store.toast('warn', 'This device may not have room',
        `About ${bytes(needed)} is needed for ${session.minutes} minutes and roughly `
        + `${bytes(space.free)} is free. Choose a file on a bigger disk, or record a shorter stretch.`);
    }

    try {
      const handle = await startDeviceRecording({
        sessionId: session.id,
        label: session.topic,
        target,
        maxMinutes: recordingCap,
        participants: () => [
          ...(streamRef.current ? [{ name: `${me?.name ?? 'Me'} (you)`, stream: streamRef.current }] : []),
          ...remotes.filter((r) => r.stream).map((r) => ({
            name: r.name !== 'Joining…' ? r.name : store.userById(r.userId).name,
            stream: r.stream!,
          })),
        ],
        onProgress: ({ bytes: written }) => setRecordedBytes(written),
        onStopped: (reason, err) => {
          setLocalRecording(false);
          if (reason === 'limit') {
            store.toast('warn', `Recording stopped after ${recordingCap} minutes`,
              'That is the limit for one recording. Start another if the class is still going.');
          } else if (reason === 'error') {
            store.toast('err', 'Recording stopped', err?.message ?? 'The device stopped accepting data.');
          }
        },
      });
      deviceRecorder.current = handle;
      setLocalRecording(true);
      // Everyone in the room is told, every time, whoever is recording and
      // wherever the file ends up.
      emit('classroom:recording:device', { sessionId: session.id, active: true });
      store.toast('ok', 'Recording on this device',
        handle.where === 'file'
          ? 'Writing straight to the file you chose.'
          : 'Kept in this browser as it goes, and saved to your downloads when you stop.');
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;   // the save dialog was dismissed
      store.toast('err', 'Could not start recording', (err as Error).message);
    }
  }

  /* ---------- render ---------- */
  if (!store.ready) return <Shell title="Classroom"><Empty title="Loading…" body="" /></Shell>;
  if (!session) {
    return (
      <Shell title="Classroom">
        <Empty title="Opening the classroom…" body="Fetching this session." />
      </Shell>
    );
  }
  if (me && me.role !== 'owner' && me.id !== session.teacherId
      && !session.studentIds.includes(me.id)) {
    return (
      <Shell title="Classroom">
        <Empty title="Not your classroom"
          body="Only the teacher and the students with a seat in this class can enter it." />
      </Shell>
    );
  }

  const everyoneRecording = localRecording
    ? [`${me?.name ?? 'You'} (you)`, ...recorders]
    : recorders;
  const recordingCount = everyoneRecording.length;

  const stateTone: Record<string, 'ok' | 'warn' | 'crit' | 'neutral'> = {
    connected: 'ok', connecting: 'warn', reconnecting: 'warn', failed: 'crit', closed: 'neutral',
  };

  return (
    <Shell title="Classroom" subtitle={session.topic} bare>
      <div className="grid min-h-0 flex-1 gap-3.5 lg:grid-cols-[300px_1fr]">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
          {remotes.length === 0 ? (
            <div className="grid aspect-[16/10] place-items-center overflow-hidden rounded-md border border-line bg-[#0A1214]">
              <div className="px-4 text-center">
                <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-brand font-ui text-[26px] font-semibold text-on-brand">
                  {initials(group ? session.topic : audience)}
                </div>
                <div className="mt-3 font-mono text-[11px] text-[#7F9490]" data-testid="room-waiting">
                  {group
                    ? `waiting for the class — ${session.booked} booked`
                    : 'waiting for the other participant to join'}
                </div>
              </div>
            </div>
          ) : (
            <div className={`grid gap-2 ${remotes.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
              data-testid="remote-tiles" data-count={remotes.length}>
              {remotes.map((r) => (
                <RemoteTile key={r.key} remote={r}
                  name={r.name !== 'Joining…' ? r.name : store.userById(r.userId).name}
                  tone={stateTone[r.state] ?? 'neutral'} />
              ))}
            </div>
          )}

          <div className="relative grid aspect-[16/11] place-items-center overflow-hidden rounded-md border border-line bg-[#0A1214]">
            <video ref={localVideo} autoPlay playsInline muted
              className={`h-full w-full object-cover ${stream && camOn ? '' : 'hidden'}`} />
            {!stream || !camOn ? <span className="text-[13px] text-[#7F9490]">Camera off</span> : null}
            <span className="absolute bottom-2 left-2 rounded bg-[rgba(8,16,18,.72)] px-2 py-1 font-mono text-[11px] text-[#E8F2EF]">
              You · {me?.name.split(' ')[0]}
            </span>
            <div className="absolute right-2 top-2 flex gap-1.5">
              {!micOn ? <Pill tone="crit">Muted</Pill> : null}
              {localRecording ? <Pill tone="crit" dot>REC</Pill> : null}
              {/* Your own recording never comes back to you — the relay
                  skips the sender — so it is counted here rather than
                  waiting for an echo that will not arrive. */}
              {roomRecording || recordingCount ? (
                <Pill tone="crit" dot>
                  {recordingCount > 1 ? `CLASS REC ×${recordingCount}` : 'CLASS REC'}
                </Pill>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-2.5 rounded-md border border-line bg-card-2 p-3.5">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Controls</span>
              <div className="flex items-center gap-1.5">
                <span id="transport-tag">
                  {transport === 'sfu'
                    ? <Pill tone="math">media server{canRecord ? '' : ' · no storage'}</Pill>
                    : transport === 'p2p' ? <Pill>peer to peer</Pill> : null}
                </span>
                <span className="font-mono text-[13px] text-ink-3">
                  {startedAt ? duration(now + skew - startedAt) : '00:00'}
                </span>
              </div>
            </div>
            <ClassClock
              elapsedMs={startedAt ? now + skew - startedAt : null}
              bookedMinutes={session.minutes}
            />

            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant={micOn ? 'default' : 'danger'} onClick={() => {
                const next = !micOn;
                setMicOn(next);
                stream?.getAudioTracks().forEach((t) => { t.enabled = next; });
                sfu.current?.setEnabled('audio', next);
              }}>{micOn ? 'Mute' : 'Unmute'}</Button>
              <Button size="sm" variant={camOn ? 'default' : 'danger'} onClick={() => {
                const next = !camOn;
                setCamOn(next);
                stream?.getVideoTracks().forEach((t) => { t.enabled = next; });
                sfu.current?.setEnabled('video', next);
              }}>{camOn ? 'Camera off' : 'Camera on'}</Button>
              {/* Anyone in the class may keep their own copy: a student
                  reviewing the lesson afterwards, and a record of what was
                  said if it is ever needed. What makes that acceptable is
                  not restricting it but announcing it — every person in the
                  room is told who is recording, and told again when they
                  stop. The hosted recording stays the teacher's, because
                  that one spends the school's storage. */}
              {true ? (
                <>
                  <Button size="sm" variant={localRecording ? 'danger' : 'default'}
                    title="Records everyone in the room and keeps the file on this device"
                    id="record-class"
                    onClick={() => void toggleDeviceRecording('device')}>
                    {localRecording ? `Stop (${bytes(recordedBytes)})` : 'Record class'}
                  </Button>
                  {!localRecording && canWriteFiles ? (
                    <Button size="sm" id="record-to-file"
                      title="Record the class straight into a file you choose"
                      onClick={() => void toggleDeviceRecording('file')}>
                      …to a file
                    </Button>
                  ) : null}
                </>
              ) : null}
              <Button size="sm" variant="danger" onClick={() => { leave(); router.push('/classes'); }}>
                Leave
              </Button>
            </div>

            {orphans.length ? (
              <div className="flex flex-col gap-2 rounded-sm border border-line bg-warn-soft p-3"
                data-testid="orphan-recordings">
                <div className="text-[13px]">
                  {orphans.length === 1 ? 'A recording was' : `${orphans.length} recordings were`}
                  {' '}interrupted before {orphans.length === 1 ? 'it' : 'they'} finished. What was
                  written is still on this device.
                </div>
                {orphans.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[12px] text-ink-2">
                      {new Date(r.startedAt).toLocaleString()} · {bytes(r.bytes)}
                    </span>
                    <span className="flex gap-1.5">
                      <Button size="sm" data-recover={r.id} onClick={() => {
                        void readDeviceRecording(r.id).then((blob) => {
                          if (!blob) { store.toast('warn', 'Nothing left to recover', ''); return; }
                          saveBlob(blob, `${r.label} (recovered).webm`);
                          store.toast('ok', 'Recovered', `${bytes(blob.size)} saved.`);
                        });
                      }}>Save it</Button>
                      <Button size="sm" variant="danger" data-discard={r.id} onClick={() => {
                        void discardDeviceRecording(r.id)
                          .then(() => setOrphans((all) => all.filter((o) => o.id !== r.id)));
                      }}>Discard</Button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <Card className="flex min-h-[240px] flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h3 className="text-base">Chat</h3>
              <span id="chat-count" className="text-[13px] text-ink-3">{messages.length} messages</span>
            </div>
            <div ref={chatLog} className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto p-3">
              {messages.map((m) => {
                const mine = m.from === me?.id;
                return (
                  <div key={m.id}
                    className={`max-w-[88%] rounded-xl px-3 py-1.5 text-[13.5px] ${
                      mine ? 'self-end rounded-br-[3px] bg-brand text-on-brand'
                           : 'self-start rounded-bl-[3px] bg-sunk'}`}>
                    {!mine ? (
                      <div className="font-mono text-[10px] uppercase tracking-wider opacity-70">
                        {store.userById(m.from).name.split(' ')[0]}
                      </div>
                    ) : null}
                    {m.text}
                  </div>
                );
              })}
            </div>
            <form className="flex gap-1.5 border-t border-line p-2.5" onSubmit={sendChat}>
              <input id="chat-input" value={draft} autoComplete="off"
                placeholder={`Message ${group ? 'the class' : audience.split(' ')[0]}`}
                onChange={(e) => setDraft(e.target.value)} />
              <Button size="sm" variant="primary" type="submit">Send</Button>
            </form>
          </Card>
        </div>

        <Card className="flex min-h-0 flex-col">
          <div className="flex gap-1 overflow-x-auto border-b border-line px-2 pt-2">
            {TABS.map(([id, label, suite]) => (
              <button key={id} data-tab={id} onClick={() => setTab(id)}
                className={`whitespace-nowrap rounded-t-sm border border-b-0 px-3.5 py-2 text-[13.5px] font-medium ${
                  tab === id
                    ? `-mb-px border-line bg-card text-ink ${
                        suite === 'math' ? 'shadow-[inset_0_2px_0_var(--math)]'
                        : suite === 'english' ? 'shadow-[inset_0_2px_0_var(--english)]' : ''}`
                    : 'border-transparent text-ink-2 hover:bg-card-2 hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3.5">
            {tab === 'whiteboard' ? (
              <Whiteboard
                strokes={strokes} live={transport !== null}
                onStroke={pushStroke}
                onClear={() => {
                  setStrokes([]);
                  if (session) emit('classroom:board:clear', { sessionId: session.id });
                }}
                onSave={isTeacher ? (canvas) => void saveBoard(canvas, 'whiteboard') : undefined}
              />
            ) : null}
            {tab === 'annotate' ? (
              <Annotator onSave={isTeacher ? (canvas) => void saveBoard(canvas, 'annotated') : undefined} />
            ) : null}
            {tab === 'equations' ? (
              <Equations
                initial={documents.equation ?? ''}
                onSave={(tex) => {
                  void store.run(() => api.saveDocument(session.id, 'equation', tex),
                    { title: 'Equation saved', body: "Stored with this session's notes." });
                }}
                onSendToBoard={(tex) => {
                  pushStroke({ tool: 'text', color: '#13222B', width: 3, alpha: 1,
                    points: [{ x: 28, y: 44 }], text: tex.slice(0, 60) });
                  setTab('whiteboard');
                }}
              />
            ) : null}
            {tab === 'document' && me ? (
              <SharedDoc sessionId={session.id} me={me} collaborators={audience} isTeacher={isTeacher}
                legacyHtml={documents.document && !documents.document.startsWith('y:')
                  ? documents.document : undefined} />
            ) : null}
            {tab === 'speech' ? <Pronunciation sessionId={session.id} /> : null}
            {tab === 'notes' ? (
              <SessionPanel
                session={session} withWhom={withWhom} isTeacher={isTeacher}
                transport={transport} canRecord={canRecord} recording={roomRecording}
                recordedBy={everyoneRecording}
                onRecording={setRoomRecording}
                onEnd={(outcome) => {
                  void store.run<unknown>(() => outcome === 'completed'
                    ? api.completeSession(session.id, 'completed')
                    : api.markNoShow(session.id),
                    { title: outcome === 'completed' ? 'Session complete' : 'Marked as a no-show',
                      body: outcome === 'completed' ? 'Attendance closed and the student was notified.'
                        : 'The whole session fee is forfeited.' })
                    .then(() => { leave(); router.push('/classes'); });
                }}
              />
            ) : null}
          </div>
        </Card>
      </div>

      {!joined ? (
        <HardwareCheck
          session={session} withWhom={withWhom} stream={stream} error={mediaError}
          devices={devices} choice={choice}
          onChoose={(next) => { setChoice(next); void openStream(next); }}
          onJoin={() => void join()}
          onCancel={() => router.push('/classes')}
        />
      ) : null}
    </Shell>
  );
}

/**
 * How much of the booked class has been used.
 *
 * A bare stopwatch answers "how long have I been here", which is not the
 * question a teacher has mid-class. This answers "how much is left", and says
 * plainly once the class has run past what the student booked.
 */
function ClassClock({ elapsedMs, bookedMinutes }: { elapsedMs: number | null; bookedMinutes: number }) {
  const bookedMs = bookedMinutes * 60_000;
  const elapsed = elapsedMs ?? 0;
  const over = elapsed > bookedMs;
  const pct = bookedMs > 0 ? Math.min(100, (elapsed / bookedMs) * 100) : 0;
  const nearly = !over && pct >= 90;

  return (
    <div data-testid="class-clock" className="flex flex-col gap-1.5 rounded-sm bg-sunk px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">Class time</span>
        <span className="font-mono text-[13px]">
          <span
            data-testid="class-elapsed"
            className={over ? 'text-crit' : nearly ? 'text-warn' : 'text-ink'}
          >
            {duration(elapsed)}
          </span>
          <span className="text-ink-3"> / {duration(bookedMs)}</span>
        </span>
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-line-2">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            over ? 'bg-crit' : nearly ? 'bg-warn' : 'bg-brand'}`}
          style={{ width: `${over ? 100 : pct}%` }}
        />
      </div>

      <div data-testid="class-clock-note" className="text-[12px] text-ink-3">
        {elapsedMs === null
          ? 'Starts when you enter the room.'
          : over
            ? <span className="text-crit">{duration(elapsed - bookedMs)} past the booked {bookedMinutes} minutes.</span>
            : `${duration(bookedMs - elapsed)} left of ${bookedMinutes} minutes.`}
      </div>
    </div>
  );
}
