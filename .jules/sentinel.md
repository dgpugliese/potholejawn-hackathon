## 2026-09-20 - [HIGH] Fix rate limit bypass via IP spoofing
**Vulnerability:** IP Spoofing allowing rate limit bypass
**Learning:** The application blindly trusts the `CF-Connecting-IP` header provided in requests without verifying if the request actually originates from a trusted proxy (e.g., Cloudflare tunnel / localhost). Attackers can send `CF-Connecting-IP: 127.0.0.1` to bypass rate limits as localhost IPs are exempted.
**Prevention:** Only use trust header values (like `CF-Connecting-IP` or `X-Forwarded-For`) when `request.remote_addr` is a known, trusted proxy IP.
