// The overview map: everything map.html does once the markup is on screen. Its job is to help
// someone find where to stand.
//
// A classic script, loaded with `defer` after Leaflet, Lucide, astronomy-engine and the shared
// modules. Its top-level names are deliberately global: the smoke tests reach `layer`,
// `catalogue` and the rest by name.

const q = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

const ACCESS_LABEL = { sealed: "Sealed road", track: "Unsealed road or 4WD track", foot: "Walking track", none: "Off-track" };
const ACCESS_SUB_LABEL = {
  sealed_road: "Sealed road",
  gravel_road: "Gravel road",
  "4wd_track": "4WD track",
  walking_track: "Walking track",
  cycle_trail: "Cycle trail",
  paper_road: "Unformed legal road",
  off_track: "Off-track, alpine",
};
const POI_LABEL = { viewpoint: "Viewpoint", peak: "Summit", picnic: "Picnic area",
  campsite: "Campsite", rest_area: "Rest area", tower: "Lookout tower" };

// Where each town's label sits, so the Wakatipu towns do not pile up at the opening zoom.
const TOWN_SIDE = { Queenstown: "left", Arrowtown: "top" };
const LEVEL_WORD = { clear: "clear", partial: "partly blocked", blocked: "blocked" };

const LIST_PAGE = 40;
const DECLUTTER_CELL_PX = 34;
const BAND_MAX_ZOOM = 6;

const phone = isPhone();
const map = L.map("map", {
  zoomControl: false,
  attributionControl: false,
  zoomAnimation: !reducedMotion(),
  fadeAnimation: !reducedMotion(),
  markerZoomAnimation: !reducedMotion(),
}).setView([-45.2, 169.2], 8);
// On a phone the sheet covers the bottom of the map, so the controls and credits move to the top.
const controlCorner = phone ? "topright" : "bottomright";
L.control.zoom({ position: controlCorner }).addTo(map);
L.control.attribution({ position: controlCorner }).addTo(map);

// Same imagery as the 3D view, so the two look like one product.
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 17, attribution: "Imagery: Esri, Maxar, Earthstar Geographics" }
).addTo(map);
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 17, opacity: 0.8 }
).addTo(map);

const cloudLayer = L.layerGroup().addTo(map);
const pathLayer = L.layerGroup().addTo(map);
const layer = L.layerGroup().addTo(map);
const townLayer = L.layerGroup().addTo(map);

let catalogue = null;
let here = null;                 // the place the list is measured from: { name, lat, lon, url }
let selected = null;             // the spot open in the detail view
let matching = [];               // filtered and ranked: what the marks draw from
let listLimit = LIST_PAGE;
let listScroll = 0;
let contourToken = 0;            // guards against a slow contour load painting the wrong spot
const access = new Set(["road"]);

// ------------------------------------------------------------------------------ phone sheet
const sheet = {
  state: "half",
  heights() {
    const h = window.innerHeight;
    return { peek: 148, half: Math.round(h * 0.48), full: h - 72 };
  },
  px() { return isPhone() ? this.heights()[this.state] : 0; },
  set(state) {
    this.state = state;
    document.documentElement.style.setProperty("--sheet-h", this.heights()[state] + "px");
    q("sheetHandle").setAttribute("aria-label",
      state === "full" ? "Shrink this panel" : "Enlarge this panel");
  },
};

function wireSheet() {
  const handle = q("sheetHandle");
  let startY = 0, startH = 0, moved = false, dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true; moved = false;
    startY = e.clientY;
    startH = q("panel").getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
    q("panel").classList.add("dragging");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    if (moved) document.documentElement.style.setProperty("--sheet-h", `${startH + dy}px`);
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    q("panel").classList.remove("dragging");
    const heights = sheet.heights();
    if (moved) {
      const h = startH + (startY - e.clientY);
      sheet.set(Object.keys(heights).reduce((best, k) =>
        (Math.abs(heights[k] - h) < Math.abs(heights[best] - h) ? k : best), "half"));
    } else {
      sheet.set({ peek: "half", half: "full", full: "half" }[sheet.state]);
    }
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (e) => {
    const order = ["peek", "half", "full"];
    const i = order.indexOf(sheet.state);
    if (e.key === "ArrowUp") { e.preventDefault(); sheet.set(order[Math.min(2, i + 1)]); }
    if (e.key === "ArrowDown") { e.preventDefault(); sheet.set(order[Math.max(0, i - 1)]); }
  });
  window.addEventListener("resize", () => sheet.set(sheet.state));
  sheet.set(sheet.state);
}

// Move the map so a point lands in the middle of the part the sheet is not covering.
function showOnMap(lat, lon, zoom) {
  const z = zoom || map.getZoom();
  const target = map.project([lat, lon], z).add([0, sheet.px() / 2]);
  map.setView(map.unproject(target, z), z, { animate: !reducedMotion() });
}

