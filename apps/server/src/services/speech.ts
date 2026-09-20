/**
 * Pronunciation assessment via Azure Speech.
 *
 * Azure's short-audio REST endpoint takes the audio as the request body and the
 * assessment parameters as a base64 JSON header. It returns a per-word and
 * per-phoneme breakdown, which is the part that makes this useful in a lesson:
 * "your /ʃ/ is fine, it's the /iː/ that is short" beats a single number.
 *
 * Audio must be 16 kHz, 16-bit, mono PCM WAV. The browser records WebM/Opus,
 * which this endpoint does not accept, so the client converts before upload —
 * see apps/pwa/audio.js.
 */
import { env } from '../env.js';
import { badRequest, HttpError } from '../lib/http-error.js';

export interface PhonemeScore { phoneme: string; accuracy: number | null }

export interface WordScore {
  word: string;
  accuracy: number | null;
  /** None | Mispronunciation | Omission | Insertion | UnexpectedBreak | … */
  errorType: string;
  phonemes: PhonemeScore[];
}

export interface Assessment {
  recognizedText: string;
  scores: {
    accuracy: number | null;
    fluency: number | null;
    completeness: number | null;
    pronunciation: number | null;
    prosody: number | null;
  };
  words: WordScore[];
  durationSeconds: number | null;
  provider: 'azure';
}

export function isSpeechConfigured(): boolean {
  return Boolean(env.AZURE_SPEECH_KEY && (env.AZURE_SPEECH_ENDPOINT || env.AZURE_SPEECH_REGION));
}

export function speechBlockedReason(): string | null {
  if (env.AZURE_SPEECH_KEY && (env.AZURE_SPEECH_ENDPOINT || env.AZURE_SPEECH_REGION)) return null;
  return 'Pronunciation scoring needs an Azure Speech resource. Set AZURE_SPEECH_KEY and '
    + 'AZURE_SPEECH_REGION (or AZURE_SPEECH_ENDPOINT) to switch it on.';
}

function endpoint(language: string): string {
  const base = env.AZURE_SPEECH_ENDPOINT
    || `https://${env.AZURE_SPEECH_REGION}.stt.speech.microsoft.com`;
  return `${base.replace(/\/+$/, '')}/speech/recognition/conversation/cognitiveservices/v1`
    + `?language=${encodeURIComponent(language)}&format=detailed`;
}

/** Azure carries the assessment parameters as base64-encoded JSON in a header. */
export function assessmentHeader(referenceText: string): string {
  const config = {
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Phoneme',
    Dimension: 'Comprehensive',
    // Catches words that were skipped or added rather than just mispronounced.
    EnableMiscue: true,
    EnableProsodyAssessment: true,
    PhonemeAlphabet: 'IPA',
  };
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
}

/** Shapes we read out of Azure's detailed response. */
interface AzurePhoneme { Phoneme?: string; PronunciationAssessment?: { AccuracyScore?: number } }
interface AzureWord {
  Word?: string;
  PronunciationAssessment?: { AccuracyScore?: number; ErrorType?: string };
  Phonemes?: AzurePhoneme[];
}
interface AzureNBest {
  Display?: string;
  Lexical?: string;
  PronunciationAssessment?: {
    AccuracyScore?: number; FluencyScore?: number;
    CompletenessScore?: number; PronScore?: number; ProsodyScore?: number;
  };
  Words?: AzureWord[];
}
interface AzureResponse {
  RecognitionStatus?: string;
  Duration?: number;
  DisplayText?: string;
  NBest?: AzureNBest[];
}

const number = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function mapResponse(body: AzureResponse): Assessment {
  const status = body.RecognitionStatus ?? 'Unknown';
  if (status !== 'Success') {
    // These are the cases a learner actually hits, so say something they can act on.
    const message = status === 'NoMatch'
      ? 'No speech was recognised in that recording. Try again, a little closer to the microphone.'
      : status === 'InitialSilenceTimeout'
        ? 'The recording was silent. Check the microphone is the one you are speaking into.'
        : `The speech service returned "${status}".`;
    throw new HttpError(422, message, 'no_speech');
  }

  const best = body.NBest?.[0];
  const overall = best?.PronunciationAssessment ?? {};

  return {
    recognizedText: best?.Display ?? body.DisplayText ?? '',
    scores: {
      accuracy: number(overall.AccuracyScore),
      fluency: number(overall.FluencyScore),
      completeness: number(overall.CompletenessScore),
      pronunciation: number(overall.PronScore),
      prosody: number(overall.ProsodyScore),
    },
    words: (best?.Words ?? []).map((word) => ({
      word: word.Word ?? '',
      accuracy: number(word.PronunciationAssessment?.AccuracyScore),
      errorType: word.PronunciationAssessment?.ErrorType ?? 'None',
      phonemes: (word.Phonemes ?? []).map((p) => ({
        phoneme: p.Phoneme ?? '',
        accuracy: number(p.PronunciationAssessment?.AccuracyScore),
      })),
    })),
    // Azure reports duration in 100-nanosecond ticks.
    durationSeconds: body.Duration ? body.Duration / 1e7 : null,
    provider: 'azure',
  };
}

export async function assess(
  audio: Buffer, referenceText: string, language = env.AZURE_SPEECH_LANGUAGE,
): Promise<Assessment> {
  if (!isSpeechConfigured()) {
    throw new HttpError(503, speechBlockedReason()!, 'not_configured');
  }
  if (!referenceText.trim()) throw badRequest('A reference phrase is required to score against.');
  assertWav16kMono(audio);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let response: Response;
  try {
    response = await fetch(endpoint(language), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY!,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Pronunciation-Assessment': assessmentHeader(referenceText),
        Accept: 'application/json',
      },
      body: new Uint8Array(audio),
      signal: controller.signal,
    });
  } catch (err) {
    throw new HttpError(
      (err as Error).name === 'AbortError' ? 504 : 502,
      (err as Error).name === 'AbortError'
        ? 'The speech service did not answer in time. Try again.'
        : 'Could not reach the speech service.',
      'upstream',
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  if (!response.ok) {
    // 401 here nearly always means a wrong key or the wrong region for the key.
    const hint = response.status === 401 || response.status === 403
      ? ' Check AZURE_SPEECH_KEY and that AZURE_SPEECH_REGION matches the resource.'
      : '';
    throw new HttpError(502, `The speech service rejected the request (${response.status}).${hint}`,
      'upstream', text.slice(0, 300));
  }

  let parsed: AzureResponse;
  try {
    parsed = JSON.parse(text) as AzureResponse;
  } catch {
    throw new HttpError(502, 'The speech service returned something unreadable.', 'upstream');
  }
  return mapResponse(parsed);
}

/**
 * Azure rejects anything that is not 16 kHz 16-bit mono PCM, and its error for
 * the wrong format is opaque. Checking the RIFF header here turns that into a
 * message that names what is wrong.
 */
export function assertWav16kMono(audio: Buffer): void {
  if (audio.length < 44) throw badRequest('That audio is too short to score.');
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw badRequest('Audio must be a WAV file. The recording is converted before upload.');
  }
  const channels = audio.readUInt16LE(22);
  const sampleRate = audio.readUInt32LE(24);
  const bitsPerSample = audio.readUInt16LE(34);

  if (channels !== 1) throw badRequest(`Audio must be mono; this has ${channels} channels.`);
  if (sampleRate !== 16000) throw badRequest(`Audio must be 16 kHz; this is ${sampleRate} Hz.`);
  if (bitsPerSample !== 16) throw badRequest(`Audio must be 16-bit; this is ${bitsPerSample}-bit.`);
}
