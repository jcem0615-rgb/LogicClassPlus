# LogicClass+

A production-shaped PWA front end for the LogicClass+ international English & Math
tutoring platform, built from the handoff in [`CLAUDE.md`](./CLAUDE.md).

**Live preview:** https://claude.ai/artifact/XAzkbT1mbjVXNQnfojfiS2

## Running it

No build step and no dependencies — it is plain HTML, CSS and ES5-compatible JS.

```bash
npx serve app -l 8123      # or any static file server
open http://localhost:8123
```

A service worker and manifest are included, so it installs as an app and the shell
works offline.

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Owner / Admin | `owner@logicclass.plus` | `admin1234` |
| Teacher (Math) | `daniel@logicclass.plus` | `teach1234` |
| Teacher (English) | `hana@logicclass.plus` | `teach1234` |
| Student | `amira@logicclass.plus` | `learn1234` |

The Owner is seeded and can never be created from the public form — registration is
Teacher/Student only, and new accounts are held at `pending` until the Owner approves
them, exactly as the spec requires.

## What is here

| Area | Built |
| --- | --- |
| Auth | Sign in, role-gated registration, admin approval queue, password-reset request queue |
| Dashboards | Separate Owner, Teacher and Student home screens |
| Library | Folders and resources, upload pipeline with the 20 MB + extension allowlist enforced, per-teacher isolation on every query |
| Announcements | Post to everyone / teachers / students, pinning, fan-out to notifications |
| Classes | Student request → teacher accept/decline → scheduled `ClassSession` |
| Classroom | Pre-call hardware check (real `getUserMedia`, device enumeration and switching, live mic meter), room shell, chat |
| Math suite | Vector whiteboard (pen, highlighter, line, box, eraser, undo, save to library), PDF/image annotator, LaTeX editor rendering through KaTeX → MathML |
| English suite | Rich-text shared document with presence chip and word count, pronunciation recorder with a real amplitude envelope measured from the recording |
| Attendance | Clock in/out, lateness against a 5-minute grace window, deduction arithmetic shown in full |
| Payroll | Per-teacher batch preview (sessions, minutes, lateness, no-shows, gross, deductions, net) and batch history |
| Billing | Invoice list, payment flow, reminders |
| PWA | Manifest, service worker, install prompt, offline outbox that queues writes and replays them on reconnect |

## What is deliberately not here

The handoff's own gap list, plus the boundary of a front end with no server:

- **Data lives in `localStorage`, not PostgreSQL.** The shapes mirror the Prisma models
  named in the handoff (`User`, `Folder`, `Resource`, `Announcement`, `ClassRequest`,
  `ClassSession`, `Attendance`, `PayrollBatch`, `Invoice`, `Notification`,
  `PasswordResetRequest`) so the swap to real API calls is a transport change.
- **No Socket.io server**, so the second participant in a classroom is a clearly
  labelled simulated peer. Whiteboard strokes, Yjs document sync and presence are
  local until the signalling server exists.
- **Server-side call recording needs an SFU.** Browser-to-browser WebRTC gives the
  server no stream to record. The Record button captures *your own* tracks with
  `MediaRecorder` and keeps the clip in the tab. LiveKit / mediasoup / a managed
  service is still a decision to make.
- **Pronunciation scoring needs a speech API.** The waveform is measured from the real
  recording; the per-phoneme numbers are a labelled placeholder, not a measurement.
- **Stripe, S3/R2 and VAPID keys are not wired up.** Paying an invoice settles it
  locally so the flow is visible.
- **i18n is not built.** `locale` is carried on `User` and editable, as specified.

## Layout

```
app/
├── index.html            page shell, font + CDN script loading
├── styles.css            design tokens, light/dark, responsive shell
├── store.js              data model, seed, auth, validation, payroll maths, offline outbox
├── views.js              dashboards, library, announcements, classes, attendance, payroll, billing, settings
├── classroom.js          hardware check, room, Math suite, English suite
├── app.js                router, shell, notifications, toasts, modals, theme, PWA
├── sw.js                 offline shell cache + Web Push handlers
├── manifest.webmanifest
└── icon.svg
```
