## 2026-10-27 - [Rate Limit Bypass via IP Spoofing]
**Vulnerability:** Attackers could bypass rate limiting by spoofing the `CF-Connecting-IP` header as a local IP (`127.0.0.1`).
**Learning:** `request.headers` should never be implicitly trusted, particularly for bypassing security controls or rate limits, unless properly validated or cleared by a trusted upstream proxy. Additionally, when handling background threads in Flask, request-bound data (like the IP or locality) must be evaluated on the main thread and captured in closures, to avoid `RuntimeError` regarding working outside of the request context.
**Prevention:** Always assess the source IP independently of headers unless utilizing `ProxyFix` correctly configured for a specific provider.
