'use client';

/** Nobody should discover their microphone is muted in front of a student. */
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Flag, Pill } from '@/components/ui';
import type { ClassSession, User } from '@/lib/types';

export interface DeviceChoice { cam: string; mic: string }

export function HardwareCheck({ session, other, stream, error, devices, choice, onChoose, onJoin, onCancel }: {
  session: ClassSession;
  other: User;
  stream: MediaStream | null;
  error: string | null;
  devices: { cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[] };
  choice: DeviceChoice;
  onChoose: (choice: DeviceChoice) => void;
  onJoin: () => void;
  onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (!stream?.getAudioTracks().length) return undefined;
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;

    const ctx = new Ctor();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);
    let raf = 0;

    const loop = () => {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const sample of buffer) { const v = (sample - 128) / 128; sum += v * v; }
      const pct = Math.min(100, Math.round(Math.sqrt(sum / buffer.length) * 320));
      setLevel(pct);
      if (pct > 8) setHeard(true);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => { cancelAnimationFrame(raf); void ctx.close(); };
  }, [stream]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(9,18,21,.55)] p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[88vh] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-line-2 bg-card shadow-2">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <span className="eyebrow">Before you join</span>
            <h2 className="mt-1 text-[19px]">Check your camera and microphone</h2>
            <p className="mt-1 text-[13px] text-ink-2">
              {session.topic} · with {other.name} · {session.minutes} minutes
            </p>
          </div>
          <Pill tone={session.subject === 'math' ? 'math' : 'english'}>
            {session.subject === 'math' ? 'Math suite' : 'English suite'}
          </Pill>
        </div>

        <div className="flex flex-col gap-3.5 overflow-y-auto p-5">
          <div className="grid aspect-video place-items-center overflow-hidden rounded-md border border-line bg-[#0A1214]">
            {stream ? (
              <video ref={video} autoPlay playsInline muted className="h-full w-full object-cover" />
            ) : (
              <span className="px-4 text-center text-[13px] text-ink-3">No camera preview</span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Mic level — say something</span>
              <span className="text-[13px] text-ink-3">{heard ? 'sounds good' : 'waiting'}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-sunk">
              <div className="h-full bg-ok transition-[width] duration-75" style={{ width: `${level}%` }} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Camera">
              <select value={choice.cam} disabled={!devices.cams.length}
                onChange={(e) => onChoose({ ...choice, cam: e.target.value })}>
                {devices.cams.length
                  ? devices.cams.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>))
                  : <option>None detected</option>}
              </select>
            </Field>
            <Field label="Microphone">
              <select value={choice.mic} disabled={!devices.mics.length}
                onChange={(e) => onChoose({ ...choice, mic: e.target.value })}>
                {devices.mics.length
                  ? devices.mics.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>))
                  : <option>None detected</option>}
              </select>
            </Field>
          </div>

          {error ? (
            <Flag title="Camera and microphone are blocked">
              {error} You can still join — the whiteboard, document, equation editor and chat all work
              without them.
            </Flag>
          ) : null}
        </div>

        <div className="flex justify-end gap-2.5 border-t border-line bg-card-2 px-5 py-3.5">
          <Button onClick={onCancel}>Cancel</Button>
          <Button id="hw-join" variant="primary" onClick={onJoin}>Join classroom</Button>
        </div>
      </div>
    </div>
  );
}
