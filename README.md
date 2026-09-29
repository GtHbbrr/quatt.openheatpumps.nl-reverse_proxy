# quatt.openheatpumps.nl reverse proxy

Experimental proof of concept: a Cloudflare Worker + Durable Object that relays
HTTP requests from a phone browser to an OpenQuatt heat pump over a single
outbound WebSocket opened by the device.

Status: experimental. Not affiliated with or endorsed by the OpenQuatt project.

## Privacy

- No user data is stored: no database, no Durable Object storage, no request logging.
- Traffic is relayed in memory. The relay operator (and Cloudflare) can technically
  see all traffic in plaintext, because TLS terminates at Cloudflare.
- The pump ID acts as a secret. Anyone who knows it can reach the pump, within the
  allowlist below.

## Documents

- PROTOCOL.md: wire protocol between the device and the relay (draft)
- SECURITY.md: threat model and reporting (draft)
