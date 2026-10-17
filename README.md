# Otago Eclipse 3D Sightline Simulator

An interactive 3D web app for the **total solar eclipse of 22 July 2028** over Otago, New
Zealand. Because the sun sits only **~8° above the horizon** at totality, local mountain
topography can physically block the view. This tool lets you stand anywhere in the path and
check whether terrain will be in the way.

Static site: `index.html`, `map.html`, `astronomy.html`, `methods.html`, `app.css`,
`viewpoints.json`, `social-card.svg`. The only build step is the Tailwind stylesheet, and
`app.css` is committed so a fresh clone runs with no tooling at all.

```bash
npm run build:css     # only needed after changing classes in the HTML
```

CI rebuilds it and fails if the committed copy has drifted from the markup.

## Eclipse facts (Dunedin)

| Event | Time (NZST) |
|---|---|
| Partial begins | 15:08:58 |
| **Totality begins** | **16:15:45** |
| **Maximum eclipse** | **16:17:11** |
| **Totality ends** | **16:18:36** |
| Partial ends | 17:17:00 |

At maximum the sun is at **altitude ≈ 8°, azimuth ≈ 311° (NW)**; totality lasts **2m51s**.
NZST = UTC + 12h, so maximum ≈ `2028-07-22T04:17:11Z`. Circumstances are computed per observer,
so they differ across the region — Queenstown reaches totality ~42 s before Dunedin.

### The eclipse ends at (or below) the horizon

The sun sets *during* this eclipse. Last contact happens with the sun under 1.7° altitude
everywhere in the South Island, and on the east coast it is already below the horizon:

| Site | Sun altitude at last contact |
|---|---|
| Te Anau | 1.64° |
| Queenstown | 1.23° |
| Wānaka | 1.07° |
| Cromwell / Invercargill | 0.91° |
| Alexandra | 0.73° |
| **Dunedin** | **−0.09°** |
| **Oamaru** | **−0.10°** |

Clean west→east gradient, since sunset comes later inland. Practically the closing phase is
unobservable almost everywhere — any hill, tree or building will take it. The app therefore
judges terrain obstruction only on phases when the sun is actually up, so a genuinely good site
is not downgraded merely because the sun had set.

## Pages

| File | What it is |
|---|---|
| `index.html` | The 3D simulator — stand somewhere, scrub the eclipse, run sightline checks |
| `map.html` | Overview map of every catalogued viewing spot |
| `astronomy.html` | Public-facing guide explaining how the eclipse and terrain sightline checks work |
| `methods.html` | Full technical specification of astronomical & geodetic methods (for astronomers) |
| `viewpoints.json` | The precomputed catalogue |

See [ASTRONOMY.md](ASTRONOMY.md) (or `methods.html` in the app) for the astronomical and geodetic
methods in review-ready detail, [DEPLOYMENT.md](DEPLOYMENT.md) for hosting and CI, and
[IDEAS.md](IDEAS.md) for parked ideas and the reasoning behind decisions already made.

The two pages link to each other. On the map, clicking a spot opens a popup with its clearance,
sun altitude, totality duration and access, plus **Open in 3D →**, which loads
`index.html?lat=…&lon=…&name=…`. Those URL parameters also make any location shareable.

Without `viewpoints.json` the simulator still works — the *Best viewing spots* panel simply
stays hidden — but the map page has nothing to show.

## Two audiences

The app serves both a casual visitor ("what will it look like from my town?") and an eclipse
chaser ("where exactly should I stand?"). A **Simple / Detailed** toggle switches between them;
the choice is remembered.

| | Simple (default) | Detailed |
|---|---|---|
| Sun position | "about one fist above the horizon, to the north-west" | altitude/azimuth in degrees |
| Sightline result | plain-language verdict and what to do about it | per-phase table with clearance in degrees |
| Magnitude | hidden | shown |
| Horizon profile | shown | shown |

The fist analogy is deliberate: an outstretched fist spans roughly 10° of sky, so a low 8° sun
is about one fist up — a measure you can use in the field.

On screens under 768px the side panels become drawers, opened one at a time from **Places** and
**Details** in the top bar, so the globe is never buried under fixed overlays.

### Arriving at a location

Landing on a spot — from a preset, a search, the catalogue or a `?lat=&lon=` link — sets up a
view that is usable without touching the camera:

- **The clock jumps to ~50% obscuration**, found by bisecting between first contact and
  maximum. There is still plenty of light on the landscape there, and **Totality** is then one
  click away with no camera adjustment needed.
