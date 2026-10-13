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
    if (q) form.end.value = q;
    openPanel();
    expandTripForm(); // the form may still be collapsed from a previous trip
    form.start.focus();
    form.start.select();
  });

  // Wire autocomplete to the pill and both trip inputs. The pill's geolocate
  // row and the picker both hand off to the existing pill -> panel flow.
  attachAutocomplete(pillInput, {
    geolocate: function () {
      requestLocation(
        function (coords) {
          form.start.value = coords;
          const q = pillInput.value.trim();
          if (q) form.end.value = q;
          openPanel();
          expandTripForm(); // the form may still be collapsed from a previous trip
          form.end.focus();
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
    geolocate: function () {
      requestLocation(
        function (coords) { form.start.value = coords; },
        function (message) { setStatus(message, true); }
      );
    },
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

  document.getElementById("use-location").addEventListener("click", function () {
    requestLocation(
      function (coords) { form.start.value = coords; },
      function (message) { setStatus(message, true); }
    );
  });

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

  // ---- Trip / Ask mode switch ------------------------------------------------
  // One panel, one segmented control — "Ask 311 data" is a mode of the same
  // tool rather than a second, visually separate app stacked underneath.
  const modeTabs = [document.getElementById("tab-trip"), document.getElementById("tab-ask")];
  const modePanels = { "tab-trip": document.getElementById("mode-trip"), "tab-ask": document.getElementById("mode-ask") };

  function setMode(tab) {
    modeTabs.forEach(function (t) {
      const active = t === tab;
      t.setAttribute("aria-selected", String(active));
      t.tabIndex = active ? 0 : -1;
      modePanels[t.id].hidden = !active;
    });
    tab.focus();
    updatePeekSummary(); // the peek strip is trip-only; hide it on the Ask tab
  }

  modeTabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { setMode(tab); });
    tab.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = modeTabs[(i + (event.key === "ArrowRight" ? 1 : modeTabs.length - 1)) % modeTabs.length];
      setMode(next);
    });
  });

  let trip = null;
  let activeId = null;
  let markersById = {};

  // ---- Mobile: collapse the spent form to a "start → end · Edit" row --------
  const tripSummary = document.getElementById("trip-summary");
  const tripSummaryText = document.getElementById("trip-summary-text");

  function collapseTripForm() {
    if (!mobileMq.matches) return;
    tripSummaryText.textContent = form.start.value + " → " + form.end.value;
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
    // No trip-branded strip while the Ask tab is active: its click handler
    // opens the sheet onto whichever panel is showing, not the trip.
    const askActive = document.getElementById("tab-ask").getAttribute("aria-selected") === "true";
    if (!route || askActive) { peekSummary.hidden = true; return; }
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
        const row = el("div", "ac-item" + (i === active ? " active" : ""));
        if (item.glyph) row.append(el("span", "ac-glyph", item.glyph));
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
          glyph: "\u{1F4CD}",
          label: "Use my current location",
          pick: opts.geolocate,
        });
      }
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
      if (place) {
        const popup = el("div", "", place.matched_address);
        L.marker([place.lat, place.lon], { icon: divIcon("endpoint-marker", 16) }).bindPopup(popup).addTo(layers);
      }
    });
  }

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
      meta.append(el("strong", "", route.route_id === trip.recommended ? "Recommended" : "Alternative"), document.createTextNode(route.miles + " mi, about " + route.minutes + " min"));
      const count = el("span", "route-count");
      count.append(el("b", "", String(route.potholes.length)), document.createTextNode("reported"));
      sign.append(el("span", "route-letter", route.route_id), meta, count);
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
      case "tool_call":
        if (event.input && typeof event.input.query === "string") {
          return "Ran SQL (" + event.tool + "): " + event.input.query;
        }
        return "Called " + event.tool + " " + JSON.stringify(event.input);
      case "tool_error": return "Error from " + event.tool + ": " + event.preview;
      case "usage": return null;
      case "agent_unavailable": return "Agent unavailable (" + event.detail + "). Used the built-in planner instead.";
      case "fallback": return event.text;
      case "final": return "Finished in " + event.steps + " model turns.";
      default: return null;
    }
  }

  function drawSteps() {
    const list = document.getElementById("steps");
    list.replaceChildren();
    let tokens = 0;
    trip.steps.forEach(function (event) {
      if (event.type === "usage") tokens += event.input_tokens + event.output_tokens;
      const text = describeStep(event);
      if (text) list.append(el("li", event.type === "tool_error" ? "error" : "", text));
    });
    if (tokens) list.append(el("li", "", "Total tokens used: " + tokens.toLocaleString()));
    document.getElementById("activity").hidden = trip.steps.length === 0;
  }

  function selectRoute(routeId) {
    activeId = routeId;
    drawMap();
    drawRouteSigns();
    drawPotholeList();
    updatePeekSummary();
  }

  function render(data) {
    trip = data;
    const briefing = document.getElementById("briefing");
    briefing.replaceChildren(document.createTextNode(data.briefing));
    briefing.append(el("span", "mode", data.mode === "agent" ? "Written by the AI agent from the data below." : "Built-in planner (AI agent not used)."));
    drawSteps();
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
    button.disabled = true;
    if (mobileMq.matches && panelOpen) {
      // Drop the sheet to half so the map and the live agent steps share the
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

    const source = new EventSource(
      "/api/trip/stream?start=" + encodeURIComponent(form.start.value) +
      "&end=" + encodeURIComponent(form.end.value)
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
  });

  // Follow-up question box wired to the 311 analyst agent.
  const askForm = document.getElementById("ask-form");
  const askButton = document.getElementById("ask-go");
  const askStatusEl = document.getElementById("ask-status");
  const answerEl = document.getElementById("answer");

  function setAskStatus(message, isError) {
    askStatusEl.textContent = message;
    askStatusEl.classList.toggle("error", Boolean(isError));
    askStatusEl.classList.toggle("busy", Boolean(message) && !isError);
  }

  // Example-question chips: fill the box and ask right away.
  document.querySelectorAll(".ask-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      if (askButton.disabled) return; // one question at a time
      askForm.question.value = chip.textContent;
      if (askForm.requestSubmit) askForm.requestSubmit();
      else askForm.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  });

  askForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const question = askForm.question.value.trim();
    if (!question) { setAskStatus("Type a question first.", true); return; }
    askButton.disabled = true;
    setAskStatus("The analyst is querying the city's 311 data.");
    answerEl.hidden = true;
    const askLive = document.getElementById("ask-live");
    const askSteps = document.getElementById("ask-live-steps");
    askSteps.replaceChildren();
    askLive.hidden = false;

    const source = new EventSource("/api/ask/stream?q=" + encodeURIComponent(question));
    function finish() {
      source.close();
      askLive.hidden = true;
      askButton.disabled = false;
    }
    source.addEventListener("step", function (e) {
      const step = JSON.parse(e.data);
      const text = describeStep(step);
      if (text) {
        askSteps.append(el("li", step.type === "tool_error" ? "error" : "", text));
        askSteps.lastChild.scrollIntoView({ block: "nearest" });
      }
    });
    source.addEventListener("result", function (e) {
      finish();
      setAskStatus("");
      answerEl.textContent = JSON.parse(e.data).answer; // textContent only, never innerHTML
      answerEl.hidden = false;
    });
    source.addEventListener("ask_error", function (e) {
      finish();
      setAskStatus(JSON.parse(e.data).error || "Something went wrong.", true);
    });
    source.onerror = function () { // connection-level failure (e.g. bad input, server down)
      finish();
      setAskStatus("Could not reach the analyst. Try again.", true);
    };
  });
})();
