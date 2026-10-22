## 2024-05-13 - [XSS via Leaflet bindPopup]
**Vulnerability:** XSS vulnerability where untrusted `place.matched_address` was passed directly as a string to Leaflet's `bindPopup()`, which treats string arguments as raw HTML and uses `innerHTML`.
**Learning:** Leaflet's `bindPopup(String)` is a sink for XSS. Passing an HTML Element instead avoids `innerHTML`.
**Prevention:** Always pass an HTML Element (e.g., via `document.createTextNode()` or an `el()` helper) to `bindPopup()` rather than a raw string.
