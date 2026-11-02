## 2024-11-02 - XSS in Leaflet bindPopup
**Vulnerability:** XSS vulnerability in `bindPopup` due to string passing (which Leaflet treats as HTML) instead of DOM elements, in this specific case `place.matched_address`.
**Learning:** `bindPopup` expects either an HTML string or a DOM element. If a string is given, it's inserted as HTML. This creates a vulnerability when passing raw string data directly to `bindPopup`.
**Prevention:** Use DOM elements, like `document.createTextNode` or the helper function `el()` to safely bind text content.
