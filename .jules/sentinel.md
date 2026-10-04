## 2026-09-20 - [Rate Limit Bypass via Spoofed Local IP]
**Vulnerability:** The application trusted the `CF-Connecting-IP` header without checking if `request.remote_addr` was local. Attackers could bypass rate limits by setting `CF-Connecting-IP: 127.0.0.1`.
**Learning:** `CF-Connecting-IP` should not be trusted if it claims to be a local IP when the actual connection originates from a public IP.
**Prevention:** Always verify the `request.remote_addr` is also a local IP before accepting a local IP from `CF-Connecting-IP`.