// ------------------------------------------------------------------------------ overlays
// Cloudier is whiter, so the clearest country stays visible through the layer. The grid stops
// at the edge of the eclipse region, and fading its outer cells stops that showing as a box.
function renderCloudOverlay() {
  cloudLayer.clearLayers();
  const on = q("showCloud").checked;
  q("cloudLegend").hidden = !on;
  if (!on || !catalogue || !catalogue.cloudGrid) return;

  const cg = catalogue.cloudGrid;
  const { lats, lons, cfcDay: cfc } = cg;
  const nLat = lats.length, nLon = lons.length;
  const dlat = cg.dlat || 0.25, dlon = cg.dlon || 0.25;
  const south = lats[0] - dlat / 2, north = lats[nLat - 1] + dlat / 2;
  const west = lons[0] - dlon / 2, east = lons[nLon - 1] + dlon / 2;

  const width = 240;
  const height = Math.round(width * ((north - south) / (east - west)));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  const FEATHER_DEG = 0.9;
  const smooth = (t) => t * t * (3 - 2 * t);

  for (let py = 0; py < height; py++) {
    const lat = north - (py / (height - 1)) * (north - south);
    const gy = Math.max(0, Math.min(nLat - 1, (lat - lats[0]) / dlat));
    const y0 = Math.floor(gy), y1 = Math.min(nLat - 1, y0 + 1), fy = gy - y0;
    for (let px = 0; px < width; px++) {
      const lon = west + (px / (width - 1)) * (east - west);
      const gx = Math.max(0, Math.min(nLon - 1, (lon - lons[0]) / dlon));
      const x0 = Math.floor(gx), x1 = Math.min(nLon - 1, x0 + 1), fx = gx - x0;
      const val = (1 - fy) * ((1 - fx) * cfc[y0][x0] + fx * cfc[y0][x1])
                + fy * ((1 - fx) * cfc[y1][x0] + fx * cfc[y1][x1]);
      const cloud = Math.max(0, Math.min(1, (val - 42) / 46));
      const edge = Math.min(lat - south, north - lat, lon - west, east - lon) / FEATHER_DEG;
      const i = (py * width + px) * 4;
      img.data[i] = 239; img.data[i + 1] = 243; img.data[i + 2] = 241;
      img.data[i + 3] = Math.round(255 * 0.82 * cloud * smooth(Math.max(0, Math.min(1, edge))));
    }
  }
  ctx.putImageData(img, 0, 0);
  L.imageOverlay(canvas.toDataURL("image/png"), [[south, west], [north, east]],
    { interactive: false }).addTo(cloudLayer);
}

