/**
 * Recording a class on the device that is teaching it.
 *
 * The other way to record a WebRTC class is a media server: route everyone
 * through an SFU, have it composite the streams and push an MP4 to a bucket.
 * That is what the LiveKit path in the server does, and it needs an SFU, a
 * bucket, and a bill for both. The browser already has every stream in the
 * room decoded in front of it, so it can do the compositing itself and keep
 * the file on the machine it was made on.
 *
 * Composition is a canvas: each participant's video is drawn into a tile
 * every frame, `captureStream` turns that into a video track, and the audio
 * from every stream is mixed through a single AudioContext. MediaRecorder
 * encodes the pair to WebM.
 *
 * Where the file goes is the part that matters for a long class. Chunks are
 * written out as they arrive — to a real file through the File System Access
 * API when the browser has it, and otherwise into IndexedDB, which is backed
 * by the browser's on-disk blob store rather than by the tab's heap. Both
 * mean a three-hour recording costs a few megabytes of memory rather than
 * two gigabytes of it, and the IndexedDB one survives the tab dying: the
 * chunks are still there to be recovered next time the room is opened.
 */

const DB_NAME = 'logicclass-recordings';
const DB_VERSION = 1;
const CHUNKS = 'chunks';
const RECORDINGS = 'recordings';

export interface DeviceRecordingMeta {
  id: string;
  sessionId: string;
  label: string;
  startedAt: number;
  endedAt?: number;
  bytes: number;
  mimeType: string;
  /** False while it is being written, true once it was stopped cleanly. */
  complete: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNKS)) {
        // Keyed by [recordingId, sequence], so one recording's parts read back
        // in order and a range delete removes exactly that recording.
        db.createObjectStore(CHUNKS, { keyPath: ['recordingId', 'seq'] });
      }
      if (!db.objectStoreNames.contains(RECORDINGS)) {
        db.createObjectStore(RECORDINGS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable.'));
  });
}

const done = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed.'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted.'));
});

const asPromise = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed.'));
});

/* ---------------- where the bytes go ---------------- */

interface Sink {
  readonly kind: 'file' | 'device';
  write(chunk: Blob, seq: number): Promise<void>;
  finish(): Promise<Blob | null>;
  discard(): Promise<void>;
}

/** Straight into a file the person chose. Nothing is kept anywhere else. */
class FileSink implements Sink {
  readonly kind = 'file';
  constructor(private readonly stream: FileSystemWritableFileStream) {}
  async write(chunk: Blob): Promise<void> { await this.stream.write(chunk); }
  async finish(): Promise<Blob | null> { await this.stream.close(); return null; }
  async discard(): Promise<void> { await this.stream.abort().catch(() => undefined); }
}

/** Into the browser's on-disk store, which outlives the tab. */
class DeviceSink implements Sink {
  readonly kind = 'device';
  constructor(private readonly db: IDBDatabase, private readonly id: string) {}

  async write(chunk: Blob, seq: number): Promise<void> {
    const tx = this.db.transaction(CHUNKS, 'readwrite');
    tx.objectStore(CHUNKS).put({ recordingId: this.id, seq, blob: chunk });
    await done(tx);
  }

  async finish(): Promise<Blob | null> {
    const parts = await readChunks(this.db, this.id);
    // Concatenating Blobs does not pull them into memory: each part stays in
    // the browser's blob store and the new Blob references them.
    return new Blob(parts, { type: parts[0]?.type || 'video/webm' });
  }

  async discard(): Promise<void> { await deleteRecording(this.db, this.id); }
}

async function readChunks(db: IDBDatabase, id: string): Promise<Blob[]> {
  const tx = db.transaction(CHUNKS, 'readonly');
  const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
  const rows = await asPromise(tx.objectStore(CHUNKS).getAll(range) as IDBRequest<Array<{ seq: number; blob: Blob }>>);
  return rows.sort((a, b) => a.seq - b.seq).map((r) => r.blob);
}

export async function deleteRecording(db: IDBDatabase, id: string): Promise<void> {
  const tx = db.transaction([CHUNKS, RECORDINGS], 'readwrite');
  tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
  tx.objectStore(RECORDINGS).delete(id);
  await done(tx);
}

/* ---------------- what the device has room for ---------------- */

export interface DeviceSpace {
  /** Bytes the browser will let this origin store, if it will say. */
  quota: number | null;
  usage: number | null;
  free: number | null;
  /** True when the browser promised not to evict this origin's storage. */
  persisted: boolean;
}

export async function deviceSpace(): Promise<DeviceSpace> {
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage?.estimate) return { quota: null, usage: null, free: null, persisted: false };
  const { quota = 0, usage = 0 } = await storage.estimate();
  let persisted = false;
  try { persisted = (await storage.persisted?.()) ?? false; } catch { /* not supported */ }
  return {
    quota: quota || null,
    usage: usage || null,
    free: quota ? Math.max(0, quota - usage) : null,
    persisted,
  };
}

/**
 * Ask the browser not to evict what we are about to write. Without this a
 * long recording is "best effort" storage, which the browser may clear when
 * the device runs low — mid-class, with no warning.
 */
