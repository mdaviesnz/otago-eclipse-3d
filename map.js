// The overview map: everything map.html does once the markup is on screen.
//
// A classic script, loaded with `defer` after Leaflet, Lucide and the catalogue module. Its
// top-level names are deliberately global: the smoke tests reach `layer`, `catalogue` and the
// rest by name.

// ====================================================================================
//  Overview map of the precomputed viewing-spot catalogue.
//  Reads the same viewpoints.json as index.html and applies the same access tiers, plus
//  granular surface/trail sub-types and Herenga a Nuku public access metadata.
// ====================================================================================
const ACCESS_COLOUR = { sealed: "#34d399", track: "#fbbf24", foot: "#60a5fa", none: "#94a3b8" };
const ACCESS_SUB_COLOUR = {
  sealed_road: "#34d399",
  gravel_road: "#a3e635",
  "4wd_track": "#fbbf24",
  walking_track: "#60a5fa",
  cycle_trail: "#38bdf8",
  paper_road: "#60a5fa",
  off_track: "#94a3b8",
};
const ACCESS_LABEL = { sealed: "sealed road", track: "4WD track", foot: "walking track", none: "off-track" };
const ACCESS_SUB_LABEL = {
  sealed_road: "sealed road",
  gravel_road: "gravel road",
  "4wd_track": "4WD track",
  walking_track: "walking track",
  cycle_trail: "cycle trail",
  paper_road: "unformed legal road (paper road)",
  off_track: "off-track — alpine",
};
const POI_LABEL = { viewpoint: "viewpoint", peak: "summit", picnic: "picnic area",
  campsite: "campsite", rest_area: "rest area", tower: "lookout tower" };

// Place zoom control at bottomright so the top-left filter panel never covers it.
const map = L.map("map", { zoomControl: false, preferCanvas: true })
  .setView([-45.2, 169.2], 8);
L.control.zoom({ position: "bottomright" }).addTo(map);

// Same imagery as the 3D view, so the two look like one product.
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 17, attribution: "Imagery: Esri, Maxar, Earthstar Geographics" }
).addTo(map);
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 17, opacity: 0.9 }
).addTo(map);

const cloudLayer = L.layerGroup().addTo(map);
const pathLayer = L.layerGroup().addTo(map);
const layer = L.layerGroup().addTo(map);
const townLayer = L.layerGroup().addTo(map);
let catalogue = null;
let source = "poi";
let cloudOverlay = null;

