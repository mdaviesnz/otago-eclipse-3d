# Parked ideas and decisions

Things deliberately not done yet, and things already decided so they don't get re-litigated.
Each entry carries enough context to act on without re-deriving the reasoning.

---

## Parked

### Caching sightline checks
**Parked 2026-08-12; option 2 implemented 2026-08-12.** Revisit options 1 and 3 if the site
gets real traffic.

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

2. ~~**Use the verdicts already in `viewpoints.json`.**~~ **Done 2026-08-12.** Selecting a
   catalogue spot now renders its precomputed verdict immediately and does not probe terrain
   at all; the live check is a button inside that card. Measured on Halfway Remarkables:
   **2 terrain tiles to select a spot, 234 to refine it** (~8 MB). With a check already run,
   moving between catalogue spots used to cost a full probe each time and now costs zero.
   A spot is matched by its own record on click, or within 25 m by coordinates — which also
   catches arrivals from the overview map's `?lat=&lon=` links.

   The four **"Fly to" presets get the whole thing precomputed**, not just a verdict: each
   carries a `profile` of terrain elevation angle vs azimuth at 1° steps across the ~52° the
   eclipse spans, with the ridge distance and height responsible for each bearing. That is the
   only thing the browser cannot work out for itself — contact times and sun positions are pure
   astronomy and free — so a preset renders the *complete* sightline card, horizon chart
   included, with **zero terrain requests** and no button to press. Cost: 4.1 KB of JSON
   (184,065 → 188,181 bytes) and ~200 extra ray-marches in the precompute.

   Doing the same for all 800 catalogue entries would add roughly 600 KB, tripling the file for
   spots most people never open — hence verdict-only there and full detail here.

   Because there is no "check it properly" button on a preset, the four of them are built on a
   **sharper DEM than the catalogue**: z13 (~6.8 m/px) within 9 km, over the region-wide z11
   (~27 m) mosaic beyond. See "DEM resolution is a near-field problem" below for why that
   split, and what it is worth.

   The presets are their own unfiltered array (a blocked town is a real answer, and these are
   the most-clicked buttons on the page).
   `tests/check_static.py` parses `LOCATIONS` out of the shipped markup and fails the build if
   it disagrees with the built coordinates — drift would not break the app, it would silently
   revert those buttons to a live probe, which is precisely the kind of invisible regression
   that file exists to catch.

   Two things fell out of doing it, both worth keeping in mind:

   - **`clearBegin` / `clearEnd` are second and third contact**, i.e. the start and end of
     *totality* — `build_viewpoints.py` reads them off `EclipseEvent.total_begin/total_end`.
     The live check's "Start" and "End" are *first and last* contact, over an hour either side,
     by which point the sun has sunk to ~1°. The labels look interchangeable and are not. The
     catalogue card therefore says "Totality begins/ends" and pairs those numbers with
     `totalBegin`/`totalEnd`, and its headline is scoped ("Clear through totality") rather than
     borrowing the live card's wider "Clear while sun is up".
   - Because the catalogue only ever rates totality, it can call a spot clear while the live
     check finds last contact blocked — which is exactly what happens at Halfway Remarkables.
     That is a difference of *scope*, not of resolution, and the refined card now says so
     explicitly. The resolution comparison is separate and only fires when the two horizons at
     maximum differ by ≥0.2°; at Halfway Remarkables they agree to within 0.1°, so the 1.3°
     figure below is fully explained by the probe geometry fix, not by DEM resolution.

3. **KV cache of arbitrary check results.** Keyed on rounded lat/lon. Skipped: it only pays off
   if users repeatedly check the *same* arbitrary point, which is unlikely outside the
   catalogue. Costs a Worker, a KV namespace, an invalidation story when terrain data changes,
   and it would mean logging where people are checking.

### Proper contact form
**Parked 2026-08-12.** The About dialog currently assembles a `mailto:` address in JavaScript
at render time, which keeps it out of the served HTML and defeats naive address harvesters —
but not a scraper that executes JS, and it still exposes a personal address publicly.

A form would be better: no address on the page at all, spam filtering, and a reply-to field.
On Cloudflare Pages the natural implementation is a **Pages Function** (`/functions/contact.js`)
posting to an email API (Resend, MailChannels, Postmark) with a Turnstile challenge to stop
bots. That is the first piece of server-side code in the project, so it also brings secrets
management and a rate-limiting question with it — hence parked rather than done.

Interim alternatives if the address starts attracting spam: point at the repo's GitHub Issues,
or use a burnable alias.

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

