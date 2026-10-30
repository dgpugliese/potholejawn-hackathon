## 2026-10-30 - XSS in Leaflet bindPopup
**Vulnerability:** Leaflet `bindPopup` taking string arguments parses it as HTML, causing XSS with unsanitized user inputs.
**Learning:** Leaflet defaults to parsing string input as HTML in tooltips/popups.
**Prevention:** Always pass a DOM element created via `document.createElement()` or `document.createTextNode()` to Leaflet popups instead of raw strings.
