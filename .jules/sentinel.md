## 2025-02-27 - [XSS in Leaflet bindPopup]
**Vulnerability:** XSS vulnerability through unsanitized input in Leaflet's `bindPopup(string)` function.
**Learning:** Leaflet parses raw strings passed to `.bindPopup()` as HTML by default, which can execute malicious scripts if the string contains untrusted user input like an address string.
**Prevention:** Avoid passing raw strings to `.bindPopup()`. Always pass DOM nodes using `document.createTextNode(userInput)` or an equivalent element-creation helper to safely set text content instead of raw HTML.
