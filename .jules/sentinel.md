## 2024-05-24 - Leaflet bindPopup() XSS Vulnerability
**Vulnerability:** Passing raw string data to `bindPopup()` in Leaflet maps. Leaflet assumes string arguments to `bindPopup()` are safe HTML strings and parses them as HTML, leading to XSS vulnerabilities.
**Learning:** Even well-known UI libraries may process certain properties as raw HTML by default. We must be vigilant about how user-controlled data is passed to APIs like Leaflet.
**Prevention:** Instead of raw strings, pass DOM elements created with secure methods like `document.createTextNode(str)` or the application's secure `el()` helper to `.bindPopup()`.
