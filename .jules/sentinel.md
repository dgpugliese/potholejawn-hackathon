# Sentinel Journal

## 2024-05-18 - [Fix Leaflet bindPopup XSS]
**Vulnerability:** Leaflet's `.bindPopup()` method was accepting raw strings for dynamic input (`place.matched_address`), which it interprets as HTML, creating a Cross-Site Scripting (XSS) vulnerability.
**Learning:** Leaflet's `.bindPopup()` interprets strings as HTML rather than text, so passing unvalidated API data directly into it is unsafe.
**Prevention:** Always wrap raw strings with `document.createTextNode()` when passing them into `.bindPopup()` or similar methods that expect HTML or DOM nodes to ensure safe text rendering.
