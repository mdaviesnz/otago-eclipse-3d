// The 3D simulator: everything index.html does once the markup is on screen.
//
// A classic script, loaded with `defer` after Cesium, astronomy-engine, Lucide and the verdict
// and catalogue modules, so all of those exist by the time this runs. Its top-level names are
// deliberately global: the smoke tests reach `catalogue`, `viewer` and the rest by name.

// ====================================================================================
//  CONFIG & CONSTANTS
// ====================================================================================
// Deliberately empty. The default terrain source needs no token, and anything hardcoded
// here is readable by anyone who views source on a public deployment. To use Cesium World
// Terrain instead, pass your own token at runtime:
//     ?terrain=ion&ionToken=YOUR_TOKEN
// It is remembered in localStorage for that browser only, and never leaves the client.
const CESIUM_ION_TOKEN = "";

// Open (token-free) data sources.
// Re:Earth Terrain serves quantized-mesh with vertex normals; no API key required.
const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";
const ESRI_IMAGERY_URL =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";

const CREDITS = {
  ion:  "Independent, unvalidated planning tool &middot; Terrain &amp; imagery: Cesium World Terrain / Bing Maps via Cesium ion.",
  open: "Independent, unvalidated planning tool &middot; Terrain: Re:Earth Terrain &middot; Mapterhorn (CC BY 4.0). Imagery: Esri World Imagery.",
};

// Eclipse clock window (UTC). NZST = UTC + 12h.
const CLOCK_START_UTC   = "2028-07-22T03:00:00Z"; // 15:00 NZST
const CLOCK_STOP_UTC    = "2028-07-22T05:30:00Z"; // 17:30 NZST
const TOTALITY_MAX_UTC  = "2028-07-22T04:17:20Z"; // 16:17:20 NZST, maximum at Dunedin (ΔT 69.2 s)

// `goTo` is each town's own "Go to..." suggestion, chosen by hand and fixed, so the most-visited
// places never depend on a rule or a catalogue rebuild; every other place is matched by the rule
// in catalogue.js. `why` is the improvement: "clear" where the town loses totality, "margin"
// where it clears the skyline by too little. Coordinates are the catalogue's, so the spot is
// answered from viewpoints.json on arrival.
//   Dunedin: Signal Hill rather than the nearer picnic area in South Dunedin, as the lookout
//     people know.
//   Wānaka: none. Its only gain is half a minute more totality 38 km away over the Crown Range,
//     a winter pass, under cloudier skies.
const LOCATIONS = [
  { name: "Queenstown", lon: 168.6626, lat: -45.0312, icon: "mountain",
    goTo: { name: "Halfway Remarkables", lat: -45.025714, lon: 168.7775044, why: "clear" } },
  { name: "Arrowtown",  lon: 168.8306, lat: -44.9385, icon: "trees",
    goTo: { name: "The Zig Zag", lat: -44.9737572, lon: 168.8646803, why: "clear" } },
  { name: "Wānaka",     lon: 169.1365, lat: -44.6942, icon: "sailboat", goTo: null },
  { name: "Cromwell",   lon: 169.2030, lat: -45.0382, icon: "grape",
    goTo: { name: "Bruce Jackson Lookout", lat: -45.051203, lon: 169.21452, why: "margin" } },
  { name: "Dunedin",    lon: 170.5028, lat: -45.8788, icon: "waves",
    goTo: { name: "Signal Hill Lookout", lat: -45.8587785, lon: 170.5467251, why: "margin" } },
];

const { inNzBounds, compassName, compassShort, heightPhrase, handMeasure, photonUrl, photonFeatures } = Places;

const EARTH_RADIUS = 6371000;        // mean Earth radius, m
const REFRACTION_K = 0.13;           // standard terrestrial refraction coefficient (effective R = R / (1 - k))
const EFFECTIVE_EARTH_RADIUS = EARTH_RADIUS / (1 - REFRACTION_K);
const SIGHTLINE_RANGE = 45000;       // m, how far out to probe terrain
const EYE_HEIGHT = 1.7;              // observer eye height, m
const HORIZON_SPAN = 20;             // deg either side of the sun to sweep for the profile
const HORIZON_STEP = 4;              // deg between profile bearings

// Terrain closer than this is ignored as ground clutter. The limit is set by DEM vertical
// error, not geometry: an angular error of atan(sigma/d) from a typical sigma of ~5 m is
// +/-32 deg at 8 m, +/-5 deg at 50 m, but only +/-3 deg at 100 m. Sampling nearer than this
// measures DEM noise, not the skyline — and it is ground you could simply step around.
const MIN_PROBE = 100;               // m

// Adaptive radial spacing: dense in the near-mid field — where a sharp ridge subtends a
// large angle and uniform stepping can stride straight over it — and geometrically coarser
// far out, where it cannot. Both more accurate and cheaper than a fixed grid.
function radialDistances(growth, maxRange = SIGHTLINE_RANGE) {
  const out = [];
  for (let d = MIN_PROBE; d <= maxRange; d += Math.max(MIN_PROBE * 0.25, d * growth)) out.push(d);
  return out;
}

// ====================================================================================
//  STATE
// ====================================================================================
let viewer = null;
let terrainSource = "open";           // "open" (default) | "ion" (via ?terrain=ion)
let activeLoc = null;                  // the place being looked at, once one has been chosen
let activeGroundCartesian = null;     // observer position (ground + eye height)
let sightlinePrimitive = null;        // current drawn ray
let sightlineToken = 0;               // guards against overlapping re-runs
let locationMarker = null;            // visible marker at the checked location
let activeCatEntry = null;            // catalogue record the observer is standing on, or null
let pinMode = false;                  // when true, clicking the map sets the location
const startJulian = Cesium.JulianDate.fromIso8601(CLOCK_START_UTC);
const stopJulian  = Cesium.JulianDate.fromIso8601(CLOCK_STOP_UTC);
const maxJ        = Cesium.JulianDate.fromIso8601(TOTALITY_MAX_UTC);
const windowSecs  = Cesium.JulianDate.secondsDifference(stopJulian, startJulian);

// scratch
const _sunIcrf = new Cesium.Cartesian3();
const _mat3 = new Cesium.Matrix3();
const _sunFixed = new Cesium.Cartesian3();

// ====================================================================================
//  ASTRONOMY: sun position (Earth-fixed) and local altitude/azimuth
// ====================================================================================
const A = window.Astronomy;
const AU_KM = 149597870.7;
const SUN_KM = 695700;
const MOON_KM = 1737.4;
const lerp = (a, b, f) => a + (b - a) * Cesium.Math.clamp(f, 0, 1);

// Cesium JulianDate -> JS Date (astronomy-engine works in UTC Dates).
const toDate = (t) => Cesium.JulianDate.toDate(t);

// Cartesian -> astronomy-engine Observer (lat/lon/height).
function observerFor(cartesian) {
  const c = Cesium.Cartographic.fromCartesian(cartesian);
  return new A.Observer(
    Cesium.Math.toDegrees(c.latitude),
    Cesium.Math.toDegrees(c.longitude),
    c.height
  );
}

// Topocentric alt/az of a body, plus its apparent radius and sky direction vector.
// Apparent (refracted) altitude via Bennett's formula ("normal"), matching what an
// observer actually sees and consistent with EclipseEvent.altitude from
// SearchLocalSolarEclipse in the precomputed catalogue.
function bodyAltAz(body, date, observer, radiusKm) {
  const eq = A.Equator(body, date, observer, true, true);
  const hz = A.Horizon(date, observer, eq.ra, eq.dec, "normal");
  const ra = eq.ra * 15 * Math.PI / 180, dec = eq.dec * Math.PI / 180;
  return {
    altitude: hz.altitude,
    azimuth: hz.azimuth,
    angRadius: Math.asin(radiusKm / (eq.dist * AU_KM)),
    unit: [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)],
  };
}

// Sun altitude/azimuth for an observer, plus the ECEF direction to the sun (for the ray).
function sunAltAz(time, originCartesian) {
  const s = bodyAltAz(A.Body.Sun, toDate(time), observerFor(originCartesian), SUN_KM);
  return {
    altitude: s.altitude,
    azimuth: s.azimuth,
    dir: enuDirection(originCartesian, s.azimuth, s.altitude),
  };
}

// Unit ECEF vector pointing at the given local azimuth/altitude (degrees).
function enuDirection(originCartesian, azimuthDeg, altitudeDeg) {
  const az = Cesium.Math.toRadians(azimuthDeg), alt = Cesium.Math.toRadians(altitudeDeg);
  const enu = new Cesium.Cartesian3(
    Math.sin(az) * Math.cos(alt),   // east
    Math.cos(az) * Math.cos(alt),   // north
    Math.sin(alt)                   // up
  );
  const m = Cesium.Transforms.eastNorthUpToFixedFrame(originCartesian);
  const v = Cesium.Matrix4.multiplyByPointAsVector(m, enu, new Cesium.Cartesian3());
  return Cesium.Cartesian3.normalize(v, v);
}

// Real eclipse geometry for this observer at this instant, from sun + moon ephemeris.
//   magnitude   fraction of the sun's DIAMETER covered
//   obscuration fraction of the sun's AREA covered
//   isTotal     true only when the lunar disc completely covers the solar disc
function eclipseAt(time, originCartesian) {
  const date = toDate(time);
  const obs = observerFor(originCartesian);
  const s = bodyAltAz(A.Body.Sun, date, obs, SUN_KM);
  const m = bodyAltAz(A.Body.Moon, date, obs, MOON_KM);
  const dot = s.unit[0] * m.unit[0] + s.unit[1] * m.unit[1] + s.unit[2] * m.unit[2];
  const sep = Math.acos(Cesium.Math.clamp(dot, -1, 1));
  const mag = Math.max(0, (s.angRadius + m.angRadius - sep) / (2 * s.angRadius));
  const obscuration = Math.min(1, circleOverlapArea(s.angRadius, m.angRadius, sep) / (Math.PI * s.angRadius * s.angRadius));
  const isTotal = m.angRadius >= s.angRadius && sep <= (m.angRadius - s.angRadius);
  return {
    mag,
    obscuration,
    isTotal,
    k: m.angRadius / s.angRadius,        // moon/sun apparent size ratio
    sepR: sep / s.angRadius,             // separation in sun-radii
    sunAlt: s.altitude,
    sunAz: s.azimuth,
    moonAlt: m.altitude,
    moonAz: m.azimuth,
  };
}

// Per-location eclipse contact times (cached per coordinate).
const circumstancesCache = new Map();
function localCircumstances(originCartesian) {
  const c = Cesium.Cartographic.fromCartesian(originCartesian);
  const lat = Cesium.Math.toDegrees(c.latitude), lon = Cesium.Math.toDegrees(c.longitude);
  const key = lat.toFixed(3) + "," + lon.toFixed(3);
  if (circumstancesCache.has(key)) return circumstancesCache.get(key);
  let info = null;
  try {
    const start = new A.AstroTime(new Date(Date.UTC(2028, 6, 21, 0, 0, 0)));
    const e = A.SearchLocalSolarEclipse(start, new A.Observer(lat, lon, c.height));
    const j = (ev) => (ev ? Cesium.JulianDate.fromDate(ev.time.date) : null);
    info = {
      kind: e.kind,
      peakObscuration: e.obscuration,
      partialBegin: j(e.partial_begin),
      totalBegin: j(e.total_begin),
      peak: j(e.peak),
      totalEnd: j(e.total_end),
      partialEnd: j(e.partial_end),
    };
  } catch (err) {
    info = null; // no eclipse visible from here
  }
  circumstancesCache.set(key, info);
  return info;
}

// Overlap area of two circles (radii r1, r2; centre separation d).
function circleOverlapArea(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) { const r = Math.min(r1, r2); return Math.PI * r * r; }
  const r1s = r1 * r1, r2s = r2 * r2;
  const a1 = Math.acos((d * d + r1s - r2s) / (2 * d * r1));
  const a2 = Math.acos((d * d + r2s - r1s) / (2 * d * r2));
  const tri = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return r1s * a1 + r2s * a2 - tri;
}


// ====================================================================================
//  3D ECLIPSE SKY RENDERER
//  Cesium's built-in Sun & Moon use a coarse lunar series (missing totality by ~12% and
//  several minutes) and draw an un-occulted yellow sun bloom behind a tiny black polygon.
//  We hide both and render a multi-layered, hardware depth-tested 3D eclipse assembly
//  (twilight horizon glow, K/F solar corona, chromosphere & prominences, limb-darkened
//  solar crescent, dark lunar silhouette, and diamond ring) at exact astronomy-engine
//  topocentric coordinates. Because every billboard has disableDepthTestDistance = 0 at
//  160 km range, foreground 3D mountain ridges naturally occlude the sun and corona.
// ====================================================================================
const SKY_ECLIPSE_DIST = 160000;     // 160 km: beyond all South Island terrain, inside frustum
const CRESCENT_STEPS = 32;
let eclipseBillboards = null;
let bbTwilight = null, bbCorona = null, bbMoon = null, bbCrescent = null, bbGlare = null, bbDiamond = null;
let currentCrescentIdx = -1;
let skyGhostEntity = null;
let currentSightlineBlocked = false;
let currentHorizonAtSun = null;

