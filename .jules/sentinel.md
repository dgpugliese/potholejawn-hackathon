## 2024-02-09 - XSS Vulnerability in Leaflet bindPopup
**Vulnerability:** XSS vulnerability where raw strings were passed directly to Leaflet's `bindPopup()`.
**Learning:** Leaflet's `bindPopup()` evaluates raw strings as HTML, exposing the application to Cross-Site Scripting (XSS) if the string contains unsanitized user input (like addresses).
**Prevention:** Always use safe DOM element creation functions (like the `el()` helper) and pass the `HTMLElement` to `bindPopup()` to ensure the text is treated as safe `textContent` rather than parsed HTML.