// Precomputed 22 July 2028 eclipse path & partial obscuration bands across the Tasman / NZ
// (astronomy-engine local solar eclipse circumference + sunset terminus).
const ECLIPSE_PATH = {"totalityPoly":[[-28.732,146],[-29.526,147],[-30.312,148],[-31.089,149],[-31.856,150],[-32.612,151],[-33.358,152],[-34.092,153],[-34.815,154],[-35.525,155],[-36.223,156],[-36.909,157],[-37.582,158],[-38.243,159],[-38.891,160],[-39.527,161],[-40.15,162],[-40.762,163],[-41.361,164],[-41.948,165],[-42.524,166],[-43.087,167],[-43.639,168],[-44.18,169],[-44.709,170],[-45.228,171],[-45.736,172],[-46.233,173],[-46.719,174],[-47.196,175],[-47.662,176],[-48.118,177],[-48.565,178],[-49.002,179],[-49.43,180],[-49.848,181],[-50.071,181.542],[-50.294,181.647],[-50.517,181.488],[-50.74,181.327],[-50.963,181.164],[-51.186,181],[-51.199,180],[-50.785,179],[-50.362,178],[-49.93,177],[-49.489,176],[-49.038,175],[-48.577,174],[-48.106,173],[-47.625,172],[-47.134,171],[-46.633,170],[-46.12,169],[-45.597,168],[-45.063,167],[-44.518,166],[-43.961,165],[-43.393,164],[-42.813,163],[-42.222,162],[-41.618,161],[-41.003,160],[-40.376,159],[-39.736,158],[-39.085,157],[-38.421,156],[-37.745,155],[-37.057,154],[-36.357,153],[-35.646,152],[-34.923,151],[-34.189,150],[-33.444,149],[-32.689,148],[-31.925,147],[-31.152,146]],"totalityNorth":[[-28.732,146],[-29.526,147],[-30.312,148],[-31.089,149],[-31.856,150],[-32.612,151],[-33.358,152],[-34.092,153],[-34.815,154],[-35.525,155],[-36.223,156],[-36.909,157],[-37.582,158],[-38.243,159],[-38.891,160],[-39.527,161],[-40.15,162],[-40.762,163],[-41.361,164],[-41.948,165],[-42.524,166],[-43.087,167],[-43.639,168],[-44.18,169],[-44.709,170],[-45.228,171],[-45.736,172],[-46.233,173],[-46.719,174],[-47.196,175],[-47.662,176],[-48.118,177],[-48.565,178],[-49.002,179],[-49.43,180],[-49.848,181]],"totalitySouth":[[-31.152,146],[-31.925,147],[-32.689,148],[-33.444,149],[-34.189,150],[-34.923,151],[-35.646,152],[-36.357,153],[-37.057,154],[-37.745,155],[-38.421,156],[-39.085,157],[-39.736,158],[-40.376,159],[-41.003,160],[-41.618,161],[-42.222,162],[-42.813,163],[-43.393,164],[-43.961,165],[-44.518,166],[-45.063,167],[-45.597,168],[-46.12,169],[-46.633,170],[-47.134,171],[-47.625,172],[-48.106,173],[-48.577,174],[-49.038,175],[-49.489,176],[-49.93,177],[-50.362,178],[-50.785,179],[-51.199,180],[-51.186,181]],"totalityCenter":[[-29.963,146],[-30.702,147],[-31.48,148],[-32.245,149],[-33.004,150],[-33.748,151],[-34.482,152],[-35.207,153],[-35.913,154],[-36.615,155],[-37.299,156],[-37.976,157],[-38.638,158],[-39.328,159],[-39.964,160],[-40.554,161],[-41.164,162],[-41.767,163],[-42.358,164],[-42.934,165],[-43.5,166],[-44.056,167],[-44.598,168],[-45.163,169],[-45.65,170],[-46.198,171],[-46.66,172],[-47.15,173],[-47.661,174],[-48.097,175],[-48.554,176],[-49.004,177],[-49.444,178],[-49.91,179],[-50.293,180],[-50.745,181],[-50.517,181.488]],"bands":{"p90":[[-24.82,146],[-26.43,148],[-28,150],[-29.53,152],[-31.02,154],[-32.46,156],[-33.85,158],[-35.19,160],[-36.48,162],[-37.72,164],[-38.92,166],[-40.06,168],[-41.15,170],[-42.2,172],[-43.21,174],[-44.17,176],[-45.1,178],[-45.98,180],[-46.83,182],[-47.25,183.04],[-47.68,183.4],[-48.1,183.12],[-48.52,182.85],[-48.94,182.57],[-49.37,182.29],[-49.79,182],[-52.49,180],[-54.1,178],[-53.24,176],[-52.35,174],[-51.42,172],[-50.45,170],[-49.43,168],[-48.38,166],[-47.28,164],[-46.13,162],[-44.94,160],[-43.7,158],[-42.41,156],[-41.08,154],[-39.69,152],[-38.27,150],[-36.79,148],[-35.28,146]],"p75":[[-19.78,146],[-21.4,148],[-23.01,150],[-24.58,152],[-26.11,154],[-27.59,156],[-29.02,158],[-30.4,160],[-31.73,162],[-33,164],[-34.24,166],[-35.41,168],[-36.53,170],[-37.61,172],[-38.65,174],[-39.64,176],[-40.58,178],[-41.5,180],[-42.36,182],[-43.19,184],[-43.69,185.25],[-44.2,185.45],[-44.7,185.17],[-45.2,184.88],[-45.7,184.59],[-46.21,184.3],[-46.71,184],[-49.79,182],[-52.49,180],[-54.82,178],[-56.85,176],[-57.98,174],[-57.06,172],[-56.11,170],[-55.12,168],[-54.09,166],[-53.02,164],[-51.89,162],[-50.72,160],[-49.5,158],[-48.23,156],[-46.93,154],[-45.57,152],[-44.17,150],[-42.72,148],[-41.23,146]],"p50":[[-11.46,146],[-13.1,148],[-14.75,150],[-16.37,152],[-17.96,154],[-19.52,156],[-21.02,158],[-22.47,160],[-23.86,162],[-25.21,164],[-26.5,166],[-27.74,168],[-28.92,170],[-30.06,172],[-31.15,174],[-32.19,176],[-33.19,178],[-34.14,180],[-35.05,182],[-35.91,184],[-37.45,187.78],[-39,188],[-40.54,187.39],[-42.08,186.6],[-43.62,185.77],[-45.17,184.9],[-46.71,184],[-49.79,182],[-52.49,180],[-54.82,178],[-56.85,176],[-58.6,174],[-60.13,172],[-61.46,170],[-62.63,168],[-63.67,166],[-64.57,164],[-64.52,162],[-63.35,160],[-62.11,158],[-60.84,156],[-59.5,154],[-58.14,152],[-56.71,150],[-55.23,148],[-53.73,146]]}};

const WARM = "#F5B83D";
let bandLayers = [];

// The path is the one warm thing on the map. The partial bands are too far away to see at any
// useful zoom, so they appear only when zoomed out to where they are on screen.
function renderEclipsePath() {
  pathLayer.clearLayers();
  L.polygon(ECLIPSE_PATH.totalityPoly, {
    stroke: false, fillColor: WARM, fillOpacity: 0.08, interactive: false,
  }).addTo(pathLayer);
  for (const lim of [ECLIPSE_PATH.totalityNorth, ECLIPSE_PATH.totalitySouth]) {
    L.polyline(lim, { color: WARM, weight: 2, opacity: 0.9, interactive: false }).addTo(pathLayer);
  }
  L.polyline(ECLIPSE_PATH.totalityCenter, {
    color: WARM, weight: 1.5, opacity: 0.75, dashArray: "6 6", interactive: false,
  }).addTo(pathLayer);
}

function syncBands() {
  const show = map.getZoom() <= BAND_MAX_ZOOM;
  q("bandLegend").hidden = !show;
  if (show && !bandLayers.length) {
    bandLayers = ["p50", "p75", "p90"].map((key) =>
      L.polygon(ECLIPSE_PATH.bands[key], {
        color: WARM, weight: 1, opacity: 0.4, fill: false, interactive: false,
      }).addTo(pathLayer));
  } else if (!show && bandLayers.length) {
    bandLayers.forEach((l) => pathLayer.removeLayer(l));
    bandLayers = [];
  }
}

