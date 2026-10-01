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
  const [roomRecording, setRoomRecording] = useState(false);
  const [localRecording, setLocalRecording] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [documents, setDocuments] = useState<Record<string, string>>({});

  const localVideo = useRef<HTMLVideoElement>(null);
  /* One connection per peer, keyed by their socket. A private lesson has a
     map of one; the code does not need to know which kind of class it is. */
  const peers = useRef(new Map<string, PeerConnection>());
  const sfu = useRef<SfuSession | null>(null);
  const localRecorder = useRef<MediaRecorder | null>(null);
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
      'classroom:peer-joined', (info) => connectToPeer(info),
    );
    const offLeft = on<{ userId: string; socketId?: string }>('classroom:peer-left', (info) => {
      if (info.socketId) { dropRemote(info.socketId); return; }
      // An older server sends only the user id; drop every socket they hold.
      remotes.filter((r) => r.userId === info.userId).forEach((r) => dropRemote(r.key));
    });
    const offRecording = on<{ status: string; bytes?: number }>('classroom:recording', (info) => {
      if (info.status === 'started') {
        setRoomRecording(true);
        store.toast('warn', 'This class is being recorded',
          'Both participants are told whenever recording starts.');
      } else if (info.status === 'ready') {
        setRoomRecording(false);
        store.toast('ok', 'Recording saved', `${bytes(info.bytes ?? 0)} uploaded by the media server.`);
      } else setRoomRecording(false);
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
    if (localRecorder.current?.state === 'recording') localRecorder.current.stop();
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
   * Record my own camera and microphone to a file.
   *
   * This used to hand MediaRecorder no timeslice and push every blob into an
   * array, which meant the entire recording sat in the tab's memory until it
   * stopped — around two gigabytes for a three-hour class, long past where a
   * browser gives up. It also built the file and then dropped it on the
   * floor: a toast said the clip was ready and there was no way to get it.
   *
   * Now it asks for a file up front and streams five-second chunks into it,
   * so memory stays flat however long the class runs. Where the File System
   * Access API is missing (Firefox, Safari) it keeps the chunks in memory and
   * downloads them at the end, which is the old behaviour minus the hoarding:
   * it stops at a ceiling and says so rather than taking the tab down.
   */
  async function toggleLocalRecording() {
    if (localRecorder.current?.state === 'recording') { localRecorder.current.stop(); return; }
    if (!stream || typeof MediaRecorder === 'undefined') {
      store.toast('err', 'Nothing to record', 'Recording needs an active camera or microphone.');
      return;
    }

    const name = `${session?.topic ?? 'class'} ${new Date().toISOString().slice(0, 16)}.webm`
      .replace(/[\\/:*?"<>|]/g, '-');
    const picker = (window as unknown as {
      showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
    }).showSaveFilePicker;

    let writer: FileSystemWritableFileStream | null = null;
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: name,
          types: [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
        });
        writer = await handle.createWritable();
      } catch {
        return;   // the save dialog was dismissed; recording never started
      }
    }

    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    let written = 0;
    /* Only reached without a file handle. Half a gigabyte is roughly forty
       minutes at this bitrate — enough to be useful, low enough that the tab
       survives it. */
    const MEMORY_CEILING = 500e6;
    let queue: Promise<void> = Promise.resolve();

    localRecorder.current = rec;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      written += e.data.size;
      if (writer) {
        // Serialised: WritableStream rejects a second write while one is
        // still in flight, and chunks arrive faster than the disk at 1080p.
        queue = queue.then(() => writer!.write(e.data)).catch(() => undefined);
        return;
      }
      chunks.push(e.data);
      if (written > MEMORY_CEILING && rec.state === 'recording') {
        store.toast('warn', 'Local recording stopped at 500 MB',
          'This browser cannot stream a recording to disk, so it is kept in memory. '
          + 'Use the class recording for a full-length copy.');
        rec.stop();
      }
    };
    rec.onstop = () => {
      setLocalRecording(false);
      if (writer) {
        void queue.then(() => writer!.close()).then(() => {
          store.toast('ok', 'Local recording saved', `${bytes(written)} written to the file you chose.`);
        }).catch((err: Error) => {
          store.toast('err', 'Could not finish the file', err.message);
        });
        return;
      }
      const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      store.toast('ok', 'Local clip downloaded', `${bytes(blob.size)} of your own tracks.`);
    };
    // Five-second chunks: without a timeslice nothing is handed over until
    // the recording ends, which is the whole problem.
    rec.start(5_000);
    setLocalRecording(true);
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
              {roomRecording ? <Pill tone="crit" dot>CLASS REC</Pill> : null}
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
              <Button size="sm" variant={localRecording ? 'danger' : 'default'}
                title="Records only your own camera and microphone, in this tab"
                onClick={() => void toggleLocalRecording()}>{localRecording ? 'Stop' : 'Record me'}</Button>
              <Button size="sm" variant="danger" onClick={() => { leave(); router.push('/classes'); }}>
                Leave
              </Button>
            </div>
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
