# LogicClass+

An international English & Math tutoring platform: 1-on-1 live classrooms with a
Math suite and an English suite, teacher attendance and payroll, and Stripe
billing. Built from the handoff in [`CLAUDE.md`](./CLAUDE.md).

**Hosted preview (demo data, no server):** https://claude.ai/artifact/XAzkbT1mbjVXNQnfojfiS2

```
LogicClass-Plus/
├── apps/
│   ├── server/   Node + Express + Socket.io + Prisma — API, realtime, signalling
│   └── pwa/      the PWA client — static, no build step
├── docs/         status against the build phases, API and socket reference
└── package.json  npm workspaces root
```

## Run it

Needs Node 20+ and PostgreSQL 14+.

```bash
npm install
cp apps/server/.env.example apps/server/.env     # set DATABASE_URL and JWT_SECRET
npm run -w apps/server prisma:generate
npm run -w apps/server prisma:migrate
npm run -w apps/server seed
npm run dev            # API on :4001, client on :4000
```

Open http://localhost:4000. It starts on demo data; **Settings → Connect a
server**, enter `http://localhost:4001`, and it switches to PostgreSQL with
realtime over Socket.io. The client keeps that choice, so it comes back
connected next time.

Seeded accounts (`SEED_DEMO_DATA=false` seeds only the Owner):

| Role | Email | Password |
| --- | --- | --- |
| Owner / Admin | `owner@logicclass.plus` | `admin1234` |
| Teacher (Math) | `daniel@logicclass.plus` | `teach1234` |
| Teacher (English) | `hana@logicclass.plus` | `teach1234` |
| Student | `amira@logicclass.plus` | `learn1234` |

The Owner is seeded and can never be created from the public form. Registration
is Teacher/Student only and new accounts sit at `PENDING` until the Owner
approves them.

To see a real two-person classroom, sign in as the teacher in one browser and the
student in another, and open the same session.

## Tests

```bash
npm run -w apps/server typecheck
node apps/server/test/smoke.mjs      # needs the server running
```

`test/smoke.mjs` drives the whole API as four different users: auth and role
gates, the approval flow, cross-teacher isolation, upload rejection, the
request → session → attendance → payroll chain, billing, announcement fan-out,
and a live Socket.io session that checks a WebRTC offer is relayed between two
sockets and that chat lands in Postgres. 59 assertions.

## What the server enforces

- **Passwords** are scrypt with a per-password salt, compared in constant time.
  The hash is never serialised — `publicUser()` is the only way a user leaves
  the process.
- **Every request body, query and param** is parsed by Zod before a handler sees
  it. Validated values replace the raw input.
- **Multi-tenant isolation** is a `WHERE` clause on every folder and resource
  query, not a UI filter. A teacher asking for another teacher's folder by ID
  gets the same 404 as for a folder that does not exist, so IDs leak nothing.
- **Uploads** are checked for extension and size *before* a storage key is
  issued, and again when the row is created; a key that does not start with
  `teachers/<your id>/` is refused.
- **Money** is integer cents everywhere. Payroll: a 5-minute grace window, then
  late minutes at 1.5× the minute rate; a no-show forfeits the session fee.
  Generating a batch freezes the figures rather than recomputing them later.
- **Stripe** invoices are marked paid by the signature-verified
  `payment_intent.succeeded` webhook, never by the browser. Without keys the
  server says so instead of faking a payment.
- **Sockets** authenticate at the handshake and verify room membership server-side.

## Configuration

`apps/server/.env.example` lists every variable. The server runs with only
`DATABASE_URL` and `JWT_SECRET`; each integration switches on when its keys
appear, and `GET /api/health` reports which are live:

- **S3 / R2** — presigned PUT uploads. Without a bucket, files go to
  `LOCAL_UPLOAD_DIR` on the API host.
- **Stripe** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- **Web Push** — `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
  (`npx web-push generate-vapid-keys`). Subscriptions the browser drops are pruned.

## What is still open

Read [`docs/00-status.md`](./docs/00-status.md) — it tracks every phase in the
handoff and is explicit about the three places this departs from the specified
stack and why. In short:

- **Recording is wired to LiveKit but unproven** — there was no live LiveKit
  server to test against, and media still flows peer-to-peer, so nothing reaches
  the SFU yet. [`docs/recording.md`](./docs/recording.md) covers setup and sizing:
  a 3-hour class is about **2.15 GB** at 720p, 67 MB audio-only.
- **Pronunciation scoring needs a speech API.** The waveform is real; the
  per-phoneme scores are a labelled placeholder.
- **Live co-editing.** The shared document saves per session, but Tiptap + Yjs
  over the existing `classroom:doc:update` relay is not wired. Largest remaining
  gap against the spec.
- **`apps/web` (Next.js) was not built.** `apps/pwa` carries the full feature
  surface as a dependency-free static PWA.
