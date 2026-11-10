// ΔT (Terrestrial Time minus Universal Time) for the 22 July 2028 eclipse.
//
// astronomy-engine extrapolates ΔT with the Espenak & Meeus polynomial, which gives 76.65 s for
// this date. The Earth has been spinning faster than that fit expected, and measured values put
// 2028 near 69 s. The difference runs every contact about 9 s early and draws the path of
// totality about 1.8 km too far north, so both the browser and the precompute fix ΔT instead.
//
// The same number lives in precompute/eclipse.py. tests/check_static.py fails if they differ.
export const DELTA_T_SECONDS = 69.2;

// Call once, before any time is created: an AstroTime keeps the ΔT it was made with.
export function useEclipseDeltaT(Astronomy) {
  if (Astronomy) Astronomy.SetDeltaTFunction(() => DELTA_T_SECONDS);
}
