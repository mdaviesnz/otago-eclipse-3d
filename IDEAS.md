# Parked ideas and decisions

Things deliberately not done yet, and things already decided so they don't get re-litigated.
Each entry carries enough context to act on without re-deriving the reasoning.

---

## Parked

### Caching sightline checks
**Parked 2026-08-12.** Worth revisiting if the site gets real traffic or checks feel slow.

The expensive part is **not** the computation — a check samples ~1,500 points and the maths
afterwards is microseconds. Nearly all the wall-clock is `sampleTerrainMostDetailed` fetching
quantized-mesh tiles. So caching *results* attacks the wrong layer. Three options, in value
order:

1. **Edge-cache the terrain tiles.** A Cloudflare Worker in front of `terrain.reearth.land`,
   caching responses in the Cloudflare cache. Every visitor then shares one warm tile set, and
   — more important — it stops hammering a best-effort free service. We produced throttled,
   CORS-less error responses from it during testing just by sampling heavily. A Worker also
   gives somewhere to serve a stale tile when upstream fails, instead of losing terrain
   silently.
   *Caveat:* proxying someone else's free service at scale is a bigger ask than direct use.
   Attribution is already displayed; a courtesy note to Re:Earth would be fair if traffic grows.

2. **Use the verdicts already in `viewpoints.json`.** Every one of the 800 catalogue entries
   already carries `clearance`, `clearBegin`, `clearEnd`, `horizon` and `wholeTotality`,
   computed at 27 m with the same probe geometry the app uses. For catalogue spots the answer is
   already on disk and the app simply ignores it. Showing it instantly on arrival — then
   optionally refining live — would make the common path feel instant with **no new
   infrastructure**. Highest value per unit of work.
   *Caveat:* precomputed and live results will not always match exactly. The catalogue uses a
   27 m raster DEM; the live check uses quantized-mesh at full detail. Measured gap: 0.07° at
   the Dunedin viewpoint, but 1.3° at Halfway Remarkables before the probe geometry was
   matched. Silently replacing a cached verdict with a slightly different live one looks like a
   bug — label which is which, or only refine when the difference is material.

3. **KV cache of arbitrary check results.** Keyed on rounded lat/lon. Skipped: it only pays off
   if users repeatedly check the *same* arbitrary point, which is unlikely outside the
   catalogue. Costs a Worker, a KV namespace, an invalidation story when terrain data changes,
   and it would mean logging where people are checking.

### Better handling of unnamed lookouts
96 of the 400 catalogued POIs are `tourism=viewpoint` with no `name` tag, so they show as
"Unnamed viewpoint" and can only be identified by coordinates. Reverse-geocoding them to a
nearby road or locality name would make them findable. Photon can do this, but it is one
request per POI and would need to run in the precompute, not the browser.

### Summits are over-represented
`natural=peak` supplies 192 of 400 POIs. Access tiering already pushes unreachable alpine
summits down, but a peak with "track" access can still mean a serious climb. Options: weight
peaks down further, or carry OSM `sac_scale` / `trail_visibility` through the pipeline so the
app can say how hard the walk is.

### Cloud climatology
The single biggest factor in whether anyone actually sees this eclipse is weather, and the app
says nothing about it. Historical July cloud-cover fraction per location (e.g. from ERA5 or a
NIWA dataset) would be a genuinely useful extra ranking dimension for chasers. Large piece of
work; entirely separate data pipeline.

### Full 360° viewshed
The sightline check sweeps ±20° of azimuth around the sun. Sufficient for the question asked,
but a full horizon panorama would let people plan for other objects (moonrise, the Milky Way)
and would look impressive. Cost scales linearly with azimuth coverage.

---

## Decisions already made

Recorded so they are not revisited without new information.

### Re:Earth Visualizer — rejected as the engine
Evaluated as an alternative to CesiumJS. **Re:Earth Visualizer *is* CesiumJS** wrapped in a
no-code platform, so it is not a swap — it is an extra abstraction layer over the same engine.
It would have made the custom terrain probing and clock control harder, and added a hosted
account dependency. `reearth-terrain` — a different thing entirely — *was* adopted, and is now
the default terrain source.

### Astronomy does not come from Cesium
Cesium's solar position is fine, but its built-in lunar series put maximum obscuration at ~88%
and drifted minutes past the true maximum. astronomy-engine reproduces the published Dunedin
contact times to the second. Do not "simplify" by going back to Cesium's ephemeris.

### Cesium ion is not the default and ships no token
Re:Earth Terrain needs no token, which makes the site publicly deployable without exposing
credentials. ion remains available via `?terrain=ion&ionToken=…` because it resolves near-field
terrain that the 30 m DEM smooths away — enough to flip the Dunedin verdict. Do not hardcode a
token to make that path more convenient.

### Flat-map mode removed
It could not answer the app's central question (no elevation data), so it was a fallback that
gave a confidently wrong answer. Removed along with the onboarding gate.

### Live "find best viewpoint" grid search removed
Superseded by the precomputed catalogue, which is more accurate (27 m, three contacts),
access-aware, and instant, versus up to 60 s for the live search. The one thing the live search
offered that the catalogue lacked — proximity to the user — is now a distance filter on the
catalogue.

### Overpass queries are serial
Two parallel requests got the IP throttled, and a throttled cell is indistinguishable from a
genuinely roadless one. Correctness beats speed here; results are cached so re-runs are cheap.

---

## Known gaps and risks

- **The GitHub Actions workflow has never run.** Its jobs pass locally, so the risk is confined
  to workflow syntax and Cloudflare credentials. Expect one round of iteration on first push.
- **No SLA on anything.** Re:Earth Terrain (best-effort, and the hard dependency for 3D), Esri
  imagery (keyless, throttles), Photon (fair-use). There is no fallback if Re:Earth goes down.
- **Browser geolocation is untested** — it needs an interactive permission grant, which the
  headless test harness cannot give. The code path is standard `getCurrentPosition` with denial
  and timeout handling.
- **Refraction is not modelled.** Altitudes are geometric; refraction lifts a low sun by roughly
  0.1°, so verdicts are marginally conservative.
- **Access ≠ permission.** Proximity to an OSM way is not a right of way, and land may be
  private. Stated in the UI and the catalogue's own `caveats` field, but worth repeating.
