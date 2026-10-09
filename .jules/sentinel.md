## YYYY-MM-DD - [Initial Creation]
**Vulnerability:** None
**Learning:** Initializing sentinel journal
**Prevention:** N/A

## 2026-09-20 - [Add Content Security Policy to Web App]
**Vulnerability:** Missing Content-Security-Policy (CSP) headers, making the application potentially vulnerable to Cross-Site Scripting (XSS) and code injection attacks if any vector arises.
**Learning:** Adding a defense-in-depth CSP restricts the origins of executable scripts, stylesheets, images, and API requests to only trusted domains (`self`, `cdnjs.cloudflare.com`, `fonts.googleapis.com`, `server.arcgisonline.com`, etc). This severely limits what malicious code can do even if XSS is injected.
**Prevention:** Always include a strong Content-Security-Policy header in web applications alongside other security headers like `X-Frame-Options` and `X-Content-Type-Options`. Ensure to whitelist only required CDNs and data URIs.