// ------------------------------------------------------------------------------ filtering
const keyOf = (s) => `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
// A few catalogue entries are named after their own coordinates, which reads as an error.
const nameOf = (s) => (!s.name ? "Unnamed spot" : /^Lookout \(/.test(s.name) ? "Unnamed lookout" : s.name);
const minutes = (s) => `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;

function entries() {
  if (!catalogue) return [];
  const pois = catalogue.pois.map((p) => ({ ...p, isPoi: true }));
  return q("includeUnnamed").checked ? pois.concat(catalogue.spots) : pois;
}

function applyFilters() {
  const wants = [...access];
  if (q("includeOffTrack").checked) wants.push("none");
  const publicOnly = q("publicOnly").checked;
  const minClear = q("minClear").value / 10;
  const minSky = +q("minSky").value;
  q("minClearVal").textContent = minClear > 0 ? `${minClear.toFixed(1)}°` : "Any";
  q("minSkyVal").textContent = minSky > SKY_ANY ? `${minSky}%` : "Any";

  matching = Catalogue.rankSpots(entries().filter((s) =>
    wants.some((w) => Catalogue.matchesAccess(s, w)) &&
    (!publicOnly || s.publicAccess !== false) &&
    s.clearance >= minClear &&
    (minSky <= SKY_ANY || s.clearProb == null || s.clearProb >= minSky)));
  return matching;
}
const SKY_ANY = 30;

function render() {
  applyFilters();
  renderList();
  renderMarks();
}

// ------------------------------------------------------------------------------ marks
function markClass(s) {
  if (s.level !== "clear") return "mark--blocked";
  return s.clearance < Catalogue.TIGHT_CLEARANCE ? "mark--tight" : "mark--clear";
}

// Leaflet makes markers focusable but does not reliably open them from the keyboard.
function openable(marker, open) {
  marker.on("click", open);
  marker.getElement().addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
}

function addMark(s, isSelected) {
  const icon = L.divIcon({
    className: `mark ${markClass(s)}${isSelected ? " mark--selected" : ""}`,
    iconSize: [14, 14],
  });
  const marker = L.marker([s.lat, s.lon], {
    icon,
    title: `${nameOf(s)}, ${Catalogue.TOTALITY_TEXT[s.level].toLowerCase()}`,
    zIndexOffset: isSelected ? 2000 : 0,
  }).addTo(layer);
  openable(marker, () => openDetail(s));
}

// Only the best spot in each patch of screen is drawn, so zooming in reveals more.
function renderMarks() {
  layer.clearLayers();
  const z = map.getZoom();
  const shown = Catalogue.declutter(matching, (s) => map.project([s.lat, s.lon], z), DECLUTTER_CELL_PX);
  const selectedKey = selected && !selected.isPreset ? keyOf(selected) : null;
  for (const s of shown) if (keyOf(s) !== selectedKey) addMark(s, false);
  if (selectedKey) addMark(selected, true);
}

function renderTowns() {
  townLayer.clearLayers();
  for (const t of catalogue.presets || []) {
    const word = LEVEL_WORD[t.level] || t.level;
    const side = TOWN_SIDE[t.name] || "right";
    const icon = L.divIcon({
      className: `town town--${side} town--${t.level}`,
      html: `<span class="town-label">${esc(t.name)}<span class="town-word">: ${word}</span></span>`,
      iconSize: [14, 14],
    });
    const marker = L.marker([t.lat, t.lon], { icon, title: `${t.name} town centre: ${word}`, zIndexOffset: 1000 })
      .addTo(townLayer);
    openable(marker, () => openDetail({ ...t, isPreset: true }));
  }
}

// ------------------------------------------------------------------------------ the list
function awayText(s) {
  if (!here) return "";
  const km = Catalogue.haversineM(here.lat, here.lon, s.lat, s.lon) / 1000;
  if (km < 0.5) return "Here";
  return `${km.toFixed(km < 10 ? 1 : 0)} km ${Places.compassShort(Catalogue.bearingDeg(here.lat, here.lon, s.lat, s.lon))}`;
}

function accessText(s) {
  return (s.accessSub && ACCESS_SUB_LABEL[s.accessSub]) || ACCESS_LABEL[s.access || "none"];
}

function renderList() {
  const box = q("spotList");
  let list = Catalogue.thinNearby(matching);
  if (here) {
    const dist = (s) => Catalogue.haversineM(here.lat, here.lon, s.lat, s.lon);
    list = [...list].sort((a, b) => dist(a) - dist(b));
  }
  const n = list.length;
  q("count").textContent = !access.size && !q("includeOffTrack").checked
    ? "Choose at least one way of getting there."
    : n === 0 ? "No spots match. Try turning on another way of getting there, or loosen More filters."
    : `${n} spot${n === 1 ? "" : "s"}${here ? ", closest first" : ", best first"}`;

  box.innerHTML = "";
  list.slice(0, listLimit).forEach((s) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row";
    const first = [awayText(s), accessText(s)].filter(Boolean).join(", ");
    const sky = s.clearProb != null ? `, ${s.clearProb.toFixed(0)}% chance of clear sky` : "";
    b.innerHTML = `<span class="glyph ${markClass(s)}" aria-hidden="true"></span>
      <span class="row-body">
        <span class="row-name">${esc(nameOf(s))}</span>
        <span class="row-sub">${esc(first)}</span>
        <span class="row-sub">${minutes(s.totality)} of totality${sky}</span>
      </span>`;
    b.addEventListener("click", () => openDetail(s));
    li.appendChild(b);
    box.appendChild(li);
  });
  q("showMore").hidden = n <= listLimit;
}

