'use client';

/**
 * Pronunciation drill, scored by the server's speech provider.
 *
 * With no provider configured the waveform is still drawn from the real
 * recording and no score is shown: a made-up number is worse than none.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { toWav16k } from '@/lib/audio';
import { useStore } from '@/lib/store';
import { ago } from '@/lib/format';
import { Bar, Button, Card, CardHead, Flag } from '@/components/ui';
import type { Assessment, SpeechStatus } from '@/lib/types';

const PHRASES = [
  { text: "I'd like a ship, not a sheep.", focus: '/ɪ/ vs /iː/', sounds: ['ɪ', 'iː', 'l', 'd', 'n'] },
  { text: 'She sells sea shells by the sea shore.', focus: '/ʃ/ vs /s/', sounds: ['ʃ', 's', 'iː', 'l', 'ɔː'] },
  { text: 'The thirty-three thieves thought they thrilled the throne.', focus: '/θ/ vs /ð/', sounds: ['θ', 'ð', 'iː', 'ɔː', 'r'] },
];

const tone = (score: number | null): string =>
  score == null ? 'var(--ink-3)' : score >= 85 ? 'var(--ok)' : score >= 70 ? 'var(--warn)' : 'var(--crit)';

export function Pronunciation({ sessionId }: { sessionId: string }) {
  const store = useStore();
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [result, setResult] = useState<Assessment | null>(null);
  const [selected, setSelected] = useState(0);
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; referenceText: string; scores: Assessment['scores']; createdAt: string }>>([]);
  const recorder = useRef<MediaRecorder | null>(null);

  const phrase = PHRASES[index]!;

  const loadHistory = useCallback(() => {
    void api.attempts({ sessionId, limit: 5 }).then((r) => setHistory(r.attempts)).catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    void api.speechStatus().then(setStatus).catch(() => setStatus({ configured: false, reason: 'Could not reach the speech service.' }));
    loadHistory();
  }, [loadHistory]);

  /** The envelope is measured from the real recording, whatever else is off. */
  async function measure(blob: Blob) {
    try {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
      const data = audio.getChannelData(0);
      const bars = 64;
      const block = Math.floor(data.length / bars);
      const values: number[] = [];
      for (let i = 0; i < bars; i += 1) {
        let sum = 0;
        for (let j = 0; j < block; j += 1) { const v = data[i * block + j] ?? 0; sum += v * v; }
        values.push(Math.sqrt(sum / block));
      }
      const max = Math.max(...values) || 1;
      setPeaks(values.map((v) => v / max));
      void ctx.close();
    } catch { /* the drill still works without a waveform */ }
  }

  async function toggleRecord() {
    if (recorder.current?.state === 'recording') { recorder.current.stop(); return; }
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
      store.toast('err', 'Recording unavailable', 'This browser does not expose MediaRecorder.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.current = rec;
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        setClip((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) }; });
        setResult(null);
        setRecording(false);
        void measure(blob);
      };
      rec.start();
      setRecording(true);
      setError(null);
    } catch (err) {
      store.toast('err', 'Microphone blocked', (err as Error).message);
    }
  }

  async function score() {
    if (!clip) return;
    setScoring(true); setError(null);
    try {
      const wav = await toWav16k(clip.blob);
      const assessment = await api.assess({
        referenceText: phrase.text, audioBase64: wav.base64, sessionId,
      });
      setResult(assessment);
      // Open on the weakest word: that is the one worth another attempt.
      let weakest = 0;
      assessment.words.forEach((w, i) => {
        const current = assessment.words[weakest];
        if (w.accuracy != null && (current?.accuracy == null || w.accuracy < current.accuracy)) weakest = i;
      });
      setSelected(weakest);
      loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScoring(false);
    }
  }

  const errorLabels: Record<string, string> = {
    None: '', Mispronunciation: 'mispronounced', Omission: 'omitted',
    Insertion: 'added', UnexpectedBreak: 'broken', MissingBreak: 'run on', Monotone: 'flat',
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow">Pronunciation drill · {phrase.focus}</span>
        <div className="flex items-center gap-2">
          <span id="speech-status" className="font-mono text-[13px]"
            style={{ color: status?.configured ? 'var(--ok)' : 'var(--ink-3)' }}>
            {status ? (status.configured ? `Azure Speech · ${status.language ?? 'en-US'}` : 'scoring off') : 'checking…'}
          </span>
          <Button size="sm" onClick={() => {
            setIndex((i) => (i + 1) % PHRASES.length);
            setClip(null); setPeaks(null); setResult(null);
          }}>Next phrase</Button>
        </div>
      </div>

      <div className="rounded-md border border-line bg-card-2 p-3.5">
        <p className="font-display text-[19px] leading-snug">{phrase.text}</p>
        <p className="mt-1.5 font-mono text-[13px] text-ink-3">
          target sounds: {phrase.sounds.map((s) => `/${s}/`).join('  ')}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={recording ? 'danger' : 'primary'} onClick={() => void toggleRecord()}>
          {recording ? 'Stop recording' : 'Record your attempt'}
        </Button>
        {clip && !recording ? (
          <Button id="analyse-btn" disabled={scoring} onClick={() => void score()}>
            {scoring ? 'Scoring…' : 'Score this attempt'}
          </Button>
        ) : null}
      </div>

      {clip ? <audio controls src={clip.url} className="w-full" /> : null}

      <div className="rounded-md border border-line bg-card-2 p-3.5">
        <div className="eyebrow mb-2">Waveform</div>
        <div className="flex h-11 items-end gap-0.5">
          {peaks
            ? peaks.map((p, i) => (
                <i key={i} className="flex-1 rounded-[1px] bg-english opacity-80"
                  style={{ height: `${Math.max(2, Math.round(p * 44))}px` }} />))
            : <span className="text-[13px] text-ink-3">Record to see your envelope.</span>}
        </div>
      </div>

      {error ? <Flag title="Not scored">{error}</Flag> : null}

      {result ? (
        <div id="score-out" className="flex flex-col gap-3 rounded-md border border-line bg-card-2 p-3.5">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Scored by {result.provider === 'azure' ? 'Azure Speech' : result.provider}</span>
            <span className="font-mono text-[13px] text-ink-3">
              {result.durationSeconds ? `${result.durationSeconds.toFixed(1)}s` : ''}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            {([['Pronunciation', result.scores.pronunciation], ['Accuracy', result.scores.accuracy],
               ['Fluency', result.scores.fluency], ['Completeness', result.scores.completeness],
               ['Prosody', result.scores.prosody]] as const).map(([label, value]) => value == null ? null : (
              <div key={label} className="flex items-center justify-between gap-3">
                <span className="min-w-[104px] text-[13px] text-ink-2">{label}</span>
                <Bar value={value} tone={tone(value)} />
                <span className="min-w-[34px] text-right font-mono text-[13px] tabular" style={{ color: tone(value) }}>
                  {Math.round(value)}
                </span>
              </div>
            ))}
          </div>

          <div>
            <div className="eyebrow mb-1.5">Heard</div>
            <p className="text-[13px] text-ink-2">“{result.recognizedText || '—'}”</p>
          </div>

          <div>
            <div className="eyebrow mb-1.5">Word by word — tap one for its sounds</div>
            <div className="flex flex-wrap gap-2">
              {result.words.map((w, i) => (
                <button key={`${w.word}-${i}`} onClick={() => setSelected(i)}
                  className={`inline-flex items-baseline gap-1.5 rounded-sm border px-2.5 py-1.5 text-sm font-medium ${
                    selected === i ? 'bg-sunk' : 'bg-card'}`}
                  style={{ borderColor: tone(w.accuracy), color: tone(w.accuracy) }}>
                  {w.word}
                  {w.accuracy != null ? <span className="font-mono text-[11px]">{Math.round(w.accuracy)}</span> : null}
                  {errorLabels[w.errorType] ? (
                    <span className="text-[11px] text-ink-3">{errorLabels[w.errorType]}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          {result.words[selected]?.phonemes.length ? (
            <div id="phoneme-out">
              <div className="eyebrow mb-1.5">Sounds in “{result.words[selected]!.word}”</div>
              <div className="flex flex-wrap gap-1.5">
                {result.words[selected]!.phonemes.map((p, i) => (
                  <div key={`${p.phoneme}-${i}`}
                    className="flex min-w-[52px] flex-col items-center gap-0.5 rounded-sm border border-line bg-card px-2 py-1.5">
                    <span className="font-mono text-[13px]" style={{ color: tone(p.accuracy) }}>
                      {p.accuracy == null ? '—' : Math.round(p.accuracy)}
                    </span>
                    <span className="font-mono text-xs text-ink-2">/{p.phoneme}/</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : status && !status.configured ? (
        <Flag title="Scoring is not switched on">
          {status.reason} The waveform above is measured from your real recording; no score is shown,
          because a made-up number is worse than none.
        </Flag>
      ) : null}

      {history.length ? (
        <Card>
          <CardHead title="Earlier attempts">
            <span className="text-[13px] text-ink-3">{history.length} in this session</span>
          </CardHead>
          {history.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 border-b border-line px-[18px] py-3 last:border-0">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">“{a.referenceText}”</div>
                <div className="font-mono text-[13px] text-ink-3">{ago(a.createdAt)}</div>
              </div>
              <span className="font-mono font-semibold" style={{ color: tone(a.scores.pronunciation) }}>
                {a.scores.pronunciation == null ? '—' : Math.round(a.scores.pronunciation)}
              </span>
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  );
}
