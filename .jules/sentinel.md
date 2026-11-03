## YYYY-MM-DD - [XSS in Leaflet bindPopup]
**Vulnerability:** XSS vulnerability where Leaflet's `bindPopup()` was directly passed unescaped API data (`place.matched_address`).
**Learning:** Leaflet's `bindPopup()` treats strings as HTML, making it vulnerable to XSS if passed unsanitized user input or external API data.
**Prevention:** Always pass a DOM node (like `document.createTextNode()`) or use safe helper functions to generate the popup content instead of a raw string.