### Resolve the refraction inconsistency
**Found 2026-08-12 while writing [ASTRONOMY.md](ASTRONOMY.md).** The app's live sun altitude is
geometric (`Refraction.Airless`), but the catalogue's `sunAlt` comes from
`EclipseEvent.altitude`, which measurement shows is **refracted** — 8.3900° against Airless
8.2852° and Normal 8.3919° at Dunedin. So catalogue clearances are systematically ~0.1° more
optimistic than the live check for the same point, which explains most of the residual
cross-validation difference (8.47° vs 8.4°).

Separately, terrestrial refraction is omitted from the horizon geometry (we use a plain
`d²/2R`), which biases up to ~2.6′ the other way at 45 km. The two omissions partially cancel,
netting roughly 4′ conservative.

Fixing means picking one convention for both paths and rebuilding the catalogue. Deferred until
an astronomy reviewer has commented, since the right refraction coefficient for a July Otago
basin — inversion-prone, late afternoon — is not obviously the textbook k = 0.13.

### DEM resolution is a near-field problem
**Measured 2026-08-12** against live native-resolution probes, while making the presets good
enough to stand without a re-check button.

The error in a raster horizon is a *smoothing* error, and it scales with pixel size over the
distance to the ridge that sets the skyline: a coarse grid averages a sharp crest down. So the
same 27 m DEM is excellent at one town and poor at the next, depending only on how close the
horizon is. Error against a live probe, at each town's three contact bearings:

| Town | Ridge distance | z11 (27 m) error |
|---|---|---|
| Arrowtown | ~775 m | +0.45, **+0.64**, +0.49 |
| Queenstown | 1.2–3.7 km | +0.22, +0.20, +0.24 |
| Dunedin | distant | +0.04, +0.15, +0.06 |
| Cromwell | distant | +0.04, −0.03, +0.05 |

Always positive: the raster reads terrain *low*, which biases verdicts optimistic — the wrong
direction for a tool answering "will I see it".

Two things worth knowing before spending tiles on this:

- **Re:Earth's Terrarium endpoint serves no z12.** It 404s. Available zooms jump 11 → 13.
- **z14 is worse than z13, not better.** At 3.4 m/px it over-reads by up to 0.38°, because it
  resolves detail that the quantized mesh the app compares against has itself smoothed away.
  Chasing resolution past the reference is chasing noise.

z13 within 9 km brings the worst of the twelve town/contact comparisons from 0.64° to **0.13°**
for 189 extra tiles, and — more telling than the size — turns a systematic under-read into a
zero-mean scatter, which is what convergence on the reference looks like rather than a smaller
bias. Final errors against live, in degrees:

| Town | First | Maximum | Last |
|---|---|---|---|
| Queenstown | −0.111 | +0.035 | −0.008 |
| Arrowtown | +0.018 | +0.069 | −0.131 |
| Cromwell | +0.029 | −0.058 | −0.003 |
| Dunedin | −0.010 | −0.013 | −0.027 |

Beyond ~9 km a 27 m pixel subtends under 0.2°, so the coarse mosaic is already fine out there —
which is exactly why this is affordable for four presets and would not be for 800 catalogue
entries. Note this makes the presets *more* accurate than the catalogue they sit beside; if the
refraction question above is ever settled, they are the natural place to apply it first.

### Queenstown and Arrowtown cannot see totality from town
**Measured 2026-08-12** when the presets were precomputed, and cross-checked live.

| | Ground | Sun at max | Terrain | Verdict |
|---|---|---|---|---|
| Queenstown | 318 m | 10.0° @ 312° | **20.6°** | blocked by 10.7° |
| Arrowtown | 410 m | 10.0° @ 312° | 15.2° | blocked by 5.3° |
| Cromwell | 210 m | 9.7° @ 312° | 7.2° | clear by 2.5° |
| Dunedin | 2 m | 8.4° @ 311° | 6.7° | clear by 1.7° |

Ben Lomond and Bob's Peak rise ~20.8° above the Queenstown town centre on exactly the bearing
the eclipsed sun sits at. Precomputed against live, once the near-field DEM was sharpened:

| Contact | Precomputed | Live (native mesh) |
|---|---|---|
| First contact | clear by 2.3° | clear by 2.4° |
| Maximum | blocked by 10.9° | blocked by 10.9° |
| Last contact | blocked by 20.6° | blocked by 20.6° |

This is the single most useful thing the app can tell a visitor, since Queenstown is the
obvious base for the event and the answer is counter-intuitive. The preset card says so
immediately on arrival and points at the catalogue. Note that Cromwell and Dunedin clear by
under 2.5°, so their verdicts are genuinely marginal — well inside the range where the
unresolved refraction question above could move them.

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
