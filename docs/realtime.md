# Socket.io events

The client connects with `auth: { token }`. The handshake rejects anything that
is not a valid JWT for an `ACTIVE` user, so there are no anonymous sockets.
Every socket joins `user:<id>`; classroom sockets also join `classroom:<sessionId>`
after the server confirms you are the teacher or student on that session.

Event names are namespaced by feature, as the handoff requires.

## Client → server
| Event | Payload | Effect |
| --- | --- | --- |
| `classroom:join` | `sessionId`, ack | Joins the room; the ack returns the peers already in it. |
| `classroom:leave` | `sessionId` | Leaves and tells the room. |
| `classroom:signal` | `{ sessionId, to?, data }` | Relays SDP/ICE. Direct to `to` when given, otherwise to the room. The server never touches media. |
| `classroom:board:stroke` | `{ sessionId, stroke }` | Broadcasts one finished stroke. |
| `classroom:board:clear` | `{ sessionId }` | Clears the peer's board. |
| `classroom:doc:update` | `{ sessionId, update }` | Opaque relay — this is the y-socket.io shape for Yjs updates. |
| `classroom:presence` | `{ sessionId, state }` | Cursor / selection presence. |
| `chat:send` | `{ sessionId, text }`, ack | Persists to `ChatMessage`, then broadcasts `chat:message`. |
| `chat:typing` | `{ sessionId }` | Transient. |

## Server → client
| Event | Payload |
| --- | --- |
| `notification:new` | The notification, at the same moment it is written and pushed |
| `classroom:peer-joined` / `peer-left` | `{ userId, name }` |
| `classroom:signal` | `{ from, data }` |
| `classroom:board:stroke` / `board:clear` | `{ from, stroke? }` |
| `classroom:doc:update` / `presence` | `{ from, update \| state }` |
| `classroom:request` / `classroom:accepted` | Request or session — drives the live inbox |
| `classroom:state` | The session after a join/leave/complete |
| `chat:message` | The persisted message |

## The peer connection

`apps/pwa/webrtc.js` implements it, and it is verified end to end: two browsers
reach `connectionState === "connected"` with real media flowing both ways.

Two decisions in there are worth keeping if you rework it:

- **Only the impolite peer offers.** Roles are fixed — the teacher is impolite,
  the student polite — so `onnegotiationneeded` produces an offer on one side
  only. Letting both offer means a rollback, and a rollback restarts ICE
  gathering, which in testing left neither side with a usable candidate pair.
- **ICE candidates are queued until the remote description exists.** They
  routinely arrive before the offer they belong to. Added early they are
  rejected and lost, and the call then fails with no error anyone can see.

Device switching uses `RTCRtpSender.replaceTrack()`, so changing camera or
microphone mid-call needs no renegotiation and the far side sees nothing.

### TURN

`GET /api/realtime/ice` returns the ICE servers. STUN alone connects most pairs;
it does not connect participants behind symmetric NAT or strict corporate
firewalls, which on a platform spanning these timezones is routine. Run coturn
with `use-auth-secret` and set `TURN_URLS` plus `TURN_STATIC_SECRET` — the
server then mints per-request credentials that expire, so the long-lived secret
never reaches a browser. The classroom tells the user when a connection fails
without TURN configured, rather than just showing a dead tile.
