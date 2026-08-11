# Astronomical methods — notes for technical review

This document describes exactly how the app computes solar position, eclipse circumstances and
terrain obstruction, so that someone with an astronomy or geodesy background can audit it. It
states the approximations explicitly and lists the open questions I would most like checked.

**Target audience:** reviewers with domain expertise. It assumes familiarity with equatorial
and horizontal coordinates, eclipse magnitude vs obscuration, ΔT, and atmospheric refraction.

Event under study: the **total solar eclipse of 22 July 2028**, as seen from Otago,
New Zealand. The sun is only ~8° above the horizon at totality there, which is why terrain
obstruction is the app's central question and why refraction handling matters more than it
usually would.

---

## 1. Ephemeris

All sun and moon positions come from **[astronomy-engine](https://github.com/cosinekitty/astronomy)**
(Don Cross, MIT licence), used identically in two independent implementations:

| Implementation | Where | Purpose |
|---|---|---|
| JavaScript (`astronomy.browser.min.js` v2) | `index.html` | Live positions, per-location circumstances, obscuration |
| Python (`astronomy-engine` on PyPI) | `precompute/build_viewpoints.py` | Offline catalogue generation |

Stated accuracy is ±1 arcminute for the Sun and Moon over the supported epoch range, which is
far below the ~0.1° effects that dominate this application.

**CesiumJS's built-in ephemeris is deliberately not used.** Cesium's solar position is
adequate, but `Simon1994PlanetaryPositions`' lunar series was measured during development to
put maximum obscuration at ~88% and to drift several minutes past the true maximum — unusable
for eclipse work. Cesium is used only as a renderer. (Cesium's *own* scene lighting still uses
its internal sun direction; that affects shading only, not any reported number.)

## 2. Time system and ΔT

- The app's clock is UTC throughout. Displayed times are **NZST = UTC+12**. July is New Zealand
  winter, so NZDT (UTC+13) does **not** apply — a common source of one-hour errors.
- astronomy-engine converts UT→TT internally using `DeltaT_EspenakMeeus` (verified: it is the
  only ΔT symbol exported by the package, and is the default).
- For 2028 this is an **extrapolation**. ΔT prediction error of order 1 s translates to roughly
  0.4–0.5 km of longitudinal shift in the umbral path, and to sub-second changes in local
  contact times. This is a systematic that no amount of care in this codebase can remove, and
  it should be borne in mind when comparing our contact times against any other prediction that
  assumed a different ΔT.

## 3. Observer model

The observer is constructed as `Observer(latitude, longitude, height)` where:

- Latitude/longitude are geodetic (WGS84), taken from `Cesium.Cartographic`.
- Height = terrain elevation + **1.7 m** assumed eye height.

**Height datum — known imprecision.** astronomy-engine documents `height` as "elevation above
sea level in meters", i.e. orthometric. Our terrain heights come from Re:Earth Terrain
(quantized-mesh), which is **ellipsoid-referenced**. The geoid–ellipsoid separation in the
Otago region is of order tens of metres, so we are feeding an ellipsoidal height where an
orthometric one is expected.

Measured sensitivity (Dunedin, varying observer height only):

| Observer height | Peak time | Peak altitude |
|---|---|---|
| 0 m | 04:17:11.848 UTC | 8.3900° |
| 500 m | 04:17:12.269 UTC | 8.3891° |
| 2000 m | 04:17:13.968 UTC | 8.3854° |

So contact times shift by roughly **1 s per km** of observer elevation, and altitude by
~0.005° per 2 km. A datum error of ~20 m therefore contributes ~0.02 s and ~5×10⁻⁵ degrees —
negligible for our purposes, but stated because the mismatch is real.

## 4. Eclipse circumstances

Per-location circumstances come from `SearchLocalSolarEclipse(startTime, observer)`, searching
from 2028-07-21T00:00:00Z. It returns `kind` (partial/annular/total), the obscuration at
maximum, and `EclipseEvent {time, altitude}` for first contact, second contact, maximum, third
contact and last contact.

These drive:
- the **Start / Totality / End** jump buttons (per location, not a fixed regional value),
- the totality window shown in the UI,
- the three moments at which the sightline is evaluated,
- the totality/partial classification in the catalogue.

Because they are computed per observer, they correctly differ across the region — Queenstown
reaches totality about 42 s before Dunedin, and durations vary with distance from the
centreline (measured range across the catalogue: 12 s to 180 s).

## 5. Time-varying magnitude and obscuration

astronomy-engine reports obscuration only at maximum, so the continuously-varying values shown
in the UI are computed in this codebase (`eclipseAt()` in `index.html`). Method:

1. Topocentric equatorial coordinates of Sun and Moon:
   `Equator(body, time, observer, ofdate=true, aberration=true)` — i.e. **of-date** equinox
   with **aberration** applied.
2. Apparent angular radii from the returned geocentric-to-topocentric distances:

   ```
   r = asin(R / d)      R_sun  = 695 700 km   (IAU nominal photospheric radius)
                        R_moon =   1 737.4 km (IAU mean lunar radius)
   ```

3. Angular separation from the dot product of unit vectors built from (RA, Dec).
4. Magnitude — fraction of the solar **diameter** covered:

   ```
   mag = (r_sun + r_moon − sep) / (2 · r_sun)
   ```

5. Obscuration — fraction of the solar **area** covered, from the exact circular-segment
   overlap area of two discs, divided by π·r_sun².

Sanity checks: separation at maximum from Dunedin computes to 0.04 arcmin; apparent diameters
31.47′ (Sun) and 32.90′ (Moon), giving a size ratio k ≈ 1.045, consistent with a total (not
annular) eclipse.

### Approximations in this section

- **Both bodies are treated as perfect circular discs.** No lunar limb profile is applied.
  Professional predictions (Espenak/Meeus, and modern Kaguya/LRO limb models) shift contact
  times by of order ±1–2 s and are essential for Baily's beads and grazing-line work. We are
  not attempting that class of prediction.
- **Obscuration is geometric area, not flux.** Solar limb darkening is ignored, so the
  perceived brightness drop is not linear in our obscuration figure. This matters only for the
  lighting model (§8), which is explicitly perceptual rather than radiometric.
- No correction for the ~0.5″ difference between the Moon's mean radius and the radius
  conventionally used for eclipse contact definitions.

## 6. Terrain horizon geometry

The obstruction test is a horizon computation, not an astronomical one, but its conventions
matter to the result.

For each probe point at ground distance `d` along a great-circle bearing:

```
drop  = d² / (2R)                      R = 6 371 000 m (mean Earth radius)
angle = atan2(h_terrain − h_observer − drop, d)
```

The horizon angle for a bearing is the maximum of `angle` over that ray. The view is obstructed
when the horizon angle ≥ the sun's altitude.

Sampling geometry:

- **Radial spacing is adaptive** — 3% geometric growth, so spacing stays under ~1 km even at
  the far end. An earlier 13% growth put samples ~3.6 km apart at 28 km and stepped over
  ridges entirely; this was caught by cross-validating two implementations that disagreed by
  1.3° (see §9).
- **Inner limit 100 m.** Set by DEM vertical error, not geometry: with σ ≈ 5 m the angular
  error `atan(σ/d)` is ±32° at 8 m, ±5° at 50 m, but ±3° at 100 m. Sampling closer measures
  DEM noise. It is also ground the observer could step around.
- **Outer limit 45 km.**
- The azimuth fan spans ±20° around the sun's bearing, evaluated at each of the three contacts,
  since the sun's azimuth moves several degrees across the eclipse.

### Terrestrial refraction is NOT applied

We use the geometric drop `d²/2R`. Standard surveying practice applies a refraction
coefficient k ≈ 0.13, equivalent to an effective Earth radius R/(1−k) ≈ 7.3×10⁶ m, which makes
distant terrain appear **higher** than geometric. The magnitude of the omission is
approximately `k·d/(2R)` in radians:

- at 10 km: ≈ 0.6′
- at 30 km: ≈ 1.8′
- at 45 km: ≈ 2.6′

So we under-estimate the elevation of distant terrain by up to ~2.6′, biasing verdicts slightly
towards "clear".

## 7. Atmospheric refraction of the Sun — and a known inconsistency

**This is the item I would most like a reviewer to check.**

astronomy-engine offers `Refraction.Airless` (none), `Normal`, and `JplHorizons`. Measured at
Dunedin at maximum eclipse:

| Setting | Sun altitude |
|---|---|
| `Airless` (geometric) | 8.2852° |
| `Normal` (refracted) | 8.3919° |

a difference of **0.107° ≈ 6.4′** — large compared with everything else in this document, and
comparable to the terrain angles that decide marginal verdicts.

The current state is **inconsistent between the two code paths**:

| Quantity | Source | Refraction |
|---|---|---|
| Live sun altitude in the app | `Horizon(..., refraction=null)` | **none** (geometric) |
| Sun azimuth (both paths) | `Horizon(..., Airless)` | none (azimuth is unaffected anyway) |
| Catalogue `sunAlt` | `EclipseEvent.altitude` from `SearchLocalSolarEclipse` | **refracted** — the returned 8.3900° matches `Normal` (8.3919°), not `Airless` (8.2852°) |

Consequence: the precomputed catalogue's clearance figures are systematically about **0.1°
more optimistic** than the app's live check for the same point. This accounts for most of the
residual difference observed in cross-validation (§9): 8.47° precomputed vs 8.4° live at the
same viewpoint.

Neither choice is obviously wrong — the *apparent* (refracted) sun is what an observer actually
sees, so arguably both should use refraction, and terrestrial refraction (§6) should be applied
alongside it for consistency. The two omissions currently push in opposite directions and
partially cancel: ignoring solar refraction makes us ~6.4′ pessimistic, ignoring terrestrial
refraction makes us up to ~2.6′ optimistic, for a net conservative bias of roughly 4′.

**Question for reviewers:** should both paths adopt refracted altitudes plus an effective-Earth-
radius terrain model, and if so what refraction coefficient is defensible for a winter
late-afternoon inversion-prone Otago basin? Standard k = 0.13 assumes a normal lapse rate;
temperature inversions over cold ground can raise it substantially, which is exactly the
condition likely at 16:17 in July.

## 8. Eclipse lighting (explicitly not physical)

The scene darkening is a **perceptual** model, not radiometric. Scene light intensity, imagery
brightness/saturation and atmosphere parameters are driven by `obscuration⁶`, chosen so that
the change is barely perceptible at 80% obscured and collapses past 97%, which matches the
subjective experience of totality arriving suddenly. It is not derived from illuminance and
should not be cited as such. Solar limb darkening (§5) would be required for any real
photometric treatment.

## 9. Validation performed

**Against published circumstances** (Dunedin, from timeanddate-class sources):

| Event | Published NZST | astronomy-engine | Δ |
|---|---|---|---|
| Partial begins | 15:08:58 | 15:09:01 | +3 s |
| Totality begins | 16:15:45 | 16:15:44 | −1 s |
| **Maximum** | **16:17:11** | **16:17:11** | **0 s** |
| Totality ends | 16:18:36 | 16:18:39 | +3 s |
| Partial ends | 17:17:00 | 17:19:58 | +3 m |

The last-contact discrepancy is explained, not ignored: astronomy-engine reports last contact
at altitude **−0.09°**, i.e. geometrically below the horizon. The published figure appears to
be clamped at sunset. This also produced a genuine finding — across the South Island, last
contact occurs below 1.7° altitude everywhere, and below the horizon on the east coast.

**Two independent implementations.** The JS and Python paths were compared directly and agree
(peak altitude 8.39°, azimuth 310.6°, totality 174.3 s).

**Two independent terrain paths.** The Python precompute (Terrarium raster DEM at 27 m,
numpy) and the JS live check (quantized-mesh at full detail, Cesium) were compared at the same
points:

| Location | Precompute horizon | Live horizon |
|---|---|---|
| Halfway Remarkables | 1.83° | 1.9° |
| Unnamed viewpoint, Dunedin | −0.08° | −0.1° |

Agreement within 0.07°. Before the probe spacing was matched (§6), the same comparison
disagreed by 1.3° — the cross-check is what found that bug.

**Catalogue verification.** Every published spot was re-tested against astronomy-engine
directly, bypassing the pipeline's interpolated field: extremes in all four compass directions
plus a random sample, zero outside totality.

## 10. Approximations, summarised

| # | Approximation | Estimated effect |
|---|---|---|
| 1 | Solar refraction omitted in the live path | 6.4′ — verdicts pessimistic |
| 2 | Terrestrial refraction omitted | up to 2.6′ at 45 km — verdicts optimistic |
| 3 | Refraction inconsistent between app and catalogue | ~0.1° offset between the two |
| 4 | Circular discs; no lunar limb profile | ±1–2 s on contact times |
| 5 | Obscuration is geometric area; no limb darkening | affects lighting model only |
| 6 | Ellipsoidal heights fed as orthometric | <0.05 s on contact times |
| 7 | ΔT extrapolated to 2028 | ~1 s → ~0.5 km path shift |
| 8 | Catalogue circumstances bilinearly interpolated on a 0.1° grid | see below |
| 9 | DEM vertical error σ ≈ 5 m, horizontal ~30 m | dominant term inside ~1 km |
| 10 | ±20° azimuth fan, not a 360° viewshed | no effect on the stated question |

On (8): the precompute evaluates circumstances on a 0.1° grid (~2 000 searches) and
interpolates bilinearly, because circumstances vary smoothly over tens of kilometres. Totality
is treated as a hard boundary — all four surrounding grid samples must be inside — so edge
candidates are not optimistically included. Every published point was subsequently re-verified
against a direct per-point search.

## 11. What I would most like checked

1. **The refraction inconsistency in §7** — both the direction of the fix and an appropriate
   coefficient for the actual meteorological conditions.
2. Whether omitting the lunar limb profile is acceptable for a tool that reports contact times
   to the second, or whether the displayed precision should be reduced to match the model.
3. Whether the 100 m inner probe limit (§6) is the right trade between DEM noise and genuinely
   obstructing near-field terrain.
4. Whether `EclipseEvent.altitude` really is refracted, as the measurements in §7 imply — this
   was inferred empirically rather than from documentation.
5. Anything in §10 whose estimated effect I have understated.

## 12. Where the code lives

| Function | File | Purpose |
|---|---|---|
| `bodyAltAz`, `sunAltAz` | `index.html` | Topocentric alt/az, apparent radii, sky unit vectors |
| `eclipseAt` | `index.html` | Time-varying magnitude and obscuration |
| `localCircumstances` | `index.html` | Per-observer contact times, cached by coordinate |
| `timeAtObscuration` | `index.html` | Bisection for the ~50% arrival time |
| `runSightlineCheck` | `index.html` | Probe geometry, horizon reduction, verdict |
| `EclipseField` | `precompute/build_viewpoints.py` | 0.1° circumstance grid and interpolation |
| `horizon_angles` | `precompute/build_viewpoints.py` | Vectorised horizon scan |

Raw catalogue output including every intermediate value is in `viewpoints.json`; its `params`
block records the exact geometry used for that build.
