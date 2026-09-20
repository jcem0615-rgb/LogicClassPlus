/**
 * The pronunciation drill, driven through a real browser.
 *
 * Records through getUserMedia and MediaRecorder, converts in the browser, and
 * checks what actually arrives: this test's stand-in Azure asserts the upload
 * is 16 kHz mono 16-bit WAV before answering, so the browser's own encoder is
 * verified rather than assumed.
 *
 * Needs the client on :4000 and the API on :4001 started with
 *   AZURE_SPEECH_KEY=test-key AZURE_SPEECH_ENDPOINT=http://127.0.0.1:45099
 *
 * Run:  node apps/server/test/speech-ui.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';

/* a stand-in for Azure, on the port the API is pointed at */
const azure = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    // What the browser actually produced, checked here rather than trusted.
    const fmt = {
      riff: body.toString('ascii', 0, 4), wave: body.toString('ascii', 8, 12),
      channels: body.readUInt16LE(22), rate: body.readUInt32LE(24), bits: body.readUInt16LE(34),
      seconds: (body.length - 44) / 2 / 16000,
    };
    console.log('  browser-produced WAV:', JSON.stringify(fmt));
    global.__fmt = fmt;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      RecognitionStatus: 'Success', Duration: 21_000_000,
      DisplayText: 'I would like a ship, not a sheep.',
      NBest: [{
        Display: 'I would like a ship, not a sheep.',
        PronunciationAssessment: { AccuracyScore: 88, FluencyScore: 92, CompletenessScore: 100, PronScore: 90, ProsodyScore: 84 },
        Words: [
          { Word: 'ship', PronunciationAssessment: { AccuracyScore: 94, ErrorType: 'None' },
            Phonemes: [{ Phoneme: 'ʃ', PronunciationAssessment: { AccuracyScore: 97 } },
                       { Phoneme: 'ɪ', PronunciationAssessment: { AccuracyScore: 91 } }] },
          { Word: 'sheep', PronunciationAssessment: { AccuracyScore: 58, ErrorType: 'Mispronunciation' },
            Phonemes: [{ Phoneme: 'ʃ', PronunciationAssessment: { AccuracyScore: 93 } },
                       { Phoneme: 'iː', PronunciationAssessment: { AccuracyScore: 41 } }] },
        ],
      }],
    }));
  });
});
await new Promise(r => azure.listen(45099, '127.0.0.1', r));

let pass = 0, fail = 0;
const ok = (n, c, x='') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + x); } };

const b = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
const p = await b.newPage({ viewport: { width: 1340, height: 950 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });

await p.goto('http://localhost:4000/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.clear(); localStorage.setItem('logicclass.plus.server','http://localhost:4001'); });
await p.goto('http://localhost:4000/', { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
await p.fill('#login-email','amira@logicclass.plus'); await p.fill('#login-password','learn1234');
await p.click('button[type=submit]'); await p.waitForTimeout(1900);

const sid = await p.evaluate(async () => {
  const t = localStorage.getItem('logicclass.plus.token');
  const r = await fetch('http://localhost:4001/api/classes/sessions', { headers: { authorization: 'Bearer ' + t } });
  const s = (await r.json()).sessions;
  return (s.find(x => x.status === 'scheduled') || s[0]).id;
});
await p.goto('http://localhost:4000/#/room/' + sid);
await p.waitForTimeout(1400); await p.click('#hw-join'); await p.waitForTimeout(1500);
await p.click('[data-tab="speech"]'); await p.waitForTimeout(1400);

ok('status shows the provider is live',
  /Azure Speech/.test(await p.textContent('#speech-status')), await p.textContent('#speech-status'));

// record through the real path: getUserMedia -> MediaRecorder -> blob
await p.click('[data-act="voice-record"]');
await p.waitForTimeout(2200);
await p.click('[data-act="voice-record"]');
await p.waitForTimeout(2000);
ok('waveform drawn from the real recording',
  (await p.evaluate(() => document.querySelectorAll('#wave i').length)) > 10);

await p.click('#analyse-btn');
await p.waitForTimeout(3500);

const out = (await p.textContent('#score-out')).replace(/\s+/g, ' ');
ok('scored by Azure, labelled as such', /Scored by Azure Speech/.test(out));
ok('overall pronunciation score shown', /Pronunciation\s*90/.test(out), out.slice(0, 120));
ok('all five dimensions rendered',
  /Accuracy\s*88/.test(out) && /Fluency\s*92/.test(out)
  && /Completeness\s*100/.test(out) && /Prosody\s*84/.test(out));
ok('mispronounced word flagged', /sheep\s*58\s*mispronounced/.test(out), out.slice(0, 260));
ok('weakest word opened by default with its phonemes', /iː/.test(out) && /41/.test(out));

const fmt = global.__fmt || {};
ok('browser produced 16 kHz mono 16-bit WAV',
  fmt.riff === 'RIFF' && fmt.wave === 'WAVE' && fmt.channels === 1 && fmt.rate === 16000 && fmt.bits === 16,
  JSON.stringify(fmt));
ok('audio length is about what was recorded', fmt.seconds > 1 && fmt.seconds < 4, String(fmt.seconds));

// tapping another word switches the phoneme detail
await p.click('.word-chip');
await p.waitForTimeout(500);
ok('tapping a word shows its sounds', /ʃ/.test(await p.textContent('#phoneme-out')));

await p.waitForTimeout(800);
ok('the attempt is listed in the history',
  /Earlier attempts/.test(await p.textContent('#attempt-history')),
  (await p.textContent('#attempt-history')).slice(0, 80));

await p.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/s1-scored.png' });
console.log(`\n${pass} passed, ${fail} failed`);
console.log('ERRORS:', errs.length ? JSON.stringify([...new Set(errs)].slice(0,5)) : 'none');
await b.close(); azure.close();
process.exit(fail ? 1 : 0);
