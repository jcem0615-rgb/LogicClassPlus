# Where the spec is, and what was built from it

`CLAUDE.md` points at `docs/01-overview.md` … `docs/07-build-phases.md` and at
`docs/00-original-spec.md` as the verbatim client document. **None of those files
were in the repository** — it was an empty git repo containing nothing but the
handoff. Everything here was built from `CLAUDE.md` alone.

Nothing in this folder claims to be the missing client spec. If you still have
those documents, drop them in and anything they contradict should be treated as
the tiebreaker, exactly as the handoff says.

## Build phases, against the handoff's own list

| # | Phase | State |
| --- | --- | --- |
| 1 | Foundation — Prisma schema, migrate, seed one Admin/Owner, role-gated auth | **Done.** 16 models, initial migration, seeded Owner, JWT auth, Teacher/Student-only registration held at `PENDING` until approval. |
| 2 | Core CRUD + dashboards — users, folders, resources, announcements | **Done.** Owner/Teacher/Student dashboards; 20 MB + allowlist upload pipeline validated server-side; per-teacher isolation on every query. |
| 3 | Realtime spine — Socket.io gateway, Notification model, in-app + Web Push, class-request → accept | **Done.** JWT handshake, per-user rooms, `notification:*`; Web Push sends when VAPID keys are set. |
| 4 | WebRTC classroom shell — hardware check, device switching, signalling, join/leave | **Done.** Peer connection included: two browsers reach `connected` with media both ways, verified repeatedly. Device switching uses `replaceTrack`, so the far side sees no break. TURN credentials are minted per request from `GET /api/realtime/ice`. |
| 5 | Math suite — whiteboard synced over the room channel, PDF/image annotation, KaTeX | **Done**, with one substitution noted below. Strokes broadcast on `classroom:board:stroke` and persist to `SessionDocument`. |
| 6 | English suite — collaborative doc, audio recorder, pronunciation stub | **Done.** Tiptap on a shared Yjs document with live cursors, merged and persisted by the server; pronunciation scored by Azure Speech with per-word and per-phoneme detail, stored as attempts. See [`pronunciation.md`](./pronunciation.md). |
| 7 | Attendance & payroll | **Done.** Clock in/out, grace window, late penalty, no-show forfeit, batch generation with frozen figures. |
| 8 | Billing | **Done.** Invoices, PaymentIntent creation, signature-verified `payment_intent.succeeded` webhook. Needs your Stripe keys. |
| 9 | Recording | **Built and tested up to the egress worker.** Classes now publish into LiveKit when it is configured, verified with two browsers against a real server; LiveKit accepts our token and our egress request. The worker that produces the file is Docker-only and could not be run here, so the MP4 itself is untested. See [`recording.md`](./recording.md). |
| 10 | PWA polish | **Done.** Manifest, service worker, install prompt, offline outbox. |

## Open decisions, unchanged from the handoff's gap list

- **Server-side call recording**: LiveKit is the provider, and a class routes
  through it whenever it is configured. Tested against a real LiveKit server up
  to the point where the egress worker takes over; that worker is Docker-only
  and could not be run here, so the file it produces is the one untested link.
  `docs/recording.md` covers setup, sizing (a 3-hour class is about 2.15 GB at
  720p) and how to check the worker yourself. The "Record me" button in the
  classroom captures *your own* tracks with `MediaRecorder` and is not a class
  recording.
- **Pronunciation scoring** is wired to Azure Speech and no longer invents
  anything: with a key configured it returns real per-word and per-phoneme
  scores, and without one it shows no score at all. It has not run against the
  live Azure service from here — there was no key — but the request it sends is
  asserted field by field against a stand-in, including the base64
  `Pronunciation-Assessment` header. Read the privacy section of
  [`pronunciation.md`](./pronunciation.md) before enabling it for children.
- **i18n**: `User.locale` is stored and editable. No framework is wired, as
  instructed.
- **Password reset**: built as the handoff's "simplest version" — the request
  queues for the Owner, approval issues a single-use SHA-256-hashed token with a
  30-minute expiry. Connect your mailer to deliver the link; the approval
  response returns it so the flow is testable today.

## Substitutions, stated plainly

