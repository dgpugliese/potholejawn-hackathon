## 2024-05-24 - Leaflet bindPopup XSS Vulnerability
**Vulnerability:** Cross-Site Scripting (XSS) via Leaflet's `bindPopup()` method when passing raw string data (e.g. `place.matched_address`).
**Learning:** Leaflet's `bindPopup()` parses raw strings as HTML by default. If untrusted or unescaped data is passed directly as a string, it can lead to XSS. Other parts of the code correctly pass DOM elements (like a `div` element with text nodes).
**Prevention:** Always pass DOM elements (created via `document.createTextNode()` or similar helpers like `el()`) to `bindPopup()`, rather than raw strings, to ensure user data is treated as text content and not executable HTML.
