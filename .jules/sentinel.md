## 2024-11-08 - [XSS vulnerability in endpoint map marker]
**Vulnerability:** Leaflet `bindPopup()` in `app.js` is called directly with a string that originates from API input (`place.matched_address`), which could be vulnerable to XSS if the string contains HTML.
**Learning:** Directly passing dynamic data into Leaflet's `bindPopup()` causes Leaflet to inject that string as HTML. This can lead to XSS. We should use DOM creation or `document.createTextNode` instead.
**Prevention:** Avoid passing raw strings directly to `.bindPopup()` to prevent XSS vulnerabilities. Instead, use `document.createTextNode()` or the `el()` helper function from `app.js` to create DOM elements with safe `textContent`.
