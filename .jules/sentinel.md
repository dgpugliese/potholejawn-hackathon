## 2026-10-03 - IP Spoofing via X-Forwarded-For or CF-Connecting-IP
**Vulnerability:** IP-based rate limiting was trivially bypassed by spoofing `CF-Connecting-IP` HTTP headers.
**Learning:** Checking headers like `CF-Connecting-IP` or `X-Forwarded-For` without validating that they come from a trusted proxy allows an attacker to bypass IP-based rate limiting. When deploying with Cloudflare or similar proxies, the proxy should enforce IP rate limiting or pass a signed/trusted identifier.
**Prevention:** Always use `request.remote_addr` for IP rate limits or properly configure a trusted proxy layer (like Werkzeug's `ProxyFix`) to parse headers safely.