// ------------------------------------------------------------------------------ search
let suggestTimer = null, suggestAbort = null, suggestItems = [], suggestActive = -1;

function setStatus(msg) {
  const el = q("searchStatus");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function hideSuggestions() {
  q("suggestions").hidden = true;
  suggestItems = [];
  suggestActive = -1;
}

function drawSuggestions(items) {
  if (!items.length) { hideSuggestions(); return; }
  suggestItems = items;
  suggestActive = -1;
  const box = q("suggestions");
  box.innerHTML = "";
  items.forEach((it, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "suggestion";
    el.textContent = it.name;
    el.addEventListener("pointerdown", (e) => e.preventDefault());
    el.addEventListener("click", () => chooseSuggestion(i));
    box.appendChild(el);
  });
  box.hidden = false;
}

async function fetchSuggestions(text) {
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();
  try {
    const res = await fetch(Places.photonUrl(text, 5),
      { signal: suggestAbort.signal, headers: { Accept: "application/json" } });
    if (res.ok) drawSuggestions(Places.photonFeatures(await res.json()));
  } catch (e) { /* aborted or offline */ }
}

const shortPlace = (name) => name.split(",")[0].slice(0, 40);

function chooseSuggestion(i) {
  const it = suggestItems[i];
  if (!it) return;
  q("placeSearch").value = "";
  hideSuggestions();
  trackMetric("custom_search", "address");
  setHere({ name: shortPlace(it.name), lat: it.lat, lon: it.lon, url: true });
}

async function searchNow() {
  hideSuggestions();
  const raw = q("placeSearch").value.trim();
  if (!raw) return;
  const coords = Places.parseCoords(raw);
  if (coords) {
    if (!Places.inNzBounds(coords.lat, coords.lon)) { setStatus("Enter a place within New Zealand."); return; }
    trackMetric("custom_search", "coords");
    q("placeSearch").value = "";
    setHere({ name: `${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)}`, ...coords, url: true });
    return;
  }
  setStatus("Searching…");
  try {
    const res = await fetch(Places.photonUrl(raw, 5), { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error();
    const list = Places.photonFeatures(await res.json());
    if (!list.length) { setStatus(`No place called “${raw}” found in New Zealand.`); return; }
    trackMetric("custom_search", "address");
    q("placeSearch").value = "";
    setHere({ name: shortPlace(list[0].name), lat: list[0].lat, lon: list[0].lon, url: true });
  } catch (e) {
    setStatus("Search is unavailable right now. Try coordinates, such as -45.03, 168.66.");
  }
}

function useMyLocation() {
  if (!navigator.geolocation) { setStatus("This browser cannot share its location. Search for a place instead."); return; }
  setStatus("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      if (!Places.inNzBounds(lat, lon)) { setStatus("You appear to be outside New Zealand. Search for a place instead."); return; }
      trackMetric("geolocation_use");
      // Not written to the address bar: a copied link should not carry where you are.
      setHere({ name: "your location", lat, lon, url: false });
    },
    (err) => setStatus(err.code === 1
      ? "Location access is off. Search for a place instead."
      : "Could not find your location. Search for a place instead."),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function setHere(place) {
  here = place;
  setStatus("");
  q("hereLine").hidden = !here;
  if (here) q("hereName").textContent = `Near ${here.name}`;
  listLimit = LIST_PAGE;
  if (selected) closeDetail(false);
  render();
  updateUrl();
  drawHere();
  if (!here) return;
  // Frame the place with its closest few spots.
  const dist = (s) => Catalogue.haversineM(here.lat, here.lon, s.lat, s.lon);
  const closest = [...matching].sort((a, b) => dist(a) - dist(b)).slice(0, 5);
  const bounds = L.latLngBounds([[here.lat, here.lon], ...closest.map((s) => [s.lat, s.lon])]);
  map.fitBounds(bounds, { padding: [40, 40], paddingBottomRight: [40, 40 + sheet.px()], maxZoom: 12,
                          animate: !reducedMotion() });
}

let hereMarker = null;
function drawHere() {
  if (hereMarker) { hereMarker.remove(); hereMarker = null; }
  if (!here) return;
  hereMarker = L.marker([here.lat, here.lon], {
    icon: L.divIcon({ className: "here", iconSize: [18, 18] }),
    interactive: false, keyboard: false, zIndexOffset: 1500,
  }).addTo(map);
}

// ------------------------------------------------------------------------------ spot detail
function contactRows(s) {
  const A = window.Astronomy;
  if (!A) return "";
  const e = A.SearchLocalSolarEclipse(new A.AstroTime(new Date(Date.UTC(2028, 6, 21))),
    new A.Observer(s.lat, s.lon, s.elev + 1.7));
  const time = (ev, seconds) => {
    const d = new Date(ev.time.date.getTime() + 12 * 3600 * 1000);     // NZST = UTC + 12
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = seconds ? `:${String(d.getUTCSeconds()).padStart(2, "0")}` : "";
    return `${d.getUTCHours() % 12 || 12}:${mm}${ss} pm`;
  };
  return [
    ["Eclipse begins", e.partial_begin, false],
    ["Totality begins", e.total_begin, true],
    ["Maximum", e.peak, false],
    ["Totality ends", e.total_end, true],
    ["Eclipse ends", e.partial_end, false],
  ].filter(([, ev]) => ev).map(([label, ev, strong]) =>
    `<tr${strong ? ' class="strong"' : ""}><td>${label}</td><td>${
      ev.altitude < 0 ? "After sunset" : time(ev, strong)}</td></tr>`).join("");
}

function factRow(label, value) {
  return value ? `<div><dt>${label}</dt><dd>${value}</dd></div>` : "";
}

function detailHtml(s) {
  const clear = s.level === "clear";
  const tight = clear && s.clearance < Catalogue.TIGHT_CLEARANCE;
  const kind = s.isPreset ? "Town centre" : s.isPoi ? (POI_LABEL[s.kind] || "Spot") : "Scanned spot";
  const look = s.level === "blocked"
    ? `Terrain stands ${Math.abs(s.clearance).toFixed(1)}° above the sun on its bearing, to the ${Places.compassName(s.sunAz)}.`
    : `Look ${Places.compassName(s.sunAz)}, ${Places.heightPhrase(s.sunAlt)}. The sun clears the skyline by ${s.clearance.toFixed(1)}°.`;

  const notes = [];
  if (s.level === "partial") notes.push("The skyline cuts in during totality, so you would lose part of it.");
  if (tight) notes.push("This margin is tight. The elevation data can be about 0.6° out near a ridge, so check the spot in person.");
  if (s.totality < 60) notes.push(`Near the edge of the path, with only ${minutes(s.totality)} of totality.`);
  if (s.publicAccess === false) notes.push("No verified public land or road here. You may need the landowner’s permission.");

  let fix = "";
  if (!clear) {
    const near = Catalogue.nearestClearSpot(catalogue, s.lat, s.lon);
    if (near) {
      const km = near.km.toFixed(near.km < 10 ? 1 : 0);
      fix = `<button id="goNearest" type="button" class="action action--primary">Go to ${esc(near.spot.name)}<small>${km} km to the ${Places.compassName(near.bearing)}, clear for all of totality</small></button>`;
    }
  }

  const url = `index.html?lat=${s.lat}&lon=${s.lon}&name=${encodeURIComponent(nameOf(s))}`;
  const away = awayText(s);
  const lowCloud = s.cloudLow > 18 ? `${s.cloudLow.toFixed(0)}% of the time` : "";
  return `
    <h2 id="detailTitle" tabindex="-1">${esc(nameOf(s))}</h2>
    <p class="detail-kind">${esc(kind)} at ${s.elev} m</p>
    <p class="detail-verdict ${clear ? "" : "detail-verdict--no"}">${Catalogue.TOTALITY_TEXT[s.level]}</p>
    <p class="detail-look">${look}</p>
    ${notes.map((n) => `<p class="detail-note">${esc(n)}</p>`).join("")}
    ${fix}
    <table class="contacts">${contactRows(s)}</table>
    <dl class="facts">
      ${factRow("Totality lasts", minutes(s.totality))}
      ${factRow("From here", away && away !== "Here" ? esc(away) : "")}
      ${s.isPreset ? "" : factRow("Getting there", esc(accessText(s)))}
      ${factRow("Land", esc(s.land))}
      ${factRow("Trail", esc(s.trackName))}
      ${factRow("Chance of clear sky", s.clearProb != null ? `${s.clearProb.toFixed(0)}%, from past Julys` : "")}
      ${factRow("Low cloud or fog", lowCloud)}
      ${factRow("Coordinates", `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`)}
    </dl>
    <div class="actions no-print">
      <a class="action ${clear ? "action--primary" : ""}" href="${url}" id="open3d" data-name="${esc(nameOf(s))}">Stand here in 3D</a>
      <a class="action" href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}" target="_blank" rel="noopener">Open in Google Maps</a>
      <button id="printCard" type="button" class="action">Print field card</button>
      <button id="showContours" type="button" class="action">Show contour map</button>
    </div>
    <figure id="contourFigure" hidden>
      <canvas id="contourCanvas" width="640" height="400" role="img"
        aria-label="Contour map centred on this spot, with a line along the sun's bearing at totality"></canvas>
      <figcaption id="contourCaption"></figcaption>
    </figure>
    <p class="fine">Check this spot in person before the day. Road access is not permission to enter.
      Wear eclipse glasses for every partial phase. Independent planning tool, not yet validated.</p>`;
}

function openDetail(s, opts = {}) {
  if (!selected) listScroll = q("panelScroll").scrollTop;
  selected = s;
  contourToken++;
  q("detailBody").innerHTML = detailHtml(s);
  q("listView").hidden = true;
  q("detailView").hidden = false;
  q("panelScroll").scrollTop = 0;
  if (sheet.state === "peek") sheet.set("half");

  q("printCard").addEventListener("click", () => window.print());
  q("showContours").addEventListener("click", () => drawContours(s));
  const go = q("goNearest");
  if (go) go.addEventListener("click", () => {
    const near = Catalogue.nearestClearSpot(catalogue, s.lat, s.lon);
    openDetail({ ...near.spot, isPoi: true });
  });
  q("open3d").addEventListener("click", (e) =>
    trackMetric("map_filter", "open_3d", e.currentTarget.dataset.name));

  renderMarks();
  if (!opts.quiet) {
    showOnMap(s.lat, s.lon, Math.max(map.getZoom(), 11));
    q("detailTitle").focus({ preventScroll: true });
  }
  updateUrl();
}

function closeDetail(restoreFocus = true) {
  selected = null;
  contourToken++;
  q("detailView").hidden = true;
  q("listView").hidden = false;
  q("panelScroll").scrollTop = listScroll;
  renderMarks();
  updateUrl();
  if (restoreFocus) q("placeSearch").focus({ preventScroll: true });
}

// One spot's contours, on request: drawn in the browser from the same elevation tiles the
// catalogue was built on, so this takes no API key and adds nothing to the catalogue.
const TERRARIUM = "https://terrain.reearth.land/terrarium/elevation";
const CONTOUR_ZOOM = 11, CONTOUR_SPAN_M = 7000, TILE = 512;

async function drawContours(s) {
  const token = ++contourToken;
  const figure = q("contourFigure"), caption = q("contourCaption"), btn = q("showContours");
  const canvas = q("contourCanvas");
  figure.hidden = false;
  btn.disabled = true;
  caption.textContent = "Loading elevation data…";
  try {
    const W = canvas.width, H = canvas.height;
    const res = Contours.metresPerPixel(s.lat, CONTOUR_ZOOM, TILE);
    const c = Contours.worldPixel(s.lat, s.lon, CONTOUR_ZOOM, TILE);
    const srcW = CONTOUR_SPAN_M / res, srcH = srcW * (H / W);
    const x0 = Math.floor(c.x - srcW / 2), y0 = Math.floor(c.y - srcH / 2);
    const gw = Math.ceil(srcW) + 2, gh = Math.ceil(srcH) + 2;
    const grid = new Float32Array(gw * gh);

    await Promise.all(Contours.tilesCovering(x0, y0, x0 + gw, y0 + gh, TILE).map(async (t) => {
      const r = await fetch(`${TERRARIUM}/${CONTOUR_ZOOM}/${t.x}/${t.y}.png`);
      if (!r.ok) throw new Error(`tile ${r.status}`);
      const bmp = await createImageBitmap(await r.blob());
      const off = document.createElement("canvas");
      off.width = bmp.width; off.height = bmp.height;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const ox = t.x * TILE, oy = t.y * TILE;
      for (let y = Math.max(y0, oy); y < Math.min(y0 + gh, oy + TILE); y++) {
        for (let x = Math.max(x0, ox); x < Math.min(x0 + gw, ox + TILE); x++) {
          const i = ((y - oy) * TILE + (x - ox)) * 4;
          grid[(y - y0) * gw + (x - x0)] = Contours.terrariumMetres(data[i], data[i + 1], data[i + 2]);
        }
      }
    }));
    if (token !== contourToken) return;

    const left = c.x - srcW / 2 - x0, top = c.y - srcH / 2 - y0;
    const px = Contours.contourImage({
      width: W, height: H,
      elevationAt: (x, y) => Contours.sampleBilinear(grid, gw, gh, left + (x / W) * srcW, top + (y / H) * srcH),
    });
    const ctx = canvas.getContext("2d");
    ctx.putImageData(new ImageData(px, W, H), 0, 0);

    // The line to look along, from the spot to the edge of the map.
    const a = (s.sunAz * Math.PI) / 180;
    const cx = W / 2, cy = H / 2, reach = Math.min(W, H) * 0.46;
    const ex = cx + Math.sin(a) * reach, ey = cy - Math.cos(a) * reach;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0A1016"; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = "#F5B83D"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = "#0A1016";
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();

    // A one-kilometre scale bar and north, in the corner the sun line never reaches.
    const barPx = (1000 / CONTOUR_SPAN_M) * W;
    ctx.fillStyle = "#0A1016";
    ctx.fillRect(W - barPx - 20, H - 24, barPx, 5);
    ctx.font = '600 20px Overpass, "Segoe UI", sans-serif';
    ctx.textAlign = "right";
    ctx.fillText("1 km", W - 20, H - 36);
    ctx.fillText("N ↑", W - 20, 30);

    caption.textContent = "50 m contours, with the sun’s bearing at totality. Elevation: Re:Earth Terrain, Mapterhorn (CC BY 4.0).";
    btn.hidden = true;
  } catch (e) {
    if (token !== contourToken) return;
    figure.hidden = true;
    btn.disabled = false;
    btn.textContent = "Elevation data did not load. Try again";
  }
}

// ------------------------------------------------------------------------------ the address bar
function updateUrl() {
  try {
    const u = new URLSearchParams();
    if (here && here.url) {
      u.set("near", `${here.lat.toFixed(4)},${here.lon.toFixed(4)}`);
      u.set("place", here.name);
    }
    if (selected) u.set("spot", keyOf(selected));
    const s = u.toString();
    history.replaceState(null, "", location.pathname + (s ? `?${s}` : ""));
  } catch (e) { /* a stale URL is better than a broken page */ }
}

function applyUrl() {
  const u = new URLSearchParams(location.search);
  const near = Places.parseCoords((u.get("near") || "").replace(",", " "));
  if (near && Places.inNzBounds(near.lat, near.lon)) {
    setHere({ name: (u.get("place") || "this place").slice(0, 40), ...near, url: true });
  }
  const key = u.get("spot");
  if (key) {
    const pool = [
      ...catalogue.pois.map((p) => ({ ...p, isPoi: true })),
      ...catalogue.spots,
      ...(catalogue.presets || []).map((p) => ({ ...p, isPreset: true })),
    ];
    const hit = pool.find((s) => keyOf(s) === key);
    if (hit) openDetail(hit);
  }
}

// ------------------------------------------------------------------------------ boot
async function load() {
  try {
    const res = await fetch("viewpoints.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("not found");
    catalogue = await res.json();
    if (!catalogue.pois || !catalogue.pois.length) throw new Error("empty");
    render();
    renderTowns();
    renderCloudOverlay();
    map.fitBounds(L.latLngBounds(catalogue.pois.map((s) => [s.lat, s.lon])), {
      padding: [20, 20], paddingBottomRight: [20, 20 + sheet.px()], animate: false,
    });
    q("status").textContent = `Catalogue built ${(catalogue.generated || "").slice(0, 10)}.`;
    applyUrl();
  } catch (e) {
    q("count").textContent = "The viewing spots did not load. Reload the page to try again.";
  }
}

function getMetricSessionId() {
  try {
    let sid = sessionStorage.getItem("eclipseMetricSid");
    if (!sid || !/^[0-9a-f]{8}$/.test(sid)) {
      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      sid = arr[0].toString(16).padStart(8, "0");
      sessionStorage.setItem("eclipseMetricSid", sid);
    }
    return sid;
  } catch (e) {
    return "";
  }
}

function trackMetric(event, detail = "", spot = "") {
  try {
    if ((location.hostname === "localhost" || location.hostname === "127.0.0.1") && !window.__TEST_METRICS) return;
    if (navigator.sendBeacon) {
      const sid = getMetricSessionId();
      navigator.sendBeacon("/api/metric", JSON.stringify({ event, detail, spot, sid }));
    }
  } catch (e) {}
}

function wire() {
  wireSheet();
  const refilter = () => { listLimit = LIST_PAGE; render(); };

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const want = chip.dataset.access;
      const on = !access.has(want);
      if (on) access.add(want); else access.delete(want);
      chip.setAttribute("aria-pressed", String(on));
      refilter();
    });
  });
  for (const id of ["publicOnly", "minClear", "minSky", "includeOffTrack"]) {
    q(id).addEventListener("input", refilter);
  }
  q("includeUnnamed").addEventListener("input", (e) => {
    trackMetric("map_filter", e.target.checked ? "both" : "poi");
    refilter();
  });
  q("showCloud").addEventListener("change", renderCloudOverlay);
  q("showMore").addEventListener("click", () => { listLimit += LIST_PAGE; renderList(); });
  q("backToList").addEventListener("click", () => closeDetail());
  q("clearHere").addEventListener("click", () => {
    setHere(null);
    q("placeSearch").focus({ preventScroll: true });
  });
  q("nearMe").addEventListener("click", useMyLocation);
  q("searchForm").addEventListener("submit", (e) => { e.preventDefault(); });

  const input = q("placeSearch");
  input.addEventListener("input", () => {
    setStatus("");
    const v = input.value.trim();
    clearTimeout(suggestTimer);
    if (v.length < 3 || Places.parseCoords(v)) { hideSuggestions(); return; }
    suggestTimer = setTimeout(() => fetchSuggestions(v), 400);
  });
  input.addEventListener("keydown", (e) => {
    const open = !q("suggestions").hidden && suggestItems.length;
    const mark = () => [...q("suggestions").children].forEach((el, i) =>
      el.classList.toggle("active", i === suggestActive));
    if (open && e.key === "ArrowDown") { e.preventDefault(); suggestActive = Math.min(suggestActive + 1, suggestItems.length - 1); mark(); }
    else if (open && e.key === "ArrowUp") { e.preventDefault(); suggestActive = Math.max(suggestActive - 1, 0); mark(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (open && suggestActive >= 0) chooseSuggestion(suggestActive); else searchNow();
    } else if (e.key === "Escape") hideSuggestions();
  });
  input.addEventListener("blur", () => setTimeout(hideSuggestions, 150));

  map.on("zoomend", () => { renderMarks(); syncBands(); });

  // The contact address is built at runtime rather than shipped in the markup. That stops naive
  // harvesters that regex the served HTML; it does not stop a scraper that runs JS.
  const addr = ["michael", "davies.net.nz"].join("@");
  q("contactLink").href = `mailto:${addr}?subject=${encodeURIComponent("Otago Eclipse 3D")}`;
  q("contactAddr").textContent = addr;

  const about = q("aboutOverlay");
  const showAbout = (on) => {
    about.classList.toggle("hidden", !on);
    if (on) q("aboutClose").focus();
  };
  q("aboutBtn").addEventListener("click", () => showAbout(true));
  q("aboutClose").addEventListener("click", () => showAbout(false));
  about.addEventListener("click", (e) => { if (e.target === about) showAbout(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!about.classList.contains("hidden")) showAbout(false);
    else if (selected) closeDetail();
  });
}

wire();
lucide.createIcons();
trackMetric("page_view", "map");
renderEclipsePath();
syncBands();
load();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
