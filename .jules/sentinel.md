## 2024-11-04 - [XSS via Leaflet bindPopup]
**Vulnerability:** XSS vulnerability where raw user input (like geocoded addresses) was passed directly as a string to Leaflet's `bindPopup()`, which parses string arguments as raw HTML by default.
**Learning:** Leaflet's `bindPopup()` interprets plain strings as HTML. If user-controlled data (like `place.matched_address`) is passed directly, it allows for Cross-Site Scripting (XSS).
**Prevention:** Never pass raw strings containing user data to `bindPopup()`. Always construct a safe DOM element using helper functions like `el()` or `document.createTextNode()`, and pass the DOM element to `bindPopup()` instead.
