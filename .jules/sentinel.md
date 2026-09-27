## 2026-09-20 - IP Spoofing Rate Limit Bypass
**Vulnerability:** The application unconditionally trusted the `CF-Connecting-IP` header to identify the client's IP address. This allowed external attackers to spoof their IP address (e.g. to `127.0.0.1` or rotating random IPs) and bypass rate limits entirely.
**Learning:** `request.headers.get("CF-Connecting-IP")` and `X-Forwarded-For` should never be blindly trusted. If a whitelist includes local loopback addresses, spoofing those headers can completely elevate an attacker's privileges.
**Prevention:** Only trust proxy headers when the connection actually originates from the trusted proxy server (checked via `request.remote_addr`).
