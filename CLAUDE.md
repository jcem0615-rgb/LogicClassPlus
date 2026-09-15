# CLAUDE.md — LogicClass+ Build Handoff

This file is the entry point for Claude Code. Read this first, then `docs/` in numeric order before writing code.

## What this is

LogicClass+ is a production-ready PWA for an international English & Math tutorial
platform. Single Owner/Admin, public registration for Teachers/Students only,
1-on-1 WebRTC classrooms with a Math suite (whiteboard, PDF annotator, LaTeX)
and an English suite (collaborative editor, pronunciation audio), teacher
attendance/payroll, Stripe billing, and full push/socket notifications.

Full functional spec (source of truth for scope) is in `docs/01-overview.md`
through `docs/07-build-phases.md`. The original client-provided spec is
preserved verbatim in `docs/00-original-spec.md` — if anything in the other
docs seems ambiguous, that file is the tiebreaker.

## Monorepo layout

```
LogicClass-Plus/
├── apps/
│   ├── web/       Next.js 14 (App Router) + TS + Tailwind — PWA frontend
│   └── server/    Node.js + Express + Socket.io + Prisma — API, realtime, signaling
├── docs/          Full spec, broken into build-order chunks
└── package.json   npm workspaces root
```

npm workspaces monorepo — `npm install` at the root installs both apps.

## Tech stack (as specified by the client doc, do not substitute)

- Frontend: Next.js App Router, TypeScript, Tailwind CSS, next-pwa
- Realtime/media: Socket.io, native WebRTC, `navigator.mediaDevices`
- Canvas/annotation: Excalidraw (chosen over raw Fabric.js — better React
  integration and built-in collaboration primitives), pdfjs-dist, KaTeX
- Collaborative text: Tiptap + Yjs, socket.io as the Yjs transport (y-socket.io)
- Backend: Node.js + Express, Socket.io server
- DB/ORM: PostgreSQL + Prisma (schema already written in full, see
  `apps/server/prisma/schema.prisma`)
- Storage: S3-compatible (AWS S3 or Cloudflare R2) via presigned URLs, Zod
  validation on every upload
- Payments: Stripe
- Push: Web Push API (VAPID) via `web-push` npm package

## Build order (see `docs/07-build-phases.md` for detail)

1. **Foundation** — Prisma schema → migrate → seed one Admin/Owner. Auth
   (JWT or NextAuth credentials provider) with role-gated registration
   (Teacher/Student only; Admin is seeded, never self-registered).
2. **Core CRUD + dashboards** — Users, Folders, Resources (with the 20MB /
   extension-allowlist upload pipeline), Announcements.
3. **Realtime spine** — Socket.io gateway, Notification model wired to
   in-app banners + Web Push, class-request → accept flow.
4. **WebRTC classroom shell** — pre-call hardware-check modal, device
   switching, signaling over Socket.io, join/leave room lifecycle.
5. **Math Suite** — Excalidraw whiteboard synced over the room's socket
   channel, PDF/image annotation layer, KaTeX equation editor.
6. **English Suite** — Tiptap+Yjs collaborative doc, audio recorder +
   pronunciation-analysis stub (flag as external-API integration point).
7. **Attendance & Payroll** — clock-in/out, tardiness/deduction calc off
   `ClassSession`, Payroll batch generation.
8. **Billing** — Stripe Invoice creation/webhooks tied to the `Invoice` model.
9. **Recording** — cloud recording of WebRTC sessions (flag as needing a
   media server — plain P2P WebRTC cannot record server-side; see gap list).
10. **PWA polish** — manifest, service worker, offline messaging queue,
    install prompts.

Build strictly in this order — later phases assume earlier ones exist
(e.g. the classroom shell needs auth + Socket.io before it's testable).

## Known gaps — flag to the user, do not silently invent

- **Server-side call recording** (§8, item 8 of the original spec) needs an
  SFU/media server (e.g. LiveKit, mediasoup, or a Daily.co/Twilio managed
  service) — plain browser-to-browser WebRTC has no server-side stream to
  record. Pick one and confirm with the user before building; the schema
  already has `ClassSession.recordingUrl` ready either way.
- **Pronunciation AI analysis** needs a third-party speech API (e.g.
  Azure Speech, Google Cloud Speech-to-Text pronunciation assessment, or
  an open-source model). Not specified in the client doc — stub the UI
  and flag the provider choice as a decision point.
- **Admin password reset queue**: schema has `PasswordResetRequest`, but the
  approval-workflow UI/notification isn't detailed in the spec — build the
  simplest version (Admin dashboard list → Approve/Reject buttons that
  trigger an emailed reset link) unless told otherwise.
- **Locale field exists on `User`** (`locale`) but no i18n framework is
  specified — leave the field for future use, don't build full i18n now.
- Real S3/R2 credentials, Stripe keys, and VAPID keys are NOT included —
  `.env.example` in `apps/server` lists every variable needed.

## Conventions to follow

- TypeScript everywhere, strict mode on.
- Zod for all request-body and file-upload validation on the server.
- Multi-tenant isolation: every Resource/Folder query must filter by the
  authenticated teacher's `teacherId` — this is a hard security requirement,
  not just a UX nicety (see `docs/06-security-validation.md`).
- Keep Socket.io event names namespaced by feature (`classroom:*`,
  `chat:*`, `notification:*`) to avoid collisions as more modules are added.

## First commands to run

```bash
npm install
cp apps/server/.env.example apps/server/.env   # then fill in real values
npm run -w apps/server prisma:generate
npm run -w apps/server prisma:migrate
npm run dev   # runs both apps/web and apps/server concurrently
```
