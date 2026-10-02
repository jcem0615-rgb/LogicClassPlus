'use client';

/** What this session is, what recording it would cost, and how to end it. */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { bytes, dayTime } from '@/lib/format';
import { Button, Flag, Summary, SubjectPill } from '@/components/ui';
import { deviceSpace, type DeviceSpace } from '@/lib/device-recording';
import type { ClassSession, RecordingEstimate } from '@/lib/types';

export function SessionPanel({ session, withWhom, isTeacher, transport, canRecord, recording, onRecording, onEnd }: {
  session: ClassSession;
  /** Who the class is with: one person, or the roster of a group. */
  withWhom: string;
  isTeacher: boolean;
  transport: 'sfu' | 'p2p' | null;
  canRecord: boolean;
  recording: boolean;
  onRecording: (active: boolean) => void;
  onEnd: (outcome: 'completed' | 'no_show') => void;
}) {
  const store = useStore();
  const [estimate, setEstimate] = useState<RecordingEstimate | null>(null);
  const [space, setSpace] = useState<DeviceSpace | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void deviceSpace().then(setSpace).catch(() => undefined); }, []);

  useEffect(() => {
    void api.recordingEstimate(session.minutes).then(setEstimate).catch(() => undefined);
  }, [session.minutes]);

  return (
    <div className="flex flex-col gap-3.5">
      <Summary items={[
        { k: 'Subject', v: session.subject === 'math' ? 'Math' : 'English' },
        { k: 'Planned', v: `${session.minutes} min`, s: dayTime(session.startsAt) },
        { k: 'Status', v: session.status === 'live' ? 'Live' : session.status },
        { k: 'Recording', v: session.recordingUrl ? 'Saved' : recording ? 'Running' : 'None' },
      ]} />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-card-2 p-3.5">
        <div>
          <div className="font-semibold">{session.topic}</div>
          <div className="text-[13px] text-ink-3">{withWhom}</div>
        </div>
        <SubjectPill subject={session.subject} />
      </div>

      {isTeacher ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => onEnd('completed')}>End and mark complete</Button>
          <Button onClick={() => onEnd('no_show')}>Student did not show</Button>
        </div>
      ) : null}

      <section className="flex flex-col gap-3 rounded-md border border-line bg-card-2 p-3.5">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Class recording</span>
          <span className="font-mono text-[13px] text-ink-3">
            {estimate ? (estimate.configured ? 'media server ready' : 'not configured') : 'checking…'}
          </span>
        </div>

        {estimate ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-ink-2">This session</span>
              <span className="font-mono font-semibold" data-testid="rec-estimate">
                {session.minutes} min → {bytes(estimate.bytes)}
              </span>
            </div>
            <div className="flex items-center justify-between text-[13px] text-ink-3">
              <span>One recording runs for up to</span>
              <span className="font-mono" data-testid="rec-cap">
                {Math.floor(estimate.maxMinutes / 60)}h
                {estimate.maxMinutes % 60 ? ` ${estimate.maxMinutes % 60}m` : ''}
              </span>
            </div>

            <div className="flex flex-col gap-1 rounded-sm border border-line bg-card p-3">
              {Object.entries(estimate.presets).map(([key, preset]) => (
                <div key={key} className={`flex items-center justify-between ${
                  key === estimate.preset ? 'font-semibold' : 'text-ink-2'}`}>
                  <span>{preset.label}{key === estimate.preset ? ' · selected' : ''}</span>
                  <span className="font-mono">{bytes(preset.bytes)}</span>
                </div>
              ))}
            </div>

            {estimate.exceedsCap ? (
              <Flag title="Longer than one recording">
                This class is booked for {session.minutes} minutes and a recording runs for at most
                {' '}{estimate.maxMinutes}. The first one stops at the limit — start a second one
                then, and you will have the class in two files rather than losing the end of it.
              </Flag>
            ) : null}

            {!estimate.configured ? (
              <Flag title="Recording is off">{estimate.reason}</Flag>
            ) : transport !== 'sfu' ? (
              <Flag title="This class is on a direct connection">
                Media is going browser to browser, so the server has no stream to record. A class is
                routed through the media server from the moment it starts, or not at all — switching
                mid-call would drop both participants.
              </Flag>
            ) : !canRecord ? (
              <Flag title="Nowhere to put the file">
                The media server is connected, but recordings are uploaded straight to object
                storage, so S3_BUCKET and its credentials must be set on the server.
              </Flag>
            ) : isTeacher ? (
              <>
                <div className="flex gap-2">
                  {recording ? (
                    <Button variant="danger" disabled={busy} onClick={() => {
                      setBusy(true);
                      void api.stopRecording(session.id)
                        .then((r) => { onRecording(false); store.toast('ok', 'Recording stopped', r.note); })
                        .catch((err) => store.toast('err', 'Could not stop', (err as Error).message))
                        .finally(() => setBusy(false));
                    }}>Stop recording</Button>
                  ) : (
                    <Button variant="primary" disabled={busy} onClick={() => {
                      setBusy(true);
                      void api.startRecording(session.id)
                        .then((r) => {
                          onRecording(true);
                          store.toast('ok', 'Recording started',
                            `Expected size: ${bytes(r.estimatedBytes)} at ${r.preset}. `
                            + `It stops by itself after ${r.maxMinutes} minutes.`);
                        })
                        .catch((err) => store.toast('err', 'Recording did not start', (err as Error).message))
                        .finally(() => setBusy(false));
                    }}>Start recording</Button>
                  )}
                </div>
                <p className="text-[13px] text-ink-3">
                  The media server composites both participants and uploads the file straight to
                  object storage. Both of you are notified whenever recording starts.
                </p>
              </>
            ) : (
              <p className="text-[13px] text-ink-3">
                Only your teacher can start a recording. You are told whenever one starts.
              </p>
            )}
          </>
        ) : null}

        <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-card p-3">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Or record on this device</span>
            <span className="font-mono text-[13px] text-ink-3" data-testid="device-space">
              {space === null ? 'checking…'
                : space.free == null ? 'space unknown'
                  : `${bytes(space.free)} free`}
            </span>
          </div>
          <p className="text-[13px] text-ink-3">
            <b>Record class</b> in the controls — the teacher's, like the one above — composites
            everyone in the room here in the browser
            and keeps the file on this machine — no media server and no bucket, so it works whether
            or not the ones above are configured. It is written out as the class runs, so a long
            lesson costs a few megabytes of memory rather than the whole recording, and what was
            written survives the tab closing.
            {space?.persisted === false
              ? ' This browser has not promised to keep it, so leave the tab open until you stop.'
              : ''}
          </p>
        </div>
      </section>
    </div>
  );
}
