# HTTP API

Base URL `http://localhost:4001/api`. Every route except the ones marked public
needs `Authorization: Bearer <token>` (the login response also sets an
`httpOnly` cookie). Errors are always `{ "error": { "message", "code" } }`.

## Auth
| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| POST | `/auth/register` | public | Teacher/Student only. Account is created `PENDING`. |
| POST | `/auth/login` | public | Rate limited to 30 attempts / 15 min per IP. |
| POST | `/auth/logout` | public | Clears the cookie. |
| GET | `/auth/me` | any | Current user. |
| POST | `/auth/password-reset` | public | Always returns `{ok:true}` — never reveals whether the address exists. |
| POST | `/auth/password-reset/confirm` | public | Consumes the single-use token. |

## Users
| Method | Path | Who |
| --- | --- | --- |
| GET | `/users` | any — scoped: Owner sees all, Teacher sees their students, Student sees active teachers |
| PATCH | `/users/:id/approve` | Owner |
| PATCH | `/users/:id/status` | Owner — `active` / `suspended` |
| DELETE | `/users/:id` | Owner — must be suspended first |
| PATCH | `/users/me` | any — name, locale, timezone, bio, hourly rate |
| GET | `/users/reset-requests` | Owner |
| PATCH | `/users/reset-requests/:id` | Owner — `approve` / `reject` |

## Library
| Method | Path | Who |
| --- | --- | --- |
| GET | `/library/folders` | any — filtered to what you may see |
| POST | `/library/folders` | Teacher |
| DELETE | `/library/folders/:id` | owning Teacher, Owner |
| GET | `/library/folders/:id/resources` | any with access — others get 404, not 403 |
| POST | `/library/uploads` | Teacher — validates, returns a presigned PUT |
| POST | `/library/uploads/local` | Teacher — disk fallback when no bucket is set |
| POST | `/library/resources` | Teacher — records the row after the bytes land |
| GET | `/library/resources/:id/url` | any with access — 5-minute presigned GET |
| DELETE | `/library/resources/:id` | owning Teacher, Owner |

## Classes
| Method | Path | Who |
| --- | --- | --- |
| GET/POST | `/classes/requests` | any / Student |
| PATCH | `/classes/requests/:id` | receiving Teacher — `accept` creates the session in one transaction |
| GET | `/classes/sessions` | any — scoped |
| GET | `/classes/sessions/:id` | participants — session, saved documents, chat history |
| POST | `/classes/sessions/:id/join` \| `/leave` \| `/complete` | participants / Teacher |
| PUT | `/classes/sessions/:id/documents` | participants — `board`, `document`, `equation`, `annotation` |
| GET/POST | `/classes/sessions/:id/messages` | participants |

## Attendance, payroll, billing
| Method | Path | Who |
| --- | --- | --- |
| GET | `/attendance` | Teacher (own), Owner (all) — returns the live policy |
| POST | `/attendance/clock-in` | Teacher — computes lateness and the deduction |
| POST | `/attendance/:id/clock-out` | Teacher |
| POST | `/attendance/no-show` | Teacher, Owner |
| GET | `/payroll/preview` | Teacher (own line), Owner (all) |
| GET/POST | `/payroll/batches` | Teacher reads own lines / Owner generates |
| GET/POST | `/billing/invoices` | Student (own), Owner |
| POST | `/billing/invoices/:id/pay` | Student — creates a PaymentIntent, or says Stripe is unconfigured |
| POST | `/billing/invoices/:id/remind` \| `/settle` | Owner |
| POST | `/stripe/webhook` | Stripe — signature verified against the raw body |

## Notifications
`GET /notifications`, `POST /notifications/read`, `GET /notifications/push-key`,
`POST /notifications/subscribe`, `POST /notifications/unsubscribe`.

## Health
`GET /api/health` — no auth. Reports which integrations are configured and the
active upload and payroll policy. The client probes this before switching out of
demo mode.
