## 2024-11-07 - XSS in Leaflet popups
**Vulnerability:** Raw user input (`place.matched_address`) was passed directly to Leaflet's `bindPopup()` function without sanitization on endpoints display.
**Learning:** Leaflet popups accept HTML by default. If unsanitized data is passed as a string, it will be executed as HTML/JS, leading to an XSS vulnerability.
**Prevention:** Always use safe DOM creation methods (like `el("span", "", data)`) or `document.createTextNode()` when binding user-controlled strings to Leaflet popups, instead of passing raw strings directly.
