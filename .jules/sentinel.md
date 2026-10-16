## 2024-05-18 - XSS in Leaflet bindPopup
**Vulnerability:** Passing raw string data to Leaflet's `bindPopup` method causes XSS if the string contains HTML.
**Learning:** Leaflet's `bindPopup` renders strings directly as HTML. User input like place addresses must be sanitized or safely inserted as text nodes.
**Prevention:** Always use `document.createTextNode` or DOM elements with `textContent` instead of raw strings when calling `.bindPopup()`.
