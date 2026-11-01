## 2024-11-01 - Leaflet `bindPopup` XSS Pattern
**Vulnerability:** Cross-Site Scripting (XSS) via raw strings passed to Leaflet's `bindPopup()`.
**Learning:** Leaflet's `bindPopup` evaluates raw string arguments as HTML, which can lead to XSS if user-supplied or external data is passed without sanitization. In `app.js`, `place.matched_address` was directly passed to `bindPopup`.
**Prevention:** Avoid passing raw strings directly to `.bindPopup()`. Instead, construct safe DOM elements using `document.createTextNode()` or the custom `el()` helper function, which sets `textContent` safely.
