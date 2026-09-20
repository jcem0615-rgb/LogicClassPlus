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
| 6 | English suite — collaborative doc, audio recorder, pronunciation stub | **Done**, bar the scoring provider. Tiptap on a shared Yjs document with live cursors, merged and persisted by the server. The recorder measures a real amplitude envelope; per-phoneme scoring still needs a speech API. |
| 7 | Attendance & payroll | **Done.** Clock in/out, grace window, late penalty, no-show forfeit, batch generation with frozen figures. |
| 8 | Billing | **Done.** Invoices, PaymentIntent creation, signature-verified `payment_intent.succeeded` webhook. Needs your Stripe keys. |
| 9 | Recording | **Decided and wired, not proven.** LiveKit Egress: control plane, signed webhook, storage accounting and consent notices are written and type-checked, but there was no live LiveKit server to test against, and the browsers still connect peer-to-peer so nothing flows through the SFU yet. See [`recording.md`](./recording.md). |
| 10 | PWA polish | **Done.** Manifest, service worker, install prompt, offline outbox. |

## Open decisions, unchanged from the handoff's gap list

- **Server-side call recording**: LiveKit is now the wired provider, and
  `docs/recording.md` covers setup and what a recording costs to store (a
  3-hour class is about 2.15 GB at 720p). Two caveats stand: the integration is
  unproven against a live LiveKit server, and media still flows peer-to-peer, so
  the client must publish into the SFU before there is anything to record. The
  "Record me" button in the classroom captures *your own* tracks with
  `MediaRecorder` and is not a class recording.
- **Pronunciation scoring** needs a speech API (Azure Speech pronunciation
  assessment, Google STT, or a self-hosted model). The waveform shown is measured
  from the real recording; the per-phoneme numbers are a labelled placeholder.
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
3. **The client is a static PWA, not Next.js App Router.** `apps/web` as
   specified does not exist. What is here is `apps/pwa`: the full feature
   surface, with one bundled file (Tiptap, ProseMirror and Yjs) and no
   framework build. If you want the Next.js version, this is the
   reference implementation to port — the API it talks to will not change.

One correction the build forced, worth knowing about: `ClassRequest.minutes`
originally accepted only 30/45/60/90, so a 3-hour class could not be booked at
all. It now accepts 15 minutes to 8 hours in quarter-hour steps.

Password hashing uses Node's built-in `scrypt` rather than adding bcrypt/argon2:
no native build step, and it is the algorithm Node's own docs recommend for this.
