# Recording, and what it costs to store

## Why it needs a media server

Peer-to-peer WebRTC sends media browser to browser. The server relays signalling
only — it never sees a frame, so there is nothing for it to record. Recording
therefore needs an SFU that the media actually flows through.

**LiveKit is what is wired here** (`RECORDING_PROVIDER=livekit`). It is open
source and self-hostable, and its Egress service composites both participants
into one file and uploads it straight to your bucket, so recordings never pass
through this API. mediasoup or a managed service (Daily, Twilio) would work the
same way; `src/services/recording.ts` is the only file that knows the provider.

With `RECORDING_PROVIDER=none` — the default — every recording entry point says
recording is unavailable and why. Nothing pretends a file exists.

## Storage for a 3-hour class

One composited MP4, H.264 video plus Opus audio, including ~3% container
overhead. These are the same bitrates the encoder is configured with, so the
estimate the app shows is what you actually get.

| Preset | Bitrate | 3-hour class | Per hour |
| --- | --- | --- | --- |
| Audio only | 48 kbps | **67 MB** | 22 MB |
| 360p | 448 kbps | **623 MB** | 208 MB |
| 480p | 748 kbps | **1.04 GB** | 347 MB |
| **720p (default)** | 1.55 Mbps | **2.15 GB** | 717 MB |
| 1080p | 4.06 Mbps | **5.65 GB** | 1.88 GB |

Two things that change these numbers:

- **Per-track instead of composited** roughly doubles the video: two streams,
  no mixing. Useful if you want to re-edit later; wasteful if you only ever
  play it back.
- **Screen share and whiteboard content compress far better than faces** — it is
  mostly static. If most of the class is the shared surface rather than two
  webcams, expect to land well under these figures.

### Planning the bill

At 720p, each 3-hour class is **2.15 GB**:

| 3-hour classes / month | Added per month | After one year |
| --- | --- | --- |
| 50 | 108 GB | 1.3 TB |
| 200 | 430 GB | 5.2 TB |
| 1000 | 2.1 TB | 25.8 TB |

Storage is the small cost; **egress is the one that bites**. Every playback of a
2 GB recording moves 2 GB. On S3, egress is billed per GB and a popular
recording can cost more to serve than to keep. Cloudflare R2 charges no egress,
which for a library people re-watch is usually the deciding factor. (Check
current list prices before you commit — these move.)

### What actually keeps the bill down

1. **Do not record by default.** Recording starts only when the teacher presses
   the button, and both participants are notified.
2. **720p is enough** for a tutoring class, and is the default here. 1080p is
   2.6× the size for a talking head and a whiteboard.
3. **Set a lifecycle rule.** Most recordings are watched within days. A rule
   that moves objects to infrequent-access after 30 days and deletes or
   transcodes to audio-only after 90 cuts the steady-state library by an order
   of magnitude. At 67 MB per 3-hour class, an audio-only archive is 32× cheaper
   than keeping the video.
4. **Keep the whiteboard as data, not pixels.** Strokes are already stored as
   JSON on `SessionDocument` — kilobytes, replayable, searchable. For many
   classes that plus the audio is the whole value of the recording.

`GET /api/recordings/usage` (Owner) reports what has actually been stored,
including a projection from the last 30 days, so the bill is never a surprise.

## Setting it up

```bash
# .env
RECORDING_PROVIDER=livekit
RECORDING_PRESET=720p
LIVEKIT_URL=https://your-livekit-host
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
# recordings are written straight to this bucket by LiveKit, not by this API
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Point LiveKit's webhook at `POST /api/recordings/webhook`. It is verified
against the API secret — the token carries a SHA-256 of the raw body, so a
replayed or altered payload is rejected.

Then: `POST /api/recordings/:sessionId/start` and `/stop`. On `egress_ended`
the webhook fills `recordingUrl`, `recordingBytes` and `recordingSeconds` on the
session and notifies the teacher.

## What is not built

The browsers still connect **peer-to-peer**, so there is nothing flowing through
LiveKit to record yet. `GET /api/recordings/token/:sessionId` mints the join
token for it; the remaining work is a client path that publishes into the SFU
instead of opening an `RTCPeerConnection` when recording is enabled. The egress
control plane, webhook, storage accounting and consent notifications above are
written and type-checked, but **untested against a live LiveKit server** — there
was none to test against here. Treat that integration as unproven until you run
it once.

## Consent

Starting a recording notifies the other participant, every time, in-app and by
push. That is not a nicety: in much of the EU, in California, and in several
other jurisdictions, recording someone without telling them is unlawful. Do not
remove it, and check the rules where your students actually are — this platform
spans timezones, and so does its legal exposure.
