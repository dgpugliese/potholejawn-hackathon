## 2026-10-18 - [Fix XSS in Leaflet Popup]
**Vulnerability:** XSS via Leaflet `bindPopup` method
**Learning:** Leaflet's `bindPopup` accepts a string and parses it directly as HTML, leading to XSS vulnerabilities if the string includes untrusted input (like an address from an API).
**Prevention:** Avoid passing raw strings to `bindPopup`. Create safe DOM elements directly or by using the `el()` helper, ensuring `textContent` is used over `innerHTML` or raw string evaluation.