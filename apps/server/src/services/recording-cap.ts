/**
 * Cutting off a recording nobody stopped.
 *
 * Egress runs until it is told otherwise. A teacher who closes the tab at the
 * end of a lesson leaves it running, and it keeps compositing and writing to
 * the bucket for as long as the room exists — a bill that grows while nobody
 * is looking. RECORDING_MAX_MINUTES is the ceiling, three hours by default,
 * which is twice the longest lesson the booking form offers.
 *
 * A timer set when the recording starts would be lost on the next deploy, and
 * deploys are exactly when nobody is watching, so the ceiling is enforced by
 * re-reading the database instead: `recordingStartedAt` is the only state,
 * and a sweep that runs on an interval stops anything past its limit. The
 * sweep is also run once at boot, which is what catches the recordings a
 * restart would otherwise have orphaned.
 */
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { isRecordingConfigured, stopRecording } from './recording.js';
import { notify } from './notifications.js';
import { emitToSession } from '../realtime/gateway.js';

/** How long a recording may run, in milliseconds. */
export const capMs = (): number => env.RECORDING_MAX_MINUTES * 60_000;

/** Milliseconds a recording started at this time has left, floored at zero. */
export const remainingMs = (startedAt: Date, now = Date.now()): number =>
  Math.max(0, startedAt.getTime() + capMs() - now);

/**
 * Stops every recording that has outlived the cap. Returns the sessions it
 * stopped, which is what the tests assert on.
 */
export async function sweepOverrunningRecordings(now = Date.now()): Promise<string[]> {
  if (!isRecordingConfigured()) return [];
  const overdue = await prisma.classSession.findMany({
    where: {
      recordingEgressId: { not: null },
      recordingStartedAt: { not: null, lt: new Date(now - capMs()) },
      // A session whose file has landed is finished, whatever its markers
      // say. Stopping an egress that already ended fails every time, and a
      // failure leaves the id in place to be retried on the next tick.
      recordingUrl: null,
    },
    select: { id: true, topic: true, teacherId: true, recordingEgressId: true },
  });

  const stopped: string[] = [];
  for (const session of overdue) {
    try {
      await stopRecording(session.recordingEgressId!);
    } catch (err) {
      // A failed stop must not block the others, and must not clear the id:
      // leaving it set means the next sweep tries again.
      console.error(`[recording] could not stop egress for ${session.id}:`, (err as Error).message);
      continue;
    }
    await prisma.classSession.update({
      where: { id: session.id },
      data: { recordingEgressId: null, recordingStartedAt: null },
    });
    emitToSession(session.id, 'classroom:recording', { status: 'stopping' });
    await notify({
      userId: session.teacherId, type: 'recording', title: 'Recording stopped at the limit',
      body: `${session.topic} — recordings run for at most ${env.RECORDING_MAX_MINUTES} minutes. `
        + 'Start another one if the class is still going.',
      url: '/#/classes',
    });
    stopped.push(session.id);
  }
  return stopped;
}

let timer: NodeJS.Timeout | null = null;

/** Runs the sweep at boot and then every minute. Idempotent. */
export function startRecordingCapSweeper(intervalMs = 60_000): void {
  if (timer) return;
  void sweepOverrunningRecordings().catch((err) => {
    console.error('[recording] sweep failed:', (err as Error).message);
  });
  timer = setInterval(() => {
    void sweepOverrunningRecordings().catch((err) => {
      console.error('[recording] sweep failed:', (err as Error).message);
    });
  }, intervalMs);
  // Nothing should be kept alive by this alone.
  timer.unref?.();
}

export function stopRecordingCapSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
