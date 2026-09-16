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

## Completing the WebRTC call

`classroom:signal` is a working relay; both sides still need the peer connection
that consumes it:

1. On `classroom:peer-joined`, the teacher creates an `RTCPeerConnection`, adds
   the local tracks, and emits its offer over `classroom:signal`.
2. The student answers on the same channel; both sides trickle ICE candidates
   through it.
3. Attach the remote stream to the tile that currently draws the stand-in.

Add a TURN server for participants behind symmetric NAT — STUN alone will not
connect every pair across the timezones this platform serves.
