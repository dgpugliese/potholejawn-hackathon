## 2024-11-06 - Leaflet bindPopup XSS Vulnerability
**Vulnerability:** XSS vulnerability in Leaflet's `bindPopup()` where user-supplied endpoint addresses were passed directly as raw strings.
**Learning:** Leaflet's `bindPopup(content)` evaluates string content as raw HTML, which can execute injected scripts if the source data (like addresses from external APIs or user input) isn't sanitized.
**Prevention:** Never pass raw strings to `.bindPopup()`. Always use `document.createTextNode()` or a DOM element helper like `el()` that sets `textContent` to safely encode output.