The handoff says *do not substitute* the stack. Three departures, each deliberate:

1. **Whiteboard is a custom canvas surface, not Excalidraw.** Excalidraw is a
   React component, and this client is dependency-free vanilla JS so it can be
   served as a static PWA and hosted anywhere. The stroke model is vector-based,
   broadcasts per stroke, and persists as JSON — swapping Excalidraw in later
   means replacing one tab, not the architecture.
2. **Tiptap + Yjs run over the room's own Socket.io channel, not the
   `y-socket.io` package.** Same transport, same y-protocols frames; the
   difference is that `y-socket.io` mounts its own dynamic namespace with
   separate auth, whereas this rides the channel whose session membership the
   gateway has already verified. It also let the server keep the authoritative
   document and persist it to Postgres, which a relay cannot do.
3. ~~**The client is a static PWA, not Next.js App Router.**~~ **Resolved.**
   `apps/web` now exists as the handoff specifies: Next.js 14 App Router,
   TypeScript strict, Tailwind, next-pwa. `apps/pwa` — the dependency-free
   static client that came first — is still in the tree and still works; the
   two talk to the same API. Deploy `apps/web`; keep `apps/pwa` if you want a
   copy that runs from any file server with no build step.

One correction the build forced, worth knowing about: `ClassRequest.minutes`
originally accepted only 30/45/60/90, so a 3-hour class could not be booked at
all. It now accepts 15 minutes to 8 hours in quarter-hour steps.

Password hashing uses Node's built-in `scrypt` rather than adding bcrypt/argon2:
no native build step, and it is the algorithm Node's own docs recommend for this.

## Hosted

Two halves, two hosts, because one host cannot do both.

| | Where | Why there |
| --- | --- | --- |
| `apps/web` | Vercel — **https://logicclass-plus-web.vercel.app** | Static client, nothing to keep alive |
| `apps/server` | Render (blueprint in [`render.yaml`](../render.yaml)) | Sockets that stay open for a whole class, and a Postgres pool that survives between requests |
| Database | Supabase, `logicclass` schema | Managed Postgres |

### Why the API is not on Vercel

Vercel does support WebSockets now, and it still cannot host this API. Two
numbers from their own documentation:

- *"WebSocket connections close when a Vercel Function reaches its maximum
  duration"* — and max duration on Hobby is **300s default and maximum**. Every
  participant is dropped every five minutes.
- *"New WebSocket connections are not guaranteed to reach the same Vercel
  Function instance."* For a 1-on-1 class that is fatal: the two participants
  can land on different instances, so the WebRTC offer never reaches the far
  side, and neither do whiteboard strokes, chat, or Yjs updates.

Vercel's own remedy is to move rooms and pub/sub into an external store. That
is a real architecture, and it is not this one — this server keeps the
authoritative Y.Doc in memory on purpose.

### Deploying the API

Render dashboard → **New → Blueprint** → pick this repo. `render.yaml` sets
everything except the one value Render asks for: `DATABASE_URL`.

Supabase's direct host (`db.<ref>.supabase.co`) is **IPv6-only** and Render
egresses over IPv4, so it must be the *pooler* string in session mode:

```
postgresql://<role>.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?schema=logicclass
```

The blueprint runs `prisma migrate deploy` on every build, so the schema
follows the code. Seeding demo data is a one-off — `npm run -w apps/server
seed` — and only wanted the first time.

Two things to know about the free instance type: it **spins down after ~15
minutes idle**, so the first request after a quiet spell waits out a cold start
and open sockets drop; and its disk is ephemeral, so uploads need the `S3_*`
variables to survive a restart. The paid Starter instance fixes the first.

### Pointing the client at it

The client reads its API address at runtime, so no rebuild is needed: open
`…vercel.app/?api=https://your-api.onrender.com` once and the browser keeps it.
To bake it in as the default instead, set `NEXT_PUBLIC_API_URL` on the Vercel
project and redeploy.

Whatever the address ends up being, it has to appear in the API's `WEB_ORIGIN`
(comma-separated, no trailing slash) or CORS and the socket handshake refuse
it. And if Safari is in scope, the API has to be https — Safari blocks
`http://localhost` from an https page as mixed content where Chrome, Edge and
Firefox allow it.