function makeTwilightTexture() {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 160;
  const ctx = cv.getContext("2d");
  // Deep coronal indigo halo around the sun centre. Squashed to fit: a circular halo is wider
  // than this canvas is tall, so it would still be visible where the canvas stops and draw a
  // hard straight edge across the sky.
  ctx.save();
  ctx.translate(128, 80);
  ctx.scale(1, 78 / 120);
  const halo = ctx.createRadialGradient(0, 0, 5, 0, 0, 120);
  halo.addColorStop(0, "rgba(148, 163, 184, 0.38)");
  halo.addColorStop(0.35, "rgba(56, 189, 248, 0.16)");
  halo.addColorStop(0.7, "rgba(30, 58, 138, 0.10)");
  halo.addColorStop(1, "rgba(15, 23, 42, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(-128, -124, 256, 248);
  ctx.restore();

  // Warm 360-degree twilight horizon glow along the lower sky (backlights mountain silhouettes)
  const horiz = ctx.createRadialGradient(128, 155, 8, 128, 155, 130);
  horiz.addColorStop(0, "rgba(251, 146, 60, 0.62)");
  horiz.addColorStop(0.35, "rgba(245, 158, 11, 0.38)");
  horiz.addColorStop(0.7, "rgba(217, 119, 6, 0.14)");
  horiz.addColorStop(1, "rgba(15, 23, 42, 0)");
  ctx.fillStyle = horiz;
  ctx.fillRect(0, 0, 256, 160);
  return cv;
}

function makeGlareTexture() {
  const cv = document.createElement("canvas");
  cv.width = 160; cv.height = 160;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(80, 80, 2, 80, 80, 78);
  g.addColorStop(0, "rgba(255, 255, 255, 0.95)");
  g.addColorStop(0.16, "rgba(254, 240, 138, 0.82)");
  g.addColorStop(0.42, "rgba(251, 191, 36, 0.38)");
  g.addColorStop(0.72, "rgba(245, 158, 11, 0.12)");
  g.addColorStop(1, "rgba(245, 158, 11, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 160, 160);
  return cv;
}

function makeCoronaTexture() {
  const cv = document.createElement("canvas");
  cv.width = 512; cv.height = 512;
  const ctx = cv.getContext("2d");
  const cx = 256, cy = 256, R = 46;

  // 1. Broad F-corona outer diffuse glow
  const outer = ctx.createRadialGradient(cx, cy, R * 0.95, cx, cy, 248);
  outer.addColorStop(0, "rgba(248, 250, 252, 0.75)");
  outer.addColorStop(0.18, "rgba(226, 232, 240, 0.42)");
  outer.addColorStop(0.45, "rgba(186, 230, 253, 0.16)");
  outer.addColorStop(0.75, "rgba(148, 163, 184, 0.05)");
  outer.addColorStop(1, "rgba(15, 23, 42, 0)");
  ctx.fillStyle = outer;
  ctx.fillRect(0, 0, 512, 512);

  // 2. Sculpted K-corona helmet streamers and polar plumes
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.38); // natural solar equatorial tilt in the NW winter sky
  const streamers = [
    { ang: 0.0, len: 235, w: 0.42, a: 0.55 },
    { ang: 0.32, len: 195, w: 0.28, a: 0.38 },
    { ang: -0.28, len: 210, w: 0.32, a: 0.44 },
    { ang: Math.PI, len: 240, w: 0.44, a: 0.58 },
    { ang: Math.PI + 0.30, len: 205, w: 0.30, a: 0.40 },
    { ang: Math.PI - 0.34, len: 190, w: 0.28, a: 0.36 },
    { ang: 0.78, len: 145, w: 0.22, a: 0.26 },
    { ang: -0.82, len: 150, w: 0.22, a: 0.26 },
    { ang: Math.PI + 0.80, len: 155, w: 0.24, a: 0.28 },
    { ang: Math.PI - 0.76, len: 140, w: 0.20, a: 0.25 },
  ];
  for (const s of streamers) {
    ctx.save();
    ctx.rotate(s.ang);
    const sg = ctx.createLinearGradient(R * 0.85, 0, s.len, 0);
    sg.addColorStop(0, `rgba(255, 251, 235, ${s.a})`);
    sg.addColorStop(0.35, `rgba(226, 232, 240, ${s.a * 0.55})`);
    sg.addColorStop(0.75, `rgba(186, 230, 253, ${s.a * 0.18})`);
    sg.addColorStop(1, "rgba(186, 230, 253, 0)");
    ctx.fillStyle = sg;
    ctx.beginPath();
    const y0 = R * Math.sin(s.w);
    ctx.moveTo(R * 0.85, -y0);
    ctx.quadraticCurveTo(s.len * 0.55, -y0 * 0.45, s.len, 0);
    ctx.quadraticCurveTo(s.len * 0.55, y0 * 0.45, R * 0.85, y0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // Fine polar & radial coronal striations
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const eq = Math.abs(Math.cos(a));
    const rayLen = R + 68 + eq * 95 + ((i * 17) % 23);
    ctx.save();
    ctx.rotate(a);
    const rg = ctx.createLinearGradient(R, 0, rayLen, 0);
    rg.addColorStop(0, "rgba(255, 255, 255, 0.28)");
    rg.addColorStop(0.5, "rgba(226, 232, 240, 0.10)");
    rg.addColorStop(1, "rgba(226, 232, 240, 0)");
    ctx.strokeStyle = rg;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(R * 0.95, 0);
    ctx.lineTo(rayLen, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // 3. Intense inner K-corona ring
  const inner = ctx.createRadialGradient(cx, cy, R - 1, cx, cy, R + 36);
  inner.addColorStop(0, "rgba(255, 255, 255, 0.98)");
  inner.addColorStop(0.18, "rgba(254, 243, 199, 0.88)");
  inner.addColorStop(0.48, "rgba(226, 232, 240, 0.35)");
  inner.addColorStop(1, "rgba(226, 232, 240, 0)");
  ctx.fillStyle = inner;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 36, 0, Math.PI * 2);
  ctx.fill();

  // 4. Ruby-pink chromospheric rim and solar prominences
  ctx.strokeStyle = "rgba(251, 113, 133, 0.92)";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 0.6, 0, Math.PI * 2);
  ctx.stroke();

  const proms = [0.45, 1.85, 3.25, 4.9, 5.65];
  ctx.fillStyle = "rgba(244, 63, 94, 0.95)";
  for (const pa of proms) {
    const px = cx + Math.cos(pa) * (R + 1.5);
    const py = cy + Math.sin(pa) * (R + 1.5);
    ctx.beginPath();
    ctx.arc(px, py, 2.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 5. Fill the inner lunar silhouette with opaque deep velvet night (alpha = 1.0 so Cesium's
  // 0.995 opaque-pass threshold writes depth across the entire disc and blocks twilight glow behind it)
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.arc(cx, cy, R - 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";

  const moonG = ctx.createRadialGradient(cx - 10, cy - 10, 4, cx, cy, R);
  moonG.addColorStop(0, "rgb(9, 14, 28)");
  moonG.addColorStop(0.75, "rgb(5, 8, 18)");
  moonG.addColorStop(1, "rgb(2, 4, 11)");
  ctx.fillStyle = moonG;
  ctx.beginPath();
  ctx.arc(cx, cy, R - 0.2, 0, Math.PI * 2);
  ctx.fill();
  return cv;
}

function makeMoonTexture() {
  const cv = document.createElement("canvas");
  cv.width = 160; cv.height = 160;
  const ctx = cv.getContext("2d");
  const R = 42;
  const g = ctx.createRadialGradient(76, 76, 4, 80, 80, R);
  g.addColorStop(0, "rgb(9, 14, 28)");
  g.addColorStop(0.82, "rgb(5, 8, 18)");
  g.addColorStop(0.97, "rgb(3, 6, 14)");
  g.addColorStop(1, "rgba(3, 6, 14, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(80, 80, R, 0, Math.PI * 2);
  ctx.fill();
  return cv;
}

function makeDiamondTexture() {
  const cv = document.createElement("canvas");
  cv.width = 160; cv.height = 160;
  const ctx = cv.getContext("2d");
  const cx = 80, cy = 80;
  const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, 52);
  g.addColorStop(0, "rgba(255, 255, 255, 1)");
  g.addColorStop(0.14, "rgba(254, 249, 195, 0.95)");
  g.addColorStop(0.35, "rgba(251, 191, 36, 0.48)");
  g.addColorStop(0.7, "rgba(245, 158, 11, 0.12)");
  g.addColorStop(1, "rgba(245, 158, 11, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 160, 160);

  // 4-point + diagonal diffraction spikes
  const drawSpike = (ang, len, w, alpha) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    const sg = ctx.createLinearGradient(-len, 0, len, 0);
    sg.addColorStop(0, "rgba(255, 255, 255, 0)");
    sg.addColorStop(0.35, `rgba(254, 240, 138, ${alpha * 0.5})`);
    sg.addColorStop(0.5, `rgba(255, 255, 255, ${alpha})`);
    sg.addColorStop(0.65, `rgba(254, 240, 138, ${alpha * 0.5})`);
    sg.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(0, -w, len, 0);
    ctx.quadraticCurveTo(0, w, -len, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  drawSpike(0.2, 76, 2.4, 0.95);
  drawSpike(0.2 + Math.PI / 2, 76, 2.4, 0.95);
  drawSpike(0.2 + Math.PI / 4, 50, 1.5, 0.65);
  drawSpike(0.2 - Math.PI / 4, 50, 1.5, 0.65);
  return cv;
}

function makeCrescentTexture(sepR, kRatio = 1.045) {
  const cv = document.createElement("canvas");
  cv.width = 160; cv.height = 160;
  const ctx = cv.getContext("2d");
  const cx = 80, cy = 80, R = 50;

  // Soft warm rim glow around the uncovered solar limb
  const rim = ctx.createRadialGradient(cx, cy, R * 0.75, cx, cy, R + 14);
  rim.addColorStop(0, "rgba(254, 240, 138, 0.9)");
  rim.addColorStop(0.6, "rgba(251, 191, 36, 0.45)");
  rim.addColorStop(1, "rgba(245, 158, 11, 0)");
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 14, 0, Math.PI * 2);
  ctx.fill();

  // Solar photosphere with limb darkening
  const sunG = ctx.createRadialGradient(cx, cy, 4, cx, cy, R);
  sunG.addColorStop(0, "#ffffff");
  sunG.addColorStop(0.55, "#fef9c3");
  sunG.addColorStop(0.85, "#fde047");
  sunG.addColorStop(0.97, "#f59e0b");
  sunG.addColorStop(1, "rgba(217, 119, 6, 0)");
  ctx.fillStyle = sunG;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // Carve out the encroaching lunar disc along +X (rotated at render time by position angle `pa`)
  // and fill the overlapping lunar bite with an opaque dark sky-indigo silhouette (alpha = 1.0)
  // so it writes to the depth buffer and blocks the daytime glare billboard behind it.
  if (sepR < 2.05) {
    const mcx = cx + sepR * R;
    const moonR = R * kRatio;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.arc(mcx, cy, moonR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R + 0.5, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(mcx, cy, moonR, 0, Math.PI * 2);
    ctx.fillStyle = "rgb(5, 8, 16)";
    ctx.fill();
    ctx.restore();
  }
  return cv;
}

function makeGhostRingTexture() {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 128;
  const ctx = cv.getContext("2d");
  ctx.strokeStyle = "rgba(248, 113, 113, 0.85)";
  ctx.lineWidth = 2.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.arc(64, 64, 34, 0, Math.PI * 2);
  ctx.stroke();
  return cv;
}

const crescentCanvases = [];
function initEclipseSky() {
  if (!viewer) return;
  if (viewer.scene.sun) viewer.scene.sun.show = false;
  if (viewer.scene.moon) viewer.scene.moon.show = false;

  eclipseBillboards = viewer.scene.primitives.add(new Cesium.BillboardCollection());
  for (let i = 0; i <= CRESCENT_STEPS; i++) {
    const sepR = (i / CRESCENT_STEPS) * 2.08;
    const cv = makeCrescentTexture(sepR);
    cv.src = `eclipse_crescent_${i}`;
    crescentCanvases.push(cv);
  }

  const twCv = makeTwilightTexture(); twCv.src = "eclipse_twilight";
  bbTwilight = eclipseBillboards.add({
    image: twCv,
    width: 960,
    height: 600,
    disableDepthTestDistance: 0,
    show: false,
  });

  const glCv = makeGlareTexture(); glCv.src = "eclipse_glare";
  bbGlare = eclipseBillboards.add({
    image: glCv,
    width: 220,
    height: 220,
    disableDepthTestDistance: 0,
    show: false,
  });

  const corCv = makeCoronaTexture(); corCv.src = "eclipse_corona";
  bbCorona = eclipseBillboards.add({
    image: corCv,
    width: 268,
    height: 268,
    disableDepthTestDistance: 0,
    show: false,
  });

  const moonCv = makeMoonTexture(); moonCv.src = "eclipse_moon";
  bbMoon = eclipseBillboards.add({
    image: moonCv,
    width: 82,
    height: 82,
    disableDepthTestDistance: 0,
    show: false,
  });

  const crInit = crescentCanvases[CRESCENT_STEPS];
  bbCrescent = eclipseBillboards.add({
    image: crInit,
    width: 82,
    height: 82,
    disableDepthTestDistance: 0,
    show: false,
  });
  bbCrescent.setImage(`eclipse_crescent_${CRESCENT_STEPS}`, crInit);
  currentCrescentIdx = CRESCENT_STEPS;

  const dmCv = makeDiamondTexture(); dmCv.src = "eclipse_diamond";
  bbDiamond = eclipseBillboards.add({
    image: dmCv,
    width: 135,
    height: 135,
    disableDepthTestDistance: 0,
    show: false,
  });

  // Subtle ghost indicator shown only when the sun is blocked behind a ridge or below horizon
  const ghCv = makeGhostRingTexture(); ghCv.src = "eclipse_ghost";
  skyGhostEntity = viewer.entities.add({
    show: false,
    billboard: {
      image: ghCv,
      width: 56,
      height: 56,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: "Sun behind terrain",
      font: "11px sans-serif",
      fillColor: Cesium.Color.fromCssColorString("#fca5a5"),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString("#0f172a").withAlpha(0.82),
      pixelOffset: new Cesium.Cartesian2(0, 38),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scale: 0.9,
    },
  });
}

function updateEclipseSky(t, e) {
  if (!eclipseBillboards || !activeGroundCartesian) return;
  if (e.sunAlt < -1.5) {
    bbTwilight.show = bbCorona.show = bbMoon.show = bbCrescent.show = bbGlare.show = bbDiamond.show = false;
    if (skyGhostEntity) skyGhostEntity.show = false;
    return;
  }

  const sunDir = enuDirection(activeGroundCartesian, e.sunAz, Math.max(-0.35, e.sunAlt));
  const moonDir = enuDirection(activeGroundCartesian, e.moonAz, Math.max(-0.35, e.moonAlt));
  const posAt = (dir, dist) => Cesium.Cartesian3.add(
    activeGroundCartesian,
    Cesium.Cartesian3.multiplyByScalar(dir, dist, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  let dAz = e.moonAz - e.sunAz;
  if (dAz > 180) dAz -= 360; else if (dAz < -180) dAz += 360;
  const pa = Math.atan2(e.moonAlt - e.sunAlt, dAz * Math.cos(Cesium.Math.toRadians(e.sunAlt)));

  // 1. Wide twilight & coronal sky glow behind terrain
  const c = localCircumstances(activeGroundCartesian);
  const hasTotality = Boolean(c && c.totalBegin);
  const twAlpha = e.isTotal ? 0.95 : Math.pow(Cesium.Math.clamp((e.obscuration - 0.55) / 0.45, 0, 1), 2) * 0.85;
  bbTwilight.show = twAlpha > 0.01;
  if (bbTwilight.show) {
    bbTwilight.position = posAt(sunDir, SKY_ECLIPSE_DIST + 8000);
    bbTwilight.color = new Cesium.Color(1, 1, 1, twAlpha);
  }

  // 2. Solar corona + chromosphere + dark lunar silhouette (emerges past 92% obscuration inside totality path)
  const corAlpha = e.isTotal ? 1.0 : (hasTotality ? Math.pow(Cesium.Math.clamp((e.obscuration - 0.92) / 0.08, 0, 1), 2.2) * 0.88 : 0);
  bbCorona.show = corAlpha > 0.01;
  if (bbCorona.show) {
    bbCorona.position = posAt(e.isTotal ? moonDir : sunDir, SKY_ECLIPSE_DIST + 2000);
    bbCorona.color = new Cesium.Color(1, 1, 1, corAlpha);
  }

  // 3. Dark lunar silhouette disc during deep partial (80% - 96% before bbCorona takes over)
  const moonAlpha = e.isTotal ? 0 : Math.pow(Cesium.Math.clamp((e.obscuration - 0.80) / 0.16, 0, 1), 1.8) * (1 - corAlpha) * 0.92;
  bbMoon.show = moonAlpha > 0.01;
  if (bbMoon.show) {
    const mOffPx = Math.min(48, 24.4 * e.sepR);
    bbMoon.position = posAt(sunDir, SKY_ECLIPSE_DIST + 1000);
    bbMoon.pixelOffset = new Cesium.Cartesian2(mOffPx * Math.cos(pa), -mOffPx * Math.sin(pa));
    bbMoon.color = new Cesium.Color(1, 1, 1, moonAlpha);
  }

  // 4. Solar photosphere crescent (hidden during totality)
  bbCrescent.show = !e.isTotal && e.sunAlt > -0.4;
  if (bbCrescent.show) {
    const idx = Math.max(0, Math.min(CRESCENT_STEPS, Math.round((Cesium.Math.clamp(e.sepR, 0, 2.08) / 2.08) * CRESCENT_STEPS)));
    if (currentCrescentIdx !== idx) {
      currentCrescentIdx = idx;
      bbCrescent.setImage(`eclipse_crescent_${idx}`, crescentCanvases[idx]);
    }
    bbCrescent.position = posAt(sunDir, SKY_ECLIPSE_DIST);
    bbCrescent.rotation = pa;
    bbCrescent.color = Cesium.Color.WHITE;
  }

  // 5. Dynamic solar atmospheric glare (positioned behind bbCrescent so the lunar bite stays crisp)
  const lightFrac = e.isTotal ? 0 : Math.max(0, 1 - e.obscuration);
  const glareAlpha = e.isTotal ? 0 : Cesium.Math.clamp(Math.pow(lightFrac, 0.55) * 0.65, 0, 0.72);
  bbGlare.show = glareAlpha > 0.02;
  if (bbGlare.show) {
    const cShift = e.mag > 0 ? Math.min(18, e.obscuration * 18) : 0;
    bbGlare.position = posAt(sunDir, SKY_ECLIPSE_DIST + 5000);
    bbGlare.pixelOffset = new Cesium.Cartesian2(-cShift * Math.cos(pa), cShift * Math.sin(pa));
    bbGlare.scale = 0.5 + 0.55 * Math.pow(lightFrac, 0.35);
    bbGlare.color = new Cesium.Color(1, 1, 1, glareAlpha);
  }

  // 6. Diamond Ring starburst at C2 / C3 (97.8% - 100% partial inside totality path)
  const showDiamond = hasTotality && !e.isTotal && e.obscuration >= 0.978;
  bbDiamond.show = showDiamond;
  if (showDiamond) {
    const u = Cesium.Math.clamp((e.obscuration - 0.978) / 0.022, 0, 1);
    const dAlpha = Math.max(0.35, Math.sin(u * Math.PI * 0.9));
    const limbPx = 22.0;
    bbDiamond.position = posAt(sunDir, SKY_ECLIPSE_DIST - 2000);
    bbDiamond.pixelOffset = new Cesium.Cartesian2(-limbPx * Math.cos(pa), limbPx * Math.sin(pa));
    bbDiamond.scale = 0.75 + 0.45 * dAlpha;
    bbDiamond.color = new Cesium.Color(1, 1, 1, dAlpha);
  }

  // 7. Hide the Totality sun-track point when the sun/moon disc is sitting over it
  if (totalityMarkerEntity && totalityMarkerEntity.point) {
    totalityMarkerEntity.point.show = e.obscuration < 0.78;
  }

  // 8. Ghost indicator when obstructed by terrain in eye-level view (or after sunset)
  if (skyGhostEntity) {
    const blockedForObserver = e.sunAlt <= 0 ||
      (Number.isFinite(currentHorizonAtSun) && e.sunAlt <= currentHorizonAtSun) ||
      currentSightlineBlocked;
    const showGhost = (cameraViewMode === "eye" && blockedForObserver) || e.sunAlt <= 0;
    skyGhostEntity.show = showGhost && e.sunAlt > -1.0;
    if (skyGhostEntity.show) {
      skyGhostEntity.position = posAt(sunDir, SKY_ECLIPSE_DIST);
      skyGhostEntity.label.text = e.sunAlt <= 0
        ? "Sun below horizon"
        : `Sun behind ridge (${e.sunAlt.toFixed(1)}°)`;
    }
  }
}

// ====================================================================================
//  ECLIPSE LIGHTING — CesiumJS models sun DIRECTION but has no concept of occultation,
//  so we dim and colour-shift the scene ourselves from the live obscuration.
// ====================================================================================
let sunLight = null;
let lastDim = -1;

function updateEclipseLighting(e) {
  if (!viewer) return;
  // Visible sunlight falls as (1 - obscuration), but perceived darkness collapses only in
  // the last few percent — which is exactly why totality feels so sudden. A high exponent
  // reproduces that: barely noticeable at 80%, plunging past 97%.
  const dim = e.isTotal ? 1.0 : Math.pow(Cesium.Math.clamp(e.obscuration, 0, 1), 5.5);
  const purkinje = Math.pow(Cesium.Math.clamp((e.obscuration - 0.5) / 0.5, 0, 1), 2);

  // Point the directional light from the true astronomy-engine sun position so raking
  // terrain shadows match the sightline ray.
  if (!sunLight) {
    sunLight = new Cesium.DirectionalLight({
      direction: new Cesium.Cartesian3(0, 0, -1),
      intensity: 2.0,
    });
    viewer.scene.light = sunLight;
  }
  if (activeGroundCartesian) {
    const sDir = enuDirection(activeGroundCartesian, e.sunAz, Math.max(4, e.sunAlt));
    Cesium.Cartesian3.negate(sDir, sunLight.direction);
  }

  if (Math.abs(dim - lastDim) < 0.002) return;   // skip redundant GPU state changes
  lastDim = dim;

  // Transition light colour: warm afternoon gold -> silvery steel Purkinje twilight -> deep umbral indigo
  const r = lerp(lerp(1.0, 0.82, purkinje), 0.56, dim);
  const g = lerp(lerp(0.97, 0.88, purkinje), 0.68, dim);
  const b = lerp(lerp(0.90, 0.98, purkinje), 0.95, dim);
  sunLight.color = new Cesium.Color(r, g, b, 1.0);
  sunLight.intensity = lerp(2.0, 0.65, dim);

  const layer = viewer.imageryLayers.length ? viewer.imageryLayers.get(0) : null;
  if (layer) {
    // Baseline above 1.0 on purpose: the default view looks along the sun's bearing, so the
    // slopes facing the camera are back-lit and Cesium renders them close to black. Lifting
    // the imagery keeps the landscape readable without flattening the raking shadows.
    layer.brightness = lerp(1.45, 0.36, dim);
    layer.saturation = lerp(1.1, 0.42, dim);   // colour drains toward totality
  }

  const sky = viewer.scene.skyAtmosphere;
  if (sky) {
    // Shift toward deep twilight navy/indigo rather than flat grey cement
    sky.hueShift = lerp(0, 0.06, dim);
    sky.brightnessShift = lerp(0, -0.68, dim);
    sky.saturationShift = lerp(0, -0.15, dim);
  }
  const globe = viewer.scene.globe;
  globe.atmosphereHueShift = lerp(0, 0.05, dim);
  globe.atmosphereBrightnessShift = lerp(0, -0.58, dim);
  globe.atmosphereSaturationShift = lerp(0, -0.2, dim);
}

// ====================================================================================
//  TIME FORMATTING (NZST wall clock)
// ====================================================================================
function formatNZST(julian) {
  const nz = Cesium.JulianDate.addHours(julian, 12, new Cesium.JulianDate());
  const g = Cesium.JulianDate.toGregorianDate(nz);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(g.hour)}:${p(g.minute)}:${p(Math.floor(g.second))}`;
}

// ====================================================================================
//  VIEWER INITIALISATION
// ====================================================================================
async function initViewer(mode, token) {
  terrainSource = mode;
  const options = {
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
  };

  if (mode === "ion") {
    // Opt-in only, via ?terrain=ion — finer over New Zealand, but needs a token.
    Cesium.Ion.defaultAccessToken = token;
    options.terrain = Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true });
  } else {
    // Default: token-free Re:Earth Terrain (quantized-mesh) + Esri World Imagery.
    // Fall back to a smooth ellipsoid if offline in the field so the sky simulation, GPS,
    // and precomputed catalogue verdicts still work without cellular reception.
    try {
      options.terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL, {
        requestVertexNormals: true,
      });
    } catch (err) {
      console.warn("Terrain provider unreachable (offline); falling back to ellipsoid:", err);
      options.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      terrainSource = "offline";
    }
    options.baseLayer = Cesium.ImageryLayer.fromProviderAsync(
      Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_IMAGERY_URL, {
        enablePickFeatures: false,
      }).catch(() => new Cesium.GridImageryProvider())
    );
  }

  viewer = new Cesium.Viewer("cesiumContainer", options);
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.highDynamicRange = false;

  initEclipseSky();

  // Clock locked to the eclipse window.
  viewer.clock.startTime = startJulian.clone();
  viewer.clock.stopTime = stopJulian.clone();
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(TOTALITY_MAX_UTC);
  viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
  viewer.clock.multiplier = 30;
  viewer.clock.shouldAnimate = false;

  // Preload Earth orientation data so sun position is astronomically exact.
  try {
    await Cesium.Transforms.preloadIcrfFixed(
      new Cesium.TimeInterval({ start: startJulian, stop: stopJulian })
    );
  } catch (e) { /* fallback path in sunPositionFixed handles this */ }

  viewer.clock.onTick.addEventListener(onTick);
  setupMapClick();

  // Ensure background tab throttling/suspension (especially in Firefox) and WebGL context loss recover cleanly
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && viewer && !viewer.isDestroyed()) {
      viewer.resize();
      if (viewer.clock) onTick(viewer.clock);
      viewer.scene.requestRender();
    }
  });

  const glCanvas = viewer.canvas;
  if (glCanvas) {
    glCanvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      console.warn("WebGL context lost; waiting for GPU restore...");
    }, false);

    glCanvas.addEventListener("webglcontextrestored", () => {
      console.log("WebGL context restored; refreshing eclipse scene...");
      if (viewer && !viewer.isDestroyed()) {
        viewer.resize();
        if (viewer.clock) onTick(viewer.clock);
        viewer.scene.requestRender();
      }
    }, false);
  }

}

// ====================================================================================
//  PER-FRAME UPDATE
// ====================================================================================
function onTick(clock) {
  const t = clock.currentTime;
  if (activeGroundCartesian) {
    // One ephemeris evaluation per tick, shared by the readout, card, badge, sky and lighting.
    const e = eclipseAt(t, activeGroundCartesian);
    updateReadouts(t, e);
    updateStripSun(e);
    updateEclipseLighting(e);
    updateEclipseSky(t, e);
    updateNarration(t, e);
  }

  // Scrubber sync (avoid feedback while user drags)
  const scrub = document.getElementById("timeScrub");
  if (!scrub.dataset.dragging) {
    const frac = Cesium.JulianDate.secondsDifference(t, startJulian) / windowSecs;
    scrub.value = Math.round(Cesium.Math.clamp(frac, 0, 1) * 1000);
  }
}


// ====================================================================================
//  LOCATION SELECTION & CAMERA
// ====================================================================================
// Eye level by default: it is the view the verdict describes. The raised overview camera can
// see over a ridge the observer cannot, so at a blocked place it shows a sun nobody there sees.
let cameraViewMode = "eye";           // "eye" (observer ground level) | "overview" (elevated behind marker)
let sunTrackEntities = [];            // 3D sun path arc and contact labels in the sky
let sightlineExtras = [];             // ridge marker and dashed continuation line

function clearSightlineVisuals() {
  if (viewer) {
    if (sightlinePrimitive) { viewer.entities.remove(sightlinePrimitive); sightlinePrimitive = null; }
    for (const ent of sightlineExtras) viewer.entities.remove(ent);
  }
  sightlineExtras = [];
  currentSightlineBlocked = false;
  currentHorizonAtSun = null;
}

function clearSunTrack3D() {
  if (viewer) {
    for (const ent of sunTrackEntities) viewer.entities.remove(ent);
  }
  sunTrackEntities = [];
}

let totalityMarkerEntity = null;

// Draw the sun's path across the sky in 3D so the user can see how the sun descends toward
// the NW horizon and how the current clock time relates to the Totality/Maximum sightline.
function drawSunTrack3D() {
  if (!viewer || !activeGroundCartesian) return;
  clearSunTrack3D();
  totalityMarkerEntity = null;
  const c = localCircumstances(activeGroundCartesian);
  const hasTotality = Boolean(c && c.totalBegin);
  const trackDist = SKY_ECLIPSE_DIST + 6000;
  const posAt = (az, alt) => Cesium.Cartesian3.add(
    activeGroundCartesian,
    Cesium.Cartesian3.multiplyByScalar(enuDirection(activeGroundCartesian, az, alt), trackDist, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  // Split the dashed sun path around totality/maximum so no line crosses through the dark lunar disc
  const steps = 80;
  const beforeSeg = [], afterSeg = [];
  for (let i = 0; i <= steps; i++) {
    const t = Cesium.JulianDate.addSeconds(startJulian, (i / steps) * windowSecs, new Cesium.JulianDate());
    const s = sunAltAz(t, activeGroundCartesian);
    if (s.altitude < -0.2) continue;
    if (c && c.peak) {
      const dt = Cesium.JulianDate.secondsDifference(t, c.peak);
      if (Math.abs(dt) < 340) continue; // leave a clean gap for the solar disc & inner corona
      if (dt < 0) beforeSeg.push(posAt(s.azimuth, s.altitude));
      else afterSeg.push(posAt(s.azimuth, s.altitude));
    } else {
      beforeSeg.push(posAt(s.azimuth, s.altitude));
    }
  }
  for (const seg of [beforeSeg, afterSeg]) {
    if (seg.length > 1) {
      sunTrackEntities.push(viewer.entities.add({
        polyline: {
          positions: seg,
          width: 1.8,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString("#fbbf24").withAlpha(0.45),
            dashLength: 12,
          }),
          arcType: Cesium.ArcType.NONE,
        },
      }));
    }
  }

  if (c && c.peak) {
    const sp = sunAltAz(c.peak, activeGroundCartesian);
    totalityMarkerEntity = viewer.entities.add({
      position: posAt(sp.azimuth, sp.altitude),
      point: {
        pixelSize: 6,
        color: Cesium.Color.fromCssColorString("#f87171"),
        outlineColor: Cesium.Color.fromCssColorString("#fef08a"),
        outlineWidth: 1.5,
        disableDepthTestDistance: 0,
      },
      label: {
        text: `${hasTotality ? "Totality" : "Maximum"} ${formatNZST(c.peak).slice(0, 5)}`,
        font: "11px sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#fde68a"),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#0f172a").withAlpha(0.78),
        pixelOffset: new Cesium.Cartesian2(0, -40),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: 0,
        scale: 0.88,
      },
    });
    sunTrackEntities.push(totalityMarkerEntity);
  }
  for (const ent of sunTrackEntities) ent.show = cameraViewMode !== "eye";   // the strip does this job
}

function highlightActiveButtons() {
  document.querySelectorAll("#presetButtons button").forEach((btn) => {
    btn.setAttribute("aria-current", String(Boolean(activeLoc && btn.dataset.name === activeLoc.name)));
  });
}


// Move the observer/checked location WITHOUT moving the camera. Returns ground height.
async function setObserver(loc) {
  activeLoc = loc;
  if (!cinematic) hideNarration();     // any offer on screen was about the place we just left
  setVerdictPending("Checking the view from here…");
  rememberPlace(loc);
  highlightActiveButtons();

  // Does this spot already have an answer on disk? A catalogue click passes its own record
  // through; anything else (a shared link, a dropped pin) is matched on coordinates.
  activeCatEntry = loc.cat || findCatalogueEntry(loc.lat, loc.lon);

  // Sample ground height so the observer sits on the terrain.
  let groundHeight = 0;
  try {
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [
      Cesium.Cartographic.fromDegrees(loc.lon, loc.lat),
    ]);
    groundHeight = samples[0].height || 0;
  } catch (e) { groundHeight = 0; }
  if (!groundHeight && activeCatEntry && Number.isFinite(activeCatEntry.elev)) {
    groundHeight = activeCatEntry.elev;
  }
  activeGroundCartesian = Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat, groundHeight + EYE_HEIGHT);
  // The catalogue may have arrived while the ground height was loading. Its own retry could not
  // answer for this place then, because the observer did not exist yet.
  if (!activeCatEntry) activeCatEntry = findCatalogueEntry(loc.lat, loc.lon);

  updateLocationMarker(loc, groundHeight);
  // A moved location invalidates any drawn sightline.
  clearSightlineVisuals();
  prepareStrip();
  drawSunTrack3D();
  if (catalogue) renderTopSpots();   // distances are relative to where we now are
  updateShareUrl(loc);

  $("drawSkyline").hidden = true;
  if (activeCatEntry) {
    // The answer is already on disk for this spot, so give it immediately. The live probe
    // is a button inside the card rather than something that fires on arrival.
    //
    // A preset carries a whole horizon profile, so it gets the full card — table, chart and
    // all — instead of the catalogue's totality-only verdict. The fallback matters: HTML and
    // viewpoints.json are cached separately, so a browser can hold a new index.html against
    // an older catalogue with no profiles in it.
    if (activeCatEntry.profile) runPresetCheck(activeCatEntry);
    else renderCatalogueVerdict(activeCatEntry);
  }
  // Anything else is checked once the camera arrives (see checkSightlineOnArrival).
  syncMapLink(loc);

  if (viewer && viewer.clock) onTick(viewer.clock); // refresh sun readout and 3D sky for the new observer
  return groundHeight;
}

// Recalculate only once the camera has settled. The maths does not depend on the camera —
// terrain is sampled from the provider, not the rendered scene — but showing a new verdict
// while the old view is still flying reads as though the answer arrived before the move.
//
// A catalogue spot is exempt: setObserver has already painted the precomputed verdict, and
// re-deriving it live would sample ~300 terrain tiles (~10 MB) to restate what we shipped in
// viewpoints.json. Clicking through ten catalogue spots used to cost ten full probes.
//
// Wait for the catalogue first. The opening location is selected before viewpoints.json has
// arrived, so without this every visit to a preset would spend a full probe on a question
// the file is about to answer.
async function checkSightlineOnArrival() {
  await catalogueSettled;
  if (!activeCatEntry) runSightlineCheck();
}

// Keep the address bar pointing at wherever we actually are, so copying the URL shares this
// exact spot. replaceState rather than pushState: browsing a list of viewpoints should not
// bury the Back button under one entry per click.
function updateShareUrl(loc) {
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return;
  try {
    const q = new URLSearchParams(location.search);   // keeps ?terrain=ion etc.
    q.set("lat", loc.lat.toFixed(5));
    q.set("lon", loc.lon.toFixed(5));
    if (loc.name) q.set("name", String(loc.name).slice(0, 60)); else q.delete("name");
    history.replaceState(null, "", `${location.pathname}?${q}`);
  } catch (e) { /* non-fatal: a stale URL is better than a broken page */ }
}

// Time on the way in to maximum when the sun is `target` obscured. Bisection: obscuration
// rises monotonically from first contact to maximum, so this converges quickly.
function timeAtObscuration(target, cartesian) {
  const c = localCircumstances(cartesian);
  if (!c || !c.peak) return null;
  let lo = c.partialBegin || Cesium.JulianDate.addSeconds(c.peak, -3600, new Cesium.JulianDate());
  let hi = c.peak.clone();
  if (eclipseAt(hi, cartesian).obscuration < target) return null;   // never gets that deep
  for (let i = 0; i < 22; i++) {
    const mid = Cesium.JulianDate.addSeconds(
      lo, Cesium.JulianDate.secondsDifference(hi, lo) / 2, new Cesium.JulianDate());
    if (eclipseAt(mid, cartesian).obscuration < target) lo = mid; else hi = mid;
  }
  return hi;
}

// Camera placed BEHIND the observer, looking along the sun's bearing at maximum, so the
// location marker sits in the foreground and the low sun is in frame at the same time.
// Standing directly over the point hid the marker and left nothing to orient by.
// High and well back, so the frame shows a landscape rather than a foreshortened strip of
// near ground. The pitch has to stay shallow to keep the low sun in shot, and a shallow
// pitch from a low camera sees almost nothing but the hillside in front of it.
const VIEW_UP = 450;      // m above the higher of the two ground heights

// Half the vertical field of view, in degrees. Cesium's frustum.fov is the HORIZONTAL angle
// on a landscape window, so on a wide screen the usable vertical span is far smaller than it
// looks — 34 deg at 1.89 aspect. Framing that ignores this puts the sun off the top edge.
function halfVerticalFovDeg() {
  const cv = viewer.scene.canvas;
  const aspect = (cv.clientWidth || 1) / (cv.clientHeight || 1);
  const f = viewer.camera.frustum.fov || Cesium.Math.toRadians(60);
  const fovV = aspect > 1 ? 2 * Math.atan(Math.tan(f / 2) / aspect) : f;
  return Cesium.Math.toDegrees(fovV) / 2;
}

// The strip's real height, so the narration and the time left sit just above it.
function syncBarOffsets() {
  const r = $("strip").getBoundingClientRect();
  if (r.height > 0) document.documentElement.style.setProperty("--strip-h", `${Math.ceil(r.height)}px`);
}

// The visible band is the canvas above the skyline strip, which takes a very different share of
// a phone than of a desktop. Measure it and return both the usable half-angle and how far the
// usable centre sits above the canvas centre.
function framingBand() {
  const cv = viewer.scene.canvas;
  const H = cv.clientHeight || 1;
  const halfV = halfVerticalFovDeg();
  const degPerPx = (2 * halfV) / H;
  const r = $("strip").getBoundingClientRect();
  const bottom = r.height > 0 ? Math.max(0, H - r.top) : 0;
  // On a phone the verdict takes the whole width, so the sun has to sit below it. On a desktop
  // it sits to one side and the sky above the horizon stays free.
  const v = $("verdictBlock").getBoundingClientRect();
  const top = window.matchMedia("(max-width: 767px)").matches && v.height > 0 ? Math.min(v.bottom, H * 0.36) : 0;
  const usableHalfDeg = Math.max(4, ((H - top - bottom) / 2) * degPerPx);
  const offsetDeg = ((bottom - top) / 2) * degPerPx;
  return { usableHalfDeg, offsetDeg };
}

// Eye-level framing: stand at the observer's location looking toward the totality sun
// bearing, pitched slightly upward so the mountain horizon sits on the lower third and the
// eclipsed sun & corona sit cleanly in the sky below the top bar.
function frameEyeLevel(loc, groundHeight) {
  const c = localCircumstances(activeGroundCartesian);
  const s = sunAltAz(c && c.peak ? c.peak : viewer.clock.currentTime, activeGroundCartesian);
  const { offsetDeg } = framingBand();
  const pitchDeg = Math.max(2.5, Math.min(8, s.altitude * 0.48)) - offsetDeg;
  return {
    destination: Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat, groundHeight + 10),
    orientation: {
      heading: Cesium.Math.toRadians(s.azimuth),
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
  };
}

async function frameForLocation(loc, groundHeight) {
  if (cameraViewMode === "eye") return frameEyeLevel(loc, groundHeight);
  const c = localCircumstances(activeGroundCartesian);
  // Heading faces where the sun will be at totality, as that is the moment being framed.
  // Pitch is set from the sun's altitude *now* (arrival, ~50% obscured) — that is its
  // highest point in this window, so framing it guarantees the sun stays in shot as it
  // sinks toward totality rather than climbing out of the top of the frame.
  const sunAz = sunAltAz(c && c.peak ? c.peak : viewer.clock.currentTime,
                         activeGroundCartesian).azimuth;
  const sunAltNow = sunAltAz(viewer.clock.currentTime, activeGroundCartesian).altitude;

  // Fit the sun (up) and the marker (down) into the same frame, then pitch midway between
  // them so both sit the same distance from the centre.
  //
  // Only the middle of the canvas is really usable — the status bar covers the top and the
  // timeline covers the bottom, and a marker placed by canvas centre alone ends up hidden
  // behind the controls. Budgeting ~62% of the half-FOV keeps both clear of the chrome.
  const { usableHalfDeg, offsetDeg } = framingBand();
  const sunA = Math.max(sunAltNow, 0);
  let depression = Cesium.Math.clamp(2 * usableHalfDeg * 0.85 - sunA, 4, 30);
  let back = Cesium.Math.clamp(VIEW_UP / Math.tan(Cesium.Math.toRadians(depression)), 500, 9000);
  depression = Cesium.Math.toDegrees(Math.atan(VIEW_UP / back));
  // Put the midpoint of sun-and-marker at the centre of the *visible* band, not the canvas.
  const pitchDeg = (sunA - depression) / 2 - offsetDeg;

  const backRad = Cesium.Math.toRadians((sunAz + 180) % 360);
  const base = Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat, groundHeight);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(base);
  const flat = Cesium.Matrix4.multiplyByPoint(frame,
    new Cesium.Cartesian3(back * Math.sin(backRad), back * Math.cos(backRad), 0),
    new Cesium.Cartesian3());
  const carto = Cesium.Cartographic.fromCartesian(flat);

  // Clear the terrain behind us too, or the camera ends up inside a hillside in a valley.
  let backGround = groundHeight;
  try {
    const s = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider,
      [Cesium.Cartographic.clone(carto)]);
    backGround = s[0].height || groundHeight;
  } catch (e) { /* keep the observer's height */ }

  return {
    destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude,
      Math.max(groundHeight, backGround) + VIEW_UP),
    orientation: {
      heading: Cesium.Math.toRadians(sunAz),
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
  };
}

function syncViewToggleUI() {
  const isEye = cameraViewMode === "eye";
  $("viewToggle").innerHTML = isEye ? "<strong>Eye level</strong> or Overview" : "Eye level or <strong>Overview</strong>";
  $("viewToggle").setAttribute("aria-label", isEye ? "Switch to the overview" : "Switch to eye level");
  if (locationMarker) locationMarker.show = !isEye;
  for (const ent of sunTrackEntities) ent.show = !isEye;
  if (sightlinePrimitive) sightlinePrimitive.show = !isEye;
  for (const ent of sightlineExtras) ent.show = !isEye;
}

async function toggleCameraViewMode() {
  cameraViewMode = cameraViewMode === "overview" ? "eye" : "overview";
  trackMetric("view_mode", cameraViewMode);
  syncViewToggleUI();
  if (!viewer || !activeLoc || !activeGroundCartesian) return;
  const gh = Cesium.Cartographic.fromCartesian(activeGroundCartesian).height - EYE_HEIGHT;
  const view = await frameForLocation(activeLoc, gh);
  placeCamera(view, { duration: flightSeconds(1.4) });
}

// Re-apply the arrival framing for wherever we already are. Needed because the first framing
// happens while the UI is still hidden (so the chrome measures zero), and again whenever the
// window resizes or a phone rotates and the usable band changes shape.
async function reframeCurrent() {
  syncBarOffsets();
  if (!viewer || !activeLoc || !activeGroundCartesian) return;
  const gh = Cesium.Cartographic.fromCartesian(activeGroundCartesian).height - EYE_HEIGHT;
  placeCamera(await frameForLocation(activeLoc, gh));
}

// Camera moves are the one motion CSS cannot reach.
const flightSeconds = (s) =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : s;

// Looking along the ground, Cesium fetches detail all the way out to the horizon: about 22 MB
// for one eye-level view of Queenstown or Dunedin. Half the screen-space precision halves that,
// with no difference you can see from the ground. From the overview the town in the foreground
// does soften, so views from up there keep Cesium's default.
const GROUND_LEVEL_DETAIL = 4;
const OVERVIEW_DETAIL = 2;

// Cesium lifts the camera above whatever terrain it has loaded under it. Just after a jump that is
// a coarse tile, which averages the ridges into the valley floor: over Queenstown it reads 898 m
// against a true 327 m, so the eye-level camera was pushed 600 m up and left there, showing the
// sun clear of the ridge that hides it. The app's framings already come from the most detailed
// terrain, so the push is held off after each move the app makes until the view has loaded.
let cameraHold = null;
function holdCameraHeight() {
  const scene = viewer.scene;
  if (cameraHold) cameraHold();
  scene.screenSpaceCameraController.enableCollisionDetection = false;
  const since = performance.now();
  const stop = scene.postRender.addEventListener(() => {
    const waited = performance.now() - since;
    if ((waited > 500 && scene.globe.tilesLoaded) || waited > 30000) {
      stop();
      cameraHold = null;
      scene.screenSpaceCameraController.enableCollisionDetection = true;
    }
  });
  cameraHold = () => { stop(); cameraHold = null; };
}

// Every camera move the app makes goes through here. Without `flight` the camera jumps.
function placeCamera(view, flight) {
  const height = Cesium.Cartographic.fromCartesian(view.destination).height;
  const ground = activeGroundCartesian ? Cesium.Cartographic.fromCartesian(activeGroundCartesian).height : height;
  viewer.scene.globe.maximumScreenSpaceError = height - ground < 100 ? GROUND_LEVEL_DETAIL : OVERVIEW_DETAIL;
  holdCameraHeight();
  if (!flight) {
    viewer.camera.setView(view);
    return;
  }
  viewer.camera.flyTo({
    ...view,
    duration: flight.duration,
    // Flights hold off Cesium's push themselves, then it would act on arrival.
    complete: () => { holdCameraHeight(); if (flight.complete) flight.complete(); },
    cancel: flight.cancel,
  });
}



async function selectLocation(loc, fly = true) {
  closePanels();
  const groundHeight = await setObserver(loc);
  if (!viewer) {
    const c = localCircumstances(activeGroundCartesian);
    const t = (c && c.peak) ? c.peak : Cesium.JulianDate.fromIso8601(TOTALITY_MAX_UTC);
    updateReadouts(t, eclipseAt(t, activeGroundCartesian));
    return;
  }

  // Arrive part-way through the partial phase rather than at totality: at ~50% obscured
  // there is still enough light to read the terrain, and the user can jump forward to
  // totality/maximum without touching the camera. Leave the clock alone mid-playback.
  if (!cinematic) {
    const c = localCircumstances(activeGroundCartesian);
    const t50 = timeAtObscuration(0.5, activeGroundCartesian) || (c && c.peak ? c.peak.clone() : null);
    if (t50) {
      viewer.clock.currentTime = t50;
      onTick(viewer.clock);
    }
  }

  const view = await frameForLocation(loc, groundHeight);
  if (fly) {
    // Recalculate on arrival — and also if the flight is cancelled, which happens when the
    // user grabs the camera mid-flight. The observer has still moved, so they still need
    // an answer for the new spot.
    placeCamera(view, {
      duration: flightSeconds(2.0),
      complete: checkSightlineOnArrival,
      cancel: checkSightlineOnArrival,
    });
  } else {
    placeCamera(view);
    checkSightlineOnArrival();
  }
}

function updateLocationMarker(loc, groundHeight) {
  if (!viewer) return;
  const pos = Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat, groundHeight);
  if (!locationMarker) {
    locationMarker = viewer.entities.add({
      position: pos,
      point: {
        pixelSize: 11,
        color: Cesium.Color.fromCssColorString("#fbbf24"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: loc.name,
        font: "12px sans-serif",
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#0f172a").withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(0, -16),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 0.92,
      },
    });
  } else {
    locationMarker.position = pos;
    locationMarker.label.text = loc.name;
  }
  locationMarker.show = cameraViewMode !== "eye";
}

// ---- Click-to-pin & tap-globe-to-close-drawer ---------------------------------------
function setupMapClick() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((evt) => {
    if (!pinMode) {
      if (document.body.dataset.panel !== "none") closePanels();
      return;
    }
    const ray = viewer.camera.getPickRay(evt.position);
    let cartesian = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
    if (!Cesium.defined(cartesian)) {
      cartesian = viewer.camera.pickEllipsoid(evt.position, viewer.scene.globe.ellipsoid);
    }
    if (!Cesium.defined(cartesian)) {
      setCustomStatus("Couldn't read that point — aim at the terrain", "error");
      return;
    }
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    togglePinMode(false);
    if (!inNzBounds(lat, lon)) {
      setCustomStatus("Please pin a location within New Zealand", "error");
      return;
    }
    trackMetric("map_pin");
    // Pinning does not move the camera, so there is nothing to wait for.
    setObserver({ name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon })
      .then(checkSightlineOnArrival);
    setCustomStatus(`Pinned ${lat.toFixed(4)}, ${lon.toFixed(4)}`, "ok");
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function togglePinMode(forceState) {
  pinMode = typeof forceState === "boolean" ? forceState : !pinMode;
  const btn = $("pinToggle");
  viewer.scene.canvas.style.cursor = pinMode ? "crosshair" : "";
  btn.setAttribute("aria-pressed", String(pinMode));
  btn.textContent = pinMode ? "Tap the 3D view…" : "Pin on the 3D view";
  if (pinMode) {
    closePanels();
    narrate("Tap the 3D view to set the place.", "Press Escape to cancel.");
  } else {
    hideNarration();
    setCustomStatus("", "");
  }
}

// ====================================================================================
//  THE VERDICT, THE SKYLINE STRIP AND THE PANELS
// ====================================================================================
const $ = (id) => document.getElementById(id);

// A clock time as people say it: 4:16 pm. NZST = UTC + 12.
function clockText(j, seconds = false) {
  const g = Cesium.JulianDate.toGregorianDate(Cesium.JulianDate.addHours(j, 12, new Cesium.JulianDate()));
  const h = g.hour % 12 || 12;
  const mm = String(g.minute).padStart(2, "0");
  const ss = seconds ? `:${String(Math.floor(g.second)).padStart(2, "0")}` : "";
  return `${h}:${mm}${ss} ${g.hour < 12 ? "am" : "pm"}`;
}

const secondsIn = (j) => Cesium.JulianDate.secondsDifference(j, startJulian);
const minutesText = (s) => {
  const r = Math.round(s);   // round first, or 179.6 s reads "2 min 60 s"
  return `${Math.floor(r / 60)} min ${String(r % 60).padStart(2, "0")} s`.replace(" ", " ");
};

function percentCovered(c) {
  if (!c || !c.peak) return "0%";
  const o = Number.isFinite(c.peakObscuration) ? c.peakObscuration : eclipseAt(c.peak, activeGroundCartesian).obscuration;
  return o >= 0.995 ? "99.9%" : `${Math.round(o * 100)}%`;
}

// The clock, the phase and the time left, once per tick.
function updateReadouts(t, e) {
  const c = activeGroundCartesian ? localCircumstances(activeGroundCartesian) : null;
  const hasTotality = Boolean(c && c.totalBegin);
  $("clockReadout").textContent = clockText(t, true);
  const pct = e.obscuration >= 0.995 ? "99.9%" : `${Math.round(e.obscuration * 100)}%`;
  $("phaseReadout").textContent = e.isTotal ? "Totality"
    : hasTotality && e.obscuration >= 0.985 ? "Diamond ring"
    : e.mag > 0 ? `${pct} covered` : "No eclipse";

  document.body.dataset.quiet = e.isTotal ? "1" : "0";
  if (e.isTotal && c && c.totalEnd) {
    const left = Math.max(0, Cesium.JulianDate.secondsDifference(c.totalEnd, t));
    $("timeLeftValue").textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
    $("timeLeftNote").textContent = `of totality left at ${activeLoc ? activeLoc.name : "this place"}${
      currentSightlineBlocked ? ", hidden by the ridge" : ""}`;
  }
  $("timeScrub").setAttribute("aria-valuetext", `${clockText(t)}, ${$("phaseReadout").textContent}`);
}

// Anything you do during totality brings the controls back for a moment.
let wakeTimer = null;
function wake() {
  document.body.dataset.awake = "1";
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => { document.body.dataset.awake = "0"; }, 2500);
}

// ---- panels ------------------------------------------------------------------------
function setPanel(which) {
  document.body.dataset.panel = which;
}
const closePanels = () => setPanel("none");

// ---- the strip ---------------------------------------------------------------------
let strip = null;       // { azLo, azHi, track, contacts, profile, known, scales }

const CONTACT_SNAP_PX = 16;
const COMPASS_MARKS = [270, 292.5, 315, 337.5, 360];

function pad(c) {
  const azs = [c.partialBegin, c.peak, c.partialEnd].filter(Boolean)
    .map((j) => sunAltAz(j, activeGroundCartesian).azimuth);
  return { azLo: Math.min(...azs) - HORIZON_SPAN / 2, azHi: Math.max(...azs) + HORIZON_SPAN / 2 };
}

// The strip for a place before any skyline is known: the sun's path and its contacts are pure
// astronomy, so they can be drawn the moment we arrive.
function prepareStrip() {
  const c = localCircumstances(activeGroundCartesian);
  const hasTotality = Boolean(c && c.totalBegin && c.totalEnd);
  const set = (id, j, time, word) => {
    const b = $(id);
    b.hidden = !j;
    if (j) b.innerHTML = `${time}<span class="contact-word">, ${word}</span>`;
  };
  set("jumpStart", c && c.partialBegin, c && c.partialBegin ? clockText(c.partialBegin) : "", "eclipse begins");
  set("jumpTotality", c && c.peak, c && c.peak ? clockText(c.peak) : "", hasTotality ? "totality" : "maximum");
  set("jumpEnd", c && c.partialEnd, c && c.partialEnd ? clockText(c.partialEnd) : "", "eclipse ends");

  if (!c || !c.peak) { strip = null; $("stripSvg").innerHTML = ""; return; }
  const { azLo, azHi } = pad(c);
  const times = [];
  for (let s = 0; s <= windowSecs; s += 60) times.push(s);
  for (const j of [c.partialBegin, c.totalBegin, c.peak, c.totalEnd, c.partialEnd]) if (j) times.push(secondsIn(j));
  times.sort((a, b) => a - b);
  const track = times.map((t) => {
    const s = sunAltAz(Cesium.JulianDate.addSeconds(startJulian, t, new Cesium.JulianDate()), activeGroundCartesian);
    return { t, az: s.azimuth, alt: s.altitude };
  }).filter((p) => p.alt >= 0 && p.az >= azLo && p.az <= azHi);

  const point = (id, j) => {
    const s = sunAltAz(j, activeGroundCartesian);
    return { id, t: secondsIn(j), az: s.azimuth, alt: s.altitude };
  };
  const contacts = [["jumpStart", c.partialBegin], ["jumpTotality", c.peak], ["jumpEnd", c.partialEnd]]
    .filter(([, j]) => j).map(([id, j]) => point(id, j));

  strip = { azLo, azHi, track, contacts, profile: null, known: [] };
  renderStrip();
}

function renderStrip() {
  const svg = $("stripSvg");
  const chart = $("stripChart");
  const W = chart.clientWidth, H = chart.clientHeight;
  if (!strip || !W || !H) return;
  const { profile, known, track, contacts, azLo, azHi } = strip;
  const yMax = Skyline.chartCeiling(profile, known, track);
  const scales = Skyline.skylineScales({ width: W, height: H, topPad: 30, basePad: 22, azLo, azHi, yMax });
  const { X, Y, base } = scales;
  strip.scales = scales;
  for (const c of contacts) c.x = X(c.az);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const WARM = "#F5B83D", FROST = "#EFF3F1", INK = "#0A1016", RED = "#E5475B";
  let out = "";
  if (profile) {
    const edge = (az) => ({ az, angle: Skyline.horizonAt(profile, az) });
    const line = Skyline.skylinePath(
      [edge(azLo), ...profile.filter((p) => p.az > azLo && p.az < azHi), edge(azHi)], X, Y);
    out += `<path d="${line} L${W} ${H} L0 ${H}Z" fill="${INK}" fill-opacity=".95"/>`;
    out += `<path d="${line}" fill="none" stroke="${FROST}" stroke-width="1.6" stroke-linejoin="round"/>`;
  } else {
    out += `<rect x="0" y="${base}" width="${W}" height="${H - base}" fill="${INK}" fill-opacity=".95"/>`;
    out += `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="${FROST}" stroke-opacity=".5" stroke-dasharray="3 6"/>`;
  }
  for (const [alt, label] of [[10, "1 fist"], [20, "2 fists"], [30, "3 fists"]]) {
    if (alt >= yMax) continue;
    const y = Y(alt).toFixed(1);
    out += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="${FROST}" stroke-opacity=".28" stroke-dasharray="2 7"/>`;
    out += `<text x="12" y="${(Y(alt) - 5).toFixed(1)}" fill="${FROST}" fill-opacity=".85" font-size="12" paint-order="stroke" stroke="${INK}" stroke-width="3" stroke-linejoin="round">${label}</text>`;
  }
  for (const az of COMPASS_MARKS) {
    if (az < azLo || az > azHi) continue;
    out += `<text x="${X(az).toFixed(1)}" y="${H - 6}" fill="${FROST}" fill-opacity=".72" font-size="12" text-anchor="middle">${compassShort(az)}</text>`;
  }
  for (const k of known) {
    const y = Y(k.angle).toFixed(1);
    out += `<line x1="${(X(k.az) - 26).toFixed(1)}" x2="${(X(k.az) + 26).toFixed(1)}" y1="${y}" y2="${y}" stroke="${FROST}" stroke-width="2"/>`;
  }
  for (const run of Skyline.splitByVisibility(track, profile)) {
    if (run.points.length < 2) continue;
    const d = run.points.map((p, i) => `${i ? "L" : "M"}${X(p.az).toFixed(1)} ${Y(p.alt).toFixed(1)}`).join(" ");
    out += run.visible
      ? `<path d="${d}" fill="none" stroke="${WARM}" stroke-width="3" stroke-linecap="round"/>`
      : `<path d="${d}" fill="none" stroke="${WARM}" stroke-opacity=".6" stroke-width="1.8" stroke-dasharray="4 6"/>`;
  }
  for (const c of contacts) {
    out += `<circle cx="${c.x.toFixed(1)}" cy="${Y(c.alt).toFixed(1)}" r="4.5" fill="${FROST}" stroke="${INK}" stroke-width="2"/>`;
  }

  const short = $("stripShort");
  short.hidden = true;
  const v = verdictView;
  if (v && profile && v.focus && v.focus.blocked && !v.focus.below) {
    const x = X(v.focus.az), y0 = Y(v.focus.alt), y1 = Y(v.focus.horizon);
    out += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${(y0 - 12).toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${RED}" stroke-width="1.8"/>`;
    const gap = v.focus.horizon - v.focus.alt;
    short.innerHTML = `${gap.toFixed(1)}° short<span class="contact-word">, ${handMeasure(gap)}</span>`;
    // It hangs under the ridge, so put it on the side where the ridge stays high.
    const onRight = Skyline.horizonAt(profile, v.focus.az + 6) >= Skyline.horizonAt(profile, v.focus.az - 6);
    short.style.left = onRight ? `${(x + 10).toFixed(0)}px` : "auto";
    short.style.right = onRight ? "auto" : `${(W - x + 10).toFixed(0)}px`;
    short.style.top = `${(y1 + 6).toFixed(0)}px`;
    short.hidden = false;
  }
  out += `<circle id="stripSun" class="sun-mark" r="11" cx="-40" cy="-40"/>`;
  svg.innerHTML = out;

  for (const c of contacts) {
    const b = $(c.id);
    b.style.left = `${Math.max(46, Math.min(W - 46, c.x)).toFixed(0)}px`;
    b.style.top = `${Y(c.alt).toFixed(0)}px`;
  }
  if (viewer && activeGroundCartesian) {
    updateStripSun(eclipseAt(viewer.clock.currentTime, activeGroundCartesian));
  }
}

function updateStripSun(e) {
  const sun = $("stripSun");
  if (!sun || !strip || !strip.scales) return;
  const { X, Y } = strip.scales;
  const inView = e.sunAlt >= 0 && e.sunAz >= strip.azLo && e.sunAz <= strip.azHi;
  sun.style.display = inView ? "" : "none";
  if (!inView) return;
  sun.setAttribute("cx", X(e.sunAz).toFixed(1));
  sun.setAttribute("cy", Y(e.sunAlt).toFixed(1));
  const hidden = strip.profile ? e.sunAlt <= Skyline.horizonAt(strip.profile, e.sunAz) : currentSightlineBlocked && e.isTotal;
  const set = (fill, stroke, dash) => {
    sun.setAttribute("fill", fill);
    sun.setAttribute("stroke", stroke);
    sun.setAttribute("stroke-width", "2");
    sun.setAttribute("stroke-dasharray", dash);
  };
  if (hidden) set("#0A1016", "#E5475B", "4 3");
  else if (e.isTotal) set("#0A1016", "#EFF3F1", "");
  else set("#F5B83D", "#EFF3F1", "");
}

function setClockSeconds(s) {
  if (!viewer) return;
  viewer.clock.currentTime = Cesium.JulianDate.addSeconds(startJulian, Cesium.Math.clamp(s, 0, windowSecs), new Cesium.JulianDate());
  onTick(viewer.clock);
}

function wireStrip() {
  const chart = $("stripChart");
  let dragging = false;
  const moveTo = (e) => {
    if (!strip || !strip.scales) return;
    const x = e.clientX - chart.getBoundingClientRect().left;
    const snap = Skyline.snapToContact(x, strip.contacts, CONTACT_SNAP_PX);
    const t = snap ? snap.t : Skyline.secondsAtX(strip.track, strip.scales.X, x);
    if (t != null) setClockSeconds(t);
  };
  chart.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    dragging = true;
    chart.setPointerCapture(e.pointerId);
    moveTo(e);
  });
  chart.addEventListener("pointermove", (e) => { if (dragging) moveTo(e); });
  const end = () => { dragging = false; };
  chart.addEventListener("pointerup", end);
  chart.addEventListener("pointercancel", end);

  const scrub = $("timeScrub");
  scrub.addEventListener("input", () => {
    scrub.dataset.dragging = "1";
    setClockSeconds((scrub.value / 1000) * windowSecs);
    delete scrub.dataset.dragging;
  });
  // Page Up and Page Down step between contacts, the keyboard's version of tapping one.
  scrub.addEventListener("keydown", (e) => {
    if ((e.key !== "PageUp" && e.key !== "PageDown") || !strip || !viewer) return;
    e.preventDefault();
    const hop = Skyline.adjacentContact(strip.contacts, secondsIn(viewer.clock.currentTime), e.key === "PageUp" ? 1 : -1);
    if (hop) setClockSeconds(hop.t);
  });

  const jump = (pick) => () => {
    const c = localCircumstances(activeGroundCartesian);
    const target = c ? pick(c) : null;
    if (target) setClockSeconds(secondsIn(target));
  };
  $("jumpStart").addEventListener("click", jump((c) => c.partialBegin));
  $("jumpTotality").addEventListener("click", jump((c) => c.peak));
  $("jumpEnd").addEventListener("click", jump((c) => c.partialEnd));

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    renderStrip();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderStrip, 200);
  });
}

// ---- the verdict -------------------------------------------------------------------
let verdictView = null;

function setVerdictPending(text) {
  verdictView = null;
  $("placeName").textContent = activeLoc ? activeLoc.name : "Choose a place";
  $("verdictRest").textContent = "";
  $("verdictReason").textContent = text;
  $("goNearest").hidden = true;
  $("openDetails").hidden = true;
  $("stripShort").hidden = true;
}

function renderVerdictBlock() {
  const v = verdictView;
  $("placeName").textContent = activeLoc.name;
  $("verdictRest").textContent = Skyline.verdictPredicate(v);
  $("verdictReason").textContent = Skyline.verdictReason(v);
  $("openDetails").hidden = false;

  // Somewhere nearby that is clearly better: clear where this place is blocked, with more room
  // above the skyline where this one is tight, or with longer totality.
  const go = $("goNearest");
  const s = v.stored;
  const here = {
    level: v.scope === "totality" ? v.level : "blocked",
    clearance: s && Number.isFinite(s.clearance) ? s.clearance : v.focus.alt - v.focus.horizon,
    totality: v.scope === "totality" ? v.totalitySeconds || 0 : 0,
  };
  const near = betterPlaceFor(activeLoc, here);
  go.hidden = !near;
  if (near) {
    const km = near.km.toFixed(near.km < 10 ? 1 : 0);
    const c = near.cat;
    // The numbers come from the catalogue; a town's own choice still reads sensibly without it.
    const gain = {
      clear: c ? `clear for all ${minutesText(c.totality)}` : "clear for all of totality",
      margin: c ? `the sun clears the skyline by ${handMeasure(c.clearance)}` : "more room above the skyline",
      longer: c ? `${minutesText(c.totality)} of totality instead of ${minutesText(here.totality)}` : "a longer totality",
    }[near.why];
    go.innerHTML = `Go to ${esc(near.name)}<small>${km} km to the ${compassName(near.bearing)}, sealed road, ${gain}</small>`;
    go.onclick = () => {
      trackMetric("catalogue_select", "poi", near.name);
      selectLocation({ name: near.name, lat: near.lat, lon: near.lon, cat: c || undefined }, true);
    };
  }
}

// The "Go to..." suggestion for a place: a town's own fixed choice (`goTo` in LOCATIONS), or
// else the nearest clearly better spot in the catalogue. Returns
// { name, lat, lon, km, bearing, why, cat } or null; `cat` is the catalogue record, if loaded.
function betterPlaceFor(loc, here) {
  const town = LOCATIONS.find((l) => Catalogue.haversineM(l.lat, l.lon, loc.lat, loc.lon) < 50);
  if (town) {
    const g = town.goTo;
    if (!g) return null;
    return { name: g.name, lat: g.lat, lon: g.lon, why: g.why, cat: findCatalogueEntry(g.lat, g.lon),
      km: Catalogue.haversineM(loc.lat, loc.lon, g.lat, g.lon) / 1000,
      bearing: Catalogue.bearingDeg(loc.lat, loc.lon, g.lat, g.lon) };
  }
  const r = catalogue && Catalogue.betterSpotNearby(catalogue, here, loc.lat, loc.lon);
  return r ? { ...r, name: r.spot.name, lat: r.spot.lat, lon: r.spot.lon, cat: r.spot } : null;
}

// The facts about a catalogue spot that belong beside its verdict.
function spotFactsHtml(s) {
  if (!s || (!s.kind && !s.isPoi)) return "";
  const row = (dt, dd) => (dd ? `<div><dt>${dt}</dt><dd>${dd}</dd></div>` : "");
  const access = (s.accessSub && ACCESS_SUB_LABEL[s.accessSub]) || ACCESS_TIP[s.access] || s.access || "";
  const type = POI_LABEL[s.kind] || s.kind || "viewpoint";
  return row("Type", esc(type[0].toUpperCase() + type.slice(1)))
    + row("Getting there", esc(access))
    + row("Land", esc(s.land))
    + row("Trail", esc(s.trackName ? formatTrackName(s.trackName) : ""))
    + row("Public access", s.publicAccess === true ? "Verified" : s.publicAccess === false ? "Not verified" : "");
}

function gmapsUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

function renderDetails() {
  const v = verdictView;
  const box = $("detailBody");
  const no = v.level !== "clear" || v.scope !== "totality";
  const rows = v.rows.map((r) => `
    <tr data-judged="${r.judged ? 1 : 0}">
      <td>${r.label}</td><td>${r.time}</td><td>${r.sun}</td>
      <td class="${r.blocked ? "no" : ""}">${r.state}</td>
    </tr>`).join("");
  const row = (dt, dd) => (dd ? `<div><dt>${dt}</dt><dd>${dd}</dd></div>` : "");
  const c = v.cloudStat;
  const s = v.stored;
  box.innerHTML = `
    <p class="detail-head" data-no="${no ? 1 : 0}">${v.headline}</p>
    <table class="contacts">
      <thead><tr><th>At this place</th><th>Time</th><th>Sun</th><th>Skyline</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <dl class="facts">
      ${row("Totality lasts", v.totalitySeconds ? minutesText(v.totalitySeconds) : "")}
      ${row("Chance of clear sky", c && c.cloud != null ? `${(c.clearProb != null ? c.clearProb : 100 - c.cloud).toFixed(0)}%, from past Julys` : "")}
      ${row("Low cloud or fog", c && c.cloudLow > 18 ? `${c.cloudLow.toFixed(0)}% of the time` : "")}
      ${row("At maximum", `Sun ${v.focus.alt.toFixed(1)}° on bearing ${v.focus.az.toFixed(0)}°, skyline ${v.focus.horizon.toFixed(1)}°`)}
      ${spotFactsHtml(s)}
      ${row("Coordinates", `${activeLoc.lat.toFixed(5)}, ${activeLoc.lon.toFixed(5)}`)}
    </dl>
    ${v.notes.map((n) => `<p class="note" data-warn="${n.warn ? 1 : 0}">${n.text}</p>`).join("")}
    <div class="detail-actions">
      <a id="detailGmaps" href="${gmapsUrl(activeLoc.lat, activeLoc.lon)}" target="_blank" rel="noopener">Open in Google Maps</a>
    </div>
    <p class="fine">${v.source}</p>
    <p class="fine">Check this spot in person before the day. Road access is not permission to enter.
      Wear eclipse glasses for every partial phase. Independent planning tool, not yet validated.</p>`;
}

function presentVerdict(view) {
  verdictView = view;
  if (strip) {
    strip.profile = view.profile;
    strip.known = view.known;
    renderStrip();
  }
  $("stripBusy").hidden = true;
  $("drawSkyline").hidden = !(view.stored && !view.profile && !view.stored.profile);
  renderVerdictBlock();
  renderDetails();
}

// ====================================================================================
//  CUSTOM LOCATION (coordinates / address / browser geolocation)
// ====================================================================================
function setCustomStatus(msg, type) {
  const el = document.getElementById("customStatus");
  el.hidden = !msg;
  el.textContent = msg || "";
  el.dataset.type = type || "";
}

async function geocodeAddress(query) {
  const res = await fetch(photonUrl(query, 5), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Geocoding service unavailable");
  const list = photonFeatures(await res.json());
  if (!list.length) throw new Error("Address not found in New Zealand");
  return { name: shortName(list[0].name), lat: list[0].lat, lon: list[0].lon };
}

// ---- Address autocomplete (Photon) -------------------------------------------------
let suggestTimer = null;
let suggestAbort = null;
let suggestItems = [];
let suggestActive = -1;
const COORD_RE = /^-?\d+(?:\.\d+)?\s*[, ]\s*-?\d+(?:\.\d+)?$/;

function hideSuggestions() {
  $("suggestions").hidden = true;
  $("questionSuggestions").hidden = true;
  suggestItems = [];
  suggestActive = -1;
}

async function fetchSuggestions(q, boxEl, onChoose) {
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();
  try {
    const res = await fetch(photonUrl(q, 5), {
      signal: suggestAbort.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    renderSuggestions(photonFeatures(await res.json()), boxEl, onChoose);
  } catch (e) { /* aborted or offline — ignore */ }
}

function renderSuggestions(items, boxEl = $("suggestions"), onChoose = chooseSuggestion) {
  const box = boxEl;
  if (!items || !items.length) { hideSuggestions(); return; }
  suggestItems = items;
  suggestActive = -1;
  box.innerHTML = "";
  suggestItems.forEach((it, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "suggest-item";
    el.textContent = it.name;
    el.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") e.preventDefault(); });
    el.addEventListener("click", () => onChoose(i));
    box.appendChild(el);
  });
  box.hidden = false;
}

function highlightSuggestion() {
  document.querySelectorAll(".suggest-item").forEach((el, i) => {
    el.classList.toggle("active", i === suggestActive);
    if (i === suggestActive) el.scrollIntoView({ block: "nearest" });
  });
}

function shortName(name) { return name.length > 40 ? name.slice(0, 38) + "…" : name; }

function chooseSuggestion(i) {
  const it = suggestItems[i];
  if (!it) return;
  document.getElementById("customInput").value = shortName(it.name);
  hideSuggestions();
  trackMetric("custom_search", "address");
  selectLocation({ name: shortName(it.name), lat: it.lat, lon: it.lon }, true);
  setCustomStatus("", "ok");
}

// "lat, lon" or "lat lon" means coordinates; anything else is an address. Throws a message fit
// to show the visitor.
async function resolvePlace(raw) {
  const coords = Places.parseCoords(raw);
  if (!coords) return geocodeAddress(raw);
  const { lat, lon } = coords;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error("Coordinates out of range");
  if (!inNzBounds(lat, lon)) throw new Error("Location must be within New Zealand");
  return { name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon };
}

async function goToCustom() {
  hideSuggestions();
  const raw = $("customInput").value.trim();
  if (!raw) return;
  setCustomStatus("Locating…", "info");
  try {
    const loc = await resolvePlace(raw);
    trackMetric("custom_search", Places.parseCoords(raw) ? "coords" : "address");
    await selectLocation(loc, true);
    setCustomStatus("", "ok");
  } catch (e) {
    setCustomStatus(e.message || "Could not find that location", "error");
  }
}

function useMyLocation() {
  if (!navigator.geolocation) { setCustomStatus("Geolocation not supported", "error"); return; }
  setCustomStatus("Requesting your location…", "info");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      if (!inNzBounds(latitude, longitude)) {
        setCustomStatus("Your location is outside New Zealand", "error");
        return;
      }
      trackMetric("geolocation_use");
      await selectLocation({ name: "My location", lat: latitude, lon: longitude }, true);
      setCustomStatus("", "ok");
    },
    (err) => setCustomStatus(err.code === 1 ? "Location permission denied" : "Could not get your location", "error"),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ====================================================================================
//  SIGHTLINE CHECK
// ====================================================================================
async function runSightlineCheck() {
  // Clicking through several spots starts several checks. Each takes seconds of terrain
  // sampling, so an earlier one can finish last and paint a result for the wrong place —
  // stamp each run and let only the newest write to the panel.
  const token = ++sightlineToken;
  const stale = () => token !== sightlineToken;
  // Remember whether we are refining a precomputed verdict, so the result can say how the
  // two compare instead of quietly overwriting one number with a slightly different one.
  const catAtStart = activeCatEntry;

  if (terrainSource === "offline" && activeCatEntry) {
    if (activeCatEntry.profile) runPresetCheck(activeCatEntry);
    else renderCatalogueVerdict(activeCatEntry);
    return;
  }

  const c = localCircumstances(activeGroundCartesian);
  // The sun swings several degrees in azimuth across the ~2 hours of the eclipse, so terrain
  // can block one contact and not another. Each contact gets its own full-resolution ray.
  const contacts = eclipseContacts(c);
  const moments = contacts.filter(isListedContact);

  $("drawSkyline").hidden = true;
  $("stripBusy").textContent = "Drawing the skyline…";
  $("stripBusy").hidden = false;
  if (!verdictView) $("verdictReason").textContent = "Checking the terrain around you…";

  // The terrain horizon does not depend on time — so sample it ONCE and test all sun
  // positions against it. Each moment's own bearing gets full radial resolution; a coarser
  // fan spanning them all builds the silhouette for the chart.
  const fine = radialDistances(0.03);
  const coarse = radialDistances(0.06);
  const azs = moments.map((m) => m.az);
  const azLo = Math.min(...azs) - HORIZON_SPAN / 2;
  const azHi = Math.max(...azs) + HORIZON_SPAN / 2;
  const rays = contacts.map((m) => ({ az: m.az, dists: fine, moment: m }));
  for (let a = azLo; a <= azHi + 1e-9; a += HORIZON_STEP) {
    if (moments.some((m) => Math.abs(m.az - a) < HORIZON_STEP / 2)) continue;
    rays.push({ az: a, dists: coarse, moment: null });
  }

  const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(activeGroundCartesian);
  const cartographics = [];
  for (const ray of rays) {
    const azRad = Cesium.Math.toRadians(ray.az);
    for (const d of ray.dists) {
      const offset = new Cesium.Cartesian3(d * Math.sin(azRad), d * Math.cos(azRad), 0);
      const fixed = Cesium.Matrix4.multiplyByPoint(enuToFixed, offset, new Cesium.Cartesian3());
      cartographics.push(Cesium.Cartographic.fromCartesian(fixed));
    }
  }

  let sampled;
  try {
    sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartographics);
  } catch (e) {
    if (stale()) return;
    $("stripBusy").textContent = "The terrain did not load. Choose a town or a catalogued spot instead.";
    if (!verdictView) $("verdictReason").textContent = "The terrain did not load, so this place can’t be checked right now.";
    return;
  }
  if (stale()) return;               // the user has moved on; a newer check owns the panel

  // Reduce each bearing to its horizon angle (max elevation angle along that ray).
  //
  // A sample whose tile failed to load comes back with no height. Defaulting that to 0 would
  // silently drop the terrain to sea level and could turn a blocked view into a "clear" one —
  // the same failure shape as a throttled Overpass cell looking roadless. The terrain service
  // is best-effort and does throttle, so skip missing samples and count them, then tell the
  // user if enough went missing to make the verdict unreliable.
  const observerHeight = Cesium.Cartographic.fromCartesian(activeGroundCartesian).height;
  const profile = [];
  const horizonByBearing = new Map();
  let k = 0, missing = 0, total = 0;
  for (const ray of rays) {
    let rayMax = -90, rayDist = 0, rayHeight = 0;
    for (const d of ray.dists) {
      const h = sampled[k++].height;
      total++;
      if (!Number.isFinite(h)) { missing++; continue; }
      const drop = (d * d) / (2 * EFFECTIVE_EARTH_RADIUS); // earth curvature + terrestrial refraction
      const angle = Cesium.Math.toDegrees(Math.atan2(h - observerHeight - drop, d));
      if (angle > rayMax) { rayMax = angle; rayDist = d; rayHeight = h; }
    }
    if (!ray.moment || isListedContact(ray.moment)) {
      profile.push({ az: ray.az, angle: rayMax });
    }
    if (ray.moment) {
      horizonByBearing.set(ray.az, { angle: rayMax, ridgeDist: rayDist, ridgeHeight: rayHeight });
    }
  }
  profile.sort((a, b) => a.az - b.az);

  // The live-terrain adapter for the verdict's horizonAt seam: every contact's bearing was
  // given its own ray above, so the lookup is exact.
  const v = Verdict.evaluateSightline({
    scope: verdictScope(c), contacts, totalitySeconds: totalitySeconds(c),
    horizonAt: (az) => horizonByBearing.get(az),
  });
  trackMetric("sightline_check", v.level);
  showSightlineVerdict(v, profile, azLo, azHi, missing / Math.max(1, total), catAtStart);
}

// Inside the path the question is whether you will see totality; outside it there is no
// totality to lose, so the verdict judges what eclipse there is (GLOSSARY.md, "Scope").
function verdictScope(c) {
  return c && c.totalBegin && c.totalEnd ? "totality" : "eclipse";
}

// Contacts at the active observer: first contact, maximum and last contact — or just "now"
// outside the eclipse — plus second and third contact inside the path of totality. Which of
// them count towards the verdict is the scope's job. `contact` keys are localCircumstances() fields;
// `alt`/`az` duplicate `sunAlt`/`sunAz` for the chart and card renderers.
function eclipseContacts(c) {
  const list = c && c.partialBegin
    ? [
        { contact: "partialBegin", label: "Start", j: c.partialBegin },
        { contact: "peak", label: "Maximum", j: c.peak },
        { contact: "partialEnd", label: "End", j: c.partialEnd },
      ]
    : [{ contact: "now", label: "Now", j: viewer.clock.currentTime.clone() }];
  if (c && c.totalBegin && c.totalEnd) {
    list.push({ contact: "totalBegin", label: "Totality begins", j: c.totalBegin },
              { contact: "totalEnd", label: "Totality ends", j: c.totalEnd });
  }
  for (const m of list) {
    const s = sunAltAz(m.j, activeGroundCartesian);
    m.sunAlt = m.alt = s.altitude;
    m.sunAz = m.az = s.azimuth;
    m.dir = s.dir;
  }
  return list;
}

// Second and third contact are judged but not listed: the card and chart show the others.
function isListedContact(m) {
  return m.contact !== "totalBegin" && m.contact !== "totalEnd";
}

function totalitySeconds(c) {
  return c && c.totalBegin && c.totalEnd
    ? Cesium.JulianDate.secondsDifference(c.totalEnd, c.totalBegin) : 0;
}

// Draw a verdict: the sightline ray, the horizon chart and the result card.
function showSightlineVerdict(v, profile, azLo, azHi, missingFraction = 0, cat = null, preset = null) {
  const f = v.focus;
  drawSightline(f.dir, !f.blocked && !f.below, {
    horizon: f.horizon,
    ridgeDist: f.ridgeDist,
    ridgeHeight: f.ridgeHeight,
    az: f.az,
  });
  renderSightlineResults(v, profile, missingFraction, cat, preset);
}

// Second and third contact sit beside "Start" and "End" in the table, where those two words
// would be ambiguous (GLOSSARY.md, "Contact").
const TABLE_CONTACT_LABEL = { partialBegin: "Eclipse begins", partialEnd: "Eclipse ends" };

function renderSightlineResults(v, profile, missingFraction = 0, cat = null, preset = null) {
  const moments = v.contacts.filter(isListedContact);
  const focus = v.focus;
  const c = activeGroundCartesian ? localCircumstances(activeGroundCartesian) : null;
  const hasTotality = Boolean(c && c.totalBegin && c.totalEnd);
  const totDur = totalitySeconds(c);
  const peakPct = percentCovered(c);
  const hasPeak = Boolean(c && c.peak);
  const note = (text, warn = false) => ({ text, warn });
  const notes = [];

  // Never present a confident verdict built on terrain that failed to download.
  if (missingFraction > 0.01) {
    notes.push(note(`${Math.round(missingFraction * 100)}% of the terrain samples did not load, so this verdict may be unreliable.`, true));
  }
  if (focus.grazing) {
    notes.push(note(`The centre of the sun clears the skyline by ${(focus.alt - focus.horizon).toFixed(1)}&deg;, but its disc spans about 0.5&deg;, so its lower edge grazes the ridge.`, true));
  }
  if (hasTotality && !focus.blocked && v.level === "partial") {
    notes.push(note("The sun clears the skyline at maximum, but terrain cuts in at the start or end of totality.", true));
  }
  if (v.nearEdge) {
    notes.push(note(`Totality lasts under a minute here (${Math.round(totDur)} s), near the edge of the path. A few kilometres towards the centre line buys a lot more.`, true));
  }
  // The verdict only judges totality, so a place can be clear and still lose the far ends of
  // the partial eclipse, when the sun is much lower.
  const lostEnds = hasTotality && v.level === "clear" ? moments.filter((m) => m.blocked) : [];
  if (lostEnds.length) {
    notes.push(note(`Totality itself is clear, but terrain hides the sun at ${lostEnds.map((m) => (m.contact === "partialBegin" ? "the start" : "the end")).join(" and ")} of the partial eclipse, over an hour away from totality.`));
  }
  if (moments.some((m) => m.below)) {
    notes.push(note("The sun sets before the eclipse finishes here, so the final phase happens below the horizon."));
  }
  if (!hasTotality && hasPeak) {
    notes.push(note(`Outside the path of totality, so ${peakPct} of the sun is covered at maximum. The corona will not be visible, and eclipse glasses must stay on the whole time.`, true));
  }
  // Under ~0.2 deg the 27 m DEM and the full-resolution mesh are merely disagreeing at their
  // own noise level, which is not worth a sentence.
  if (cat && Number.isFinite(cat.horizon) && Number.isFinite(focus.horizon)
      && Math.abs(cat.horizon - focus.horizon) >= 0.2) {
    notes.push(note(`The catalogue put the skyline here at ${cat.horizon.toFixed(1)}&deg; from a ~27 m elevation model. At native terrain resolution it is ${focus.horizon.toFixed(1)}&deg;.`));
  }

  let cloudStat = (preset && preset.cloud != null) ? preset : (cat && cat.cloud != null) ? cat : null;
  if (!cloudStat && activeGroundCartesian) {
    const cart = Cesium.Cartographic.fromCartesian(activeGroundCartesian);
    cloudStat = sampleCloudClimatology(Cesium.Math.toDegrees(cart.latitude), Cesium.Math.toDegrees(cart.longitude));
  }

  // Every contact, in the order they happen; bold marks the ones that decide the verdict.
  const judgedKeys = v.scope === "totality" ? ["totalBegin", "peak", "totalEnd"] : ["partialBegin", "peak", "partialEnd", "now"];
  const rows = [...v.contacts]
    .sort((a, b) => Cesium.JulianDate.compare(a.j, b.j))
    .map((m) => ({
      label: TABLE_CONTACT_LABEL[m.contact] || m.label,
      time: clockText(m.j, m.contact === "totalBegin" || m.contact === "totalEnd"),
      sun: `${m.alt.toFixed(1)}&deg;`,
      judged: judgedKeys.includes(m.contact),
      blocked: m.blocked,
      state: m.below ? "Sun has set" : m.blocked
        ? `Blocked by ${(m.horizon - m.alt).toFixed(1)}&deg;` : `Clear by ${(m.alt - m.horizon).toFixed(1)}&deg;`,
    }));

  const outside = { clear: hasPeak ? `Partial eclipse only, ${peakPct} covered` : "No eclipse visible here",
    partial: "Partial eclipse, partly hidden by terrain", blocked: "Not visible", below: "Sun below horizon" };

  presentVerdict({
    level: v.level, scope: v.scope, grazing: focus.grazing, hasPeak, nearEdge: v.nearEdge,
    totalitySeconds: totDur, peakPct, peakTime: hasPeak ? clockText(c.peak) : "",
    headline: v.scope === "totality" ? Catalogue.TOTALITY_TEXT[v.level] || "Sun below horizon" : outside[v.level],
    focus, rows, notes, cloudStat,
    stored: cat || preset || activeCatEntry,
    profile, known: [],
    source: `Source: ${preset ? "precomputed from a ~7 m elevation model (~27 m past 9 km)"
      : terrainSource === "ion" ? "Cesium World Terrain" : "Re:Earth Terrain (~30 m)"}.`,
  });
}

function drawSightline(sunDir, clear, opts = {}) {
  clearSightlineVisuals();
  currentSightlineBlocked = !clear;
  currentHorizonAtSun = Number.isFinite(opts.horizon) ? opts.horizon : null;

  const c = localCircumstances(activeGroundCartesian);
  const sp = c && c.peak ? sunAltAz(c.peak, activeGroundCartesian) : null;
  const az = Number.isFinite(opts.az) ? opts.az : (sp ? sp.azimuth : 311);
  const alt = sp ? sp.altitude : 9;
  // Aim just below the inner corona when clear so the ray leads the eye from the observer
  // marker to the eclipse without crossing over the dark lunar disc.
  const aimDir = clear
    ? enuDirection(activeGroundCartesian, az, Math.max(0.2, alt - 0.85))
    : sunDir;
  const skyEnd = Cesium.Cartesian3.add(
    activeGroundCartesian,
    Cesium.Cartesian3.multiplyByScalar(aimDir, SKY_ECLIPSE_DIST + 4000, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  if (!clear && opts.ridgeDist > 0 && Number.isFinite(opts.az)) {
    const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(activeGroundCartesian);
    const azRad = Cesium.Math.toRadians(opts.az);
    const obsH = Cesium.Cartographic.fromCartesian(activeGroundCartesian).height;
    const dz = Number.isFinite(opts.ridgeHeight) ? (opts.ridgeHeight - obsH) : 0;
    const ridgeOffset = new Cesium.Cartesian3(
      opts.ridgeDist * Math.sin(azRad),
      opts.ridgeDist * Math.cos(azRad),
      dz
    );
    const ridgePos = Cesium.Matrix4.multiplyByPoint(enuToFixed, ridgeOffset, new Cesium.Cartesian3());

    sightlinePrimitive = viewer.entities.add({
      show: cameraViewMode !== "eye",   // from the observer's own eye this is a vertical pole
      polyline: {
        positions: [activeGroundCartesian, ridgePos],
        width: 4.5,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.25,
          color: Cesium.Color.fromCssColorString("#f87171").withAlpha(0.95),
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });
    sightlineExtras.push(viewer.entities.add({
      show: cameraViewMode !== "eye",
      polyline: {
        positions: [ridgePos, skyEnd],
        width: 1.8,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString("#f87171").withAlpha(0.42),
          dashLength: 14,
        }),
        arcType: Cesium.ArcType.NONE,
      },
    }));
    const km = (opts.ridgeDist / 1000).toFixed(1);
    const hStr = Number.isFinite(opts.horizon) ? `, ${opts.horizon.toFixed(1)}°` : "";
    sightlineExtras.push(viewer.entities.add({
      show: cameraViewMode !== "eye",   // the strip says this at eye level
      position: ridgePos,
      point: {
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString("#ef4444"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `Blocking ridge (${km} km${hStr})`,
        font: "11px sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#fecaca"),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#450a0a").withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(0, -14),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 0.88,
      },
    }));
  } else {
    const col = clear
      ? Cesium.Color.fromCssColorString("#34d399").withAlpha(0.82)
      : Cesium.Color.fromCssColorString("#f87171").withAlpha(0.85);
    sightlinePrimitive = viewer.entities.add({
      show: cameraViewMode !== "eye",
      polyline: {
        positions: [activeGroundCartesian, skyEnd],
        width: 3.5,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.22,
          color: col,
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });
  }
  if (viewer && activeGroundCartesian) {
    updateEclipseSky(viewer.clock.currentTime, eclipseAt(viewer.clock.currentTime, activeGroundCartesian));
  }
}

// ====================================================================================
//  PRECOMPUTED VIEWPOINT CATALOGUE
//  Built offline by precompute/build_viewpoints.py over the whole land area from which
//  totality is visible, filtered to spots near a road or track. Loading is optional —
//  the app works fully without viewpoints.json present.
// ====================================================================================
let catalogue = null;

// Resolves once the catalogue has loaded or failed, whichever happens.
let settleCatalogue = () => {};
const catalogueSettled = new Promise((resolve) => { settleCatalogue = resolve; });

async function loadCatalogue() {
  try {
    const res = await fetch("viewpoints.json", { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.spots) || !data.spots.length) return;
    catalogue = data;
    $("topSpotsSection").hidden = false;
    // Prefer named lookouts when the catalogue has them — a signposted viewpoint is a far
    // more useful recommendation than a bare grid coordinate.
    // Presets are town centres rather than recommendations, and two of the four are blocked.
    // Tag them so the verdict card can point somewhere useful instead of dead-ending.
    (data.presets || []).forEach((p) => { p.isPreset = true; });
    (data.pois || []).forEach((p) => { p.isPoi = true; });
    renderTopSpots();
    lucide.createIcons();

    // The catalogue arrives after the opening location has been selected, so a deep link
    // (?lat=&lon=, which is how the overview map hands off) misses the match on the way in.
    // Retry it once the data is here.
    if (activeLoc && activeGroundCartesian && !activeCatEntry) {
      activeCatEntry = findCatalogueEntry(activeLoc.lat, activeLoc.lon);
      if (activeCatEntry?.profile) runPresetCheck(activeCatEntry);
      else if (activeCatEntry) renderCatalogueVerdict(activeCatEntry);
    }
  } catch (e) {
    /* no catalogue shipped — the live search still works */
  } finally {
    settleCatalogue();
  }
}

// ------------------------------------------------------------------------------------
//  PRECOMPUTED VERDICTS
//  Every catalogue entry already carries the answer this app exists to give — the horizon
//  angle, the clearance at each contact, and whether totality itself survives the skyline —
//  computed offline against a 27 m DEM with the same probe geometry the live check uses.
//  Deriving that again in the browser costs ~300 quantized-mesh tiles (~10 MB) per click
//  from a best-effort third-party service, so for a catalogue spot we show what we already
//  know and make the live probe opt-in. It is also simply better: instant, not five seconds.
// ------------------------------------------------------------------------------------

// How close the observer must be to count as standing on a catalogue entry. Grid candidates
// are 250 m apart so this cannot match the wrong one, and it comfortably absorbs the 5 dp
// (~1 m) rounding that shared links carry.
const CAT_MATCH_M = 25;

function findCatalogueEntry(lat, lon) {
  if (!catalogue || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null, bestM = CAT_MATCH_M;
  // Nearest wins across all three lists. Presets are included so the four "Fly to" buttons —
  // the most-clicked control on the page — are answered from disk too; their coordinates are
  // byte-identical to LOCATIONS, so they always match at zero distance.
  for (const arr of [catalogue.pois || [], catalogue.spots || [], catalogue.presets || []]) {
    for (const s of arr) {
      const m = Catalogue.haversineM(lat, lon, s.lat, s.lon);
      if (m < bestM) { bestM = m; best = s; }
    }
  }
  return best;
}

// Bilinear interpolation across the 48-year July CM SAF CLARA-A3 cloud cover grid.
function sampleCloudClimatology(lat, lon) {
  if (!catalogue || !catalogue.cloudGrid || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const g = catalogue.cloudGrid;
  if (lat < g.latMin - 0.25 || lat > g.latMax + 0.25 || lon < g.lonMin - 0.25 || lon > g.lonMax + 0.25) return null;
  const y = Math.max(0, Math.min(g.rows - 1, (lat - g.latMin) / g.dlat));
  const x = Math.max(0, Math.min(g.cols - 1, (lon - g.lonMin) / g.dlon));
  const y0 = Math.floor(y);
  const y1 = Math.min(g.rows - 1, y0 + 1);
  const x0 = Math.floor(x);
  const x1 = Math.min(g.cols - 1, x0 + 1);
  const fy = y - y0;
  const fx = x - x0;
  const interp = (grid) => {
    const v00 = grid[y0][x0];
    const v01 = grid[y0][x1];
    const v10 = grid[y1][x0];
    const v11 = grid[y1][x1];
    return (1.0 - fy) * ((1.0 - fx) * v00 + fx * v01) + fy * ((1.0 - fx) * v10 + fx * v11);
  };
  const cDay = Math.round(interp(g.cfcDay) * 10) / 10;
  const cLow = Math.round(interp(g.cfcLow) * 10) / 10;
  return {
    cloud: cDay,
    clearProb: Math.round(Math.max(0, Math.min(100, 100 - cDay)) * 10) / 10,
    cloudLow: cLow,
  };
}

// A catalogue record's verdict. The level and grazing flag are precomputed by
// precompute/verdict.py and read as stored (docs/adr/0001-precomputed-verdicts.md); only the
// per-phase states for the table are derived here, from the same rule in verdict.js.
//
// Note the scope. clearBegin/clearEnd are SECOND and THIRD contact — the start and end of
// totality (build_viewpoints.py takes them from EclipseEvent.total_begin/total_end). The
// live check's "Start"/"End" are FIRST and LAST contact, over an hour either side, by which
// time the sun has sunk to ~1 deg. The two answer different questions and must not be
// labelled alike; the keys below double as field names on localCircumstances().
function catalogueVerdict(s) {
  if (!s) return null;
  const phases = [
    { key: "totalBegin", label: "Totality begins", clear: s.clearBegin },
    { key: "peak",       label: "Maximum",         clear: s.clearance },
    { key: "totalEnd",   label: "Totality ends",   clear: s.clearEnd },
  ].filter((p) => Number.isFinite(p.clear))
   .map((p) => ({ ...p, state: Verdict.contactState({ clearance: p.clear }) }));
  return { phases, level: s.level, scope: "totality", grazing: s.grazing === true,
           nearEdge: Number.isFinite(s.totality) && s.totality > 0
             && s.totality < Verdict.NEAR_EDGE_S };
}

// The full sightline card for a preset, with no terrain fetched.
//
// Only the horizon needs terrain, and for the presets it is already on disk across the
// whole azimuth range the eclipse covers. Everything else — contact times, sun altitude and
// bearing — is pure astronomy and free in the browser, so this judges exactly the contacts
// runSightlineCheck does, through the stored-profile adapter instead of live rays, and hands
// the verdict to exactly the same renderers. The result is the complete card, chart
// included, that used to need a 234-tile probe.
function presetVerdict(p) {
  const c = localCircumstances(activeGroundCartesian);
  return Verdict.evaluateSightline({
    scope: verdictScope(c), contacts: eclipseContacts(c), totalitySeconds: totalitySeconds(c),
    horizonAt: Verdict.horizonFromProfile(p.profile),
  });
}

function runPresetCheck(p) {
  sightlineToken++;                 // any in-flight live probe no longer owns the panel
  const v = presetVerdict(p);
  const moments = v.contacts.filter(isListedContact);

  // Plot the profile at its stored 1 deg resolution rather than the live check's 4 deg —
  // it costs nothing here and draws a better silhouette.
  const azs = moments.map((m) => m.az);
  const azLo = Math.min(...azs) - HORIZON_SPAN / 2;
  const azHi = Math.max(...azs) + HORIZON_SPAN / 2;
  const profile = [];
  for (let k = 0; k < p.profile.angles.length; k++) {
    const az = p.profile.azFrom + k * p.profile.azStep;
    if (az >= azLo && az <= azHi) profile.push({ az, angle: p.profile.angles[k] });
  }
  showSightlineVerdict(v, profile, azLo, azHi, 0, null, p);
}

function renderCatalogueVerdict(s) {
  const v = catalogueVerdict(s);
  if (!v) return;
  // Contact times come from this observer's own live circumstances, not the catalogue.
  // They are pure astronomy and cost nothing; only the terrain figures are precomputed.
  const c = localCircumstances(activeGroundCartesian);
  const sunAt = (key) => (c && c[key] ? sunAltAz(c[key], activeGroundCartesian) : null);
  const note = (text, warn = false) => ({ text, warn });
  const notes = [];
  if (v.grazing) notes.push(note("During totality the sun clears the skyline by less than its own radius (0.26&deg;), so the lower edge of the disc grazes the ridge. Standing a little higher would clear it.", true));
  if (v.level === "partial") notes.push(note("The skyline cuts in during totality, so you would lose part of it.", true));
  if (v.nearEdge) notes.push(note("Totality lasts under a minute here, near the edge of the path. A few kilometres towards the centre line buys a lot more.", true));
  if (s.publicAccess === false) notes.push(note("No verified public land or road here. You may need the landowner’s permission.", true));

  const rows = v.phases.map((p) => {
    const sun = sunAt(p.key);
    return {
      label: p.label,
      time: c && c[p.key] ? clockText(c[p.key], p.key !== "peak") : "",
      sun: sun ? `${sun.altitude.toFixed(1)}&deg;` : "",
      judged: true,
      blocked: p.state === "blocked",
      state: p.state === "blocked" ? `Blocked by ${Math.abs(p.clear).toFixed(1)}&deg;` : `Clear by ${p.clear.toFixed(1)}&deg;`,
    };
  });

  // Without a stored profile we still know the skyline at the three moments that decide it.
  const known = v.phases.map((p) => {
    const sun = sunAt(p.key);
    return sun ? { az: sun.azimuth, angle: sun.altitude - p.clear } : null;
  }).filter(Boolean);

  presentVerdict({
    level: v.level, scope: "totality", grazing: v.grazing, hasPeak: true, nearEdge: v.nearEdge,
    totalitySeconds: s.totality, peakPct: "100%", peakTime: c && c.peak ? clockText(c.peak) : "",
    headline: Catalogue.TOTALITY_TEXT[v.level],
    focus: { alt: s.sunAlt, az: s.sunAz, horizon: s.horizon, ridgeDist: 0,
             blocked: v.level === "blocked", below: false, grazing: v.grazing },
    rows, notes, cloudStat: s, stored: s, profile: null, known,
    source: "Source: precomputed catalogue, ~27 m elevation model, totality only.",
  });

  // The ray is a visual cue, so take its direction from live astronomy rather than the
  // catalogue's own azimuth — the two agree to a tenth of a degree, which is invisible here.
  if (c && c.peak && activeGroundCartesian) {
    drawSightline(sunAltAz(c.peak, activeGroundCartesian).dir, v.level !== "blocked", {
      horizon: s.horizon,
      az: s.sunAz,
    });
  }
}

let spotSource = "poi";              // "poi" = named lookouts, "grid" = anywhere scanned
const POI_ICON = { viewpoint: "binoculars", peak: "triangle", picnic: "trees",
  campsite: "tent", rest_area: "circle-parking", tower: "tower-control" };
const POI_LABEL = { viewpoint: "viewpoint", peak: "summit", picnic: "picnic area",
  campsite: "campsite", rest_area: "rest area", tower: "lookout tower" };
const ACCESS_ICON = { sealed: "car", track: "truck", foot: "footprints", none: "mountain" };
const ACCESS_TIP = { sealed: "sealed road", track: "unsealed road or 4WD track", foot: "walking track",
  none: "no mapped access — off-track" };
const ACCESS_SUB_LABEL = {
  sealed_road: "Sealed road",
  gravel_road: "Gravel road",
  "4wd_track": "4WD track",
  walking_track: "Walking track",
  cycle_trail: "Cycle trail",
  paper_road: "Unformed legal road",
  off_track: "Off-track / alpine",
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function formatTrackName(raw) {
  if (!raw) return "";
  if (raw === raw.toUpperCase() && raw !== raw.toLowerCase()) {
    return raw.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(4wd|Doc|Sh)\b/g, (m) => m.toUpperCase());
  }
  return raw;
}


function renderTopSpots() {
  if (!catalogue || !catalogue.pois) return;
  const want = $("accessFilter").value;
  const radiusKm = parseFloat($("distFilter").value) || 0;
  let here = null;
  if (activeGroundCartesian) {
    const c = Cesium.Cartographic.fromCartesian(activeGroundCartesian);
    here = { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
  }
  const withDist = catalogue.pois.map((s, i) => {
    if (!here) return { ...s, _i: i };
    const m = Catalogue.haversineM(here.lat, here.lon, s.lat, s.lon);
    return { ...s, _i: i, _km: m / 1000,
             _bearing: compassShort(Catalogue.bearingDeg(here.lat, here.lon, s.lat, s.lon)) };
  });
  const matching = Catalogue.thinNearby(withDist.filter((s) =>
    Catalogue.matchesAccess(s, want) && (!radiusKm || !here || s._km <= radiusKm)));
  const list = matching.slice(0, 40);

  const wrap = $("topSpots");
  wrap.innerHTML = list.length
    ? list.map((s) => {
        const title = s.name || `Unnamed ${POI_LABEL[s.kind] || "viewpoint"}`;
        const access = (s.accessSub && ACCESS_SUB_LABEL[s.accessSub]) || ACCESS_TIP[s.access || "none"] || "";
        const away = s._km == null ? "" : s._km < 1 ? "Here" : `${s._km.toFixed(s._km < 10 ? 1 : 0)} km ${s._bearing}`;
        const first = [away, access].filter(Boolean).join(", ");
        const sky = s.clearProb != null ? `, ${s.clearProb.toFixed(0)}% chance of clear sky` : "";
        const flags = [
          s.publicAccess === false ? "Not verified as public" : "",
          s.level !== "clear" ? "Part of totality blocked" : "",
          s.totality > 0 && s.totality < Verdict.NEAR_EDGE_S ? "Near the edge of the path" : "",
        ].filter(Boolean).join(". ");
        const active = Boolean(activeLoc && Catalogue.haversineM(activeLoc.lat, activeLoc.lon, s.lat, s.lon) < CAT_MATCH_M);
        return `<button type="button" data-i="${s._i}" class="spot-btn" aria-current="${active}">
          <span class="spot-name">${esc(title)}</span>
          <span class="spot-sub">${esc(first)}</span>
          <span class="spot-sub">Clears by ${s.clearance.toFixed(1)}&deg;, ${minutesText(s.totality)} of totality${sky}</span>
          ${flags ? `<span class="spot-sub spot-flag">${esc(flags)}</span>` : ""}
        </button>`;
      }).join("")
    : `<p>No viewpoints or sites match${radiusKm ? ` within ${radiusKm} km` : ""}. Try widening the filters.</p>`;

  const tier = { sealed: " on sealed roads", track: " on unsealed roads or 4WD tracks",
    foot: " reachable on foot", drive: " you can drive to" }[want] || "";
  $("topSpotsNote").textContent = list.length
    ? `${list.length === matching.length ? matching.length : `${list.length} of ${matching.length}`}${tier}${radiusKm ? ` within ${radiusKm} km` : ""}, ranked by how far the sun clears the skyline.`
    : "";

  wrap.querySelectorAll(".spot-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = catalogue.pois[+btn.dataset.i];
      s.isPoi = true;
      const label = s.name || `Unnamed ${POI_LABEL[s.kind] || "spot"}`;
      trackMetric("catalogue_select", "poi", label);
      selectLocation({ name: label, lat: s.lat, lon: s.lon, cat: s }, true);
    });
  });
}

// ====================================================================================
//  AUDIENCE MODE
// ====================================================================================
function syncPlayIcon() {
  $("playPause").innerHTML = viewer && viewer.clock.shouldAnimate
    ? '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="4" height="12"/><rect x="9" y="2" width="4" height="12"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2l10 6-10 6z"/></svg>';
}


// ====================================================================================
//  CINEMATIC PLAYBACK — "watch it happen"
// ====================================================================================
let cinematic = false;
let cinematicEnd = null;
const CINE_FAST = 60;    // through the long partial phases
const CINE_SLOW = 12;    // through totality itself

function syncWatchButton() {
  $("watchIt").textContent = cinematic ? "Stop" : "Watch from here";
}

function hideNarration() {
  $("narration").hidden = true;
  $("narrationActions").hidden = true;
}

// Blocked from here: finish on somewhere that isn't, rather than on a dark hillside.
function offerNearestClearSpot() {
  if (!currentSightlineBlocked || !activeLoc) return false;
  // The same suggestion as the verdict's button, so a town offers its own choice here too.
  const near = betterPlaceFor(activeLoc, { level: "blocked", totality: 0 });
  if (!near || near.why !== "clear") return false;
  const { km } = near;
  const direction = compassName(near.bearing);
  narrate(`Totality is hidden from ${activeLoc.name}.`,
    `${near.name}, ${km.toFixed(km < 10 ? 1 : 0)} km to the ${direction}, has a clear view of all of it.`);
  const go = document.getElementById("narrationGo");
  go.textContent = `Go to ${near.name}`;
  go.onclick = () => selectLocation({ name: near.name, lat: near.lat, lon: near.lon, cat: near.cat || undefined }, true);
  $("narrationActions").hidden = false;
  return true;
}

function narrate(text, sub) {
  const box = document.getElementById("narration");
  const el = document.getElementById("narrationText");
  if (el.textContent !== text) {
    el.textContent = text;
    document.getElementById("narrationSub").textContent = sub || "";
    box.hidden = false;
  }
}

async function startCinematic() {
  closePanels();
  hideNarration();
  const c = localCircumstances(activeGroundCartesian);
  if (!c || !c.peak) { narrate("No eclipse is visible from this spot.", ""); return; }
  trackMetric("watch_playback");

  const begin = c.totalBegin || c.peak;
  viewer.clock.currentTime = Cesium.JulianDate.addSeconds(begin, -480, new Cesium.JulianDate());
  cinematicEnd = Cesium.JulianDate.addSeconds(c.totalEnd || c.peak, 120, new Cesium.JulianDate());

  // Frame the sun cleanly below the narration banner. If this spot has a clear sightline,
  // swoop down near ground level looking across the horizon. If it is blocked by a nearby
  // hill (like Queenstown town centre), keep whichever view is selected: at eye level that
  // is the truth of it, a dark ridge with a ring marking where the sun is hidden.
  const s = sunAltAz(c.peak, activeGroundCartesian);
  const ground = Cesium.Cartographic.fromCartesian(activeGroundCartesian);
  if (!currentSightlineBlocked) {
    const { offsetDeg } = framingBand();
    const pitchDeg = Math.max(2.5, Math.min(7.5, s.altitude * 0.45)) - offsetDeg;
    placeCamera({
      destination: Cesium.Cartesian3.fromRadians(ground.longitude, ground.latitude, ground.height + 25),
      orientation: {
        heading: Cesium.Math.toRadians(s.azimuth),
        pitch: Cesium.Math.toRadians(pitchDeg),
        roll: 0,
      },
    }, { duration: flightSeconds(2.0) });
  } else if (activeLoc) {
    const view = await frameForLocation(activeLoc, ground.height - EYE_HEIGHT);
    placeCamera(view, { duration: flightSeconds(2.0) });
  }

  viewer.clock.multiplier = CINE_FAST;
  viewer.clock.shouldAnimate = true;
  cinematic = true;
  document.body.dataset.cinematic = "1";
  syncPlayIcon();
  syncWatchButton();
  onTick(viewer.clock);
  narrate("Keep your eyes on the north-western sky…", "The eclipse is already under way");
}

function stopCinematic(finished = false) {
  cinematic = false;
  document.body.dataset.cinematic = "0";
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 30;
  syncPlayIcon();
  syncWatchButton();
  if (!(finished && offerNearestClearSpot())) hideNarration();
}

function updateNarration(t, e) {
  if (!cinematic) return;
  if (cinematicEnd && Cesium.JulianDate.greaterThan(t, cinematicEnd)) { stopCinematic(true); return; }
  const o = e.obscuration;
  const c = localCircumstances(activeGroundCartesian);
  const hasTotality = Boolean(c && c.totalBegin);

  // Slow right down through totality — it is the payoff, and at speed it flashes past.
  const target = hasTotality && o >= 0.99 ? CINE_SLOW : CINE_FAST;
  if (viewer.clock.multiplier !== target) viewer.clock.multiplier = target;

  // Direction matters: the same coverage means something different coming out.
  const past = c && c.peak ? Cesium.JulianDate.greaterThan(t, c.peak) : false;
  const dtPeak = c && c.peak ? Math.abs(Cesium.JulianDate.secondsDifference(t, c.peak)) : Infinity;

  if (e.isTotal) {
    narrate("Totality — the sun is completely hidden.",
      "The only time it is safe to look without eclipse glasses.");
  } else if (!hasTotality && dtPeak <= 45) {
    const pct = o >= 0.995 ? "99.9%" : Math.round(o * 100) + "%";
    narrate(`Maximum eclipse — ${pct} of the sun is covered here.`,
      "Outside the path of totality, eclipse glasses must stay on the whole time.");
  } else if (!past) {
    if (hasTotality && o >= 0.9) narrate("Almost there — the light is draining away fast.", "Watch the landscape darken.");
    else if (o >= 0.85) narrate("Approaching maximum eclipse — the light is noticeably dimmer.", "Eclipse glasses required throughout a partial eclipse.");
    else if (o >= 0.4) narrate("More than half the sun is covered now.", "The daylight turns oddly flat and silvery.");
    else if (o > 0.005) narrate("The moon has taken a bite out of the sun.", "Eclipse glasses required at this stage.");
    else narrate("Any moment now…", `The sun sits ${heightPhrase(e.sunAlt)}, to the ${compassName(e.sunAz)}.`);
  } else {
    if (hasTotality && o >= 0.9) narrate("Totality is over — the first sliver of sun is back.", "Glasses back on.");
    else if (o >= 0.4) narrate("The sun is climbing back out from behind the moon.", "Daylight returning.");
    else if (o > 0.005) narrate("Just a last bite left.", "The eclipse is nearly finished.");
    else narrate("That's the end of the eclipse.", `The sun is now ${heightPhrase(e.sunAlt)}.`);
  }
}

// ====================================================================================
//  UI WIRING
// ====================================================================================
function buildPresetButtons() {
  const wrap = $("presetButtons");
  LOCATIONS.forEach((loc) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.name = loc.name;
    b.className = "place-btn";
    b.textContent = loc.name;
    b.addEventListener("click", () => {
      trackMetric("preset_select", loc.name, loc.name);
      selectLocation(loc, true);
    });
    wrap.appendChild(b);
  });
  highlightActiveButtons();
}

function wireControls() {
  wireStrip();
  for (const type of ["pointermove", "pointerdown", "keydown"]) document.addEventListener(type, wake, { passive: true });

  document.getElementById("playPause").addEventListener("click", () => {
    viewer.clock.shouldAnimate = !viewer.clock.shouldAnimate;
    if (!viewer.clock.shouldAnimate && cinematic) stopCinematic();
    syncPlayIcon();
  });

  document.getElementById("viewToggle").addEventListener("click", toggleCameraViewMode);

  $("placeButton").addEventListener("click", () => setPanel("places"));
  $("openDetails").addEventListener("click", () => setPanel("details"));
  $("closePlaces").addEventListener("click", closePanels);
  $("closeDetails").addEventListener("click", closePanels);
  $("drawSkyline").addEventListener("click", runSightlineCheck);

  // Build the contact address at runtime rather than shipping it in the markup. This stops
  // naive address harvesters that regex the served HTML; it does not stop a scraper that
  // executes JavaScript, so it is a speed bump rather than protection.
  (() => {
    const addr = ["michael", "davies.net.nz"].join("@");
    const link = document.getElementById("contactLink");
    link.href = `mailto:${addr}?subject=${encodeURIComponent("Otago Eclipse 3D")}`;
    document.getElementById("contactAddr").textContent = addr;
  })();

  // About dialog: closes on the X, on the backdrop, and on Escape.
  const about = document.getElementById("aboutOverlay");
  const showAbout = (on) => {
    about.classList.toggle("hidden", !on);
    if (on) document.getElementById("aboutClose").focus();
  };
  document.getElementById("aboutBtn").addEventListener("click", () => showAbout(true));
  document.getElementById("aboutClose").addEventListener("click", () => showAbout(false));
  about.addEventListener("click", (e) => { if (e.target === about) showAbout(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!about.classList.contains("hidden")) showAbout(false);
      else if (pinMode) togglePinMode(false);
      else if (document.body.dataset.panel !== "none") closePanels();
    }
  });
  document.getElementById("watchIt").addEventListener("click", () => {
    if (cinematic) stopCinematic(); else startCinematic();
  });
  document.getElementById("accessFilter").addEventListener("change", renderTopSpots);
  document.getElementById("distFilter").addEventListener("change", renderTopSpots);

  document.getElementById("narrationDismiss").addEventListener("click", hideNarration);

  document.getElementById("customGo").addEventListener("click", goToCustom);
  document.getElementById("customGeo").addEventListener("click", useMyLocation);
  document.getElementById("pinToggle").addEventListener("click", () => togglePinMode());

  const inp = document.getElementById("customInput");
  inp.addEventListener("input", () => {
    const v = inp.value.trim();
    if (!v || v.length < 3 || COORD_RE.test(v)) { hideSuggestions(); return; }
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => fetchSuggestions(v, $("suggestions"), chooseSuggestion), 400);
  });
  inp.addEventListener("keydown", (e) => {
    const open = !$("suggestions").hidden && suggestItems.length;
    if (open && e.key === "ArrowDown") {
      e.preventDefault(); suggestActive = Math.min(suggestActive + 1, suggestItems.length - 1); highlightSuggestion();
    } else if (open && e.key === "ArrowUp") {
      e.preventDefault(); suggestActive = Math.max(suggestActive - 1, 0); highlightSuggestion();
    } else if (e.key === "Enter") {
      if (open && suggestActive >= 0) { e.preventDefault(); chooseSuggestion(suggestActive); }
      else goToCustom();
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });
  inp.addEventListener("blur", () => setTimeout(hideSuggestions, 150));
}

function revealUI() {
  document.body.dataset.ui = "on";
  syncBarOffsets();
  renderStrip();
}

// A place in the link, if it is a usable one.
function linkedPlace() {
  const q = new URLSearchParams(location.search);
  const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inNzBounds(lat, lon)) {
    // Fall back to the question rather than guessing a place.
    document.documentElement.classList.remove("has-place");
    $("questionStatus").textContent = "That link points outside New Zealand. Choose a place instead.";
    return null;
  }
  return { name: (q.get("name") || "").slice(0, 60) || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon };
}

// ---- the opening question -------------------------------------------------------------
let viewerReady = false;
let pendingPlace = null;

function rememberPlace(loc) {
  try { localStorage.setItem("eclipseLastPlace", JSON.stringify({ name: loc.name, lat: loc.lat, lon: loc.lon })); } catch (e) {}
}

function recalledPlace() {
  try {
    const p = JSON.parse(localStorage.getItem("eclipseLastPlace"));
    return p && p.name && inNzBounds(p.lat, p.lon) ? p : null;
  } catch (e) { return null; }
}

// Hands the map the place, so "Map" opens on the closest spots. Not for a located device:
// the map writes this into its address bar, and a copied link should not carry where you are.
function syncMapLink(loc) {
  $("navMap").href = loc.name === "My location"
    ? "map.html"
    : `map.html?near=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}&place=${encodeURIComponent(loc.name)}`;
}

function answerQuestion(loc) {
  if (!viewerReady) {
    pendingPlace = loc;
    $("questionStatus").textContent = `Loading the terrain for ${loc.name}…`;
    return;
  }
  arrive(loc);
}

// The answer is ready well before the landscape: the verdict comes from viewpoints.json, but the
// terrain arrives coarse first. Shown as it comes, that is stars, then the inside of a low-detail
// hill, then a smear. A quiet backdrop covers the 3D view until the ground around the observer
// has loaded. Distant tiles go on sharpening after it lifts.
function liftVeilWhenGroundLoads() {
  const veil = $("landscapeVeil");
  const lift = () => { veil.dataset.state = "off"; };
  if (!viewer || !activeGroundCartesian) { lift(); return; }
  const scene = viewer.scene;
  const ground = Cesium.Cartographic.fromCartesian(activeGroundCartesian);
  const groundHeight = ground.height - EYE_HEIGHT;
  const since = performance.now();
  let groundAt = null;
  const stop = scene.postRender.addEventListener(() => {
    const now = performance.now();
    if (groundAt === null) {
      // Within the eye-level camera's 10 m: the detailed tile under the observer is in.
      const h = scene.globe.getHeight(ground);
      if (h !== undefined && Math.abs(h - groundHeight) < 10) groundAt = now;
    }
    if ((now - since > 400 && scene.globe.tilesLoaded) || (groundAt !== null && now - groundAt > 1500) ||
        now - since > 8000) {
      stop();
      lift();
    }
  });
}

async function arrive(loc) {
  pendingPlace = null;
  $("landscapeStatus").textContent = `Loading the terrain around ${loc.name}…`;
  $("landscapeVeil").dataset.state = "on";
  $("question").hidden = true;
  $("splash").dataset.done = "1";
  revealUI();
  try {
    await selectLocation(loc, false);
    await reframeCurrent();
    if (viewer) onTick(viewer.clock);
  } finally {
    liftVeilWhenGroundLoads();
  }
}

async function askByText(raw) {
  const text = (raw || "").trim();
  if (!text) { $("questionStatus").textContent = "Type a place, or choose a town below."; return; }
  $("questionStatus").textContent = "Looking that up…";
  try {
    const loc = await resolvePlace(text);
    trackMetric("custom_search", Places.parseCoords(text) ? "coords" : "address");
    answerQuestion(loc);
  } catch (e) {
    $("questionStatus").textContent = e.message || "Could not find that place.";
  }
}

function chooseTown(name) {
  const loc = LOCATIONS.find((l) => l.name === name);
  if (!loc) return;
  trackMetric("preset_select", loc.name, loc.name);
  answerQuestion(loc);
}

function wireQuestion() {
  if (window.__dropEarlyQuestion) window.__dropEarlyQuestion();
  document.querySelectorAll("[data-town]").forEach((b) =>
    b.addEventListener("click", () => chooseTown(b.dataset.town)));

  const input = $("questionInput");
  const box = $("questionSuggestions");
  const choose = (i) => {
    const it = suggestItems[i];
    if (!it) return;
    hideSuggestions();
    trackMetric("custom_search", "address");
    answerQuestion({ name: shortName(it.name), lat: it.lat, lon: it.lon });
  };
  $("questionForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (suggestActive >= 0 && suggestItems.length) choose(suggestActive);
    else { hideSuggestions(); askByText(input.value); }
  });
  input.addEventListener("input", () => {
    const v = input.value.trim();
    clearTimeout(suggestTimer);
    if (v.length < 3 || COORD_RE.test(v)) { hideSuggestions(); return; }
    suggestTimer = setTimeout(() => fetchSuggestions(v, box, choose), 400);
  });
  input.addEventListener("keydown", (e) => {
    const open = !box.hidden && suggestItems.length;
    if (open && e.key === "ArrowDown") { e.preventDefault(); suggestActive = Math.min(suggestActive + 1, suggestItems.length - 1); highlightSuggestion(); }
    else if (open && e.key === "ArrowUp") { e.preventDefault(); suggestActive = Math.max(suggestActive - 1, 0); highlightSuggestion(); }
    else if (e.key === "Escape") hideSuggestions();
  });
  input.addEventListener("blur", () => setTimeout(hideSuggestions, 150));

  const last = recalledPlace();
  if (last) {
    const back = $("questionBack");
    back.textContent = `Back to ${last.name}`;
    back.hidden = false;
    back.addEventListener("click", () => answerQuestion(last));
  }

  // Anything chosen while simulator.js was still on its way.
  const early = window.__questionAnswer;
  if (early && early.town) chooseTown(early.town);
  else if (early && early.query) askByText(early.query);
}

async function start() {
  // Terrain is locked to the open Re:Earth source; ?terrain=ion is an escape hatch for
  // higher-resolution work, but needs a token and is not surfaced in the UI.
  const q = new URLSearchParams(location.search);
  let token = CESIUM_ION_TOKEN;
  const supplied = q.get("ionToken");
  if (supplied) {
    token = supplied;
    try { localStorage.setItem("cesiumIonToken", supplied); } catch (e) {}
  } else {
    try { token = localStorage.getItem("cesiumIonToken") || token; } catch (e) {}
  }
  const mode = q.get("terrain") === "ion" && token ? "ion" : "open";
  const linked = linkedPlace();
  try {
    await initViewer(mode, token);
    viewerReady = true;
    $("dataCredit").innerHTML = `Wear eclipse glasses for every partial phase. ${CREDITS[terrainSource] || CREDITS[mode] || ""}`;
    loadCatalogue();               // optional; fire-and-forget

    // Keep the framing correct through resizes and phone rotation.
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      syncBarOffsets();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(reframeCurrent, 350);
    });

    if (linked) await arrive(linked);
    else if (pendingPlace) await arrive(pendingPlace);
  } catch (e) {
    const msg = "The 3D view could not start: " + (e.message || e);
    if (linked) {
      $("splashStatus").hidden = true;
      $("splashError").textContent = msg;
      $("splashError").hidden = false;
    } else {
      $("questionStatus").textContent = `${msg}. The map still works.`;
    }
  }
}

// ====================================================================================
//  ANONYMOUS USAGE METRICS (/api/metric -> Cloudflare Workers Analytics Engine)
//  Records coarse feature-usage counts, public catalogue/preset spot names, and an
//  ephemeral per-tab session token (sessionStorage, wiped when the tab closes) without
//  ever sending private addresses, custom coordinates, cookies, or persistent user IDs.
// ====================================================================================
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

// ====================================================================================
//  BOOT
// ====================================================================================
window.addEventListener("DOMContentLoaded", () => {
  document.body.dataset.panel = "none";
  buildPresetButtons();
  wireControls();
  wireQuestion();
  syncViewToggleUI();
  syncPlayIcon();
  lucide.createIcons();
  trackMetric("page_view", "simulator");
  start();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
