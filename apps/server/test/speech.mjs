/**
 * Pronunciation scoring, end to end against a stand-in for Azure Speech.
 *
 * There is no Azure key in this environment, so the test starts a local server
 * that behaves like Azure's short-audio endpoint and asserts the request it
 * receives is the one Azure documents: the subscription key, the WAV content
 * type, and the base64 Pronunciation-Assessment header with phoneme
 * granularity. The response is a real-shaped detailed payload.
 *
 * Run:  node apps/server/test/speech.mjs      (needs the API on :4001)
 */
import { createServer } from 'node:http';

const API = 'http://localhost:4001/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' ' + extra); }
};

/* ---------------- a stand-in for Azure ---------------- */
let lastRequest = null;
const azure = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    lastRequest = { url: req.url, headers: req.headers, body };

    // A reference phrase starting with ZZZ makes the stand-in answer the way
    // Azure does for a silent or unintelligible recording.
    let requested = {};
    try {
      requested = JSON.parse(Buffer.from(req.headers['pronunciation-assessment'] || '', 'base64').toString('utf8'));
    } catch {}
    if (String(requested.ReferenceText || '').startsWith('ZZZ')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ RecognitionStatus: 'NoMatch' }));
      return;
    }
    if (!req.headers['ocp-apim-subscription-key']) {
      res.writeHead(401).end('{"error":"missing key"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      RecognitionStatus: 'Success',
      Duration: 31_000_000,                     // 3.1s in 100ns ticks
      DisplayText: 'I would like a ship, not a sheep.',
      NBest: [{
        Display: 'I would like a ship, not a sheep.',
        PronunciationAssessment: {
          AccuracyScore: 88.0, FluencyScore: 92.0,
          CompletenessScore: 100.0, PronScore: 90.0, ProsodyScore: 84.0,
        },
        Words: [
          { Word: 'ship', PronunciationAssessment: { AccuracyScore: 94.0, ErrorType: 'None' },
            Phonemes: [
              { Phoneme: 'ʃ', PronunciationAssessment: { AccuracyScore: 97.0 } },
              { Phoneme: 'ɪ', PronunciationAssessment: { AccuracyScore: 91.0 } },
              { Phoneme: 'p', PronunciationAssessment: { AccuracyScore: 95.0 } },
            ] },
          { Word: 'sheep', PronunciationAssessment: { AccuracyScore: 58.0, ErrorType: 'Mispronunciation' },
            Phonemes: [
              { Phoneme: 'ʃ', PronunciationAssessment: { AccuracyScore: 93.0 } },
              { Phoneme: 'iː', PronunciationAssessment: { AccuracyScore: 41.0 } },
              { Phoneme: 'p', PronunciationAssessment: { AccuracyScore: 88.0 } },
            ] },
        ],
      }],
    }));
  });
});
const MOCK_PORT = Number(process.env.SPEECH_MOCK_PORT || 45099);
await new Promise((r) => azure.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`stand-in Azure listening on http://127.0.0.1:${MOCK_PORT}`);
console.log('to exercise the scoring path, restart the API with:');
console.log(`  AZURE_SPEECH_KEY=test-key AZURE_SPEECH_ENDPOINT=http://127.0.0.1:${MOCK_PORT}\n`);

/* ---------------- helpers ---------------- */
async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const login = async (email, password) =>
  (await call('/auth/login', { method: 'POST', body: { email, password } })).json;

/** A valid 16 kHz mono 16-bit WAV of a quiet tone. */
function wav16k(seconds = 1.5) {
  const rate = 16000;
  const frames = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buf.writeInt16LE(Math.round(Math.sin(i / 12) * 6000), 44 + i * 2);
  return buf;
}
/** A 44.1 kHz stereo WAV, which Azure would refuse. */
function wavWrongFormat() {
  const buf = wav16k(0.5);
  buf.writeUInt16LE(2, 22);      // channels
  buf.writeUInt32LE(44100, 24);  // sample rate
  return buf;
}

const student = await login('amira@logicclass.plus', 'learn1234');
const teacher = await login('daniel@logicclass.plus', 'teach1234');
const phrase = "I'd like a ship, not a sheep.";

console.log('\n1. Availability is reported honestly');
const health = await call('/health');
ok('health reports whether speech is configured',
  typeof health.json.integrations.speech === 'boolean',
  JSON.stringify(health.json.integrations));
const status = await call('/speech/status', { token: student.token });
ok('status names the provider', status.json.provider === 'azure');
if (!status.json.configured) {
  ok('unconfigured status explains what to set',
    /AZURE_SPEECH_KEY/.test(status.json.reason || ''), status.json.reason);
  const attempt = await call('/speech/assess', { method: 'POST', token: student.token,
    body: { referenceText: phrase, audioBase64: wav16k().toString('base64') } });
  ok('unconfigured scoring refuses with 503, inventing nothing',
    attempt.status === 503 && !attempt.json.scores, JSON.stringify(attempt.json).slice(0, 120));
}

console.log('\n2. Auth and input validation');
const anon = await call('/speech/assess', { method: 'POST',
  body: { referenceText: phrase, audioBase64: wav16k().toString('base64') } });
ok('scoring requires sign-in', anon.status === 401);
const noAudio = await call('/speech/assess', { method: 'POST', token: student.token,
  body: { referenceText: phrase, audioBase64: '' } });
ok('empty audio rejected', noAudio.status === 400);
const noText = await call('/speech/assess', { method: 'POST', token: student.token,
  body: { referenceText: '', audioBase64: wav16k().toString('base64') } });