- **The camera sits behind the observer**, looking along the sun's bearing at totality, so the
  location marker is in the foreground and the low sun is in the same frame. Standing directly
  over the point hid the marker and gave nothing to orient by.
- **Pitch is computed from the live frustum and the measured UI chrome.** Cesium's 60° FOV is
  the *horizontal* angle, so on a 1.89 aspect the usable vertical span is only 34° — a fixed
  pitch put the sun off the top edge. The status bar and timeline are measured too, because
  they are very different proportions on a phone (bottom bar ~29% of the screen) than on a
  desktop, and a percentage guess hides the marker on one or wastes space on the other.
- Pitch is fitted to the sun's altitude **on arrival** (its highest in this window), so as the
  sun sinks toward totality it moves *toward* the centre of frame rather than out of the top.

Imagery brightness sits above 1.0 at low obscuration for a related reason: the default view
looks along the sun's bearing, so slopes facing the camera are back-lit and would otherwise
render close to black.

### Features

- **Preset navigation** — Queenstown, Arrowtown, Cromwell, Dunedin.
- **Custom location** — coordinates (`-44.70, 169.13`), address search with autocomplete
  (↑/↓ to highlight, Enter to choose, Esc to dismiss), browser geolocation, or **Pin on map**
  to click a point on the terrain.
- **Timeline** with play/pause and **Start / Totality / End** jump buttons labelled with *this
  location's own* contact times.
- **Sightline check** — reports whether terrain blocks the sun, at all three of those moments.
- **Horizon profile chart** — terrain silhouette across ±20° of azimuth plotted against the
  sun's track, totality segment highlighted.
- **Eclipse progress card** — the moon crossing the sun, with live magnitude, obscuration %,
  phase and this location's totality window.
- **Eclipse lighting** — the landscape darkens as totality approaches. CesiumJS models sun
  *direction* but has no concept of occultation, so the scene is dimmed from live obscuration
  (light intensity, imagery brightness/saturation, atmosphere). The curve is deliberately
  non-linear — barely perceptible at 80% obscured, plunging past 97% — which is why totality
  feels so sudden.
- **Watch it happen** — a guided playback that runs the partial phases at 60×, slows to 12×
  through totality, and narrates each phase.
- **Best viewing spots** — the precomputed catalogue, filterable by access tier and by distance
  from wherever you currently are.

## How the sightline check works

From the selected point (ground level + eye height), the app fans out a set of bearings — the
sun's own azimuth at full radial resolution, plus a coarser sweep ±20° either side —
batch-samples terrain via `sampleTerrainMostDetailed`, and reduces each bearing to its horizon
angle, correcting for earth curvature and standard terrestrial refraction (`k = 0.13`,
`drop = d² / 2R_eff`). If the **terrain angle on the sun's bearing ≥ the sun's refracted
altitude**, the view is obstructed; if clearance is between `0°` and the solar semi-diameter
(`0.26°`), the app flags that the lower solar limb grazes the ridge. The ±20° sweep becomes the
horizon profile chart.

**Radial spacing is adaptive** — dense in the near-mid field, geometrically coarser far out. A
fixed grid is simultaneously too coarse near (it can stride over a sharp ridge) and wasteful
far. Sampling **starts at 100 m**, a floor set by DEM vertical error rather than geometry: with
a typical σ ≈ 5 m the angular error `atan(σ/d)` is ±32° at 8 m and ±5° at 50 m, but only ±3° at
100 m. Probing closer measures DEM noise, not the skyline — and it is ground you could step
around.

## Astronomy

