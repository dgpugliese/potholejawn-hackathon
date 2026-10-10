## 2026-09-21 - XSS in Leaflet Popups
**Vulnerability:** Leaflet `bindPopup()` interprets strings as raw HTML. Passing un-sanitized address data (e.g. `place.matched_address` from a geocoding API) directly into `bindPopup()` allows for XSS if the data source contains malicious scripts.
**Learning:** Third-party APIs (like OpenStreetMap Nominatim) cannot be completely trusted to return safe strings.
**Prevention:** Always use the DOM to create elements and set `textContent` before passing them to `bindPopup()`. The `el()` helper function in `app.js` is the correct pattern for safely displaying dynamic text in popups.
