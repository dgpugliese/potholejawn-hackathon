## 2024-10-29 - Leaflet bindPopup XSS
**Vulnerability:** Leaflet's `.bindPopup()` passes strings through to `innerHTML`, allowing XSS if inputs (like address lookup fields) are unsanitized.
**Learning:** Some parts of the codebase were still passing raw strings directly to `.bindPopup()`.
**Prevention:** Avoid passing raw strings directly to `.bindPopup()`. Instead, use `document.createTextNode()` or the `el()` helper function from `app.js` to create DOM elements with safe `textContent`.
