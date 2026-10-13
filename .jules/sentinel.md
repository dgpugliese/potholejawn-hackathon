## 2024-05-18 - XSS via Leaflet bindPopup
**Vulnerability:** Raw address strings passed directly to Leaflet's `.bindPopup()` in `app.js`, causing XSS.
**Learning:** Leaflet popups render HTML by default, making them vulnerable if user-controlled data is passed directly.
**Prevention:** Always use the `el()` helper to create safe DOM elements with `textContent` before passing to `.bindPopup()`.
