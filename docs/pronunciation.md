# Pronunciation scoring

Scored by **Azure Speech pronunciation assessment**. It returns an overall
score plus a breakdown per word and per phoneme, which is the part that earns
its place in a lesson: "your /ʃ/ is fine, it's the /iː/ that is short" is
teachable in a way that "72%" is not.

## What the student sees

Five dimensions, each 0–100:

| | What it measures |
| --- | --- |
| **Accuracy** | How close the sounds are to a native pronunciation |
| **Fluency** | Pausing and rhythm between words |
| **Completeness** | How much of the phrase was actually said |
| **Prosody** | Stress and intonation |
| **Pronunciation** | Azure's weighted overall score |

Then every word, coloured by score and labelled when Azure flags it —
*mispronounced*, *omitted*, *added* — and tapping one opens its phonemes in IPA
with a score each. The weakest word opens by default, because that is the one
worth another attempt.

Attempts are stored, so progress on a sound is visible over weeks rather than
being a number that vanishes when the tab closes.

## Setting it up

Create a **Speech** resource in the Azure portal; the key and region are on its
*Keys and Endpoint* page.

```bash
# apps/server/.env
AZURE_SPEECH_KEY=<key>
AZURE_SPEECH_REGION=westeurope       # must match the resource's region
AZURE_SPEECH_LANGUAGE=en-US
```

`GET /api/health` and `GET /api/speech/status` report whether it is on. Until it
is, the drill still records and draws the real waveform, and **no score is
shown at all** — a made-up number is worse than none, and the screen says so.

## How the audio gets there

Azure's short-audio endpoint accepts 16 kHz 16-bit mono PCM WAV. The browser
records WebM/Opus, so `apps/pwa/audio.js` decodes, resamples through an
`OfflineAudioContext` and encodes a WAV before upload — no ffmpeg on the API
host. The server re-checks the RIFF header before spending an upstream call, so
a wrong format fails with a message that names what is wrong instead of Azure's
opaque error.

Assessment parameters ride in the `Pronunciation-Assessment` header as base64
JSON: `HundredMark` grading, `Phoneme` granularity, `Comprehensive` dimension,
miscue detection on (so skipped and added words are caught, not just
mispronounced ones), and the IPA alphabet.

## Cost

Azure bills pronunciation assessment by audio duration, as part of speech to
text. Estimate it from the audio, not the number of clicks:

```
attempts per lesson × seconds per attempt × lessons per month ÷ 3600 = hours/month
```

A student doing 10 attempts of 5 seconds in a lesson is about 50 seconds of
audio — roughly **one hour of billed audio per 70 lessons**. It is small next to
recording storage, but it is per attempt, so the endpoint is rate limited per
user (20/minute in production, `AUTH_RATE_LIMIT`-style tunable in code) and a
failed attempt is never billed twice by being retried automatically.

Check Azure's current pricing page before committing to a plan.

## Privacy — read this before switching it on

Turning this on sends a student's **voice** to Microsoft. That has consequences
this platform cannot decide for you:

- **Many of these students are children.** Voice is personal data, and in the
  UK/EU processing a child's personal data needs a lawful basis and usually
  parental consent. Get it before enabling scoring for under-16s, and record
  that you have it.
- **The audio is not stored by LogicClass+.** Only the scores and the word and
  phoneme breakdown are written to `PronunciationAttempt`; the WAV is held in
  memory for the length of the request and discarded. That is deliberate — a
  library of minors' voice recordings is a liability, not a feature. If you
  later add "listen back to your attempt", store it deliberately, with a
  retention period and a delete path.
- **Choose the region deliberately.** `AZURE_SPEECH_REGION` decides which
  country the audio is processed in. For EU students, pick an EU region.
- **Tell people.** The drill screen names the provider on every scored attempt.
  Keep that; it is the honest minimum, and your privacy notice should say the
  same thing at more length.

## If you switch providers

`apps/server/src/services/speech.ts` is the only file that knows about Azure.
It exposes `assess(audio, referenceText, language)` returning a provider-neutral
shape, so Google's pronunciation assessment or a self-hosted model would replace
that one file. The client, the storage and the UI do not change.