export async function keepStorage(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

/**
 * Roughly what a recording of this length will occupy. The canvas is encoded
 * at about the same rate as the server's 720p preset, so the two figures are
 * comparable and a teacher deciding where to put a class is comparing like
 * with like.
 */
const DEVICE_BITS_PER_SECOND = 1_500_000 + 48_000;

export const estimatedBytesFor = (minutes: number): number =>
  Math.round((DEVICE_BITS_PER_SECOND * minutes * 60) / 8 * 1.03);

/* ---------------- composing the room ---------------- */

export interface Participant { name: string; stream: MediaStream }

interface Composite { stream: MediaStream; stop: () => void }

/**
 * One canvas with a tile per participant, plus every audio track mixed
 * together. Drawn on an interval rather than requestAnimationFrame: rAF stops
 * when the tab is in the background, and a teacher who switches tabs mid-class
 * would otherwise record a still frame.
 */
function composeRoom(participants: () => Participant[], fps: number): Composite {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  const videos = new Map<MediaStream, HTMLVideoElement>();
  const videoFor = (stream: MediaStream): HTMLVideoElement => {
    let el = videos.get(stream);
    if (!el) {
      el = document.createElement('video');
      el.srcObject = stream;
      el.muted = true;          // the audio path is the mixer, not this element
      el.playsInline = true;
      void el.play().catch(() => undefined);
      videos.set(stream, el);
    }
    return el;
  };

  const draw = () => {
    const people = participants();
    ctx.fillStyle = '#0A1214';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!people.length) return;

    const cols = people.length === 1 ? 1 : 2;
    const rows = Math.ceil(people.length / cols);
    const cw = canvas.width / cols;
    const ch = canvas.height / rows;

    people.forEach((person, i) => {
      const x = (i % cols) * cw;
      const y = Math.floor(i / cols) * ch;
      const el = videoFor(person.stream);
      if (el.videoWidth) {
        // Cover the tile without distorting anyone.
        const scale = Math.max(cw / el.videoWidth, ch / el.videoHeight);
        const w = el.videoWidth * scale;
        const h = el.videoHeight * scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cw, ch);
        ctx.clip();
        ctx.drawImage(el, x + (cw - w) / 2, y + (ch - h) / 2, w, h);
        ctx.restore();
      }
      ctx.fillStyle = 'rgba(8,16,18,.72)';
      ctx.fillRect(x + 10, y + ch - 36, ctx.measureText(person.name).width + 110, 26);
      ctx.fillStyle = '#E8F2EF';
      ctx.font = '15px ui-monospace, monospace';
      ctx.fillText(person.name, x + 18, y + ch - 18);
    });
  };

  draw();
  const timer = setInterval(draw, Math.round(1000 / fps));
  const canvasStream = (canvas as HTMLCanvasElement & {
    captureStream(fps?: number): MediaStream;
  }).captureStream(fps);

  // Audio: one mixer, every participant into it, one track out.
  const AudioCtor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  let audio: AudioContext | null = null;
  const sources: MediaStreamAudioSourceNode[] = [];
  if (AudioCtor) {
    audio = new AudioCtor();
    const destination = audio.createMediaStreamDestination();
    for (const person of participants()) {
      if (!person.stream.getAudioTracks().length) continue;
      const source = audio.createMediaStreamSource(person.stream);
      source.connect(destination);
      sources.push(source);
    }
    destination.stream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
  }

  return {
    stream: canvasStream,
    stop: () => {
      clearInterval(timer);
      sources.forEach((s) => s.disconnect());
      void audio?.close().catch(() => undefined);
      videos.forEach((el) => { el.srcObject = null; });
      videos.clear();
      canvasStream.getTracks().forEach((t) => t.stop());
    },
  };
}

/* ---------------- the recording itself ---------------- */

export interface DeviceRecordingOptions {
  sessionId: string;
  label: string;
  /**
   * Where the bytes land. 'device' is the browser's own on-disk store and
   * needs no dialog, so it is the default and the one that always works.
   * 'file' opens a save dialog and writes straight into what the person
   * picks, which escapes the storage quota and skips the download at the end.
   *
   * Which of the two is used is asked for rather than inferred. The dialog
   * throws the same AbortError whether the person pressed cancel or the
   * browser could not show it at all, and a recorder that cannot tell those
   * apart either records after someone declined or silently does nothing.
   */
  target?: 'device' | 'file';
  /** Read fresh on every frame, so somebody joining mid-class appears. */
  participants: () => Participant[];
  /** Hard stop, matching the server's ceiling for a hosted recording. */
  maxMinutes: number;
  fps?: number;
  /** Called about once a second with how much has been written. */
  onProgress?: (state: { bytes: number; seconds: number }) => void;
  onStopped?: (reason: 'asked' | 'limit' | 'error', error?: Error) => void;
}

export interface DeviceRecording {
  stop(): Promise<DeviceRecordingResult>;
  readonly where: 'file' | 'device';
}

export interface DeviceRecordingResult {
  bytes: number;
  seconds: number;
  /** Present when the recording is in the browser's store rather than a file. */
  blob: Blob | null;
  filename: string;
  where: 'file' | 'device';
}