Sun and moon positions come from [astronomy-engine](https://github.com/cosinekitty/astronomy)
(MIT, ~116 KB, no external data files, ±1 arcminute), **not** from Cesium. Cesium's solar
position is fine, but its built-in lunar series is too coarse for eclipse work — it put maximum
obscuration at ~88% and drifted minutes past the true maximum.

astronomy-engine reproduces the published Dunedin circumstances independently:

| Event | Published NZST | astronomy-engine | Δ |
|---|---|---|---|
| Totality begins | 16:15:45 | 16:15:44 | −1 s |
| **Maximum** | **16:17:11** | **16:17:11** | **0 s** |
| Totality ends | 16:18:36 | 16:18:39 | +3 s |

For the full method — coordinate frames, ΔT, atmospheric and terrestrial refraction handling,
terrain geometry, validation, and every approximation with its estimated magnitude — see
**[ASTRONOMY.md](ASTRONOMY.md)** (and `methods.html`).

## Precomputed viewpoint catalogue

`precompute/build_viewpoints.py` scans **the entire land area from which totality is visible**
offline and emits `viewpoints.json`. The app lists it under **Best viewing spots**, and
`map.html` plots all of it.

Two lists, toggled with **Lookouts / Anywhere**:

- **Lookouts** — named places people already go to look at things, from OSM: `tourism=viewpoint`,
  `natural=peak`, `man_made=tower` + `tower:type=observation`, `highway=rest_area`,
  `tourism=picnic_site`, `tourism=camp_site`. Usually the more useful list — a signposted
  lookout beats an anonymous coordinate on a hillside.
- **Anywhere** — the raw grid scan, for when no named spot works.

Scoring POIs on visibility rather than just listing them matters: many OSM viewpoints exist to
look *at* something specific (a waterfall, a bird colony, a steep street) and sit in gullies
with poor horizons. Those fall to the bottom automatically.

**Filters.** Access tiers are **exclusive**, not inclusive-downward: *Sealed road only*, *4WD
track only*, *Walking track only*, plus *Drivable* and *Any*. That matters — because ranking
puts sealed-road spots first, an inclusive "road or track" filter returned the same all-sealed
top 40 as "sealed" and appeared to do nothing. A **distance filter** (10/25/50/100 km) narrows
to spots near wherever you are standing, and each entry shows its distance and bearing.

> **Access ≠ permission.** Proximity to an OSM way is not a right of way, and land may be
> private. Treat the catalogue as a shortlist to investigate, not an invitation.

### Building it

```bash
python -m pip install --user numpy pillow requests astronomy-engine
cd precompute && python build_viewpoints.py
```

**Runtime: about 3½ hours cold, ~4 minutes warm.** The cold time is almost entirely the serial
Overpass road queries; the 1,360 terrain tiles and the 2.6-million-candidate numpy scan are
minor by comparison. Everything downloaded is cached under `precompute/cache/` (~400 MB), so
re-runs and interrupted runs are cheap. Flags: `--zoom`, `--spacing`, `--radius`, `--top`,
`--min-clearance`, `--no-osm`, `--no-poi`.

`verify_output.py` re-checks the emitted catalogue.

### How it works

1. **Region** — a land envelope over the totality path (lat −46.6…−43.3, lon 166.0…171.6). Most
   of the path is ocean; the per-candidate totality test discards anything outside it.
2. **Terrain** — Re:Earth **Terrarium** raster tiles, decoded as `(R·256 + G + B/256) − 32768`
   into one mosaic. At zoom 11 the 512 px tiles give **~27 m/px** (~1,360 tiles), matching the
   ~30 m source DEM; finer would only interpolate.
3. **Eclipse circumstances** — astronomy-engine on a 0.1° grid (~2,000 searches), bilinearly
   interpolated. Circumstances vary smoothly over tens of kilometres, so this is far cheaper
   than one search per candidate and indistinguishable at the precision that matters. Totality
   is a hard boundary: all four surrounding samples must be inside, so edge candidates are not
   optimistically included.
4. **Horizon scan** — candidates on a **250 m** grid, each probed along *its own* sun bearing at
   **second contact, maximum and third contact**. Vectorised in numpy, so ~650k candidates cost
   minutes. Each spot records `clearBegin` / `clearance` / `clearEnd` and a `wholeTotality`
   flag, because the sun shifts in azimuth across totality — a spot can be clear at second
   contact and blocked by third.

   The probe ray uses the **same 3% growth and 45 km reach as the app**, deliberately. An
   earlier version grew at 13%, putting samples ~3.6 km apart at 28 km range and striding over
   distant ridges — a cross-check against the app disagreed by 1.3° for exactly that reason.
   The mosaic is padded 45 km beyond the region so boundary rays never run off the edge and
   report a falsely clear horizon.
5. **Access** — OpenStreetMap via Overpass, queried only for the 0.25° cells containing
   surviving candidates, then rasterised so each candidate's distance to the nearest road is an
   O(1) lookup. Kept spots are within **100 m** (`--radius`) of a road, track or path.
6. **Ranking** — **access tier first**, then horizon clearance, then totality duration. That
   ordering is load-bearing: ranking on clearance alone filled the list with 2500–3000 m alpine
   summits (Mount Tūtoko, Mount Aspiring) with superb horizons and no way to reach them.
   Results are thinned to 2.5 km minimum separation, and quotas reserve 50/30/20% of the grid
   list for sealed/track/foot — otherwise sealed-road spots crowd out every walk-in option.

**Overpass requests are deliberately serial.** Running even two in parallel got this IP
throttled with 503/504s — and a throttled cell is indistinguishable from a genuinely roadless
one, which would silently mark reachable spots as inaccessible. Failed cells are retried with
backoff, swept again after a cool-off, and anything still missing is printed loudly *and*
recorded as `osmGaps` in the output, so a coverage hole cannot pass unnoticed.

**Access classes are deliberately narrow.** `footway`, `cycleway` and `service` are excluded —
they are dominated by urban pavements, driveways and car-park aisles rather than genuine
"can I get there" access, and including them made the Overpass query ~35× slower. NZ tramping
tracks use `highway=path`, which *is* included.

## Running locally

```bash
python -m http.server 8080
# then open http://localhost:8080
```

`file://` mostly works, but a local server is recommended so CesiumJS loads its bundled assets
reliably.

## Deploying

On **Cloudflare Workers** as a static-asset site: `wrangler.jsonc` declares an asset directory
and no Worker script, and GitHub Actions assembles that directory and uploads it only once the
checks pass. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full setup, including why this is not
Cloudflare's Git integration.

`precompute/` is a dev tool and harmless if deployed, but **`precompute/cache/` must never be
committed** — ~1,750 files and ~400 MB of tiles and Overpass responses. `.gitignore` excludes
it; check `git status` before the first commit.

`_headers` sets `nosniff`, `Referrer-Policy`, `X-Frame-Options`, scopes the geolocation
permission to the site, and keeps `viewpoints.json` and the HTML on short revalidating caches
so a catalogue rebuild reaches users without renaming files.

### Third-party services

All client-side, all free, none with an SLA:

| Service | Used for | Notes |
|---|---|---|
| [Re:Earth Terrain](https://terrain.reearth.land) | 3D terrain (quantized-mesh, ~30 m Mapterhorn DEM) | Best-effort, no key. Attribution required and displayed. |
| Esri World Imagery | Satellite basemap | Keyless endpoint; can throttle under load. Attributed. |
| Photon (komoot) | Address search | OSM-based, built for autocomplete. Fair-use. |
| unpkg / jsDelivr | Leaflet, Lucide, astronomy-engine, CesiumJS | Standard CDNs. Tailwind is prebuilt and self-hosted. |

**Why Photon and not Nominatim:** Nominatim's usage policy states that auto-complete search "is
not yet supported by Nominatim and you must not implement such a service", and warns that
violations "will get you banned". As-you-type search would have breached that on a public
deployment — and Nominatim is a shared community resource, so the cost lands on everyone.

### Cesium ion (optional)

No token ships with the site, and the default terrain needs none. To use Cesium World Terrain
instead — finer over New Zealand — supply your own at runtime:

```
index.html?terrain=ion&ionToken=YOUR_TOKEN
```

It is kept in that browser's `localStorage` and never leaves the client. Do **not** hardcode a
token into `index.html` before publishing: anyone can read it from view-source and spend your
quota.

The two sources can disagree where resolution matters. At Queenstown, blocked by a large ridge,
they agree closely (20.9° ion vs 20.8° open, same 1045 m ridge at 1.9 km). At Dunedin, a
marginal near-field case, ion resolves a small rise ~0.1 km away that the ~30 m DEM smooths
away — enough to flip the verdict. For ridge-scale questions the open DEM is fine; for
close-range terrain, prefer ion and treat marginal verdicts as "check on site".

## Limitations

- The sightline model sweeps ±20° of azimuth around the sun, not a full 360° viewshed.
- Terrain within 100 m of the observer is excluded as ground clutter (see above).
- Solar and terrain altitudes use standard atmospheric refraction (`Refraction.Normal` for the
  sun; `k = 0.13` effective Earth radius for terrain); winter temperature inversions can shift
  apparent angles near the horizon by several arcminutes.
- Eclipse lighting approximates perceived brightness; it is not a radiometric model.
- Everything else loads from CDNs, so an internet connection is required.

## Tech stack

HTML5 · Tailwind CSS (prebuilt, purged) · Lucide icons · Leaflet (overview map) · CesiumJS v1.118
(3D rendering) · astronomy-engine (ephemeris and eclipse circumstances) · Re:Earth Terrain +
Esri imagery · OpenStreetMap via Overpass and Photon.

Cesium is the *renderer*; astronomy is deliberately handled by a dedicated library rather than
the engine's built-in ephemeris.