ok('missing reference phrase rejected', noText.status === 400);
const foreignSession = await call('/speech/assess', { method: 'POST', token: student.token,
  body: { referenceText: phrase, audioBase64: wav16k().toString('base64'), sessionId: 'does-not-exist' } });
ok("another person's session is refused", foreignSession.status === 404 || foreignSession.status === 403,
  String(foreignSession.status));

console.log('\n3. Against the stand-in Azure');
console.log('   (restart the API with AZURE_SPEECH_KEY + AZURE_SPEECH_ENDPOINT to run these)');
if (status.json.configured) {
  const wrongFormat = await call('/speech/assess', { method: 'POST', token: student.token,
    body: { referenceText: phrase, audioBase64: wavWrongFormat().toString('base64') } });
  ok('wrong sample rate is caught before the upstream call',
    wrongFormat.status === 400 && /16 kHz|mono/.test(wrongFormat.json?.error?.message || ''),
    JSON.stringify(wrongFormat.json?.error?.message));

  const scored = await call('/speech/assess', { method: 'POST', token: student.token,
    body: { referenceText: phrase, audioBase64: wav16k(2).toString('base64') } });
  ok('scoring succeeds', scored.status === 200, JSON.stringify(scored.json).slice(0, 160));

  // the request Azure would have received
  const h = lastRequest?.headers ?? {};
  ok('subscription key is sent', Boolean(h['ocp-apim-subscription-key']));
  ok('content type declares 16 kHz PCM WAV',
    /audio\/wav/.test(h['content-type'] || '') && /samplerate=16000/.test(h['content-type'] || ''),
    h['content-type']);
  ok('detailed format requested for the chosen language',
    /format=detailed/.test(lastRequest?.url || '') && /language=en-US/.test(lastRequest?.url || ''),
    lastRequest?.url);
  let config = {};
  try { config = JSON.parse(Buffer.from(h['pronunciation-assessment'] || '', 'base64').toString('utf8')); } catch {}
  ok('assessment header carries the reference phrase', config.ReferenceText === phrase, JSON.stringify(config));
  ok('phoneme granularity requested', config.Granularity === 'Phoneme');
  ok('miscue detection on, so skipped words are caught', config.EnableMiscue === true);
  ok('IPA alphabet requested', config.PhonemeAlphabet === 'IPA');
  ok('the audio body is a RIFF/WAVE file',
    lastRequest?.body?.toString('ascii', 0, 4) === 'RIFF' && lastRequest?.body?.toString('ascii', 8, 12) === 'WAVE');

  // the response mapping
  const r = scored.json;
  ok('overall scores mapped', r.scores.pronunciation === 90 && r.scores.accuracy === 88
    && r.scores.fluency === 92 && r.scores.completeness === 100 && r.scores.prosody === 84,
    JSON.stringify(r.scores));
  ok('duration converted from 100ns ticks to seconds', Math.abs(r.durationSeconds - 3.1) < 0.001, String(r.durationSeconds));
  ok('per-word scores and error types mapped',
    r.words.length === 2 && r.words[1].word === 'sheep' && r.words[1].errorType === 'Mispronunciation',
    JSON.stringify(r.words.map(w => w.word + ':' + w.errorType)));
  ok('per-phoneme scores mapped with IPA symbols',
    r.words[1].phonemes.length === 3 && r.words[1].phonemes[1].phoneme === 'iː'
    && r.words[1].phonemes[1].accuracy === 41,
    JSON.stringify(r.words[1].phonemes));

  console.log('\n4. Attempts are recorded');
  const mine = await call('/speech/attempts?limit=5', { token: student.token });
  ok('the attempt was saved for the student',
    mine.json.attempts.length > 0 && mine.json.attempts[0].scores.pronunciation === 90,
    JSON.stringify(mine.json.attempts[0]?.scores));
  ok('saved attempt keeps the phoneme detail',
    Array.isArray(mine.json.attempts[0].words) && mine.json.attempts[0].words[1].phonemes.length === 3);
  const otherStudent = await login('kenji@logicclass.plus', 'learn1234');
  const theirs = await call('/speech/attempts?limit=5', { token: otherStudent.token });
  ok('a student sees only their own attempts',
    theirs.json.attempts.every(a => a.studentId === otherStudent.user.id),
    String(theirs.json.attempts.length));
  const teacherView = await call('/speech/attempts?limit=5', { token: teacher.token });
  ok('a teacher sees attempts, scoped to their sessions', Array.isArray(teacherView.json.attempts));

  console.log('\n5. Upstream failures are reported, not faked');
  const silent = await call('/speech/assess', { method: 'POST', token: student.token,
    body: { referenceText: 'ZZZ silent recording', audioBase64: wav16k(1).toString('base64') } });
  ok('a recording with no speech returns 422, not a score',
    silent.status === 422 && !silent.json.scores, JSON.stringify(silent.json).slice(0, 120));
  ok('and says what to do about it',
    /No speech was recognised/.test(silent.json?.error?.message || ''), silent.json?.error?.message);

  const before = (await call('/speech/attempts?limit=50', { token: student.token })).json.attempts.length;
  const silentAgain = await call('/speech/assess', { method: 'POST', token: student.token,
    body: { referenceText: 'ZZZ silent again', audioBase64: wav16k(1).toString('base64') } });
  const after = (await call('/speech/attempts?limit=50', { token: student.token })).json.attempts.length;
  ok('a failed attempt is not stored as a score', before === after && silentAgain.status === 422,
    before + ' -> ' + after);
}

console.log(`\n${pass} passed, ${fail} failed`);
azure.close();
process.exit(fail ? 1 : 0);
