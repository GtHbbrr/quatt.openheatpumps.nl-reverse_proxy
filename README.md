# quatt.openheatpumps.nl reverse proxy

Production-ready stateless reverse proxy infrastructure. This repository implements 
the Cloudflare Worker + Durable Object relay that securely routes HTTP requests from 
a phone browser to an OpenQuatt heat pump controller (ESP32-S3) over a single 
outbound WebSocket tunnel.

Status: **Stable, Production Ready**. Powered by OpenQuatt Wire Protocol v2.0. 
This project is an independent community effort and is not affiliated with or 
endorsed by the official OpenQuatt project.

## Core Features (v2.0)

- **Zero-Trust Client Security:** Fully compliant with ESP-IDF v5 mbedTLS transport standards [7.tech-support].
- **Query-Token Authentication:** Secure, asynchronous handshake via URL parameters, preventing micro-controller stack frame fragmentation [7.tech-support].
- **Concurrency Isolation:** Hardware-level single-token lock intercepts and drops duplicate browser rendering triggers [7.tech-support].

## Privacy

- **No Data Persistence:** No user data, session states, or request contents are stored in any database or Durable Object persistent storage layer.
- **In-Memory Routing:** Traffic is strictly processed and relayed in volatile RAM. Note: Because TLS terminates at the Cloudflare Edge, the relay infrastructure processes transit traffic in plaintext. This architecture is fully documented to users.
- **Cryptographic Isolation:** The volatile pairing token acts as a cryptographic secret. Access is strictly limited to endpoints defined within the firmware's compile-time allowlist.

## Documentation

- **[PROTOCOL.md](PROTOCOL.md):** Detailed wire protocol specification between the device and the relay (Upgraded to v2.0 Production).
- **[SECURITY.md](SECURITY.md):** Threat modeling, attack vector analysis, and security vulnerability reporting guidelines.