const CHUNK_MS = 5_000;

export async function startDeviceRecording(
  options: DeviceRecordingOptions,
): Promise<DeviceRecording> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser cannot record video.');
  }
  const filename = `${options.label} ${new Date().toISOString().slice(0, 16)}.webm`
    .replace(/[\\/:*?"<>|]/g, '-');

  let sink: Sink | null = null;
  if (options.target === 'file') {
    const picker = (window as unknown as {
      showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
    }).showSaveFilePicker;
    if (!picker) throw new Error('This browser cannot write straight to a file.');
    // Whatever goes wrong here — cancelled, or no dialog to show — the answer
    // is to tell the caller, not to quietly record somewhere else.
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
    });
    sink = new FileSink(await handle.createWritable());
  }

  const id = `${options.sessionId}-${Date.now()}`;
  let db: IDBDatabase | null = null;
  if (!sink) {
    db = await openDb();
    await keepStorage();
    sink = new DeviceSink(db, id);
    const tx = db.transaction(RECORDINGS, 'readwrite');
    tx.objectStore(RECORDINGS).put({
      id, sessionId: options.sessionId, label: options.label,
      startedAt: Date.now(), bytes: 0, mimeType: 'video/webm', complete: false,
    } satisfies DeviceRecordingMeta);
    await done(tx);
  }

  const composite = composeRoom(options.participants, options.fps ?? 24);
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(composite.stream, mimeType ? { mimeType } : undefined);

  const startedAt = Date.now();
  let bytes = 0;
  let seq = 0;
  let writes: Promise<void> = Promise.resolve();
  let failure: Error | null = null;
  let settled: ((result: DeviceRecordingResult) => void) | null = null;
  let stopReason: 'asked' | 'limit' | 'error' = 'asked';

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    const index = seq++;
    bytes += event.data.size;
    // Serialised: a WritableStream rejects a second write while one is in
    // flight, and at 720p the chunks outpace a slow disk.
    writes = writes
      .then(() => sink!.write(event.data, index))
      .catch((err: Error) => {
        failure ??= err;
        if (recorder.state === 'recording') { stopReason = 'error'; recorder.stop(); }
      });
    options.onProgress?.({ bytes, seconds: Math.round((Date.now() - startedAt) / 1000) });
  };

  const limit = setTimeout(() => {
    if (recorder.state === 'recording') { stopReason = 'limit'; recorder.stop(); }
  }, options.maxMinutes * 60_000);

  const finished = new Promise<DeviceRecordingResult>((resolve) => { settled = resolve; });

  recorder.onstop = () => {
    clearTimeout(limit);
    composite.stop();
    void writes
      .then(() => sink!.finish())
      .then(async (blob) => {
        if (db) {
          const tx = db.transaction(RECORDINGS, 'readwrite');
          tx.objectStore(RECORDINGS).put({
            id, sessionId: options.sessionId, label: options.label,
            startedAt, endedAt: Date.now(), bytes,
            mimeType: recorder.mimeType || 'video/webm', complete: true,
          } satisfies DeviceRecordingMeta);
          await done(tx);
        }
        options.onStopped?.(failure ? 'error' : stopReason, failure ?? undefined);
        settled?.({
          bytes, seconds: Math.round((Date.now() - startedAt) / 1000),
          blob, filename, where: sink!.kind,
        });
      })
      .catch((err: Error) => {
        options.onStopped?.('error', err);
        settled?.({
          bytes, seconds: Math.round((Date.now() - startedAt) / 1000),
          blob: null, filename, where: sink!.kind,
        });
      });
  };

  recorder.start(CHUNK_MS);

  return {
    where: sink.kind,
    stop: () => {
      if (recorder.state === 'recording') recorder.stop();
      return finished;
    },
  };
}

/* ---------------- what a crash left behind ---------------- */

/**
 * Recordings sitting in the browser's store. A tab that died mid-class leaves
 * one marked incomplete, and its chunks are still playable up to the moment
 * the tab went — which is the whole reason for writing them out as they
 * arrive rather than keeping them in a variable.
 */
export async function listDeviceRecordings(sessionId?: string): Promise<DeviceRecordingMeta[]> {
  let db: IDBDatabase;
  try { db = await openDb(); } catch { return []; }
  const tx = db.transaction(RECORDINGS, 'readonly');
  const rows = await asPromise(tx.objectStore(RECORDINGS).getAll() as IDBRequest<DeviceRecordingMeta[]>);
  db.close();
  return rows
    .filter((r) => !sessionId || r.sessionId === sessionId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** The file for one of them, assembled from its chunks. */
export async function readDeviceRecording(id: string): Promise<Blob | null> {
  const db = await openDb();
  const parts = await readChunks(db, id);
  db.close();
  if (!parts.length) return null;
  return new Blob(parts, { type: 'video/webm' });
}

export async function discardDeviceRecording(id: string): Promise<void> {
  const db = await openDb();
  await deleteRecording(db, id);
  db.close();
}

/** Hands the viewer a file without routing it through anyone's server. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
