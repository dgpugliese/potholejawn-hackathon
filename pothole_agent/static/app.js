"use strict";

(function () {
  const OLD_REPORT_DAYS = 90;
  const COLORS = { recommended: "#006b54", other: "#4a6785" };

  const map = L.map("map", { zoomControl: true }).setView([39.9526, -75.1652], 13);
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution:
        'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Sources: Esri, HERE, Garmin, OpenStreetMap contributors',
    }
  ).addTo(map);

  const layers = L.layerGroup().addTo(map);

  // ---- Brand watermark ------------------------------------------------------
  // The emblem sits faded behind the data, always centred in the viewport.
  // It lives in a custom pane (z 350: above tiles, below overlays/markers/
  // popups) and is re-centred on every map move so it never drifts with pans.
  const watermarkPane = map.createPane("watermark");
  watermarkPane.style.zIndex = 350;
  watermarkPane.style.pointerEvents = "none";
  const watermark = document.createElement("img");
  watermark.src = "/static/logo.png";
  watermark.alt = "";
  watermark.className = "map-watermark";
  watermarkPane.appendChild(watermark);
  function visibleMapCenter() {
    // Centre within the map area the user can actually see: the open desktop
    // panel covers the left edge, the open mobile sheet covers the bottom.
    const size = map.getSize();
    let left = 0;
    let bottom = 0;
    const panelEl = document.getElementById("panel");
    if (panelEl && !panelEl.classList.contains("collapsed")) {
      const rect = panelEl.getBoundingClientRect();
      if (window.innerWidth > 768) left = Math.max(0, rect.right);
      else bottom = Math.max(0, window.innerHeight - rect.top);
    }
    return L.point((left + size.x) / 2, (size.y - bottom) / 2);
  }
  function centerWatermark() {
    // setPosition owns the element's transform, so subtract half the rendered
    // size ourselves instead of relying on a CSS translate(-50%, -50%).
    const c = map.containerPointToLayerPoint(visibleMapCenter());
    const half = L.point(watermark.offsetWidth / 2, watermark.offsetHeight / 2);
    L.DomUtil.setPosition(watermark, c.subtract(half));
  }
  map.on("move zoom viewreset resize", centerWatermark);
  watermark.addEventListener("load", centerWatermark);
  document.addEventListener("transitionend", function (event) {
    if (event.target && event.target.id === "panel") centerWatermark();
  });
  centerWatermark();

  // ---- Floating pill + slide-in panel ---------------------------------------
  const panel = document.getElementById("panel");
  const panelTab = document.getElementById("panel-tab");
  const mobileMq = window.matchMedia("(max-width: 768px)");
  let panelOpen = false;

  // ---- Mobile bottom-sheet states -------------------------------------------
  // peek (~120px strip) / half (55% — map and routes both visible) / full
  // (92% — reading and typing). Desktop never gets these classes.
  let sheetState = "full";

  function setSheet(state) {
    // Peek only earns its strip once there is a trip to summarize; before
    // that, minimizing the sheet just dismisses it (map + pill only).
    if (state === "peek" && !trip) { closePanel(); return; }
    sheetState = state;
    panel.classList.toggle("sheet-peek", state === "peek");
    panel.classList.toggle("sheet-half", state === "half");
    panel.classList.toggle("sheet-full", state === "full");
    // "collapsed" stays in sync with peek so the watermark-centring and
    // fitBounds code paths that predate the three-state sheet keep working.
    panel.classList.toggle("collapsed", state === "peek");
  }

  function openPanel() {
    if (mobileMq.matches) setSheet("full");
    else panel.classList.remove("collapsed");
    if (panelOpen) return;
    panelOpen = true;
    document.body.classList.add("panel-open");
    panelTab.setAttribute("aria-label", "Close trip panel");
    setTimeout(function () { map.invalidateSize(); }, 320);
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    document.body.classList.remove("panel-open");
    panelTab.setAttribute("aria-label", "Open trip panel");
    setTimeout(function () { map.invalidateSize(); }, 320);
  }

  function togglePanel() { if (panelOpen) closePanel(); else openPanel(); }

  // Padding for fitBounds so routes are not hidden under the open panel,
  // the pill, or the mobile bottom sheet.
  function fitPadding() {
    const mobile = mobileMq.matches;
    if (mobile) {
      let sheet = 100; // clears the bottom search pill when the sheet is closed
      if (panelOpen) {
        // At peek only the strip covers the map; at half or full assume the
        // half height — routes are typically viewed with the sheet at half.
        sheet = sheetState === "peek" ? 148 : Math.round(window.innerHeight * 0.55) + 16;
      }
      return { paddingTopLeft: [24, 24], paddingBottomRight: [24, sheet] };
    }
    return { paddingTopLeft: [panelOpen ? 380 + 40 : 40, 84], paddingBottomRight: [40, 40] };
  }

  // ---- Citywide open-report layer -------------------------------------------
  // Before a trip is planned, show every open pothole report in view as quiet
  // dots on a canvas renderer. Hidden while a trip result is on screen so the
  // routes stay the hero.
  const CITYWIDE_MIN_ZOOM = 12;
  const CITYWIDE_DEBOUNCE_MS = 400;
  const citywideRenderer = L.canvas({ padding: 0.4 });
  const citywideLayer = L.layerGroup().addTo(map);
  const citywideBadge = document.createElement("div");
  citywideBadge.className = "citywide-badge";
  citywideBadge.hidden = true;
  const CitywideBadge = L.Control.extend({ onAdd: () => citywideBadge });
  // Bottom-left on desktop; on mobile the bottom edge belongs to the search
  // pill, so the badge docks top-left under the zoom control instead.
  const citywideControl = new CitywideBadge({
    position: mobileMq.matches ? "topleft" : "bottomleft",
  }).addTo(map);
  mobileMq.addEventListener("change", function () {
    citywideControl.setPosition(mobileMq.matches ? "topleft" : "bottomleft");
  });
  let citywideVisible = true;
  let citywideSeq = 0; // ignores out-of-order fetch responses
  let citywideTimer = null;

  function fetchCitywide() {
    if (!citywideVisible) return;
    if (map.getZoom() < CITYWIDE_MIN_ZOOM) {
      citywideSeq += 1;
      citywideLayer.clearLayers();
      citywideBadge.hidden = true;
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
      .map((v) => v.toFixed(5))
      .join(",");
    citywideSeq += 1;
    const seq = citywideSeq;
    fetch("/api/potholes?bbox=" + encodeURIComponent(bbox))
      .then((r) => {
        if (!r.ok) throw new Error("potholes fetch failed: " + r.status);
        return r.json();
      })
      .then((data) => {
        if (seq !== citywideSeq || !citywideVisible) return; // a newer fetch or a trip took over
        citywideLayer.clearLayers();
        data.potholes.forEach(function (p) {
          const dot = L.circleMarker([p.lat, p.lon], {
            renderer: citywideRenderer,
            radius: 3.5,
            weight: 1,
            color: "#26282b",
            opacity: 0.55,
            fillColor: "#ffcc00",
            fillOpacity: 0.5,
          }).addTo(citywideLayer);
          const popup = el("div");
          popup.append(
            el("strong", "", p.address),
            el("br"),
            document.createTextNode("Reported " + p.reported + " (" + ageLabel(p.days_open) + ")")
          );
          dot.bindPopup(popup);
        });
        const n = data.potholes.length;
        citywideBadge.textContent =
          n.toLocaleString() + (n >= 1500 ? "+" : "") +
          " open pothole report" + (n === 1 ? "" : "s") + " in view";
        citywideBadge.hidden = false;
      })
      .catch(function () { /* keep the last good dots; the map stays usable */ });
  }

  function hideCitywide() {
    citywideVisible = false;
    citywideSeq += 1; // cancel any in-flight fetch
    map.removeLayer(citywideLayer);
    citywideBadge.hidden = true;
  }

  function showCitywide() {
    if (!citywideVisible) {
      citywideVisible = true;
      citywideLayer.addTo(map);
    }
    fetchCitywide();
  }

  map.on("moveend", function () {
    clearTimeout(citywideTimer);
    citywideTimer = setTimeout(fetchCitywide, CITYWIDE_DEBOUNCE_MS);
  });
  fetchCitywide(); // populate the map on first load, before any trip is planned
  // ---------------------------------------------------------------------------

  const form = document.getElementById("trip-form");
  const button = document.getElementById("go");
  const statusEl = document.getElementById("status");
  const results = document.getElementById("results");

  // Pill -> panel handoff: typing a destination in the floating pill opens the
  // trip panel with that address in the "Going to" field and puts focus in the
  // "Starting from" field. An empty pill just opens the panel.
  const pillForm = document.getElementById("pill");
  const pillInput = document.getElementById("pill-input");
  pillForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const q = pillInput.value.trim();
    openPanel();
    expandTripForm(); // the form may still be collapsed from a previous trip
    if (!q) { form.end.focus(); return; }
    form.end.value = q;
    submitTrip(); // from your location, like Google Maps; "Change" picks another start
  });

  function submitTrip() {
    if (form.requestSubmit) form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  // ---- Start point: "Your location" by default, a typed address on request ---
  // Google Maps style: the first question is where you are going. The start
  // is resolved from the device when the trip runs; "Change" reveals a field.
  const fromToggle = document.getElementById("from-toggle");
  const fromText = document.getElementById("from-text");
  const startWrap = document.getElementById("start-wrap");
  let startMode = "location";
  let myLocation = null; // { coords: "lat, lon", at: ms } cached briefly
  let lastField = "end"; // which field a saved-place chip fills

  function setStartMode(mode) {
    startMode = mode;
    const custom = mode === "custom";
    startWrap.hidden = !custom;
    form.start.required = custom;
    fromToggle.setAttribute("aria-expanded", String(custom));
    fromToggle.classList.toggle("custom", custom);
    fromText.textContent = custom ? (form.start.value.trim() || "Choose a starting point") : "Your location";
    if (custom) { form.start.focus(); lastField = "start"; } else lastField = "end";
  }
  fromToggle.addEventListener("click", function () { setStartMode(startMode === "custom" ? "location" : "custom"); });
  form.start.addEventListener("input", function () { fromText.textContent = form.start.value.trim() || "Choose a starting point"; });

  function startLabel() { return startMode === "custom" ? form.start.value.trim() : "Your location"; }

  function locate(onDone, onError) {
    if (myLocation && Date.now() - myLocation.at < 60000) { onDone(myLocation.coords); return; }
    requestLocation(function (coords) { myLocation = { coords: coords, at: Date.now() }; onDone(coords); }, onError);
  }
  // Warm the location permission the moment someone starts typing a destination.
  form.end.addEventListener("focus", function () { if (startMode === "location" && !myLocation) locate(function () {}, function () {}); }, { once: true });

  // Resolves to the string the planner should geocode as the start.
  function resolveStart(onReady) {
    if (startMode === "custom") {
      const value = form.start.value.trim();
      if (!value) { setStatus("Enter a starting point.", true); form.start.focus(); return; }
      onReady(value);
      return;
    }
    setStatus("Finding your location\u2026");
    locate(onReady, function (message) {
      setStartMode("custom");
      setStatus(message + " Enter a starting point instead.", true);
    });
  }

  // Wire autocomplete to the pill and both trip inputs. The pill's geolocate
  // row and the picker both hand off to the existing pill -> panel flow.
  attachAutocomplete(pillInput, {
    recents: true,
    geolocate: function () {
      // Confirms the default: trips start from the device's position.
      setStartMode("location");
      locate(
        function () {
          const q = pillInput.value.trim();
          openPanel();
          expandTripForm();
          if (q) { form.end.value = q; submitTrip(); } else form.end.focus();
        },
        function (message) { openPanel(); setStatus(message, true); }
      );
    },
    onPick: function () {
      if (pillForm.requestSubmit) pillForm.requestSubmit();
      else pillForm.dispatchEvent(new Event("submit", { cancelable: true }));
    },
  });
  attachAutocomplete(form.start, {
    geolocate: function () { setStartMode("location"); },
  });
  attachAutocomplete(form.end, {});

  // Mobile keyboard handling for the bottom pill: fixed elements anchor to
  // the layout viewport, which the keyboard covers, so translate the pill up
  // by the keyboard's overlap (visualViewport height + pan offset) and let
  // each autocomplete's own visualViewport listeners re-anchor the dropdown.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    function liftPill() {
      if (!mobileMq.matches) { pillForm.style.transform = ""; return; }
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      pillForm.style.transform = inset
        ? "translateX(-50%) translateY(-" + Math.round(inset) + "px)"
        : "";
    }
    vv.addEventListener("resize", liftPill);
    vv.addEventListener("scroll", liftPill);
  }

  document.getElementById("use-location").addEventListener("click", function () { setStartMode("location"); });

  panelTab.addEventListener("click", togglePanel);

  // ---- Mobile sheet: drag gesture on the handle + tap-cycle fallback --------
  // Pointer events drive a live inline transform while the finger is down;
  // release snaps (via the existing CSS transition, so it keeps the same
  // momentum-feel easing as every other panel move) to the nearest state, or
  // dismisses the sheet on a hard downward fling past peek.
  const sheetHandle = document.getElementById("sheet-handle");
  let sheetDrag = null;
  let sheetJustDragged = false;

  function sheetVisibleHeights() {
    // Visible sheet height (px) for each snap state, matching the CSS. The
    // peek value ignores the safe-area inset: it only picks the nearest snap
    // target, and the CSS translate adds the inset back on its own.
    return { full: panel.offsetHeight, half: Math.round(window.innerHeight * 0.55), peek: 120 };
  }

  function currentSheetTranslate() {
    // How far the panel is translated down from its natural (fully open) spot.
    const rect = panel.getBoundingClientRect();
    return rect.top - (window.innerHeight - panel.offsetHeight);
  }

  sheetHandle.addEventListener("pointerdown", function (event) {
    if (!mobileMq.matches || !panelOpen) return;
    sheetDrag = {
      startY: event.clientY,
      lastY: event.clientY,
      lastT: event.timeStamp,
      velocity: 0,
      startTranslate: currentSheetTranslate(),
      moved: false,
    };
    try { sheetHandle.setPointerCapture(event.pointerId); } catch (err) { /* synthetic events have no active pointer */ }
    panel.classList.add("dragging");
  });

  sheetHandle.addEventListener("pointermove", function (event) {
    if (!sheetDrag) return;
    const dy = event.clientY - sheetDrag.startY;
    if (Math.abs(dy) > 6) sheetDrag.moved = true;
    const dt = event.timeStamp - sheetDrag.lastT;
    if (dt > 0) sheetDrag.velocity = (event.clientY - sheetDrag.lastY) / dt; // px per ms, + = down
    sheetDrag.lastY = event.clientY;
    sheetDrag.lastT = event.timeStamp;
    const H = panel.offsetHeight;
    const translate = Math.min(H + 24, Math.max(0, sheetDrag.startTranslate + dy));
    panel.style.transform = "translateY(" + translate + "px)";
  });

  function endSheetDrag(event) {
    if (!sheetDrag) return;
    const drag = sheetDrag;
    sheetDrag = null;
    panel.classList.remove("dragging"); // transitions back on before the snap
    if (!drag.moved) {
      panel.style.transform = "";
      return; // a plain tap: let the click handler cycle states
    }
    sheetJustDragged = true;
    setTimeout(function () { sheetJustDragged = false; }, 80);
    const H = panel.offsetHeight;
    const heights = sheetVisibleHeights();
    // Project the release point a beat forward so a flick carries momentum.
    const projected = Math.min(H + 24, Math.max(0, currentSheetTranslate() + drag.velocity * 160));
    const visible = H - projected;
    if (visible < heights.peek / 2 && drag.velocity > 0) {
      panel.style.transform = "";
      closePanel(); // flung down past peek: dismiss
      return;
    }
    let best = "peek";
    let bestDist = Infinity;
    ["peek", "half", "full"].forEach(function (state) {
      const d = Math.abs(visible - heights[state]);
      if (d < bestDist) { bestDist = d; best = state; }
    });
    setSheet(best);
    panel.style.transform = ""; // hand position back to the state class; CSS animates the snap
    setTimeout(function () { map.invalidateSize(); }, 320);
    try {
      if (event && sheetHandle.hasPointerCapture(event.pointerId)) {
        sheetHandle.releasePointerCapture(event.pointerId);
      }
    } catch (err) { /* pointer already gone */ }
  }

  sheetHandle.addEventListener("pointerup", endSheetDrag);
  sheetHandle.addEventListener("pointercancel", endSheetDrag);

  sheetHandle.addEventListener("click", function () {
    if (sheetJustDragged) return; // the click that trails a drag is not a tap
    // Tap fallback cycles peek -> half -> full -> peek.
    setSheet(sheetState === "peek" ? "half" : sheetState === "half" ? "full" : "peek");
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && panelOpen && !document.querySelector(".leaflet-popup")) {
      closePanel();
    }
  });

  let trip = null;
  let activeId = null;
  let markersById = {};

  // ---- Mobile: collapse the spent form to a "start → end · Edit" row --------
  const tripSummary = document.getElementById("trip-summary");
  const tripSummaryText = document.getElementById("trip-summary-text");

  function collapseTripForm() {
    if (!mobileMq.matches) return;
    tripSummaryText.textContent = startLabel() + " → " + form.end.value;
    tripSummary.hidden = false;
    form.hidden = true;
  }

  function expandTripForm() {
    tripSummary.hidden = true;
    form.hidden = false;
  }

  tripSummary.addEventListener("click", function () {
    expandTripForm();
    if (mobileMq.matches) setSheet("full");
  });
  mobileMq.addEventListener("change", function () {
    if (!mobileMq.matches) {
      expandTripForm(); // desktop always shows the form
      // Desktop hides the disclosure's summary toggle, so a list left closed
      // on mobile would otherwise become unreachable after a rotate/resize.
      document.getElementById("list-disclosure").open = true;
    }
  });

  // ---- Mobile: informative peek strip ---------------------------------------
  const peekSummary = document.getElementById("peek-summary");
  const peekChip = document.getElementById("peek-chip");
  const peekMeta = document.getElementById("peek-meta");

  function updatePeekSummary() {
    const route = trip && trip.routes.find(function (r) { return r.route_id === activeId; });
    if (!route) { peekSummary.hidden = true; return; }
    peekChip.textContent = route.route_id;
    peekChip.classList.toggle("recommended", route.route_id === trip.recommended);
    const n = route.potholes.length;
    peekMeta.textContent = n + " reported · " + route.miles + " mi · " + route.minutes + " min";
    peekSummary.hidden = false;
  }

  peekSummary.addEventListener("click", function () { setSheet("half"); });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text; // textContent only: API data is never parsed as HTML
    return node;
  }

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle("error", Boolean(isError));
    statusEl.classList.toggle("busy", Boolean(message) && !isError);
  }

  function ageLabel(days) {
    if (days < 1) return "today";
    if (days < 60) return days + " days open";
    return Math.round(days / 30) + " months open";
  }

  function divIcon(className, size) {
    return L.divIcon({ className: "", html: '<div class="' + className + '"></div>', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  // ---- Philly landmark layer ------------------------------------------------
  // Tiny clickable chips for iconic spots. Clicking one offers "From here" /
  // "To here" shortcuts that fill the trip form — a fast way to start a demo.
  // L.marker lives in Leaflet's markerPane, which stacks above the canvas
  // overlayPane used by the citywide dots, so landmarks always sit on top.
  const LANDMARK_MIN_ZOOM = 11;
  const LANDMARKS = [
    { name: "City Hall", lat: 39.9526, lon: -75.1635, glyph: "\u{1F3DB}\u{FE0F}" },
    { name: "Liberty Bell", lat: 39.9496, lon: -75.1503, glyph: "\u{1F514}" },
    { name: "Philadelphia Museum of Art", lat: 39.9656, lon: -75.1810, glyph: "\u{1F3A8}" },
    { name: "LOVE Park", lat: 39.9540, lon: -75.1657, glyph: "\u{2764}\u{FE0F}" },
    { name: "Citizens Bank Park", lat: 39.9061, lon: -75.1665, glyph: "\u{26BE}" },
    { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, glyph: "\u{1F3C8}" },
    { name: "Wells Fargo Center", lat: 39.9012, lon: -75.1720, glyph: "\u{1F3C0}" },
    { name: "30th Street Station", lat: 39.9557, lon: -75.1820, glyph: "\u{1F682}" },
    { name: "Reading Terminal Market", lat: 39.9533, lon: -75.1593, glyph: "\u{1F968}" },
    { name: "Temple University", lat: 39.9812, lon: -75.1554, glyph: "\u{1F989}" },
    { name: "University of Pennsylvania", lat: 39.9522, lon: -75.1932, glyph: "\u{1F393}" },
    { name: "Boathouse Row", lat: 39.9698, lon: -75.1888, glyph: "\u{1F6A3}" },
    { name: "Philadelphia Zoo", lat: 39.9714, lon: -75.1958, glyph: "\u{1F981}" },
    { name: "Betsy Ross House", lat: 39.9524, lon: -75.1450, glyph: "\u{1F9F5}" },
    { name: "Pennovation Center", lat: 39.9418, lon: -75.1966, glyph: "\u{1F680}" },
  ];
  const landmarkLayer = L.layerGroup();

  function landmarkIcon(glyph) {
    // glyph is our own static string above, never API data.
    return L.divIcon({
      className: "",
      html: '<div class="landmark-chip">' + glyph + "</div>",
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -13],
    });
  }

  LANDMARKS.forEach(function (lm) {
    const marker = L.marker([lm.lat, lm.lon], {
      icon: landmarkIcon(lm.glyph),
      title: lm.name,
    }).addTo(landmarkLayer);
    const popup = el("div", "landmark-popup");
    popup.append(el("strong", "", lm.name));
    const actions = el("div", "landmark-actions");
    [["From here", "start"], ["To here", "end"]].forEach(function (pair) {
      const btn = el("button", "landmark-btn", pair[0]);
      btn.type = "button";
      btn.addEventListener("click", function () {
        form[pair[1]].value = lm.name + ", Philadelphia, PA";
        marker.closePopup();
        openPanel(); // the panel may be closed; bring the trip form into view
        const other = pair[1] === "start" ? form.end : form.start;
        if (other.value.trim()) button.focus();
        else other.focus();
      });
      actions.append(btn);
    });
    popup.append(actions);
    marker.bindPopup(popup);
  });

  // Landmark markers are kept off the map (owner call: the chips cluttered it).
  // The LANDMARKS list still powers instant autocomplete matches, and the layer
  // wiring stays here should the chips ever earn their way back.
  void LANDMARK_MIN_ZOOM;
  // ---------------------------------------------------------------------------

  // ---- Location autocomplete ------------------------------------------------
  // Instant landmark matches, then debounced Photon (komoot) suggestions kept
  // inside the Philly bounding box. Everything is rendered with textContent —
  // API data is never parsed as HTML.
  const AC_MIN_REMOTE = 3;
  const AC_DEBOUNCE_MS = 300;
  const AC_MAX_ITEMS = 8;
  const PHOTON_URL =
    "https://photon.komoot.io/api/?limit=5&lat=39.9526&lon=-75.1652" +
    "&bbox=-75.30,39.85,-74.94,40.15&q=";

  function inPhilly(lat, lon) {
    return lat >= 39.85 && lat <= 40.15 && lon >= -75.3 && lon <= -74.94;
  }

  function requestLocation(onDone, onError) {
    if (!navigator.geolocation) {
      onError("Location is not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        if (!inPhilly(lat, lon)) {
          onError("You appear to be outside Philadelphia — enter a Philly address instead.");
          return;
        }
        onDone(lat.toFixed(5) + ", " + lon.toFixed(5));
      },
      function () {
        onError("Could not get your location. Check the browser's location permission.");
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  }

  const LOCATE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>';

  // opts.geolocate: optional callback for a leading "Use my current location"
  // row. opts.onPick: called after a suggestion fills the input (pill flow).
  function attachAutocomplete(input, opts) {
    opts = opts || {};
    const box = el("div", "ac-list");
    box.hidden = true;
    document.body.appendChild(box);
    let items = [];
    let active = -1;
    let seq = 0;
    let timer = null;
    let loading = false;

    function position() {
      const r = input.getBoundingClientRect();
      box.style.left = r.left + "px";
      box.style.width = r.width + "px";
      if (input === pillInput && mobileMq.matches) {
        // The pill rides the bottom edge on mobile, so the list opens UPWARD,
        // anchored above the whole pill — it tracks the pill through keyboard
        // lifts because both use the same layout-viewport coordinates.
        box.style.top = "auto";
        box.style.bottom = window.innerHeight - pillForm.getBoundingClientRect().top + 8 + "px";
      } else {
        box.style.bottom = "auto";
        box.style.top = r.bottom + 4 + "px";
      }
    }

    function close() {
      box.hidden = true;
      box.classList.remove("ac-open");
      items = [];
      active = -1;
      loading = false;
      seq += 1; // ignore any in-flight Photon response
      clearTimeout(timer);
    }

    function renderList() {
      const wasHidden = box.hidden;
      box.replaceChildren();
      if (!items.length && !loading) {
        box.hidden = true;
        box.classList.remove("ac-open");
        return;
      }
      items.forEach(function (item, i) {
        const row = el("div", "ac-item" + (i === active ? " active" : "") + (item.cls ? " " + item.cls : ""));
        if (item.icon) {
          const glyph = el("span", "ac-glyph");
          glyph.insertAdjacentHTML("afterbegin", item.icon); // our own static SVG markup
          row.append(glyph);
        } else if (item.glyph) row.append(el("span", "ac-glyph", item.glyph));
        const text = el("span", "ac-text");
        text.append(el("span", "ac-label", item.label));
        if (item.sub) text.append(el("span", "ac-sub", item.sub));
        row.append(text);
        row.addEventListener("mousedown", function (event) {
          event.preventDefault(); // keep focus in the input
          pick(item);
        });
        box.append(row);
      });
      // A quiet trailing row while Photon results are still in flight — the
      // list itself (landmarks/geolocate) is already live, this just signals
      // more may be on the way instead of leaving typing feeling unanswered.
      if (loading) box.append(el("div", "ac-loading", "Searching Philly…"));
      position();
      box.hidden = false;
      if (wasHidden) {
        // Animate the open, not every keystroke's re-render, so results
        // updating mid-type never interrupts or restarts a running transition.
        box.classList.remove("ac-open");
        void box.offsetWidth; // restart the entrance animation
        box.classList.add("ac-open");
      }
    }

    function pick(item) {
      close();
      item.pick();
    }

    function choose(value) {
      input.value = value;
      if (opts.onPick) opts.onPick(value);
    }

    function localMatches(q) {
      const needle = q.toLowerCase();
      return LANDMARKS.filter(function (lm) {
        return lm.name.toLowerCase().indexOf(needle) !== -1;
      })
        .slice(0, 5)
        .map(function (lm) {
          return {
            glyph: lm.glyph,
            label: lm.name,
            sub: "Philly landmark",
            pick: function () { choose(lm.name + ", Philadelphia, PA"); },
          };
        });
    }

    function refresh() {
      const q = input.value.trim();
      let list = [];
      if (opts.geolocate) {
        list.push({
          icon: LOCATE_ICON,
          label: "Use my current location",
          pick: opts.geolocate,
        });
      }
      list = list.concat(savedMatches(q, { recents: Boolean(opts.recents), choose: choose }));
      if (q) list = list.concat(localMatches(q));
      items = list;
      active = -1;
      clearTimeout(timer);
      seq += 1;
      loading = q.length >= AC_MIN_REMOTE;
      renderList();
      if (!loading) return;
      const mySeq = seq;
      timer = setTimeout(function () {
        fetch(PHOTON_URL + encodeURIComponent(q))
          .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("photon " + r.status)); })
          .then(function (data) {
            if (mySeq !== seq || document.activeElement !== input) return;
            loading = false;
            const seen = {};
            items.forEach(function (i) { seen[i.label + "|" + (i.sub || "")] = true; });
            (data.features || []).forEach(function (f) {
              if (items.length >= AC_MAX_ITEMS) return;
              const c = f.geometry && f.geometry.coordinates;
              const p = f.properties || {};
              if (!c || !inPhilly(c[1], c[0])) return;
              // The bbox rectangle clips a corner of New Jersey; drop anything
              // whose named city is not Philadelphia.
              if (typeof p.city === "string" && p.city && !/philadelphia/i.test(p.city)) return;
              if (typeof p.state === "string" && /new jersey/i.test(p.state)) return;
              let label = typeof p.name === "string" && p.name ? p.name : "";
              if (!label && typeof p.street === "string" && p.street) {
                label = (typeof p.housenumber === "string" && p.housenumber ? p.housenumber + " " : "") + p.street;
              }
              if (!label) return;
              const sub = [p.district, p.city || "Philadelphia", p.postcode]
                .filter(function (x) { return typeof x === "string" && x; })
                .join(", ");
              const key = label + "|" + sub;
              if (seen[key]) return;
              seen[key] = true;
              items.push({
                label: label,
                sub: sub,
                pick: function () {
                  const cityHint = /philadelphia|phila/i.test(label) ? "" : ", Philadelphia, PA";
                  choose(label + cityHint);
                },
              });
            });
            renderList();
          })
          .catch(function () {
            if (mySeq !== seq) return;
            loading = false;
            renderList(); // landmarks-only is still a working autocomplete
          });
      }, AC_DEBOUNCE_MS);
    }

    input.addEventListener("input", refresh);
    input.addEventListener("focus", refresh);
    input.addEventListener("blur", function () { setTimeout(close, 120); });
    input.addEventListener("keydown", function (event) {
      if (box.hidden) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        active = (active + 1) % items.length;
        renderList();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        active = (active - 1 + items.length) % items.length;
        renderList();
      } else if (event.key === "Enter") {
        if (active >= 0) {
          event.preventDefault();
          pick(items[active]);
        } else {
          close(); // fall through to the normal form submit
        }
      } else if (event.key === "Escape") {
        event.stopPropagation(); // don't also close the panel
        close();
      }
    });
    window.addEventListener("resize", function () { if (!box.hidden) position(); });
    if (window.visualViewport) {
      // Keep the dropdown pinned under its input while the mobile keyboard
      // opens/closes or the visual viewport pans.
      window.visualViewport.addEventListener("resize", function () { if (!box.hidden) position(); });
      window.visualViewport.addEventListener("scroll", function () { if (!box.hidden) position(); });
    }
  }
  // ---------------------------------------------------------------------------

  function drawMap() {
    layers.clearLayers();
    markersById = {};
    const ordered = trip.routes.slice().sort((a, b) => (a.route_id === activeId) - (b.route_id === activeId));
    ordered.forEach(function (route) {
      const isActive = route.route_id === activeId;
      const latlngs = route.coordinates.map((c) => [c[1], c[0]]);
      const line = L.polyline(latlngs, {
        color: route.route_id === trip.recommended ? COLORS.recommended : COLORS.other,
        weight: isActive ? 7 : 4,
        opacity: isActive ? 0.95 : 0.6,
      }).addTo(layers);
      line.on("click", () => selectRoute(route.route_id));
      if (isActive) map.fitBounds(line.getBounds(), fitPadding());
    });

    const active = trip.routes.find((r) => r.route_id === activeId);
    active.potholes.forEach(function (p) {
      const old = p.days_open >= OLD_REPORT_DAYS;
      const marker = L.marker([p.lat, p.lon], { icon: divIcon("pothole-marker" + (old ? " old" : ""), 22) }).addTo(layers);
      const popup = el("div");
      popup.append(el("strong", "", p.address), el("br"), document.createTextNode("Reported " + p.reported + " (" + ageLabel(p.days_open) + ")"), el("br"), document.createTextNode("Mile " + p.mile_marker + " of this route"));
      marker.bindPopup(popup);
      markersById[p.id] = marker;
    });

    [trip.start, trip.end].forEach(function (place) {
      if (place) L.marker([place.lat, place.lon], { icon: divIcon("endpoint-marker", 16) }).bindPopup(place.matched_address).addTo(layers);
    });
  }

  function kindLabel(route) {
    if (route.kind === "smooth") return "Smoothest";
    const fastest = trip.routes.filter((r) => r.kind === "fast").sort((a, b) => a.minutes - b.minutes)[0];
    return fastest && fastest.route_id === route.route_id ? "Fastest" : "Alternative";
  }

  function drawComparison() {
    const box = document.getElementById("comparison");
    const c = trip.comparison;
    if (!c || c.reports_avoided <= 0) { box.hidden = true; box.textContent = ""; return; }
    const n = c.reports_avoided;
    let cost;
    if (c.extra_minutes > 0) cost = "for about " + c.extra_minutes + " extra minute" + (c.extra_minutes === 1 ? "" : "s");
    else if (c.extra_minutes < 0) cost = "and is " + (-c.extra_minutes) + " minute" + (c.extra_minutes === -1 ? "" : "s") + " faster";
    else cost = "for no extra time";
    box.replaceChildren(
      el("b", "", "Avoids " + n + " reported pothole" + (n === 1 ? "" : "s")),
      document.createTextNode(" " + cost + " versus the fastest route (" + c.against + ")" +
        (c.extra_miles > 0 ? ", " + c.extra_miles + " mi longer." : "."))
    );
    box.hidden = false;
  }

  function drawDirections() {
    const active = trip.routes.find((r) => r.route_id === activeId);
    const details = document.getElementById("directions");
    const list = document.getElementById("directions-list");
    list.replaceChildren();
    const steps = active.steps || [];
    if (!steps.length) { details.hidden = true; return; }
    details.hidden = false;
    document.getElementById("directions-summary").textContent =
      "Turn-by-turn for route " + active.route_id + " (" + steps.length + " steps)";
    steps.forEach(function (step) {
      const item = el("li");
      item.append(el("span", "dir-text", step.text));
      if (step.miles >= 0.05) item.append(el("span", "dir-dist", step.miles + " mi"));
      list.append(item);
    });
  }

  function mapsUrl(route) {
    // Google Maps URL API: origin/destination plus up to 8 via points so the
    // real nav app drives the same smooth route. Coordinates only, no text.
    if (!trip.start || !trip.end) return "";
    const fmt = (p) => p.lat.toFixed(5) + "," + p.lon.toFixed(5);
    let url = "https://www.google.com/maps/dir/?api=1&travelmode=driving" +
      "&origin=" + fmt(trip.start) + "&destination=" + fmt(trip.end);
    const via = (route.via || []).slice(0, 8).map(fmt);
    if (via.length) url += "&waypoints=" + encodeURIComponent(via.join("|"));
    return url;
  }

  function drawActions() {
    const active = trip.routes.find((r) => r.route_id === activeId);
    const link = document.getElementById("open-maps");
    link.href = mapsUrl(active);
    link.textContent = active.kind === "smooth" ? "Drive this in Google Maps" : "Open in Google Maps";
  }

  // Shareable URLs: /?from=...&to=...&avoid=strong re-runs the same trip.
  function updateUrl(start, end, avoid) {
    const params = new URLSearchParams();
    if (start) params.set("from", start);
    params.set("to", end);
    if (avoid && avoid !== "balanced") params.set("avoid", avoid);
    history.replaceState(null, "", "?" + params.toString());
  }

  document.getElementById("share").addEventListener("click", function () {
    const url = location.href;
    const done = function () { setStatus("Link copied. Anyone can open it to see this trip."); setTimeout(function () { setStatus(""); }, 2500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { setStatus(url); });
    } else {
      setStatus(url);
    }
  });

  function drawRouteSigns() {
    const box = document.getElementById("routes");
    box.replaceChildren();
    trip.routes.forEach(function (route) {
      const sign = el("button", "route-sign");
      sign.type = "button";
      if (route.route_id === trip.recommended) sign.classList.add("recommended");
      if (route.route_id === activeId) sign.classList.add("active");
      sign.setAttribute("aria-pressed", String(route.route_id === activeId));

      const meta = el("span", "route-meta");
      const title = el("strong", "", kindLabel(route));
      if (route.route_id === trip.recommended) title.append(el("span", "route-badge", "Recommended"));
      meta.append(title, document.createTextNode(route.miles + " mi, about " + route.minutes + " min"));
      const count = el("span", "route-count");
      count.append(el("b", "", String(route.potholes.length)), document.createTextNode("reported"));
      sign.append(el("span", "route-letter", route.route_id), meta, count);
      if (route.kind === "smooth") sign.classList.add("smooth");
      sign.addEventListener("click", () => selectRoute(route.route_id));
      box.append(sign);
    });
  }

  function drawPotholeList() {
    const active = trip.routes.find((r) => r.route_id === activeId);
    const n = active.potholes.length;
    document.getElementById("list-title").textContent = n
      ? "Along route " + active.route_id + ", in driving order"
      : "No open reports along route " + active.route_id;
    // Mobile shows the list under a disclosure; its collapsed-by-default state
    // is set once per trip in render(), so route taps here never slam a
    // user-opened list shut.
    document.getElementById("list-summary").textContent = n
      ? n + " report" + (n === 1 ? "" : "s") + " along Route " + active.route_id
      : "No open reports along Route " + active.route_id;
    const list = document.getElementById("pothole-list");
    list.replaceChildren();
    active.potholes.forEach(function (p) {
      const item = el("li");
      const age = el("span", "age" + (p.days_open >= OLD_REPORT_DAYS ? " old" : ""), ageLabel(p.days_open));
      item.append(el("span", "mile", "mi " + p.mile_marker), el("span", "", p.address), age);
      item.addEventListener("click", function () {
        const marker = markersById[p.id];
        if (marker) { map.setView(marker.getLatLng(), 17); marker.openPopup(); }
      });
      list.append(item);
    });
  }

  function describeStep(event) {
    switch (event.type) {
      case "thought": return event.text;
      case "question": return null;
      case "tool_call":
        if (event.input && typeof event.input.query === "string") {
          return "Ran SQL (" + event.tool + "): " + event.input.query;
        }
        return describeToolCall(event.tool, event.input || {});
      case "tool_error": return "Error from " + event.tool + ": " + event.preview;
      case "usage": return null;
      case "agent_unavailable": return "Planned with the built-in route picker.";
      case "fallback": return event.text;
      case "final": return null;
      default: return null;
    }
  }

  function describeToolCall(tool, input) {
    switch (tool) {
      case "geocode_address": return "Looked up \u201c" + input.address + "\u201d as the " + (input.role || "place");
      case "find_routes": return "Fetched the fastest driving routes and alternatives";
      case "find_smooth_route": return "Planned a smooth route with every open pothole report as a street penalty";
      case "scan_route": return "Scanned route " + input.route_id + " against the city\u2019s 311 data";
      case "recommend_route": return "Recommended route " + input.route_id + (input.reason ? ": " + input.reason : "");
      default: return "Called " + tool + " " + JSON.stringify(input);
    }
  }

  function drawSteps() {
    const list = document.getElementById("steps");
    list.replaceChildren();
    trip.steps.forEach(function (event) {
      const text = describeStep(event);
      if (text) list.append(el("li", event.type === "tool_error" ? "error" : "", text));
    });
    document.getElementById("activity").hidden = trip.steps.length === 0;
  }

  function selectRoute(routeId) {
    activeId = routeId;
    drawMap();
    drawRouteSigns();
    drawPotholeList();
    drawDirections();
    drawActions();
    updatePeekSummary();
  }

  function render(data) {
    trip = data;
    const briefing = document.getElementById("briefing");
    briefing.replaceChildren(document.createTextNode(data.briefing));
    briefing.append(el("span", "mode", "Based on open 311 reports from the last 12 months."));
    drawComparison();
    drawSteps();
    recordRecent(startMode === "custom" ? form.start.value.trim() : null, form.end.value.trim());
    results.classList.add("fresh"); // cards cascade in once; route taps re-render silently
    clearTimeout(render.freshTimer);
    render.freshTimer = setTimeout(function () { results.classList.remove("fresh"); }, 900);
    // Fresh trip: mobile starts the report list collapsed, desktop open (its
    // summary toggle is hidden). Set once here, not on every route tap.
    document.getElementById("list-disclosure").open = !mobileMq.matches;
    results.hidden = false;
    hideCitywide(); // trip results are the hero; the citywide dots would be noise
    if (mobileMq.matches && panelOpen) {
      collapseTripForm(); // the spent form folds to a "start → end · Edit" row
      setSheet("half"); // routes + map together
      // Route signs now lead the results, so the top of the sheet IS the
      // answer: just rewind the scroller.
      panel.querySelector(".panel-scroll").scrollTop = 0;
    }
    selectRoute(data.recommended);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!form.end.value.trim()) { setStatus("Enter a destination.", true); form.end.focus(); return; }
    resolveStart(runTrip);
  });

  function runTrip(startValue) {
    button.disabled = true;
    if (mobileMq.matches && panelOpen) {
      // Drop the sheet to half so the map and the live planning steps share the
      // screen, and dismiss the keyboard so it doesn't cover either. The form
      // folds to its summary row so the ticker starts near the top.
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      collapseTripForm();
      setSheet("half");
    }
    setStatus("Looking up addresses, routes, and open pothole reports.");
    results.hidden = true;
    showCitywide(); // a new search starts fresh: bring back the citywide dots
    const live = document.getElementById("live");
    const liveList = document.getElementById("live-steps");
    liveList.replaceChildren();
    live.hidden = false;

    const avoid = form.avoid.value === "strong" ? "strong" : "balanced";
    updateUrl(startMode === "custom" ? startValue : null, form.end.value, avoid);
    const source = new EventSource(
      "/api/trip/stream?start=" + encodeURIComponent(startValue) +
      "&end=" + encodeURIComponent(form.end.value) + "&avoid=" + avoid
    );
    function finish() {
      source.close();
      live.hidden = true;
      button.disabled = false;
    }
    source.addEventListener("step", function (e) {
      const step = JSON.parse(e.data);
      const text = describeStep(step);
      if (text) {
        liveList.append(el("li", step.type === "tool_error" ? "error" : "", text));
        liveList.lastChild.scrollIntoView({ block: "nearest" });
      }
    });
    source.addEventListener("result", function (e) {
      finish();
      setStatus("");
      render(JSON.parse(e.data));
    });
    function tripFailed(message) {
      finish();
      expandTripForm(); // let the user fix the inputs right away
      // The failed run is the current state: drop the previous trip so the
      // peek strip can't advertise a result that contradicts the error.
      trip = null;
      activeId = null;
      updatePeekSummary();
      setStatus(message, true);
    }
    source.addEventListener("trip_error", function (e) {
      tripFailed(JSON.parse(e.data).error || "Something went wrong.");
    });
    source.onerror = function () { // connection-level failure (e.g. bad input, server down)
      tripFailed("Could not plan the trip. Check the addresses and try again.");
    };
  }

  // ---- Live navigation --------------------------------------------------------
  // Follows the device's position along the active route like Google Maps or
  // Waze: a maneuver banner with distance, voice guidance, a warning for each
  // reported pothole ahead, and a fresh smooth route from /api/navigate when
  // the driver leaves the route. "Preview drive" replays the route without GPS
  // through the exact same code path, so the whole flow is testable at a desk.
  const NAV_ZOOM = 17;
  const OFF_ROUTE_M = 45;        // further than this from the line counts as off route
  const OFF_ROUTE_FIXES = 2;     // consecutive off-route fixes before re-routing
  const REROUTE_MIN_GAP_MS = 8000;
  const ARRIVE_M = 30;
  const STEP_DONE_M = 18;        // a maneuver this close behind is considered done
  const ANNOUNCE_NEAR_M = 120;
  const POTHOLE_AHEAD_M = 160;
  const M_PER_DEG_LAT = 111132;
  const M_PER_DEG_LON = 111320 * Math.cos((40 * Math.PI) / 180);

  const nav = {
    active: false, route: null, dest: null, watchId: null, puck: null, layer: L.layerGroup(),
    pts: [], cum: [], total: 0, steps: [], potholes: [], stepIdx: -1, offCount: 0,
    lastReroute: 0, rerouting: false, spoken: {}, sim: null, muted: false, wakeLock: null,
    lastFix: null, heading: 0, alertTimer: null,
  };
  const navEl = document.getElementById("nav");
  const navArrow = document.getElementById("nav-arrow");
  const navDistance = document.getElementById("nav-distance");
  const navInstruction = document.getElementById("nav-instruction");
  const navNext = document.getElementById("nav-next");
  const navAlert = document.getElementById("nav-alert");
  const navEta = document.getElementById("nav-eta");
  const navRemaining = document.getElementById("nav-remaining");
  const ARROWS = {
    left: "↰", right: "↱", "slight left": "↖", "slight right": "↗",
    "sharp left": "↰", "sharp right": "↱", uturn: "↩", straight: "↑",
    arrive: "⚑", "": "↑",
  };

  function toXY(lat, lon) { return { x: lon * M_PER_DEG_LON, y: lat * M_PER_DEG_LAT }; }

  function prepareNavRoute(route) {
    // Project the polyline once; every GPS fix then snaps against it.
    nav.route = route;
    nav.pts = route.coordinates.map((c) => toXY(c[1], c[0]));
    nav.cum = [0];
    for (let i = 1; i < nav.pts.length; i++) {
      nav.cum.push(nav.cum[i - 1] + Math.hypot(nav.pts[i].x - nav.pts[i - 1].x, nav.pts[i].y - nav.pts[i - 1].y));
    }
    nav.total = nav.cum[nav.cum.length - 1] || 0;
    nav.steps = (route.steps || []).map(function (step) {
      const at = step.location ? snapToRoute(step.location[1], step.location[0]).along : null;
      return { text: step.text, modifier: step.modifier || "", along: at };
    }).filter((s) => s.along !== null);
    nav.potholes = (route.potholes || []).map(function (p) {
      const snap = snapToRoute(p.lat, p.lon);
      return { id: p.id, along: snap.along, address: p.address, announced: false };
    });
    nav.stepIdx = -1;
    nav.spoken = {};
    nav.offCount = 0;
    drawNavRoute();
  }

  function snapToRoute(lat, lon) {
    // Nearest point on the polyline: {dist (m off route), along (m from start)}.
    const p = toXY(lat, lon);
    let best = { dist: Infinity, along: 0, seg: 0 };
    for (let i = 1; i < nav.pts.length; i++) {
      const a = nav.pts[i - 1], b = nav.pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (d < best.dist) best = { dist: d, along: nav.cum[i - 1] + t * Math.sqrt(len2), seg: i - 1 };
    }
    return best;
  }

  function drawNavRoute() {
    nav.layer.clearLayers();
    const latlngs = nav.route.coordinates.map((c) => [c[1], c[0]]);
    L.polyline(latlngs, { color: COLORS.recommended, weight: 8, opacity: 0.9 }).addTo(nav.layer);
    (nav.route.potholes || []).forEach(function (p) {
      const old = p.days_open >= OLD_REPORT_DAYS;
      L.marker([p.lat, p.lon], { icon: divIcon("pothole-marker" + (old ? " old" : ""), 20), interactive: false }).addTo(nav.layer);
    });
    if (nav.dest) L.marker([nav.dest.lat, nav.dest.lon], { icon: divIcon("endpoint-marker", 16), interactive: false }).addTo(nav.layer);
    if (!nav.puck) {
      nav.puck = L.marker(latlngs[0], {
        icon: L.divIcon({ className: "", html: puckHtml(), iconSize: [34, 48], iconAnchor: [17, 24] }),
        interactive: false, zIndexOffset: 1000,
      });
    }
    nav.myReports.addTo(nav.layer);
    nav.puck.addTo(nav.layer);
  }

  function fmtDistance(m) {
    if (settings.units === "metric") {
      if (m < 1000) return Math.max(0, Math.round(m / 50) * 50) + " m";
      return (m / 1000).toFixed(1) + " km";
    }
    const feet = m * 3.28084;
    if (feet < 1000) return Math.max(0, Math.round(feet / 50) * 50) + " ft";
    return (m / 1609.344).toFixed(1) + " mi";
  }

  function spokenDistance(m) {
    return fmtDistance(m).replace(/ mi$/, " miles").replace(/ ft$/, " feet").replace(/ km$/, " kilometers").replace(/ m$/, " meters");
  }

  function speak(text, key) {
    if (key) { if (nav.spoken[key]) return; nav.spoken[key] = true; }
    if (nav.muted || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = settings.rate || 1;
      const chosen = settings.voice && englishVoices().find(function (v) { return v.name === settings.voice; });
      if (chosen) utterance.voice = chosen;
      window.speechSynthesis.speak(utterance);
    } catch (err) { /* voice is a bonus, never a blocker */ }
  }

  function showAlert(text, kind, ms) {
    navAlert.textContent = text;
    navAlert.className = "nav-alert" + (kind ? " " + kind : "");
    navAlert.hidden = false;
    clearTimeout(nav.alertTimer);
    if (ms) nav.alertTimer = setTimeout(function () { navAlert.hidden = true; }, ms);
  }

  function updateBanner(along) {
    // The current maneuver is the first one still ahead of the driver.
    let idx = nav.steps.findIndex((s) => s.along > along - STEP_DONE_M);
    if (idx === -1) idx = nav.steps.length - 1;
    const step = nav.steps[idx];
    if (!step) return;
    const toGo = Math.max(0, step.along - along);
    if (idx !== nav.stepIdx) {
      nav.stepIdx = idx;
      if (toGo > ANNOUNCE_NEAR_M) speak("In " + spokenDistance(toGo) + ", " + step.text, "start-" + idx);
    }
    if (toGo <= ANNOUNCE_NEAR_M && !nav.spoken["near-" + idx]) {
      speak(step.text, "near-" + idx);
      if (navigator.vibrate) navigator.vibrate([80, 40, 80]); // a nudge at the wheel, like Waze
    }
    navArrow.textContent = ARROWS[step.modifier] || ARROWS[""];
    navDistance.textContent = toGo < 15 ? "Now" : "In " + fmtDistance(toGo);
    navInstruction.textContent = step.text;
    const next = nav.steps[idx + 1];
    navNext.hidden = !next;
    if (next) navNext.textContent = "Then " + next.text.charAt(0).toLowerCase() + next.text.slice(1);

    const remaining = Math.max(0, nav.total - along);
    const minutes = nav.total ? Math.max(1, Math.round((remaining / nav.total) * nav.route.minutes)) : 0;
    const eta = new Date(Date.now() + minutes * 60000);
    navEta.textContent = eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    navRemaining.textContent = minutes + " min \u2022 " + fmtDistance(remaining).replace(/^0 (ft|m)$/, "0 $1") +
      (nav.route.kind === "smooth" ? " \u2022 smooth route" : "");
    navProgress.style.width = (nav.total ? Math.min(100, (along / nav.total) * 100) : 0).toFixed(1) + "%";

    // Reported potholes just ahead get a heads-up, once each.
    nav.potholes.forEach(function (p) {
      if (p.announced || p.along < along - 5 || p.along > along + POTHOLE_AHEAD_M) return;
      p.announced = true;
      showAlert("Reported pothole ahead \u2022 " + fmtDistance(Math.max(0, p.along - along)), "", 6000);
      speak("Reported pothole ahead", "pothole-" + p.id);
    });
  }

  function onPosition(lat, lon, heading, speedMps) {
    if (!nav.active) return;
    if (typeof speedMps === "number" && !isNaN(speedMps) && speedMps >= 0) updateSpeedo(speedMps);
    else if (nav.lastFix && nav.lastFixAt) {
      const a = toXY(nav.lastFix.lat, nav.lastFix.lon), b = toXY(lat, lon);
      const dt = (Date.now() - nav.lastFixAt) / 1000;
      if (dt > 0.2) updateSpeedo(0.6 * nav.speedMps + 0.4 * (Math.hypot(b.x - a.x, b.y - a.y) / dt));
    }
    nav.lastFixAt = Date.now();
    if (typeof heading === "number" && !isNaN(heading)) nav.heading = heading;
    else if (nav.lastFix) {
      const a = toXY(nav.lastFix.lat, nav.lastFix.lon), b = toXY(lat, lon);
      if (Math.hypot(b.x - a.x, b.y - a.y) > 3) nav.heading = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    }
    nav.lastFix = { lat: lat, lon: lon };
    nav.puck.setLatLng([lat, lon]);
    const puckEl = nav.puck.getElement() && nav.puck.getElement().querySelector(".nav-puck");
    if (puckEl) puckEl.style.transform = "rotate(" + Math.round(nav.heading) + "deg)";
    if (nav.following) map.setView([lat, lon], Math.max(map.getZoom(), NAV_ZOOM), { animate: true, duration: 0.4 });

    const toDest = toXY(nav.dest.lat, nav.dest.lon), here = toXY(lat, lon);
    if (Math.hypot(toDest.x - here.x, toDest.y - here.y) <= ARRIVE_M) { arrive(); return; }

    const snap = snapToRoute(lat, lon);
    if (snap.dist > OFF_ROUTE_M) {
      nav.offCount += 1;
      if (nav.offCount >= OFF_ROUTE_FIXES && !nav.rerouting && Date.now() - nav.lastReroute > REROUTE_MIN_GAP_MS) {
        reroute(lat, lon);
      }
      return; // keep the last banner until the new route arrives
    }
    nav.offCount = 0;
    updateBanner(snap.along);
  }

  function reroute(lat, lon) {
    nav.rerouting = true;
    nav.lastReroute = Date.now();
    showAlert("Re-routing around the potholes…", "reroute");
    speak("Re-routing");
    const avoid = form.avoid.value === "strong" ? "strong" : "balanced";
    fetch("/api/navigate?from=" + lat.toFixed(6) + "," + lon.toFixed(6) +
          "&to=" + nav.dest.lat.toFixed(6) + "," + nav.dest.lon.toFixed(6) + "&avoid=" + avoid)
      .then((r) => r.json().then((data) => ({ ok: r.ok, data: data })))
      .then(function (res) {
        nav.rerouting = false;
        if (!nav.active) return;
        if (!res.ok || !res.data.coordinates) throw new Error(res.data.error || "re-route failed");
        prepareNavRoute(res.data);
        navAlert.hidden = true;
        const n = (res.data.potholes || []).length;
        showAlert("New route: " + n + " reported pothole" + (n === 1 ? "" : "s") + " ahead", "reroute", 4000);
        if (nav.sim) nav.sim.restartFrom(lat, lon);
        updateBanner(snapToRoute(lat, lon).along);
      })
      .catch(function (err) {
        nav.rerouting = false;
        nav.offCount = 0; // try again after the next few fixes
        showAlert(String(err.message || err), "error", 5000);
      });
  }

  function arrive() {
    navArrow.textContent = ARROWS.arrive;
    navDistance.textContent = "Arrived";
    navInstruction.textContent = "You have reached your destination.";
    navNext.hidden = true;
    speak("You have arrived at your destination", "arrived");
    stopSim();
    setTimeout(stopNavigation, 4000);
  }

  function startNavigation(simulate) {
    const route = trip.routes.find((r) => r.route_id === activeId);
    if (!route || !trip.end) return;
    nav.active = true;
    nav.dest = { lat: trip.end.lat, lon: trip.end.lon };
    nav.muted = false;
    setMuteLabel();
    nav.following = true;
    nav.limitMph = null;
    nav.lastFixAt = 0;
    navRecenter.hidden = true;
    closeSheets();
    loadMyReports();
    updateSpeedo(0);
    document.getElementById("speedo").querySelector("span").textContent = settings.units === "metric" ? "km/h" : "mph";
    document.body.classList.add("navigating");
    applyNight();
    nav.nightTimer = setInterval(applyNight, 60000);
    nav.limitTimer = setInterval(pollRoad, 4000);
    closePanel();
    hideCitywide();
    layers.clearLayers();
    nav.layer.addTo(map);
    prepareNavRoute(route);
    navEl.hidden = false;
    navAlert.hidden = true;
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request("screen").then(function (lock) { nav.wakeLock = lock; }).catch(function () {});
    }
    speak("Starting navigation on the " + (route.kind === "smooth" ? "smooth" : "fastest") + " route");
    if (simulate) { startSim(); return; }
    if (!navigator.geolocation) {
      showAlert("Location is not available here. Showing a preview instead.", "error", 5000);
      startSim();
      return;
    }
    nav.watchId = navigator.geolocation.watchPosition(
      function (pos) { onPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed); },
      function () { showAlert("Waiting for a GPS fix… check location permission.", "error", 6000); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  function stopNavigation() {
    if (!nav.active) return;
    nav.active = false;
    stopSim();
    if (nav.watchId !== null) { navigator.geolocation.clearWatch(nav.watchId); nav.watchId = null; }
    if (nav.wakeLock) { nav.wakeLock.release().catch(function () {}); nav.wakeLock = null; }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    clearInterval(nav.limitTimer);
    clearInterval(nav.nightTimer);
    [navMenu, navAlts, navScrim].forEach(function (e) { e.classList.remove("closing"); e.hidden = true; });
    document.getElementById("nav-menu-open").setAttribute("aria-expanded", "false");
    navRecenter.hidden = true;
    navEl.hidden = true;
    document.body.classList.remove("navigating", "night");
    map.removeLayer(nav.layer);
    nav.layer.clearLayers();
    nav.puck = null;
    if (trip) { openPanel(); selectRoute(activeId); }
  }

  // Preview: glide along the route at ~25 mph, feeding the same onPosition().
  function startSim() {
    stopSim();
    const sim = { along: 0, timer: null, speed: 11, restartFrom: null };
    sim.restartFrom = function (lat, lon) { sim.along = snapToRoute(lat, lon).along; };
    sim.timer = setInterval(function () {
      if (!nav.active || nav.rerouting) return;
      sim.along = Math.min(nav.total, sim.along + sim.speed * 0.5);
      const p = pointAlong(sim.along);
      onPosition(p[0], p[1], null, sim.speed);
      if (sim.along >= nav.total) stopSim();
    }, 500);
    nav.sim = sim;
  }

  function stopSim() {
    if (nav.sim) { clearInterval(nav.sim.timer); nav.sim = null; }
  }

  function pointAlong(along) {
    const coords = nav.route.coordinates;
    for (let i = 1; i < nav.cum.length; i++) {
      if (nav.cum[i] >= along) {
        const span = nav.cum[i] - nav.cum[i - 1] || 1;
        const t = (along - nav.cum[i - 1]) / span;
        return [coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]), coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0])];
      }
    }
    const last = coords[coords.length - 1];
    return [last[1], last[0]];
  }


  // ---- Settings: vehicle, voice, display ---------------------------------------
  // Persisted in localStorage so the car you picked is the car you see next trip.
  const SETTINGS_KEY = "pj.settings";
  const DEFAULT_SETTINGS = { vehicle: "car", color: "#f5c518", voice: "", rate: 1, night: "auto", units: "us" };
  const VEHICLE_COLORS = ["#f5c518", "#e8590c", "#c62828", "#1e88e5", "#2e7d32", "#f7f6f2", "#26282b", "#8e24aa"];
  // Top-down silhouettes, nose up, body in currentColor so the colour swatch applies.
  const GLASS = "#cfe8ff", DARK = "#1b1c1e";
  const VEHICLES = {
    car: { name: "Car", svg: '<rect x="4" y="12" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="26" y="12" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="4" y="31" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="26" y="31" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="6" y="3" width="22" height="42" rx="8" fill="currentColor"/><path d="M9 16 q8 -5 16 0 v6 h-16z" fill="' + GLASS + '"/><path d="M9 36 q8 4 16 0 v-6 h-16z" fill="' + GLASS + '"/><rect x="10" y="22" width="14" height="8" rx="2" fill="rgba(0,0,0,0.12)"/>' },
    suv: { name: "SUV", svg: '<rect x="3" y="11" width="5" height="10" rx="1.5" fill="' + DARK + '"/><rect x="26" y="11" width="5" height="10" rx="1.5" fill="' + DARK + '"/><rect x="3" y="31" width="5" height="10" rx="1.5" fill="' + DARK + '"/><rect x="26" y="31" width="5" height="10" rx="1.5" fill="' + DARK + '"/><rect x="5" y="2" width="24" height="44" rx="5" fill="currentColor"/><path d="M8 14 q9 -4 18 0 v7 h-18z" fill="' + GLASS + '"/><rect x="8" y="23" width="18" height="10" rx="2" fill="rgba(0,0,0,0.12)"/><path d="M8 40 q9 3 18 0 v-6 h-18z" fill="' + GLASS + '"/>' },
    pickup: { name: "Pickup", svg: '<rect x="3" y="11" width="5" height="10" rx="1.5" fill="' + DARK + '"/><rect x="26" y="11" width="5" height="10" rx="1.5" fill="' + DARK + '"/><rect x="3" y="32" width="5" height="10" rx="1.5" fill="' + DARK + '"/><rect x="26" y="32" width="5" height="10" rx="1.5" fill="' + DARK + '"/><rect x="5" y="2" width="24" height="44" rx="4" fill="currentColor"/><path d="M8 13 q9 -4 18 0 v7 h-18z" fill="' + GLASS + '"/><rect x="8" y="24" width="18" height="19" rx="2" fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.35)"/>' },
    taxi: { name: "Taxi", svg: '<rect x="4" y="12" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="26" y="12" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="4" y="31" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="26" y="31" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="6" y="3" width="22" height="42" rx="8" fill="currentColor"/><path d="M9 16 q8 -5 16 0 v6 h-16z" fill="' + GLASS + '"/><path d="M9 36 q8 4 16 0 v-6 h-16z" fill="' + GLASS + '"/><rect x="11" y="23" width="12" height="5" rx="1" fill="' + DARK + '"/><rect x="13" y="24" width="2" height="3" fill="#fff"/><rect x="16" y="24" width="2" height="3" fill="#fff"/><rect x="19" y="24" width="2" height="3" fill="#fff"/>' },
    bus: { name: "Bus", svg: '<rect x="3" y="9" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="27" y="9" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="3" y="34" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="27" y="34" width="4" height="9" rx="1.5" fill="' + DARK + '"/><rect x="5" y="1" width="24" height="46" rx="3" fill="currentColor"/><rect x="7" y="4" width="20" height="7" rx="1.5" fill="' + GLASS + '"/><rect x="7" y="13" width="20" height="26" rx="1.5" fill="rgba(0,0,0,0.15)"/><rect x="7" y="41" width="20" height="4" rx="1" fill="' + GLASS + '"/>' },
    moto: { name: "Motorcycle", svg: '<rect x="14" y="2" width="6" height="12" rx="3" fill="' + DARK + '"/><rect x="14" y="34" width="6" height="12" rx="3" fill="' + DARK + '"/><rect x="4" y="11" width="26" height="3" rx="1.5" fill="' + DARK + '"/><rect x="11" y="12" width="12" height="24" rx="5" fill="currentColor"/><ellipse cx="17" cy="16" rx="4" ry="3" fill="' + GLASS + '"/><rect x="13" y="22" width="8" height="10" rx="3" fill="rgba(0,0,0,0.25)"/>' },
    bike: { name: "Bicycle", svg: '<rect x="15" y="1" width="4" height="13" rx="2" fill="' + DARK + '"/><rect x="15" y="34" width="4" height="13" rx="2" fill="' + DARK + '"/><rect x="5" y="9" width="24" height="2.5" rx="1" fill="' + DARK + '"/><rect x="15.5" y="12" width="3" height="24" fill="currentColor"/><rect x="11" y="24" width="12" height="4" rx="2" fill="currentColor"/><ellipse cx="17" cy="21" rx="4.5" ry="3" fill="currentColor"/>' },
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch (err) { /* fresh defaults */ }
  if (!VEHICLES[settings.vehicle]) settings.vehicle = "car";
  if (VEHICLE_COLORS.indexOf(settings.color) === -1) settings.color = DEFAULT_SETTINGS.color;

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (err) { /* private mode */ }
  }

  function vehicleSvg(id, color) {
    const v = VEHICLES[id] || VEHICLES.car;
    return '<svg viewBox="0 0 34 48" aria-hidden="true" style="color:' + color + '">' + v.svg + "</svg>";
  }

  function puckHtml() {
    return '<div class="nav-puck vehicle">' + vehicleSvg(settings.vehicle, settings.color) + "</div>";
  }

  const settingsDialog = document.getElementById("settings");
  const vehicleGrid = document.getElementById("vehicle-grid");
  const colorRow = document.getElementById("color-row");
  const voiceSelect = document.getElementById("voice-select");
  const voiceRate = document.getElementById("voice-rate");
  const nightSelect = document.getElementById("night-select");
  const unitsSelect = document.getElementById("units-select");

  Object.keys(VEHICLES).forEach(function (id) {
    const label = el("label", "vehicle-opt");
    const input = document.createElement("input");
    input.type = "radio"; input.name = "vehicle"; input.value = id; input.checked = id === settings.vehicle;
    const face = el("span");
    face.insertAdjacentHTML("afterbegin", vehicleSvg(id, settings.color)); // our own static markup, never API data
    face.append(document.createTextNode(VEHICLES[id].name));
    label.append(input, face);
    input.addEventListener("change", function () { settings.vehicle = id; saveSettings(); applyVehicle(); });
    vehicleGrid.append(label);
  });
  VEHICLE_COLORS.forEach(function (color) {
    const label = el("label", "color-opt");
    label.title = color;
    const input = document.createElement("input");
    input.type = "radio"; input.name = "color"; input.value = color; input.checked = color === settings.color;
    const swatch = el("span"); swatch.style.background = color;
    label.append(input, swatch);
    input.addEventListener("change", function () { settings.color = color; saveSettings(); applyVehicle(); });
    colorRow.append(label);
  });

  function applyVehicle() {
    vehicleGrid.querySelectorAll("svg").forEach(function (svg) { svg.style.color = settings.color; });
    if (nav.puck && nav.puck.getElement()) {
      const wrap = nav.puck.getElement().querySelector(".nav-puck");
      if (wrap) { wrap.innerHTML = vehicleSvg(settings.vehicle, settings.color); wrap.style.transform = "rotate(" + Math.round(nav.heading) + "deg)"; }
    }
  }

  function englishVoices() {
    if (!("speechSynthesis" in window)) return [];
    return window.speechSynthesis.getVoices().filter(function (v) { return /^en/i.test(v.lang); });
  }

  function fillVoices() {
    const voices = englishVoices();
    voiceSelect.replaceChildren(el("option", "", "Default"));
    voiceSelect.firstChild.value = "";
    voices.forEach(function (v) {
      const opt = el("option", "", v.name + " (" + v.lang + ")");
      opt.value = v.name;
      if (v.name === settings.voice) opt.selected = true;
      voiceSelect.append(opt);
    });
  }
  fillVoices();
  if ("speechSynthesis" in window) window.speechSynthesis.addEventListener("voiceschanged", fillVoices);
  voiceSelect.addEventListener("change", function () { settings.voice = voiceSelect.value; saveSettings(); });
  voiceRate.value = settings.rate;
  voiceRate.addEventListener("change", function () { settings.rate = parseFloat(voiceRate.value) || 1; saveSettings(); });
  document.getElementById("voice-test").addEventListener("click", function () {
    speak("In 500 feet, turn left onto North Broad Street. Reported pothole ahead.");
  });
  nightSelect.value = settings.night;
  nightSelect.addEventListener("change", function () { settings.night = nightSelect.value; saveSettings(); applyNight(); });
  unitsSelect.value = settings.units;
  unitsSelect.addEventListener("change", function () {
    settings.units = unitsSelect.value; saveSettings();
    document.getElementById("speedo").querySelector("span").textContent = settings.units === "metric" ? "km/h" : "mph";
    if (nav.active && nav.lastFix) updateBanner(snapToRoute(nav.lastFix.lat, nav.lastFix.lon).along);
  });

  function openSettings() {
    fillVoices();
    if (typeof settingsDialog.showModal === "function") settingsDialog.showModal();
    else settingsDialog.setAttribute("open", "");
  }
  document.getElementById("settings-open").addEventListener("click", openSettings);
  document.getElementById("nav-settings").addEventListener("click", function () { closeSheets(); openSettings(); });

  function isNight() {
    if (settings.night === "night") return true;
    if (settings.night === "day") return false;
    const hour = new Date().getHours();
    return hour < 6 || hour >= 19;
  }
  function applyNight() { document.body.classList.toggle("night", nav.active && isNight()); }

  // ---- Navigation extras: speedometer, follow mode, menus, alternatives --------
  const speedoEl = document.getElementById("speedo");
  const speedoValue = document.getElementById("speedo-value");
  const speedoLimit = document.getElementById("speedo-limit");
  const navMenu = document.getElementById("nav-menu");
  const navAlts = document.getElementById("nav-alts");
  const navRecenter = document.getElementById("nav-recenter");
  const navProgress = document.getElementById("nav-progress").firstElementChild;
  nav.following = true;
  nav.speedMps = 0;
  nav.limitMph = null;
  nav.limitTimer = null;
  nav.nightTimer = null;
  nav.myReports = L.layerGroup();

  function speedUnits(mps) { return settings.units === "metric" ? mps * 3.6 : mps * 2.23694; }

  function updateSpeedo(mps) {
    nav.speedMps = Math.max(0, mps || 0);
    speedoValue.textContent = String(Math.round(speedUnits(nav.speedMps)));
    const limit = nav.limitMph;
    speedoLimit.hidden = limit === null;
    if (limit !== null) {
      speedoLimit.querySelector("b").textContent = settings.units === "metric" ? Math.round((limit * 1.609344) / 5) * 5 : limit;
      speedoEl.classList.toggle("speeding", nav.speedMps * 2.23694 > limit + 4);
    } else {
      speedoEl.classList.remove("speeding");
    }
  }

  function pollRoad() {
    if (!nav.active || !nav.lastFix) return;
    fetch("/api/road?at=" + nav.lastFix.lat.toFixed(6) + "," + nav.lastFix.lon.toFixed(6))
      .then((r) => (r.ok ? r.json() : null))
      .then(function (data) {
        if (!nav.active || !data) return;
        const road = data.road;
        nav.limitMph = road && typeof road.posted_mph === "number" ? road.posted_mph : null;
        updateSpeedo(nav.speedMps);
      })
      .catch(function () { /* keep the last known limit */ });
  }

  // Sheets animate out before they hide; a scrim dims the map underneath.
  const navScrim = document.getElementById("nav-scrim");

  function dismiss(element) {
    if (element.hidden || element.classList.contains("closing")) return;
    element.classList.add("closing");
    const done = function () {
      element.removeEventListener("animationend", done);
      element.classList.remove("closing");
      element.hidden = true;
    };
    element.addEventListener("animationend", done);
    setTimeout(done, 300); // safety net if the animation is disabled
  }

  function reveal(element) {
    element.classList.remove("closing");
    element.hidden = false;
  }

  function closeSheets() {
    dismiss(navMenu);
    dismiss(navAlts);
    dismiss(navScrim);
    document.getElementById("nav-menu-open").setAttribute("aria-expanded", "false");
  }

  function openSheet(sheet) {
    if (sheet === navMenu) dismiss(navAlts); else dismiss(navMenu);
    reveal(navScrim);
    reveal(sheet);
  }

  navScrim.addEventListener("click", closeSheets);
  document.getElementById("nav-menu-open").addEventListener("click", function () {
    const willOpen = navMenu.hidden || navMenu.classList.contains("closing");
    if (willOpen) openSheet(navMenu); else closeSheets();
    this.setAttribute("aria-expanded", String(willOpen));
  });
  document.getElementById("nav-menu-close").addEventListener("click", closeSheets);
  document.getElementById("nav-alts-close").addEventListener("click", closeSheets);

  navRecenter.addEventListener("click", function () {
    nav.following = true;
    navRecenter.hidden = true;
    if (nav.lastFix) map.setView([nav.lastFix.lat, nav.lastFix.lon], NAV_ZOOM, { animate: true });
  });
  map.on("dragstart", function () {
    if (!nav.active) return;
    nav.following = false;
    navRecenter.hidden = false;
  });
  document.getElementById("nav-overview").addEventListener("click", function () {
    closeSheets();
    nav.following = false;
    navRecenter.hidden = false;
    const latlngs = nav.route.coordinates.map((c) => [c[1], c[0]]);
    map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [24, 120], paddingBottomRight: [24, 110] });
  });

  function toast(text) {
    const node = el("div", "nav-toast", text);
    navEl.append(node);
    setTimeout(function () { node.remove(); }, 3500);
  }

  // "Report a pothole here": drops a pin at the current position and remembers it
  // on this device. Philly 311 has no deep link with coordinates, so the pin is
  // the driver's own note to file after the trip from the panel's 311 link.
  document.getElementById("nav-report").addEventListener("click", function () {
    closeSheets();
    if (!nav.lastFix) return;
    const report = { lat: nav.lastFix.lat, lon: nav.lastFix.lon, at: new Date().toISOString() };
    let mine = [];
    try { mine = JSON.parse(localStorage.getItem("pj.reports") || "[]"); } catch (err) { mine = []; }
    mine.push(report);
    try { localStorage.setItem("pj.reports", JSON.stringify(mine.slice(-50))); } catch (err) { /* private mode */ }
    L.marker([report.lat, report.lon], { icon: divIcon("my-report-marker", 20), interactive: false }).addTo(nav.myReports);
    toast("Pothole marked here. File it with Philly 311 after your drive.");
    speak("Pothole marked");
    if (navigator.vibrate) navigator.vibrate(40);
  });

  function loadMyReports() {
    nav.myReports.clearLayers();
    let mine = [];
    try { mine = JSON.parse(localStorage.getItem("pj.reports") || "[]"); } catch (err) { mine = []; }
    mine.forEach(function (r) {
      if (typeof r.lat === "number" && typeof r.lon === "number") {
        L.marker([r.lat, r.lon], { icon: divIcon("my-report-marker", 20), interactive: false }).addTo(nav.myReports);
      }
    });
  }

  function altLabelLetter(route) { return route.route_id || "?"; }

  document.getElementById("nav-alts-open").addEventListener("click", function () {
    openSheet(navAlts);
    document.getElementById("nav-menu-open").setAttribute("aria-expanded", "false");
    const list = document.getElementById("nav-alts-list");
    const status = document.getElementById("nav-alts-status");
    list.replaceChildren();
    status.hidden = false;
    status.textContent = "Comparing routes from your position…";
    const from = nav.lastFix || { lat: nav.route.coordinates[0][1], lon: nav.route.coordinates[0][0] };
    fetch("/api/navigate?alternatives=1&from=" + from.lat.toFixed(6) + "," + from.lon.toFixed(6) +
          "&to=" + nav.dest.lat.toFixed(6) + "," + nav.dest.lon.toFixed(6))
      .then((r) => r.json().then((data) => ({ ok: r.ok, data: data })))
      .then(function (res) {
        if (navAlts.hidden || navAlts.classList.contains("closing")) return;
        if (!res.ok || !res.data.routes || !res.data.routes.length) throw new Error(res.data.error || "No alternatives right now.");
        status.hidden = true;
        res.data.routes.forEach(function (route) {
          const sign = el("button", "route-sign");
          sign.type = "button";
          if (route.kind === "smooth") sign.classList.add("recommended", "smooth");
          if (nav.route && route.coordinates.length === nav.route.coordinates.length &&
              route.coordinates[0][0] === nav.route.coordinates[0][0]) sign.classList.add("current");
          const meta = el("span", "route-meta");
          meta.append(el("strong", "", route.label), document.createTextNode(fmtMiles(route.miles) + ", about " + route.minutes + " min"));
          const count = el("span", "route-count");
          count.append(el("b", "", String(route.potholes.length)), document.createTextNode("reported"));
          sign.append(el("span", "route-letter", altLabelLetter(route)), meta, count);
          sign.addEventListener("click", function () {
            closeSheets();
            prepareNavRoute(route);
            if (nav.sim) nav.sim.restartFrom(from.lat, from.lon);
            nav.spoken = {};
            speak("Switched to the " + route.label.toLowerCase());
            toast("Now on the " + route.label.toLowerCase() + ": " + route.potholes.length + " reported pothole" + (route.potholes.length === 1 ? "" : "s"));
            updateBanner(snapToRoute(from.lat, from.lon).along);
          });
          list.append(sign);
        });
      })
      .catch(function (err) {
        status.hidden = false;
        status.textContent = String(err.message || err);
      });
  });

  function fmtMiles(miles) {
    return settings.units === "metric" ? (miles * 1.609344).toFixed(1) + " km" : miles + " mi";
  }

  document.getElementById("nav-start").addEventListener("click", function () { startNavigation(false); });
  document.getElementById("nav-preview").addEventListener("click", function () { startNavigation(true); });
  document.getElementById("nav-exit").addEventListener("click", stopNavigation);
  function setMuteLabel() {
    const btn = document.getElementById("nav-mute");
    btn.setAttribute("aria-pressed", String(nav.muted));
    btn.querySelector(".sheet-text b").textContent = nav.muted ? "Unmute voice" : "Mute voice";
    btn.querySelector(".sheet-text small").textContent = nav.muted ? "Voice guidance is off" : "Guidance keeps showing on screen";
    btn.querySelector(".icon-on").hidden = nav.muted;
    btn.querySelector(".icon-off").hidden = !nav.muted;
  }
  document.getElementById("nav-mute").addEventListener("click", function () {
    nav.muted = !nav.muted;
    setMuteLabel();
    closeSheets();
    if (nav.muted && "speechSynthesis" in window) window.speechSynthesis.cancel();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !nav.active) return;
    if ((!navMenu.hidden && !navMenu.classList.contains("closing")) ||
        (!navAlts.hidden && !navAlts.classList.contains("closing"))) { closeSheets(); return; }
    if (settingsDialog.open) return;
    stopNavigation();
  });
  // Test hook: ?sim=1 lets a script feed positions (used by the automated checks).
  if (new URLSearchParams(location.search).get("sim") === "1") {
    window.__pjNav = { feedPosition: onPosition, state: nav, start: startNavigation, stop: stopNavigation };
  }


  // ---- Saved places and recents ----------------------------------------------
  // Home, Work and starred favourites, plus the last few trips, kept on this
  // device (localStorage). They surface as chips under the trip form, at the
  // top of every search list, and in Settings for housekeeping.
  const PLACES_KEY = "pj.places";
  const RECENTS_KEY = "pj.recents";
  const MAX_RECENTS = 6;
  const PLACE_ICONS = {
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg>',
    work: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/></svg>',
    favorite: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.9 6.4.8-4.7 4.5 1.2 6.4L12 17.5l-5.7 3.1 1.2-6.4L2.8 9.7l6.4-.8z"/></svg>',
    recent: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  };

  function readJson(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v : []; } catch (err) { return []; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode */ }
  }
  function loadPlaces() {
    return readJson(PLACES_KEY).filter(function (p) {
      return p && typeof p.address === "string" && p.address && /^(home|work|favorite)$/.test(p.kind);
    });
  }
  function placeByKind(kind) { return loadPlaces().find((p) => p.kind === kind) || null; }
  function cleanLabel(text) {
    return String(text || "").replace(/,\s*(philadelphia|phila)\b.*$/i, "").trim().slice(0, 40);
  }
  function upsertPlace(place) {
    let places = loadPlaces();
    if (place.kind === "home" || place.kind === "work") places = places.filter((p) => p.kind !== place.kind);
    else places = places.filter((p) => p.address.toLowerCase() !== place.address.toLowerCase());
    places.push({ id: place.id || String(Date.now()), kind: place.kind, label: place.label, address: place.address, at: new Date().toISOString() });
    writeJson(PLACES_KEY, places.slice(-30));
    renderSavedRow();
    renderSavedList();
  }
  function removePlace(id) {
    writeJson(PLACES_KEY, loadPlaces().filter((p) => p.id !== id));
    renderSavedRow();
    renderSavedList();
  }

  // Which trip field a chip should fill: the one last touched, else "Going to".
  form.start.addEventListener("focus", function () { lastField = "start"; });
  form.end.addEventListener("focus", function () { lastField = "end"; });

  function fillFromPlace(place) {
    const toStart = lastField === "start" && startMode === "custom";
    const target = toStart ? form.start : form.end;
    target.value = place.address;
    if (toStart) fromText.textContent = place.address;
    openPanel();
    expandTripForm();
    if (!toStart && startMode === "location") { submitTrip(); return; } // Home from here: just go
    const other = target === form.start ? form.end : form.start;
    if (other.value.trim()) button.focus(); else other.focus();
  }

  function placeChip(kind, place) {
    const chip = el("button", "place-chip " + kind + (place ? "" : " unset"));
    chip.type = "button";
    chip.insertAdjacentHTML("afterbegin", PLACE_ICONS[kind]); // our own static markup
    const text = place ? place.label || (kind === "home" ? "Home" : kind === "work" ? "Work" : "Saved") : (kind === "home" ? "Set home" : "Set work");
    chip.append(el("span", "chip-text", text));
    chip.title = place ? place.address : "";
    chip.addEventListener("click", function () {
      if (place) fillFromPlace(place);
      else openPlaceDialog({ kind: kind });
    });
    return chip;
  }

  function renderSavedRow() {
    const row = document.getElementById("saved-row");
    row.replaceChildren();
    row.append(placeChip("home", placeByKind("home")), placeChip("work", placeByKind("work")));
    loadPlaces().filter((p) => p.kind === "favorite").forEach(function (p) { row.append(placeChip("favorite", p)); });
    const add = el("button", "place-chip unset");
    add.type = "button";
    add.insertAdjacentHTML("afterbegin", PLACE_ICONS.add);
    add.append(el("span", "chip-text", "Add"));
    add.setAttribute("aria-label", "Save a new place");
    add.addEventListener("click", function () { openPlaceDialog({ kind: "favorite" }); });
    row.append(add);
  }

  function renderSavedList() {
    const list = document.getElementById("saved-list");
    list.replaceChildren();
    const places = loadPlaces();
    if (!places.length) {
      list.append(el("li", "saved-empty", "No saved places yet. Home and Work show up under the trip form."));
      return;
    }
    places.forEach(function (p) {
      const item = el("li");
      const icon = el("span", "place-chip " + p.kind);
      icon.style.padding = "0.3rem";
      icon.insertAdjacentHTML("afterbegin", PLACE_ICONS[p.kind]);
      const text = el("span", "saved-text");
      text.append(el("b", "", p.label || (p.kind === "home" ? "Home" : p.kind === "work" ? "Work" : "Saved")), el("small", "", p.address));
      const remove = el("button", "saved-remove", "Remove");
      remove.type = "button";
      remove.addEventListener("click", function () { removePlace(p.id); });
      item.append(icon, text, remove);
      list.append(item);
    });
  }

  // Save-a-place dialog, with the same autocomplete as the trip form.
  const placeDialog = document.getElementById("place-dialog");
  const placeForm = document.getElementById("place-form");
  const placeStatus = document.getElementById("place-status");
  attachAutocomplete(placeForm.address, {
    geolocate: function () {
      requestLocation(
        function (coords) { placeForm.address.value = coords; },
        function (message) { placeStatus.textContent = message; }
      );
    },
  });

  function openPlaceDialog(prefill) {
    prefill = prefill || {};
    placeForm.reset();
    placeStatus.textContent = "";
    placeForm.kind.value = prefill.kind || "favorite";
    placeForm.label.value = prefill.label || "";
    placeForm.address.value = prefill.address || "";
    document.getElementById("place-title").textContent = prefill.address ? "Save this place" : "Save a place";
    if (typeof placeDialog.showModal === "function") placeDialog.showModal(); else placeDialog.setAttribute("open", "");
    (placeForm.address.value ? placeForm.label : placeForm.address).focus();
  }
  function closePlaceDialog() {
    if (placeDialog.open) placeDialog.close(); else placeDialog.removeAttribute("open");
  }
  document.getElementById("place-cancel").addEventListener("click", closePlaceDialog);
  placeForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const address = placeForm.address.value.trim();
    if (!address) { placeStatus.textContent = "Enter an address or place."; return; }
    const kind = placeForm.kind.value;
    const label = cleanLabel(placeForm.label.value) || (kind === "favorite" ? cleanLabel(address) : "");
    upsertPlace({ kind: kind, label: label, address: address });
    closePlaceDialog();
    setStatus("Saved " + (label || kind) + ".");
    setTimeout(function () { if (statusEl.textContent.indexOf("Saved ") === 0) setStatus(""); }, 2500);
  });
  document.getElementById("saved-add").addEventListener("click", function () { openPlaceDialog({ kind: "favorite" }); });
  document.getElementById("save-place").addEventListener("click", function () {
    if (!trip) return;
    openPlaceDialog({
      kind: "favorite",
      label: cleanLabel(form.end.value),
      address: (trip.end && trip.end.source !== "device coordinates" && form.end.value.trim()) || (trip.end ? trip.end.lat.toFixed(5) + ", " + trip.end.lon.toFixed(5) : ""),
    });
  });

  // Recents: the last few trips, newest first, offered in the "Where to?" pill.
  function loadRecents() { return readJson(RECENTS_KEY).filter((r) => r && r.end); }
  function recordRecent(start, end) {
    const key = ((start || "") + "|" + end).toLowerCase();
    const recents = loadRecents().filter((r) => ((r.start || "") + "|" + r.end).toLowerCase() !== key);
    recents.unshift({ start: start, end: end, at: new Date().toISOString() });
    writeJson(RECENTS_KEY, recents.slice(0, MAX_RECENTS));
  }

  // Suggestions for the autocomplete: saved places that match, then recents.
  function savedMatches(q, opts) {
    const needle = q.toLowerCase();
    const items = [];
    loadPlaces().forEach(function (p) {
      const name = p.label || p.kind;
      if (needle && name.toLowerCase().indexOf(needle) === -1 && p.address.toLowerCase().indexOf(needle) === -1) return;
      items.push({
        icon: PLACE_ICONS[p.kind], cls: "saved",
        label: name === p.kind ? (p.kind === "home" ? "Home" : p.kind === "work" ? "Work" : "Saved") : name,
        sub: p.address.toLowerCase() === name.toLowerCase() ? "Saved place" : p.address,
        pick: function () { opts.choose(p.address); },
      });
    });
    if (opts.recents && !needle) {
      loadRecents().slice(0, 3).forEach(function (r) {
        items.push({
          icon: PLACE_ICONS.recent, cls: "recent",
          label: r.start ? cleanLabel(r.start) + " \u2192 " + cleanLabel(r.end) : cleanLabel(r.end),
          sub: r.start ? "Recent trip" : "Recent trip from your location",
          pick: function () {
            if (r.start) { form.start.value = r.start; setStartMode("custom"); } else setStartMode("location");
            form.end.value = r.end;
            openPanel();
            expandTripForm();
            submitTrip();
          },
        });
      });
    }
    return items;
  }

  renderSavedRow();
  renderSavedList();

  // A shared link (?from=&to=&avoid=) plans the trip as soon as the page loads.
  (function runFromUrl() {
    const params = new URLSearchParams(location.search);
    const from = (params.get("from") || "").trim();
    const to = (params.get("to") || "").trim();
    if (!to) return;
    if (from) { form.start.value = from.slice(0, 200); setStartMode("custom"); }
    form.end.value = to.slice(0, 200);
    form.avoid.value = params.get("avoid") === "strong" ? "strong" : "balanced";
    openPanel();
    submitTrip();
  })();
})();
