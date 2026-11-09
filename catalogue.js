// Reading the precomputed catalogue: which spots match a filter, how they rank, how far away
// they are, and which one to suggest when the answer here is no. See GLOSSARY.md, "Places".
//
// Pure. No DOM, no Cesium, no astronomy: callers pass catalogue records and coordinates. Both
// the simulator and the overview map read the catalogue through this module, so a filter or a
// suggestion cannot mean one thing on one page and something else on the other.

const EARTH_RADIUS_M = 6371000;
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Great-circle distance in metres.
export function haversineM(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2);
  const dp = p2 - p1, dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Initial bearing from the first point to the second, in degrees clockwise from north.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Access tiers are exclusive, not inclusive-downward (README, "Filters"). "track" covers both
// gravel roads and 4WD tracks: the scanned grid spots cannot tell them apart.
export function matchesAccess(s, want) {
  if (!want || want === "any") return true;
  const acc = s.access || "none";
  const sub = s.accessSub || "";
  if (want === "drive") return acc === "sealed" || acc === "track";
  if (want === "road") return acc === "sealed" || sub === "gravel_road";   // a normal car
  if (want === "sealed") return acc === "sealed";
  if (want === "gravel_road") return sub === "gravel_road";
  if (want === "track") return acc === "track";
  if (want === "4wd_track") return sub === "4wd_track" || (!sub && acc === "track");
  if (want === "foot") return acc === "foot";
  if (want === "cycle_trail") return sub === "cycle_trail";
  if (want === "none") return acc === "none";
  return true;
}

// Some entries are two names for one place, such as a lookout and the rest area beside it, and
// they would otherwise fill a short list. Pass a ranked list: the first of each cluster stays.
export function thinNearby(list) {
  const kept = [];
  for (const s of list) {
    const dup = kept.some((k) => {
      const m = haversineM(s.lat, s.lon, k.lat, k.lon);
      return m < 500 || (k.name === s.name && m < 2000);
    });
    if (!dup) kept.push(s);
  }
  return kept;
}

const SUGGESTABLE_KINDS = new Set(["viewpoint", "tower", "picnic"]);

// Deliberately conservative: we are sending someone there, so it must be a named public lookout
// or picnic area on a sealed road with a comfortable margin and a good length of totality.
function suggestable(s) {
  if (s.publicAccess !== true || s.access !== "sealed" || s.level !== "clear") return false;
  if (!SUGGESTABLE_KINDS.has(s.kind) || s.clearance < COMFORTABLE_CLEARANCE || s.totality < 120) return false;
  return Boolean(s.name) && !/^Lookout \(/.test(s.name);   // not named after its own coordinates
}

// Why a spot is worth the trip from here, or null if it isn't clearly better:
//   "clear"  here loses some or all of totality, or is outside the path
//   "margin" here clears the skyline by less than COMFORTABLE_CLEARANCE
//   "longer" totality lasts at least one 15 s step longer there
// A better chance of clear sky on its own does not count: past Julys differ by a point or two
// between neighbouring spots, too little to drive for.
function improvement(s, here) {
  const tierHere = here.totality > 0 ? marginTier(here) : 3;
  const tierThere = marginTier(s);
  if (tierThere < tierHere) return tierHere === 3 ? "clear" : "margin";
  if (tierThere === tierHere && Math.round(s.totality / 15) > Math.round(here.totality / 15)) return "longer";
  return null;
}

// The nearest suggestable spot that is clearly better than `here` ({ level, clearance, totality }),
// with the reason. Returns { spot, km, bearing, why } or null. The simulator's five towns have
// their own fixed suggestions instead (LOCATIONS in simulator.js).
export function betterSpotNearby(catalogue, here, lat, lon) {
  let best = null, bestM = Infinity, why = null;
  for (const s of (catalogue && catalogue.pois) || []) {
    if (!suggestable(s)) continue;
    const reason = improvement(s, here);
    if (!reason) continue;
    const m = haversineM(lat, lon, s.lat, s.lon);
    if (m < bestM) { bestM = m; best = s; why = reason; }
  }
  return best && { spot: best, km: bestM / 1000, bearing: bearingDeg(lat, lon, best.lat, best.lon), why };
}

// The one place to suggest when the answer here is no.
export const nearestClearSpot = (catalogue, lat, lon) =>
  betterSpotNearby(catalogue, { level: "blocked", totality: 0 }, lat, lon);

// Past this much clearance, more does not improve the view.
export const COMFORTABLE_CLEARANCE = 3;
// Under this, the catalogue's ~27 m elevation model can be wrong by enough to matter (up to
// ~0.6 deg near a ridge, see IDEAS.md), so a spot should be checked in person.
export const TIGHT_CLEARANCE = 1;

function marginTier(s) {
  if (s.level !== "clear") return 3;     // loses some of totality, however large its clearance
  if (s.clearance < TIGHT_CLEARANCE) return 2;
  return s.clearance < COMFORTABLE_CLEARANCE ? 1 : 0;
}

// Enough clearance first, then longer totality, then a better chance of clear sky. Totality is
// compared in 15 s steps, so near-equal lengths count as equal and the weather decides.
export function compareSpots(a, b) {
  return marginTier(a) - marginTier(b)
    || Math.round(b.totality / 15) - Math.round(a.totality / 15)
    || (b.clearProb ?? 0) - (a.clearProb ?? 0);
}

export const rankSpots = (list) => [...list].sort(compareSpots);

// Keep the first spot in each screen cell, so pass a ranked list. `project` gives a spot's
// { x, y } in pixels at the current zoom.
export function declutter(list, project, cellPx) {
  const taken = new Set();
  return list.filter((s) => {
    const { x, y } = project(s);
    const cell = `${Math.floor(x / cellPx)},${Math.floor(y / cellPx)}`;
    if (taken.has(cell)) return false;
    taken.add(cell);
    return true;
  });
}

// The headline for a totality-scope verdict, the same wherever a place is shown.
export const TOTALITY_TEXT = {
  clear: "Clear through totality",
  partial: "Part of totality blocked",
  blocked: "Totality not visible",
};
