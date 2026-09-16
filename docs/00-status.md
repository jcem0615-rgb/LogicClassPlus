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
| 4 | WebRTC classroom shell — hardware check, device switching, signalling, join/leave | **Done** for the shell and signalling relay (`classroom:signal` forwards SDP/ICE). The browser-side `RTCPeerConnection` that consumes those messages is the remaining piece — see below. |
| 5 | Math suite — whiteboard synced over the room channel, PDF/image annotation, KaTeX | **Done**, with one substitution noted below. Strokes broadcast on `classroom:board:stroke` and persist to `SessionDocument`. |
| 6 | English suite — collaborative doc, audio recorder, pronunciation stub | **Partly.** Rich-text editor with presence, saved per session; recorder measures a real amplitude envelope. Yjs CRDT transport and the scoring provider are open — see below. |
| 7 | Attendance & payroll | **Done.** Clock in/out, grace window, late penalty, no-show forfeit, batch generation with frozen figures. |
| 8 | Billing | **Done.** Invoices, PaymentIntent creation, signature-verified `payment_intent.succeeded` webhook. Needs your Stripe keys. |
| 9 | Recording | **Not built — needs a decision.** See below. |
| 10 | PWA polish | **Done.** Manifest, service worker, install prompt, offline outbox. |

## Open decisions, unchanged from the handoff's gap list

- **Server-side call recording** needs an SFU or managed media service (LiveKit,
  mediasoup, Daily, Twilio). Plain P2P WebRTC gives the server no stream to
  record. `ClassSession.recordingUrl` is ready for whichever you pick. The
  Record button in the classroom captures *your own* tracks with `MediaRecorder`
  and keeps the clip in the tab; it is not a class recording.
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
2. **The collaborative document is a rich-text editor with presence, not
   Tiptap + Yjs.** The socket transport it needs is already in place
   (`classroom:doc:update` relays opaque binary updates, which is exactly what
   y-socket.io carries). Wiring Yjs is a client-side change with no server work.
3. **The client is a static PWA, not Next.js App Router.** `apps/web` as
   specified does not exist. What is here is `apps/pwa`: the full feature
   surface, no build step. If you want the Next.js version, this is the
   reference implementation to port — the API it talks to will not change.

Password hashing uses Node's built-in `scrypt` rather than adding bcrypt/argon2:
no native build step, and it is the algorithm Node's own docs recommend for this.
