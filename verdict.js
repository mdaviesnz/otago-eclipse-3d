// The sightline verdict: will terrain hide the sun at this place? See GLOSSARY.md, "Verdicts".
//
// Pure. No DOM, no Cesium, no astronomy: callers supply each contact's sun altitude and
// bearing, and the horizon on any bearing through `horizonAt`. That seam has two adapters in
// the app: live terrain rays (runSightlineCheck) and a stored horizon profile (presets).
//
// The same rule is implemented in precompute/verdict.py, which writes `level` into
// viewpoints.json for every catalogue spot and preset. tests/fixtures/verdict-cases.json pins
// the two together; change both, and the cases, or neither (docs/adr/0001-precomputed-verdicts.md).

export const SUN_RADIUS_DEG = 0.26;   // apparent solar semi-diameter (~15.7 arcmin)
export const NEAR_EDGE_S = 60;        // under a minute of totality = near the edge of the path

// Contacts are keyed by the field names localCircumstances() uses.
const JUDGED = {
  eclipse: ["partialBegin", "peak", "partialEnd", "now"],
  totality: ["totalBegin", "peak", "totalEnd"],
};
// In eclipse scope, second and third contact can only downgrade a clear verdict.
const GUARDS = { eclipse: ["totalBegin", "totalEnd"], totality: [] };

// One contact on its own. Clearance of zero or less is blocked: the sun's centre is on or
// behind the skyline. A missing clearance (no such contact here) is blocked too.
export function contactState({ sunAlt, clearance }) {
  if (Number.isFinite(sunAlt) && sunAlt <= 0) return "below";
  if (!Number.isFinite(clearance) || clearance <= 0) return "blocked";
  return clearance < SUN_RADIUS_DEG ? "grazing" : "clear";
}

// Reduce contacts that already carry a clearance to a verdict.
export function judge({ scope, contacts, totalitySeconds = 0 }) {
  if (!JUDGED[scope]) throw new Error(`unknown verdict scope: ${scope}`);
  const judged = [], guards = [];
  const out = contacts.map((c) => {
    const state = contactState(c);
    const m = { ...c, state,
      below: state === "below",
      blocked: state === "blocked",
      grazing: state === "grazing" };
    if (JUDGED[scope].includes(c.contact)) judged.push(m);
    else if (GUARDS[scope].includes(c.contact)) guards.push(m);
    return m;
  });

  // Eclipse scope skips contacts where the sun has set: across Otago the eclipse ends at or
  // below the horizon, and counting that as an obstruction would downgrade a perfect site.
  // Totality scope counts them against: you cannot see a totality that happens after sunset.
  const up = scope === "eclipse" ? judged.filter((m) => !m.below) : judged;
  const bad = (m) => m.blocked || m.below;
  const nBad = up.filter(bad).length;
  const partialTotality = guards.some(bad);

  const level = judged.length === 0 || judged.every((m) => m.below) ? "below"
    : nBad === 0 && !partialTotality ? "clear"
    : nBad === up.length ? "blocked"
    : "partial";

  return {
    level,
    scope,
    grazing: up.some((m) => m.grazing),
    nearEdge: totalitySeconds > 0 && totalitySeconds < NEAR_EDGE_S,
    partialTotality,
    contacts: out,
  };
}

// Judge contacts against terrain. Each contact carries the sun's `sunAlt` and `sunAz`; the
// horizon on that bearing comes from `horizonAt(az) -> { angle, ridgeDist, ridgeHeight }`.
// Returns judge()'s verdict, each contact enriched with its horizon, ridge and clearance, and
// `focus`: the contact the card and the drawn sightline centre on (maximum, when there is one).
export function evaluateSightline({ scope, contacts, horizonAt, totalitySeconds = 0 }) {
  const measured = contacts.map((c) => {
    const h = horizonAt(c.sunAz);
    return { ...c, horizon: h.angle, ridgeDist: h.ridgeDist, ridgeHeight: h.ridgeHeight,
             clearance: c.sunAlt - h.angle };
  });
  const v = judge({ scope, contacts: measured, totalitySeconds });
  const focus = v.contacts.find((c) => c.contact === "peak")
    || v.contacts.find((c) => JUDGED[scope].includes(c.contact))
    || v.contacts[0];
  return { ...v, focus };
}

// The stored-profile adapter for horizonAt. Angles interpolate between stored bearings; the
// ridge that set the angle is a discrete feature, so it comes from the nearer sample rather
// than a blend of two different hillsides. Off either end, the end value holds.
export function horizonFromProfile(profile) {
  const { azFrom, azStep, angles, ridgeDist, ridgeElev } = profile;
  const last = angles.length - 1;
  return (az) => {
    const i = (az - azFrom) / azStep;
    const lo = Math.max(0, Math.min(last, Math.floor(i)));
    const hi = Math.max(0, Math.min(last, lo + 1));
    const t = Math.max(0, Math.min(1, i - lo));
    const near = t < 0.5 ? lo : hi;
    return {
      angle: angles[lo] * (1 - t) + angles[hi] * t,
      ridgeDist: ridgeDist[near],
      ridgeHeight: ridgeElev[near],
    };
  };
}
