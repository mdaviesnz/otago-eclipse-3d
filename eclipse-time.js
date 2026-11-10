// ΔT (Terrestrial Time minus Universal Time) for the 22 July 2028 eclipse.
//
// astronomy-engine extrapolates ΔT with the Espenak & Meeus polynomial, which gives 76.65 s for
// this date. The Earth has been spinning faster than that fit expected, and measured values put
// 2028 near 69 s. The difference runs every contact about 9 s early and draws the path of
// totality about 1.8 km too far north, so both the browser and the precompute fix ΔT instead.
//
// The same number lives in precompute/eclipse.py. tests/check_static.py fails if they differ.
export const DELTA_T_SECONDS = 69.2;

// The diamond ring is the last bead of sunlight before second contact and the first after
// third. It lasts a few seconds; this window is a little generous so it can be seen at speed.
export const DIAMOND_RING_SECONDS = 10;

// How strongly the diamond ring shows at `now`: 0 when it does not, rising to 1 at the contact.
// All three are seconds on the same clock; pass null contacts where there is no totality.
//
// It goes by time from the contact, not by how much of the sun is covered. 98% covered comes a
// minute or two before totality, when the sun is still far too bright to look at.
export function diamondRing(now, totalBegin, totalEnd) {
  if (!Number.isFinite(totalBegin) || !Number.isFinite(totalEnd)) return 0;
  const away = now < totalBegin ? totalBegin - now : now > totalEnd ? now - totalEnd : Infinity;
  return away < DIAMOND_RING_SECONDS ? 1 - away / DIAMOND_RING_SECONDS : 0;
}

// Call once, before any time is created: an AstroTime keeps the ΔT it was made with.
export function useEclipseDeltaT(Astronomy) {
  if (Astronomy) Astronomy.SetDeltaTFunction(() => DELTA_T_SECONDS);
}