function renderCloudOverlay() {
  cloudLayer.clearLayers();
  const show = document.getElementById("showCloud");
  const legendSec = document.getElementById("cloudLegendSection");
  if (!show || !show.checked || !catalogue || !catalogue.cloudGrid) {
    if (legendSec) legendSec.classList.add("hidden");
    return;
  }
  if (legendSec) legendSec.classList.remove("hidden");

  const cg = catalogue.cloudGrid;
  const lats = cg.lats;
  const lons = cg.lons;
  const cfc = cg.cfcDay;
  const nLat = lats.length;
  const nLon = lons.length;

  const dlat = cg.dlat || 0.25;
  const dlon = cg.dlon || 0.25;
  const south = lats[0] - dlat / 2;
  const north = lats[nLat - 1] + dlat / 2;
  const west = lons[0] - dlon / 2;
  const east = lons[nLon - 1] + dlon / 2;

  const canvas = document.createElement("canvas");
  const width = 180;
  const height = Math.round(width * ((north - south) / (east - west)));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  function getColor(val) {
    const t = Math.max(0, Math.min(1, (val - 42) / 46));
    let r, g, b, a;
    if (t < 0.25) {
      const f = t / 0.25;
      r = 2 + f * (56 - 2);
      g = 132 + f * (189 - 132);
      b = 199 + f * (248 - 199);
      a = 0.50 + f * 0.05;
    } else if (t < 0.55) {
      const f = (t - 0.25) / 0.30;
      r = 56 + f * (129 - 56);
      g = 189 + f * (140 - 189);
      b = 248 + f * (248 - 248);
      a = 0.55 + f * 0.05;
    } else if (t < 0.80) {
      const f = (t - 0.55) / 0.25;
      r = 129 + f * (203 - 129);
      g = 140 + f * (213 - 140);
      b = 248 + f * (225 - 248);
      a = 0.60 + f * 0.08;
    } else {
      const f = (t - 0.80) / 0.20;
      r = 203 + f * (248 - 203);
      g = 213 + f * (250 - 213);
      b = 225 + f * (252 - 225);
      a = 0.68 + f * 0.12;
    }
    return [Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)];
  }

  for (let py = 0; py < height; py++) {
    const lat = north - (py / (height - 1)) * (north - south);
    const gy = (lat - lats[0]) / dlat;
    const yClamped = Math.max(0, Math.min(nLat - 1, gy));
    const y0 = Math.floor(yClamped);
    const y1 = Math.min(nLat - 1, y0 + 1);
    const fy = yClamped - y0;

    for (let px = 0; px < width; px++) {
      const lon = west + (px / (width - 1)) * (east - west);
      const gx = (lon - lons[0]) / dlon;
      const xClamped = Math.max(0, Math.min(nLon - 1, gx));
      const x0 = Math.floor(xClamped);
      const x1 = Math.min(nLon - 1, x0 + 1);
      const fx = xClamped - x0;

      const v00 = cfc[y0][x0];
      const v01 = cfc[y0][x1];
      const v10 = cfc[y1][x0];
      const v11 = cfc[y1][x1];
      const val = (1 - fy) * ((1 - fx) * v00 + fx * v01) + fy * ((1 - fx) * v10 + fx * v11);

      const [r, g, b, alpha] = getColor(val);
      const idx = (py * width + px) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = alpha;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  cloudOverlay = L.imageOverlay(dataUrl, [[south, west], [north, east]], {
    opacity: 0.65,
    interactive: false,
  }).addTo(cloudLayer);
}

// Precomputed 22 July 2028 eclipse path & partial obscuration bands across the Tasman / NZ
// (astronomy-engine local solar eclipse circumference + sunset terminus).
const ECLIPSE_PATH = {"totalityPoly":[[-28.732,146],[-29.526,147],[-30.312,148],[-31.089,149],[-31.856,150],[-32.612,151],[-33.358,152],[-34.092,153],[-34.815,154],[-35.525,155],[-36.223,156],[-36.909,157],[-37.582,158],[-38.243,159],[-38.891,160],[-39.527,161],[-40.15,162],[-40.762,163],[-41.361,164],[-41.948,165],[-42.524,166],[-43.087,167],[-43.639,168],[-44.18,169],[-44.709,170],[-45.228,171],[-45.736,172],[-46.233,173],[-46.719,174],[-47.196,175],[-47.662,176],[-48.118,177],[-48.565,178],[-49.002,179],[-49.43,180],[-49.848,181],[-50.071,181.542],[-50.294,181.647],[-50.517,181.488],[-50.74,181.327],[-50.963,181.164],[-51.186,181],[-51.199,180],[-50.785,179],[-50.362,178],[-49.93,177],[-49.489,176],[-49.038,175],[-48.577,174],[-48.106,173],[-47.625,172],[-47.134,171],[-46.633,170],[-46.12,169],[-45.597,168],[-45.063,167],[-44.518,166],[-43.961,165],[-43.393,164],[-42.813,163],[-42.222,162],[-41.618,161],[-41.003,160],[-40.376,159],[-39.736,158],[-39.085,157],[-38.421,156],[-37.745,155],[-37.057,154],[-36.357,153],[-35.646,152],[-34.923,151],[-34.189,150],[-33.444,149],[-32.689,148],[-31.925,147],[-31.152,146]],"totalityNorth":[[-28.732,146],[-29.526,147],[-30.312,148],[-31.089,149],[-31.856,150],[-32.612,151],[-33.358,152],[-34.092,153],[-34.815,154],[-35.525,155],[-36.223,156],[-36.909,157],[-37.582,158],[-38.243,159],[-38.891,160],[-39.527,161],[-40.15,162],[-40.762,163],[-41.361,164],[-41.948,165],[-42.524,166],[-43.087,167],[-43.639,168],[-44.18,169],[-44.709,170],[-45.228,171],[-45.736,172],[-46.233,173],[-46.719,174],[-47.196,175],[-47.662,176],[-48.118,177],[-48.565,178],[-49.002,179],[-49.43,180],[-49.848,181]],"totalitySouth":[[-31.152,146],[-31.925,147],[-32.689,148],[-33.444,149],[-34.189,150],[-34.923,151],[-35.646,152],[-36.357,153],[-37.057,154],[-37.745,155],[-38.421,156],[-39.085,157],[-39.736,158],[-40.376,159],[-41.003,160],[-41.618,161],[-42.222,162],[-42.813,163],[-43.393,164],[-43.961,165],[-44.518,166],[-45.063,167],[-45.597,168],[-46.12,169],[-46.633,170],[-47.134,171],[-47.625,172],[-48.106,173],[-48.577,174],[-49.038,175],[-49.489,176],[-49.93,177],[-50.362,178],[-50.785,179],[-51.199,180],[-51.186,181]],"totalityCenter":[[-29.963,146],[-30.702,147],[-31.48,148],[-32.245,149],[-33.004,150],[-33.748,151],[-34.482,152],[-35.207,153],[-35.913,154],[-36.615,155],[-37.299,156],[-37.976,157],[-38.638,158],[-39.328,159],[-39.964,160],[-40.554,161],[-41.164,162],[-41.767,163],[-42.358,164],[-42.934,165],[-43.5,166],[-44.056,167],[-44.598,168],[-45.163,169],[-45.65,170],[-46.198,171],[-46.66,172],[-47.15,173],[-47.661,174],[-48.097,175],[-48.554,176],[-49.004,177],[-49.444,178],[-49.91,179],[-50.293,180],[-50.745,181],[-50.517,181.488]],"bands":{"p90":[[-24.82,146],[-26.43,148],[-28,150],[-29.53,152],[-31.02,154],[-32.46,156],[-33.85,158],[-35.19,160],[-36.48,162],[-37.72,164],[-38.92,166],[-40.06,168],[-41.15,170],[-42.2,172],[-43.21,174],[-44.17,176],[-45.1,178],[-45.98,180],[-46.83,182],[-47.25,183.04],[-47.68,183.4],[-48.1,183.12],[-48.52,182.85],[-48.94,182.57],[-49.37,182.29],[-49.79,182],[-52.49,180],[-54.1,178],[-53.24,176],[-52.35,174],[-51.42,172],[-50.45,170],[-49.43,168],[-48.38,166],[-47.28,164],[-46.13,162],[-44.94,160],[-43.7,158],[-42.41,156],[-41.08,154],[-39.69,152],[-38.27,150],[-36.79,148],[-35.28,146]],"p75":[[-19.78,146],[-21.4,148],[-23.01,150],[-24.58,152],[-26.11,154],[-27.59,156],[-29.02,158],[-30.4,160],[-31.73,162],[-33,164],[-34.24,166],[-35.41,168],[-36.53,170],[-37.61,172],[-38.65,174],[-39.64,176],[-40.58,178],[-41.5,180],[-42.36,182],[-43.19,184],[-43.69,185.25],[-44.2,185.45],[-44.7,185.17],[-45.2,184.88],[-45.7,184.59],[-46.21,184.3],[-46.71,184],[-49.79,182],[-52.49,180],[-54.82,178],[-56.85,176],[-57.98,174],[-57.06,172],[-56.11,170],[-55.12,168],[-54.09,166],[-53.02,164],[-51.89,162],[-50.72,160],[-49.5,158],[-48.23,156],[-46.93,154],[-45.57,152],[-44.17,150],[-42.72,148],[-41.23,146]],"p50":[[-11.46,146],[-13.1,148],[-14.75,150],[-16.37,152],[-17.96,154],[-19.52,156],[-21.02,158],[-22.47,160],[-23.86,162],[-25.21,164],[-26.5,166],[-27.74,168],[-28.92,170],[-30.06,172],[-31.15,174],[-32.19,176],[-33.19,178],[-34.14,180],[-35.05,182],[-35.91,184],[-37.45,187.78],[-39,188],[-40.54,187.39],[-42.08,186.6],[-43.62,185.77],[-45.17,184.9],[-46.71,184],[-49.79,182],[-52.49,180],[-54.82,178],[-56.85,176],[-58.6,174],[-60.13,172],[-61.46,170],[-62.63,168],[-63.67,166],[-64.57,164],[-64.52,162],[-63.35,160],[-62.11,158],[-60.84,156],[-59.5,154],[-58.14,152],[-56.71,150],[-55.23,148],[-53.73,146]]}};

function renderEclipsePath() {
  pathLayer.clearLayers();
  const show = document.getElementById("showPath");
  const legendSec = document.getElementById("pathLegendSection");
  if (show && !show.checked) {
    if (legendSec) legendSec.classList.add("hidden");
    return;
  }
  if (legendSec) legendSec.classList.remove("hidden");

  // Partial obscuration bands (outer to inner; low fillOpacity since nested bands stack)
  const bandSpecs = [
    { key: "p50", fill: "#fef08a", fillOpacity: 0.03, stroke: "#fde047", weight: 1, opacity: 0.32 },
    { key: "p75", fill: "#fbbf24", fillOpacity: 0.04, stroke: "#fbbf24", weight: 1, opacity: 0.42 },
    { key: "p90", fill: "#fb923c", fillOpacity: 0.05, stroke: "#fb923c", weight: 1.2, opacity: 0.52 },
  ];
  for (const b of bandSpecs) {
    const coords = ECLIPSE_PATH.bands && ECLIPSE_PATH.bands[b.key];
    if (!coords) continue;
    L.polygon(coords, {
      color: b.stroke,
      weight: b.weight,
      opacity: b.opacity,
      fillColor: b.fill,
      fillOpacity: b.fillOpacity,
      interactive: false,
    }).addTo(pathLayer);
  }

  // Path of totality polygon
  L.polygon(ECLIPSE_PATH.totalityPoly, {
    color: "#f59e0b",
    weight: 1.6,
    opacity: 0.8,
    fillColor: "#f59e0b",
    fillOpacity: 0.10,
    interactive: false,
  }).addTo(pathLayer);

  // Northern and southern totality limits
  for (const lim of [ECLIPSE_PATH.totalityNorth, ECLIPSE_PATH.totalitySouth]) {
    L.polyline(lim, {
      color: "#fbbf24",
      weight: 2,
      opacity: 0.9,
      interactive: false,
    }).addTo(pathLayer);
  }

  // Centreline (maximum duration)
  L.polyline(ECLIPSE_PATH.totalityCenter, {
    color: "#fde68a",
    weight: 1.6,
    opacity: 0.85,
    dashArray: "6 5",
    interactive: false,
  }).addTo(pathLayer);
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dur = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;

function entries() {
  if (!catalogue) return [];
  const pois = (catalogue.pois || []).map((p) => ({ ...p, isPoi: true }));
  const grid = (catalogue.spots || []).map((s) => ({ ...s, isPoi: false }));
  return source === "poi" ? pois : source === "grid" ? grid : pois.concat(grid);
}

function renderTowns() {
  townLayer.clearLayers();
  if (!catalogue || !Array.isArray(catalogue.presets)) return;
  for (const t of catalogue.presets) {
    // Verdicts are precomputed (docs/adr/0001-precomputed-verdicts.md): read, never judged here.
    const clear = t.level === "clear";
    const url = `index.html?lat=${t.lat}&lon=${t.lon}&name=${encodeURIComponent(t.name)}`;
    const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${t.lat},${t.lon}`;
    const verdictHtml = t.level === "blocked"
      ? `<span style="color:#f87171">Blocked by ${Math.abs(t.clearance).toFixed(1)}&deg;</span>`
      : t.level === "partial"
      ? `<span style="color:#fbbf24">Part of totality blocked</span>`
      : `<span style="color:#6ee7b7">+${t.clearance.toFixed(1)}&deg; clear</span>`;
    const popup = `
      <div style="min-width:190px">
        <div style="font-weight:700;color:#fbbf24">${esc(t.name)} (town centre)</div>
        <div style="color:#94a3b8;font-size:11px;margin-bottom:6px">Reference preset &middot; ${t.elev} m</div>
        <table style="font-size:11px;width:100%">
          <tr><td style="color:#94a3b8">Town centre view</td><td style="text-align:right">${verdictHtml}</td></tr>
          <tr><td style="color:#94a3b8">Sun at maximum</td><td style="text-align:right">${t.sunAlt.toFixed(1)}&deg;</td></tr>
          <tr><td style="color:#94a3b8">Totality</td><td style="text-align:right">${dur(t.totality)}</td></tr>
          ${t.cloud != null ? `<tr><td style="color:#94a3b8">July cloud cover</td><td style="text-align:right;color:#e2e8f0">${t.cloud.toFixed(0)}% <span style="color:#38bdf8">(${t.clearProb != null ? t.clearProb.toFixed(0) + "% clear" : ""})</span></td></tr>` : ""}
        </table>
        <a href="${url}" style="display:block;margin-top:8px;text-align:center;background:#f59e0b;color:#0f172a;font-weight:600;border-radius:6px;padding:5px 8px;text-decoration:none">
          Open in 3D &rarr;
        </a>
        <a href="${gmapsUrl}" target="_blank" rel="noopener" style="display:block;margin-top:6px;text-align:center;background:#1e293b;border:1px solid #475569;color:#e2e8f0;font-weight:500;font-size:11px;border-radius:6px;padding:5px 8px;text-decoration:none">
          Open in Google Maps &nearr;
        </a>
      </div>`;
    L.circleMarker([t.lat, t.lon], {
      radius: 6.5,
      color: clear ? "#fbbf24" : "#f87171",
      weight: 2.2,
      fillColor: "#0f172a",
      fillOpacity: 0.92,
    })
      .bindTooltip(t.name, { permanent: true, direction: "right", offset: [8, 0], className: "town-tooltip" })
      .bindPopup(popup)
      .addTo(townLayer);
  }
}

function formatTrackName(raw) {
  if (!raw) return "";
  if (raw === raw.toUpperCase() && raw !== raw.toLowerCase()) {
    return raw.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(4wd|Doc|Sh)\b/g, (m) => m.toUpperCase());
  }
  return raw;
}

function render() {
  const want = document.getElementById("accessFilter").value;
  const minClear = document.getElementById("clearFilter").value / 10;
  const cloudFilterEl = document.getElementById("cloudFilter");
  const maxCloud = cloudFilterEl ? parseFloat(cloudFilterEl.value) : 70;
  const wholeOnly = document.getElementById("wholeOnly").checked;
  const publicOnlyEl = document.getElementById("publicOnly");
  const publicOnly = publicOnlyEl ? publicOnlyEl.checked : false;
  document.getElementById("clearVal").textContent = minClear.toFixed(1) + "°";
  const cloudEl = document.getElementById("cloudVal");
  if (cloudEl) {
    cloudEl.innerHTML = maxCloud >= 70 ? "Any" : `&le;&nbsp;${maxCloud}% <span class="text-[10px] text-slate-400 font-normal">(${100 - maxCloud}% clear)</span>`;
  }

  const list = entries().filter((s) =>
    Catalogue.matchesAccess(s, want) &&
    (!publicOnly || s.publicAccess !== false) &&
    s.clearance >= minClear &&
    (!wholeOnly || s.level === "clear") &&
    (maxCloud >= 70 || s.cloud == null || s.cloud <= maxCloud));

  const isCoarsePointer = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const baseRadius = isCoarsePointer ? 4.5 : 3;
  layer.clearLayers();
  for (const s of list) {
    const colour = (s.accessSub && ACCESS_SUB_COLOUR[s.accessSub]) || ACCESS_COLOUR[s.access || "none"];
    const isPrivate = s.publicAccess === false;
    // Kept deliberately small and semi-transparent: lookouts cluster tightly along ridges,
    // and larger opaque markers merge into unreadable blobs once you zoom in.
    const radius = baseRadius + Math.min(4, Math.max(0, s.clearance) * 0.4);
    L.circleMarker([s.lat, s.lon], {
      radius,
      color: isPrivate ? "#f87171" : (s.isPoi ? "#f8fafc" : colour),
      weight: s.isPoi ? 1.3 : 0.8,
      fillColor: colour,
      fillOpacity: isPrivate ? 0.45 : 0.72,
      opacity: isPrivate ? 0.75 : 0.9,
    }).bindPopup(popupHtml(s)).addTo(layer);
  }

  const total = entries().length;
  const summaryText = `${list.length} of ${total} shown`;
  document.getElementById("count").textContent = summaryText;
  const badge = document.getElementById("mobileCountBadge");
  if (badge) badge.textContent = `${list.length} spots`;
}

function popupHtml(s) {
  const title = s.isPoi
    ? (s.name || `Unnamed ${POI_LABEL[s.kind] || "spot"}`)
    : `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;
  const sub = s.isPoi ? (POI_LABEL[s.kind] || s.kind) : "scanned spot";
  const url = `index.html?lat=${s.lat}&lon=${s.lon}&name=${encodeURIComponent(title)}`;
  const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`;
  const accessLabel = (s.accessSub && ACCESS_SUB_LABEL[s.accessSub]) || ACCESS_LABEL[s.access || "none"];
  const landRow = s.land
    ? `<tr><td style="color:#94a3b8;padding-right:8px">Public land</td><td style="text-align:right;color:#e2e8f0">${esc(s.land)}</td></tr>`
    : "";
  const trailRow = s.trackName
    ? `<tr><td style="color:#94a3b8;padding-right:8px">Trail</td><td style="text-align:right;color:#e2e8f0">${esc(formatTrackName(s.trackName))}</td></tr>`
    : "";
  const publicRow = s.isPoi
    ? (s.publicAccess === false
        ? `<tr><td style="color:#94a3b8;padding-right:8px">Tenure</td><td style="text-align:right;color:#f87171">Private / unverified</td></tr>`
        : `<tr><td style="color:#94a3b8;padding-right:8px">Tenure</td><td style="text-align:right;color:#6ee7b7">Public access</td></tr>`)
    : "";
  // Near the edge of the path totality collapses to seconds — worth calling out, since a
  // great horizon there still buys you far less than the ~3 minutes on the centreline.
  const warn = (s.publicAccess === false
      ? `<div style="color:#f87171;margin-top:4px;font-size:11px">&#9888; No verified public land or road parcel &mdash; landowner permission may be required</div>` : "")
    + (s.level !== "clear"
      ? `<div style="color:#fbbf24;margin-top:4px">&#9888; blocked for part of totality</div>` : "")
    + (s.totality < 60
      ? `<div style="color:#fbbf24;margin-top:4px">&#9888; near the path edge &mdash; only ${dur(s.totality)} of totality</div>` : "");
  return `
    <div style="min-width:205px">
      <div style="font-weight:600;color:#f8fafc">${esc(title)}</div>
      <div style="color:#94a3b8;font-size:11px;margin-bottom:6px">${esc(sub)} &middot; ${s.elev} m</div>
      <table style="font-size:11px;width:100%">
        <tr><td style="color:#94a3b8">Clears skyline</td><td style="text-align:right;color:#6ee7b7">+${s.clearance.toFixed(1)}&deg;</td></tr>
        <tr><td style="color:#94a3b8">Sun at maximum</td><td style="text-align:right">${s.sunAlt.toFixed(1)}&deg;</td></tr>
        <tr><td style="color:#94a3b8">Totality</td><td style="text-align:right">${dur(s.totality)}</td></tr>
        <tr><td style="color:#94a3b8">Access</td><td style="text-align:right">${esc(accessLabel)}</td></tr>
        ${s.cloud != null ? `<tr><td style="color:#94a3b8">July cloud cover</td><td style="text-align:right;color:#e2e8f0">${s.cloud.toFixed(0)}% <span style="color:#38bdf8">(${s.clearProb != null ? s.clearProb.toFixed(0) + "% clear" : ""})</span></td></tr>` : ""}
        ${s.cloudLow > 18 ? `<tr><td style="color:#94a3b8">Low cloud / fog</td><td style="text-align:right;color:#fbbf24">${s.cloudLow.toFixed(0)}%</td></tr>` : ""}
        ${publicRow}
        ${landRow}
        ${trailRow}
      </table>
      ${warn}
      <a href="${url}" style="display:block;margin-top:8px;text-align:center;background:#f59e0b;color:#0f172a;font-weight:600;border-radius:6px;padding:6px 8px;text-decoration:none">
        Open in 3D &rarr;
      </a>
      <a href="${gmapsUrl}" target="_blank" rel="noopener" style="display:block;margin-top:6px;text-align:center;background:#1e293b;border:1px solid #475569;color:#e2e8f0;font-weight:500;font-size:11px;border-radius:6px;padding:5px 8px;text-decoration:none">
        Open in Google Maps &nearr;
      </a>
      <div style="color:#64748b;font-size:10px;margin-top:6px">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</div>
    </div>`;
}

function setSource(src) {
  source = src;
  const on = "flex-1 text-xs sm:text-[11px] font-medium rounded-lg px-2 py-1.5 sm:py-1 transition bg-amber-500 text-slate-900";
  const off = "flex-1 text-xs sm:text-[11px] font-medium rounded-lg px-2 py-1.5 sm:py-1 transition bg-slate-800/70 hover:bg-slate-700 text-slate-300";
  document.getElementById("srcPoi").className = src === "poi" ? on : off;
  document.getElementById("srcGrid").className = src === "grid" ? on : off;
  document.getElementById("srcBoth").className = src === "both" ? on : off;
  render();
}

async function load() {
  const status = document.getElementById("status");
  try {
    const res = await fetch("viewpoints.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("viewpoints.json not found");
    catalogue = await res.json();
    if (!catalogue.spots || !catalogue.spots.length) throw new Error("catalogue is empty");
    setSource("poi");
    renderTowns();
    renderCloudOverlay();
    const all = entries().concat((catalogue.spots || []).map((s) => ({ ...s })));
    map.fitBounds(L.latLngBounds(all.map((s) => [s.lat, s.lon])).pad(0.05));
    status.textContent = `Catalogue generated ${(catalogue.generated || "").slice(0, 10)}`;
    if ((catalogue.osmGaps || []).length) {
      status.textContent += ` · ${catalogue.osmGaps.length} OSM gap(s)`;
    }
  } catch (e) {
    status.innerHTML = `<span class="text-red-400">${esc(e.message)}</span> — run
      <span class="font-mono">precompute/build_viewpoints.py</span> first.`;
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

["accessFilter", "clearFilter", "cloudFilter", "wholeOnly", "publicOnly"].forEach((id) =>
  document.getElementById(id).addEventListener("input", render));
document.getElementById("showPath").addEventListener("change", renderEclipsePath);
document.getElementById("showCloud").addEventListener("change", renderCloudOverlay);
document.getElementById("srcPoi").addEventListener("click", () => { trackMetric("map_filter", "poi"); setSource("poi"); });
document.getElementById("srcGrid").addEventListener("click", () => { trackMetric("map_filter", "grid"); setSource("grid"); });
document.getElementById("srcBoth").addEventListener("click", () => { trackMetric("map_filter", "both"); setSource("both"); });
document.getElementById("map").addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest('a[href^="index.html"]');
  if (a) {
    let spotName = "";
    try {
      spotName = new URL(a.getAttribute("href"), location.origin).searchParams.get("name") || "";
    } catch (err) {}
    trackMetric("map_filter", "open_3d", spotName);
  }
});

const setMapFiltersOpen = (open) => {
  const body = document.getElementById("mapFiltersBody");
  const legend = document.getElementById("mapLegendCard");
  const btn = document.getElementById("toggleMapFilters");
  const lbl = document.getElementById("toggleMapFiltersLabel");
  body.classList.toggle("hidden", !open);
  legend.classList.toggle("hidden", !open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (lbl) lbl.textContent = open ? "Hide" : "Filters";
};

if (window.innerWidth < 640) {
  setMapFiltersOpen(false);
}

document.getElementById("toggleMapFilters").addEventListener("click", () => {
  const isHidden = document.getElementById("mapFiltersBody").classList.contains("hidden");
  setMapFiltersOpen(isHidden);
});

// Build the contact address at runtime rather than shipping it in the markup. Stops naive
// harvesters that regex the served HTML; not a defence against a scraper that runs JS.
(() => {
  const addr = ["michael", "davies.net.nz"].join("@");
  const link = document.getElementById("contactLink");
  link.href = `mailto:${addr}?subject=${encodeURIComponent("Otago Eclipse 3D")}`;
  document.getElementById("contactAddr").textContent = addr;
})();

// About dialog: closes on the X, on the backdrop, and on Escape.
const aboutOverlay = document.getElementById("aboutOverlay");
const showAbout = (on) => {
  aboutOverlay.classList.toggle("hidden", !on);
  if (on) document.getElementById("aboutClose").focus();
};
document.getElementById("aboutBtn").addEventListener("click", () => showAbout(true));
document.getElementById("aboutClose").addEventListener("click", () => showAbout(false));
aboutOverlay.addEventListener("click", (e) => { if (e.target === aboutOverlay) showAbout(false); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !aboutOverlay.classList.contains("hidden")) showAbout(false);
});

lucide.createIcons();
trackMetric("page_view", "map");
renderEclipsePath();
load();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
