// Finding and describing places: New Zealand bounds, address search, compass directions and
// heights in fists. Shared by the simulator and the overview map.
//
// Pure, except that callers do their own fetching: this module only builds the request and
// reads the response.

// Bounding box around mainland New Zealand (North Island, South Island, Stewart Island).
export const NZ_BOUNDS = { latMin: -47.6, latMax: -34.0, lonMin: 166.0, lonMax: 179.0 };

export function inNzBounds(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= NZ_BOUNDS.latMin && lat <= NZ_BOUNDS.latMax &&
    lon >= NZ_BOUNDS.lonMin && lon <= NZ_BOUNDS.lonMax;
}

// Geocoding uses Photon rather than Nominatim. Nominatim's usage policy explicitly forbids
// autocomplete ("you must not implement such a service") and bans offenders; Photon is
// OSM-based and purpose-built for type-ahead. Results are biased toward Otago and bounded
// to New Zealand.
const PHOTON_URL = "https://photon.komoot.io/api/";
const BIAS = { lat: -45.1, lon: 169.2 };

export function photonUrl(query, limit) {
  const bbox = `${NZ_BOUNDS.lonMin},${NZ_BOUNDS.latMin},${NZ_BOUNDS.lonMax},${NZ_BOUNDS.latMax}`;
  return `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=${limit}` +
         `&lat=${BIAS.lat}&lon=${BIAS.lon}&bbox=${bbox}&lang=en`;
}

// A readable label from Photon's structured properties.
export function photonLabel(p) {
  const parts = [
    [p.name, p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street].find(Boolean),
    p.city || p.town || p.village || p.locality,
    p.county || p.state,
    p.country,
  ].filter(Boolean);
  const seen = new Set();
  return parts.filter((x) => (seen.has(x) ? false : seen.add(x))).join(", ");
}

export function photonFeatures(json) {
  return (json.features || [])
    .filter((f) => f.geometry && Array.isArray(f.geometry.coordinates))
    .map((f) => ({
      name: photonLabel(f.properties || {}),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }))
    .filter((f) => f.name && inNzBounds(f.lat, f.lon));
}

// "lat, lon" or "lat lon" as typed. Null when the text is not a coordinate pair at all.
export function parseCoords(text) {
  const m = String(text).trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  return m ? { lat: parseFloat(m[1]), lon: parseFloat(m[2]) } : null;
}

const COMPASS = ["north", "north-north-east", "north-east", "east-north-east", "east",
  "east-south-east", "south-east", "south-south-east", "south", "south-south-west",
  "south-west", "west-south-west", "west", "west-north-west", "north-west", "north-north-west"];
const COMPASS_SHORT = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compassIndex = (az) => Math.round((((az % 360) + 360) % 360) / 22.5) % 16;

export const compassName = (az) => COMPASS[compassIndex(az)];
export const compassShort = (az) => COMPASS_SHORT[compassIndex(az)];

// An angle as a hand held at arm's length: a finger is about 2 degrees, three fingers about 5
// and a fist about 10.
export function handMeasure(deg) {
  if (deg < 0.75) return "less than a finger";
  if (deg < 3) return "about one finger";
  if (deg < 7) return "about three fingers";
  if (deg < 14) return "about one fist";
  return `about ${Math.round(deg / 10)} fists`;
}

// Height described the way you'd actually judge it in the field: an outstretched fist
// spans roughly 10 degrees of sky.
export function heightPhrase(alt) {
  if (alt <= 0) return "below the horizon";
  const fists = alt / 10;
  if (fists < 0.35) return "barely above the horizon";
  if (fists < 0.75) return "about half a fist above the horizon";
  if (fists < 1.4) return "about one fist above the horizon";
  return `about ${Math.round(fists)} fists above the horizon`;
}
