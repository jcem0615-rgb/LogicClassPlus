/**
 * Recording to the format Azure Speech accepts.
 *
 * MediaRecorder produces WebM/Opus; the short-audio endpoint takes 16 kHz
 * 16-bit mono PCM WAV and nothing else. Converting here keeps ffmpeg off the
 * API host.
 */
const TARGET_RATE = 16_000;

type AudioContextCtor = typeof AudioContext;
type OfflineAudioContextCtor = typeof OfflineAudioContext;

function audioContext(): AudioContext {
  const Ctor = (window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext);
  if (!Ctor) throw new Error('This browser cannot decode audio.');
  return new Ctor();
}

async function decode(buffer: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = audioContext();
  try {
    return await ctx.decodeAudioData(buffer);
  } catch {
    throw new Error('That recording could not be decoded.');
  } finally {
    void ctx.close();
  }
}

async function resample(buffer: AudioBuffer): Promise<AudioBuffer> {
  const frames = Math.ceil(buffer.duration * TARGET_RATE);
  if (!frames) throw new Error('That recording is empty.');

  const Ctor = (window.OfflineAudioContext
    ?? (window as unknown as { webkitOfflineAudioContext?: OfflineAudioContextCtor })
      .webkitOfflineAudioContext);
  if (!Ctor) throw new Error('This browser cannot resample audio.');

  const offline = new Ctor(1, frames, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return view.buffer;
}

/** Chunked: String.fromCharCode.apply blows the stack on long audio. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(''));
}

export interface ConvertedAudio {
  base64: string; bytes: number; seconds: number; blob: Blob;
}

export async function toWav16k(input: Blob): Promise<ConvertedAudio> {
  const decoded = await decode(await input.arrayBuffer());
  if (decoded.duration < 0.3) throw new Error('That recording is too short to score.');
  const rendered = await resample(decoded);
  const wav = encodeWav(rendered.getChannelData(0), TARGET_RATE);
  return {
    base64: toBase64(wav),
    bytes: wav.byteLength,
    seconds: rendered.length / TARGET_RATE,
    blob: new Blob([wav], { type: 'audio/wav' }),
  };
}
