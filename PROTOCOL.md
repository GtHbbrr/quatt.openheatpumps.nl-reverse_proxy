# Wire protocol (draft v1)

Status: **draft, experimental**. Everything here may change until a first working
implementation exists on both sides.

This document specifies the protocol between an OpenQuatt device (ESP32) and a
relay (this repository's Cloudflare Worker is one implementation). The device opens
one outbound WebSocket to the relay. The relay uses it to forward HTTP requests
from a browser to the device's own local web server and to stream the responses back.

The protocol is deliberately small so that a memory-constrained microcontroller can
implement it. The device is always the authority on what it serves.

## 1. Goals and non-goals

Goals

- One outbound WSS connection per device. No inbound ports.
- Reuse the device's existing web app unchanged (same paths, same assets).
- Bounded memory on the device: fixed frame size, fixed number of streams.
- Read-only by default. The device enforces its own allowlist.
- The relay stores nothing: no database, no persisted state, no request logging.

Non-goals (v1)

- Request bodies and write methods (POST, PUT, DELETE). Reserved, see section 9.
- End-to-end encryption between browser and device. TLS terminates at the relay, so
  the relay operator can see all traffic in plaintext. This must be documented to
  users.
- Multiple independent access tokens per device. v1 has one shared secret.

## 2. Terminology

| Term | Meaning |
|---|---|
| Device | The ESP32 running OpenQuatt firmware. |
| Relay | The service the device connects to and that browsers talk to. |
| Pump secret | 256-bit random value generated on the device. Acts as a password. |
| Route ID | `SHA-256(pump_secret)`, lowercase hex. Not secret. Used to pick the right Durable Object (or equivalent) and, optionally, as subdomain label. |
| Stream | One HTTP request/response exchange, identified by a `stream_id`. |

## 3. Secrets and identifiers

- The device generates `pump_secret` with the hardware RNG: 32 random bytes,
  encoded base64url without padding (43 characters).
- It must never be derived from the MAC address, serial number or any other
  guessable value.
- The secret is shown to the user only through the local pairing flow (QR code or
  redirect with the secret in a URL **fragment**, so it is never sent to a server
  as part of a request line).
- The relay computes `route_id = hex(SHA-256(secret))` and uses that for routing.
  The secret itself must not be written to logs, storage or error messages.
- Turning the tunnel off, or "clear generated IDs" on the device, discards the
  secret. The next activation generates a new one.

## 4. Transport

- WebSocket over TLS (`wss://`), HTTP/1.1 upgrade.
- Endpoint: `wss://<relay>/device`
- Authentication: request header `Authorization: Bearer <pump_secret>` on the
  upgrade request. The secret is not placed in the URL or query string.
- Subprotocol: `openquatt-tunnel.v1` (`Sec-WebSocket-Protocol`).
- Only one active device connection per `route_id`. A new connection replaces the
  old one; the old one is closed with code `4000`.
- All application data uses **binary** WebSocket frames. Text frames are a protocol
  error.
- Keepalive uses WebSocket-level ping/pong (see section 8), not application frames.

## 5. Frame format

Every binary WebSocket message contains exactly one frame:

```
+--------+----------------+------------------+
| type   | stream_id      | payload          |
| 1 byte | 4 bytes, BE    | 0..max_frame     |
+--------+----------------+------------------+
```

- `stream_id = 0` is used for connection-level frames (HELLO, HELLO_ACK).
- Stream IDs are chosen by the relay, start at 1 and increase. A stream ID is never
  reused within one connection.
- `max_frame` is the maximum **payload** size (header excluded), negotiated in the
  handshake. Default 4096 bytes. A larger frame is a protocol error (close `4009`).
- Control payloads are UTF-8 JSON objects. Body payloads are raw bytes.

### Frame types

| Code | Name | Direction | Payload |
|---|---|---|---|
| 0x01 | HELLO | device to relay | JSON |
| 0x02 | HELLO_ACK | relay to device | JSON |
| 0x10 | REQ_HEAD | relay to device | JSON |
| 0x11 | REQ_BODY | relay to device | reserved (v2) |
| 0x12 | REQ_END | relay to device | reserved (v2) |
| 0x20 | RES_HEAD | device to relay | JSON |
| 0x21 | RES_BODY | device to relay | raw bytes |
| 0x22 | RES_END | device to relay | empty |
| 0x30 | RESET | either direction | JSON `{"code": <int>}` |

Unknown frame types are ignored on stream 0 only if the connection has negotiated a
higher minor version; otherwise they are a protocol error (close `4003`).

## 6. Handshake

After the WebSocket is open, the device sends HELLO within 5 seconds:

```json
{
  "v": 1,
  "fw": "0.52.0",
  "profile": "<hardware profile id>",
  "max_frame": 4096,
  "max_streams": 2,
  "caps": ["sse"]
}
```

| Field | Meaning |
|---|---|
| `v` | Protocol major version the device speaks. |
| `fw` | Firmware version string. The relay may show it on the pairing confirmation screen. |
| `profile` | Hardware profile identifier. Informational. |
| `max_frame` | Largest payload the device is willing to send or receive in one frame. |
| `max_streams` | Concurrent streams the device can serve. |
| `caps` | Optional capabilities. `sse` means the device can serve long-lived event streams. |

The relay answers with HELLO_ACK:

```json
{
  "v": 1,
  "max_frame": 4096,
  "max_streams": 2,
  "request_timeout_s": 10,
  "idle_timeout_s": 30,
  "ping_interval_s": 30
}
```

The relay must not raise `max_frame` or `max_streams` above what the device
announced. It may lower them. If the relay does not support `v`, it closes with
`4002`.

Until HELLO_ACK has been sent, the relay treats the device as **offline** for browser
requests.

## 7. Request and response flow

### 7.1 Normal request (v1: GET and HEAD only)

```
browser -> relay :  GET /api/foo
relay   -> device:  REQ_HEAD  stream=7  {"m":"GET","p":"/api/foo","h":{...}}
device  -> relay :  RES_HEAD  stream=7  {"s":200,"h":{"content-type":"application/json"}}
device  -> relay :  RES_BODY  stream=7  <bytes>
device  -> relay :  RES_BODY  stream=7  <bytes>
device  -> relay :  RES_END   stream=7
```

REQ_HEAD payload:

| Field | Type | Meaning |
|---|---|---|
| `m` | string | Method. v1: `GET` or `HEAD`. |
| `p` | string | Path plus query, starting with `/`. Max 1024 bytes. |
| `h` | object | Forwarded request headers (see 7.4). Max 2048 bytes total. |

RES_HEAD payload:

| Field | Type | Meaning |
|---|---|---|
| `s` | integer | HTTP status code. |
| `h` | object | Response headers (see 7.4). Max 2048 bytes total. |

Rules:

- A stream ends normally with RES_END, or abnormally with RESET.
- For HEAD requests the device sends RES_HEAD and RES_END only.
- Bodies are sent in chunks of at most `max_frame` bytes. The relay re-chunks or
  streams them to the browser as it sees fit.
- If the device sets `content-length`, the relay may pass it on. Otherwise the relay
  uses chunked transfer encoding towards the browser.
- Content compressed by the device (`content-encoding: gzip`) is passed through
  unchanged.

### 7.2 Long-lived streams (server-sent events)

The ESPHome web server publishes live updates over `GET /events` as
`text/event-stream`. The same framing is used:

- The device sends RES_HEAD with `content-type: text/event-stream`, then RES_BODY
  frames whenever an event is ready. RES_END is only sent if the device closes the
  stream.
- The relay ends the stream by sending RESET with code `2` when the browser
  disconnects.
- Long-lived streams count against `max_streams`. The relay should allow at most
  **one** event stream per device at a time and reject additional ones with `503`
  towards the browser.
- Streams that are not event streams are subject to `idle_timeout_s`; event streams
  are kept alive by the device's own periodic pings (ESPHome sends one every 10 s).
  If no bytes arrive on an event stream for `3 * idle_timeout_s`, the relay sends
  RESET code `1`.

### 7.3 Aborting a stream

RESET can be sent by either side at any time and terminates the stream immediately.
Frames received afterwards for that `stream_id` are ignored.

| Code | Meaning |
|---|---|
| 1 | Timeout |
| 2 | Client (browser) went away |
| 3 | Forbidden by allowlist |
| 4 | Too large |
| 5 | Device busy or out of memory |
| 6 | Internal error |

### 7.4 Header handling

The device is the final authority. The relay applies the same rules to keep the
device's work small.

Request headers forwarded by the relay (all others are dropped): `accept`,
`accept-encoding`, `accept-language`, `if-none-match`, `if-modified-since`, `range`
(v1: dropped unless the device announces support), `user-agent`.

The relay **never** forwards `cookie`, `authorization`, `x-forwarded-*`, or any
header it added itself for its own routing. The `Host` and `Origin` seen by the
device are those of the local device, not the relay. (See open question 2.)

Response headers the device may send: `content-type`, `content-encoding`,
`content-length`, `cache-control`, `etag`, `last-modified`. Anything else, in
particular `set-cookie`, is dropped by the relay.

The relay adds its own security headers to browser responses (at least a
restrictive `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`) and sets its own
cache policy for responses that carry state.

### 7.5 Allowlist

Two layers, both required:

1. **Device** (authoritative). The firmware keeps a compile-time allowlist of
   method and path patterns that may be served through the tunnel. Anything else
   is answered with RES_HEAD `403` followed by RES_END, or with RESET code `3`.
2. **Relay** (defence in depth). Rejects everything except `GET`/`HEAD` and paths
   that look sane (starts with `/`, no `..`, no control characters, no absolute
   URLs, max 1024 bytes) before it ever reaches the device.

Never reachable through the tunnel in any configuration: firmware upload (OTA),
Wi-Fi and network settings, tunnel settings itself, backup/restore, and any
endpoint that changes setpoints or writes to the heat pump.

## 8. Limits, timeouts and keepalive

| Item | Default | Enforced by |
|---|---|---|
| Max frame payload | 4096 bytes | both |
| Concurrent streams | 2 (one may be the event stream) | relay, device |
| Time from REQ_HEAD to RES_HEAD | 10 s | relay |
| Idle time on a non-event stream | 30 s | relay |
| Max response size (non-event) | 2 MiB | relay |
| Path length | 1024 bytes | both |
| Header block | 2048 bytes | both |
| HELLO after connect | 5 s | relay |
| WebSocket ping interval | 30 s | relay |
| Pong deadline | 10 s | relay |

Keepalive: the relay sends WebSocket ping frames every `ping_interval_s`. If no pong
arrives within the pong deadline, the relay closes the connection. On a relay built
on hibernating WebSockets, use the platform's automatic ping/pong response so that
an idle connection does not keep the runtime awake.

Reconnect: after any loss of connection the device retries with exponential backoff
starting at 5 s, doubling up to 300 s, with random jitter of plus or minus 20 %. It
resets the backoff after a connection has lasted at least 60 s. It does not retry
while the tunnel switch is off.

Rate limiting (relay): per route ID and per client IP, for both device connections
and browser requests. Exceeding it yields close `4008` on the device socket and
HTTP `429` towards browsers.

## 9. Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal closure (for example the tunnel was switched off on the device) |
| 4000 | Replaced by a newer connection with the same secret |
| 4001 | Authentication failed (missing or malformed secret) |
| 4002 | Unsupported protocol version |
| 4003 | Protocol error (bad frame type, text frame, bad stream ID) |
| 4008 | Rate limited |
| 4009 | Frame too large |

The relay must not reveal whether a given route ID exists or is online to anyone
without a valid pump secret.

## 10. Browser side (informative, not part of the device protocol)

This is how the reference relay uses the protocol. Other relays may differ.

1. The device shows or opens `https://<relay>/pair#<pump_secret>`. The fragment is
   never sent to a server.
2. The pairing page shows a confirmation screen (with `fw` and `profile` from
   HELLO), then sends the secret once to `POST /api/pair`.
3. The relay checks that a device with that route ID is online, then answers with
   `Set-Cookie: oq_pump=<secret>; HttpOnly; Secure; SameSite=Strict; Path=/;
   Max-Age=<n>`. The page then removes the fragment from the URL and history.
4. Later browser requests carry the cookie. The relay hashes it to the route ID,
   selects the matching connection and forwards the request as REQ_HEAD.
5. A browser request for a route ID with no online device gets a static "device
   offline" page. The relay does not queue requests.

Because localStorage is not sent with requests and can be evicted by some browsers
after inactivity, the secret lives in a server-set cookie. Isolation between
devices on a shared origin is weak: a subdomain per route ID is the stronger option
and is left as a future step.

## 11. Implementation notes for the device

- Allocate frame and header buffers once, sized `max_frame * max_streams`, and prefer
  PSRAM for anything that is not required to be in internal memory. TLS buffers stay
  internal. Do not allocate per request.
- Serve REQ_HEAD by dispatching to the local web server on the loopback interface, or
  by calling its handlers directly. Do not duplicate route logic.
- Apply the allowlist before dispatching. Fail closed on any allocation failure.
- Keep the tunnel off by default and open the connection only while it is enabled.
- Report free internal heap, minimum heap, and largest free block while the tunnel is
  active, as described in the project's memory guidelines.

## 12. Open questions

1. **Multiple phones.** One shared secret means "clear IDs" revokes everyone. A list
   of tokens on the device (one secret per phone, all mapping to one route ID) would
   allow per-phone revocation, at the cost of more state on the device.
2. **Host, Origin and CSRF.** Check how the web app and the ESPHome web server treat
   `Host`, `Origin` and any CSRF tokens. If proxied requests fail those checks, the
   fix must not weaken them for LAN clients.
3. **Absolute URLs.** The web app must use relative URLs and same-origin requests
   only. Verify this before choosing between a path prefix and a whole-origin proxy.
4. **Range requests** for large assets and downloads such as log exports.
5. **Write access.** Adding POST needs REQ_BODY/REQ_END, an explicit opt-in on the
   device, per-endpoint allowlisting and the confirmation behaviour required by the
   web app guidelines (an accepted write is not a confirmed result).
6. **End-to-end encryption.** Making the relay blind would need a browser-to-device
   secure channel on top of this protocol. Out of scope for v1.
7. **Subdomain per device** (`<route_id>.<relay>`) for origin isolation, and the
   wildcard routing and certificate this requires.

## 13. Versioning

`v` in HELLO is the major version. Additions that do not break older peers (new
optional JSON fields, new `caps` entries) do not bump it. Breaking changes bump it,
and the relay closes older or newer devices with `4002`.
