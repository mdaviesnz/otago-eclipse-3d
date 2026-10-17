# Astronomical & Geodetic Methods — Technical Specification

This document provides a complete specification of how **Otago Eclipse 3D** computes solar and
lunar positions, topocentric eclipse circumstances, atmospheric refraction, and terrain horizon
obstruction for the **total solar eclipse of 22 July 2028** over the South Island of New Zealand.

It is written for domain reviewers in astronomy, positional astrometry, and geodesy, and states
all physical assumptions, coordinate transformations, numerical algorithms, and error budgets
explicitly.

---

## 1. Physical Context of the Event

On the afternoon of **22 July 2028** (mid-winter in the Southern Hemisphere), the lunar umbra
crosses Fiordland, Southland, and Otago from west-north-west to east-south-east before leaving
the New Zealand coast just after 16:19 NZST (04:19 UTC):

- **Maximum eclipse in Dunedin (`-45.8788°, 170.5028°`):** `04:17:11.8 UTC` (`16:17:11.8 NZST`).
- **Apparent solar altitude at maximum:** $8.39^\circ$ (Dunedin, east coast) to $10.0^\circ\text{–}10.8^\circ$ (Queenstown / Fiordland, inland west).
- **Solar azimuth at maximum:** $\approx 310.6^\circ\text{–}312.9^\circ$ (north-west).
- **Totality duration on the centreline:** up to $\approx 179\text{ s}$ ($2\text{m } 59\text{s}$).
- **Sunset during the closing partial phase:** Fourth contact (C4) occurs with the Sun below
  $1.7^\circ$ altitude across the entire South Island, and slightly below the geometric horizon
  along the east coast (Dunedin refracted altitude $-0.09^\circ$, geometric altitude $-0.63^\circ$
  at `05:19:58 UTC`).

Because the Sun sits only $8^\circ\text{–}10^\circ$ above the north-western horizon during
totality—across a region of steep glacial valleys and basin-and-range topography—local terrain
obstruction is the primary determinant of whether totality is observable from a given site. At
these grazing altitudes, atmospheric refraction and Earth curvature are significant compared to
the angular diameter of the Sun ($\approx 0.52^\circ$) and must be treated consistently.

---

## 2. Ephemeris and Coordinate Pipeline

### 2.1 Ephemeris Engine

All solar and lunar positions and eclipse contact times are computed using
**[astronomy-engine](https://github.com/cosinekitty/astronomy)** (Don Cross, MIT License), which
is executed identically in both code paths:

| Environment | Library | Role |
|---|---|---|
| Browser (`index.html`) | `astronomy.browser.min.js` (v2) | Real-time topocentric coordinates, continuous magnitude/obscuration, and per-location contact times |
| Offline pipeline (`precompute/build_viewpoints.py`) | `astronomy-engine` (Python) | Regional circumstance grid (`EclipseField`), POI/grid horizon clearances, and town-centre preset profiles |

`astronomy-engine` implements:
- **Solar position:** VSOP87 theory (Bretagnon & Francou 1988) truncated to retain sub-arcsecond
  accuracy in the modern era.
- **Lunar position:** ELP/MPP02-derived series (Chapront & Francou 2003).
- **Precession and nutation:** IAU 2000B precession–nutation model (McCarthy & Luzum 2003).

**Epoch accuracy vs. secular bound:** While `astronomy-engine` states a conservative worst-case
guarantee of $\pm 1\text{ arcminute}$ across its full multi-century span, its actual relative
Sun–Moon positional error in the 2028 epoch is $\sim 1\text{–}3\text{ arcseconds}$. Because the
Moon's topocentric synodic rate relative to the Sun is $\approx 0.55''/\text{s}$, a $1\text{ arcminute}$
along-track error would shift contact times by $\sim 110\text{ s}$; in validation against
published Fred Espenak / NASA GSFC predictions (§9), `astronomy-engine` reproduces Dunedin C1,
C2, maximum, and C3 to within $0\text{–}3\text{ s}$.

**Deliberate exclusion of CesiumJS's internal ephemeris:** CesiumJS (`v1.118`) is used strictly
as a 3D terrain renderer. Its built-in `Simon1994PlanetaryPositions` lunar analytical series is
designed for scene lighting rather than occultations; during development it was measured to miss
the lunar latitude at totality by several arcminutes (peaking at $\approx 88\%$ obscuration and
several minutes late). Cesium's internal sun direction drives 3D terrain shading only and never
enters any astronomical readout or sightline calculation.

### 2.2 Coordinate Transformations

For an observer at geodetic latitude $\phi$, longitude $\lambda$, and height $h$ above the WGS84
ellipsoid at instant $t$:

1. **Topocentric Equatorial Coordinates of Date (`Equator`):**
   ```
   eq = Equator(body, t, observer, ofdate=true, aberration=true)
   ```
   - Evaluates the heliocentric/geocentric state vectors of the Earth, Sun, and Moon in the
     J2000.0 equatorial frame (ICRF/EME2000).
   - Applies annual aberration and gravitational light deflection for the Sun, and light-time
     iteration for the Moon.
   - Rotates from J2000.0 to the true equator and equinox of date (`ofdate=true`) via IAU 2000B
     precession and nutation.
   - Subtracts the observer's geocentric position vector on the rotating WGS84 ellipsoid
     (including diurnal aberration) to yield topocentric right ascension $\alpha$, declination
     $\delta$, and topocentric distance $d$ (in AU).

2. **Topocentric Horizontal Coordinates (`Horizon`):**
   ```
   hz = Horizon(t, observer, eq.ra, eq.dec, Refraction.Normal)
   ```
   - Computes local apparent sidereal time (GAST) at longitude $\lambda$ and converts
     $(\alpha, \delta)$ to local geometric altitude $\alpha_{\text{geom}}$ and azimuth $A$
     (measured clockwise from true North: $0^\circ = \text{N}, 90^\circ = \text{E}, 311^\circ \approx \text{NW}$).
   - Applies standard atmospheric refraction (`Refraction.Normal`, §6.1) to yield apparent
     altitude $\alpha_{\text{app}}$.

---

## 3. Time Scales and $\Delta T$

- **Internal clock:** All calculations operate in **UTC** (represented as `Cesium.JulianDate` or
  JavaScript `Date` in the browser, and UTC `Astronomy.Time` in Python).
- **Displayed wall-clock time:** **NZST ($\text{UTC} + 12\text{ h}$)**. Because July is Southern
  Hemisphere winter, New Zealand Daylight Time ($\text{UTC} + 13\text{ h}$) is not in force.
- **Terrestrial Time ($\text{TT}$) and $\Delta T$:** `astronomy-engine` converts Universal Time
  ($\text{UT} \approx \text{UTC}$) to Terrestrial Time ($\text{TT} = \text{UT} + \Delta T$)
  using the Espenak & Meeus (2006) polynomial fit (`DeltaT_EspenakMeeus`), which evaluates to
  $\Delta T \approx 72.7\text{ s}$ for 2028.55.
- **$\Delta T$ extrapolation uncertainty:** Recent IERS Earth rotation measurements indicate a
  slower deceleration of UT1 than the 2006 quadratic extrapolation predicted, placing actual
  2028 $\Delta T$ closer to $69.5\text{–}70.5\text{ s}$ (an offset of $\delta(\Delta T) \approx 2\text{–}3\text{ s}$).
  Because Earth rotates eastward at $\approx 465\text{ m/s} \cdot \cos(45^\circ) \approx 329\text{ m/s}$,
  each $1\text{ s}$ of $\Delta T$ uncertainty shifts the umbral ground track by $\approx 0.33\text{ km}$
  in longitude and shifts contact times by $\approx 1\text{ s}$ when compared against predictions
  adopting a different $\Delta T$ value.

---

## 4. Observer Geodesy and Datum Model

The observer position is constructed as `Observer(latitude, longitude, height)` where:
- $\phi, \lambda$ are WGS84 geodetic latitude and longitude.
- $h = h_{\text{terrain}} + 1.7\text{ m}$ (terrain elevation plus a $1.7\text{ m}$ standard eye height).

### 4.1 Ellipsoidal vs. Orthometric Height Datum

`astronomy-engine` interprets `height` as metres above mean sea level, adds it to the WGS84
ellipsoidal radius at latitude $\phi$, and uses that geocentric vector for topocentric parallax.
The app's default terrain source (Re:Earth Terrain, derived from Mapterhorn / Copernicus GLO-30)
is referenced to the WGS84 ellipsoid. Over Otago, the NZGeoid2016 geoid–ellipsoid separation $N$
is approximately $+5\text{ m}$ to $+35\text{ m}$. Feeding ellipsoidal height directly therefore
introduces a vertical datum offset of $\lesssim 35\text{ m}$.

Note that for terrain sightline checks (§7), **both** the observer height $h_{\text{obs}}$ and
all terrain sample heights $h_{\text{terrain}}(d)$ come from the same DEM and share the same
vertical datum, so any datum offset cancels in the elevation difference $h_{\text{terrain}} - h_{\text{obs}}$
(leaving only the negligible geoid slope over distance $d$).

### 4.2 Sensitivity of Eclipse Circumstances to Observer Elevation

Because the Moon's shadow cone arrives at a shallow grazing angle ($\alpha_\odot \approx 8.4^\circ\text{–}10^\circ$),
raising an observer vertically by $\Delta h$ shifts their intercept with the slanted shadow axis
down-track (south-eastward along the solar bearing) by an equivalent horizontal ground distance
$\Delta x = \Delta h \cot\alpha_\odot \approx 6.8\,\Delta h$.

Measured sensitivity at Dunedin (`-45.8788°, 170.5028°`) varying observer height $h$:

| Observer height $h$ | Maximum eclipse (UTC) | Apparent solar altitude at maximum |
|---|---|---|
| $0\text{ m}$ | `04:17:11.848` | $8.3900^\circ$ |
| $500\text{ m}$ | `04:17:12.269` | $8.3891^\circ$ |
| $2000\text{ m}$ | `04:17:13.968` | $8.3854^\circ$ |

Contact times shift by **$\approx +1.06\text{ s}$ per km of elevation**, and apparent solar
altitude at maximum decreases by **$\approx -0.0023^\circ$ per km** (not from direct solar
parallax, which is $0.0015''/\text{km}$, but because the $+1.06\text{ s/km}$ delay in maximum
eclipse allows Earth's rotation to carry the setting Sun lower at $-0.0022^\circ/\text{s}$).
A $35\text{ m}$ geoid–ellipsoid datum offset therefore affects contact times by $< 0.04\text{ s}$
and altitude by $< 10^{-4}\text{ deg}$.

In the live simulator (`index.html`) and in the four precomputed town presets (`preset_rows` in
`build_viewpoints.py`), `SearchLocalSolarEclipse` is called with the actual observer elevation
$h = h_{\text{terrain}} + 1.7\text{ m}$. In the regional circumstance grid (`EclipseField`, §5.1),
grid nodes are evaluated at $h = 0\text{ m}$, which introduces up to $1\text{–}2\text{ s}$ of
contact-time offset for high-altitude alpine candidates ($1500\text{–}2000\text{ m}$).

---

## 5. Eclipse Circumstances, Magnitude, and Obscuration

### 5.1 Local Contact Times (`SearchLocalSolarEclipse`)

Per-observer contact times are computed via `SearchLocalSolarEclipse(startTime, observer)`
starting from `2028-07-21T00:00:00Z`. The solver uses iterative root-finding on the topocentric
angular separation between the solar and lunar centres relative to their apparent semi-diameters
to return:
- `kind`: `partial`, `annular`, or `total`
- `partial_begin` (first contact, C1): $\text{sep} = s_\odot + s_\mathbb{C}$ (decreasing)
- `total_begin` (second contact, C2): $\text{sep} = s_\mathbb{C} - s_\odot$ (decreasing)
- `peak` (maximum eclipse): $\frac{d}{dt}(\text{sep}) = 0$
- `total_end` (third contact, C3): $\text{sep} = s_\mathbb{C} - s_\odot$ (increasing)
- `partial_end` (fourth contact, C4): $\text{sep} = s_\odot + s_\mathbb{C}$ (increasing)

Each returned `EclipseEvent` includes `{ time, altitude }`, where `altitude` is the **refracted**
solar altitude (`Refraction.Normal`) at that instant.

In the offline catalogue builder (`build_viewpoints.py`), `EclipseField` evaluates
`SearchLocalSolarEclipse` on a $0.1^\circ \times 0.1^\circ$ latitude/longitude grid ($\approx 2\,000$
nodes across $[-46.6^\circ, -43.3^\circ] \times [166.0^\circ, 171.6^\circ]$) and interpolates
solar altitude, azimuth, and totality duration bilinearly for the $\sim 650\,000$ land
candidates. To prevent false-positive totality verdicts along the northern and southern umbral
limits, totality membership is treated as a strict logical conjunction: **all four surrounding
$0.1^\circ$ grid corners must be inside the path of totality** (`tot = c00 & c01 & c10 & c11`).

### 5.2 Instantaneous Magnitude, Obscuration, and Totality Criterion (`eclipseAt`)

Because `astronomy-engine` reports obscuration only at peak eclipse, the live simulator computes
time-varying eclipse geometry on every clock tick in `eclipseAt(time, originCartesian)`:

1. **Topocentric Apparent Semi-Diameters:**
   From the topocentric distances $d_\odot, d_\mathbb{C}$ returned by `Equator` (converted from
   AU to km using $1\text{ AU} = 149\,597\,870.7\text{ km}$):
   $$s_\odot = \arcsin\!\left(\frac{R_\odot}{d_\odot}\right), \qquad s_\mathbb{C} = \arcsin\!\left(\frac{R_\mathbb{C}}{d_\mathbb{C}}\right)$$
   with nominal spherical radii:
   $$R_\odot = 695\,700\text{ km} \quad\text{(IAU 2015 Resolution B3 nominal photospheric radius)}$$
   $$R_\mathbb{C} = 1\,737.4\text{ km} \quad\text{(IAU working group mean lunar radius, } k_0 = R_\mathbb{C}/R_\oplus = 0.2725076\text{)}$$
   At Dunedin maximum eclipse, this yields apparent diameters $2s_\odot = 31.47'$ and
   $2s_\mathbb{C} = 32.90'$, with radius ratio $k = s_\mathbb{C} / s_\odot = 1.0454$.

2. **Topocentric Angular Separation ($\text{sep}$):**
   Unit direction vectors $\hat{\mathbf{u}}_\odot, \hat{\mathbf{u}}_\mathbb{C}$ are formed from
   topocentric $(\alpha, \delta)$ of date:
   $$\hat{\mathbf{u}} = \begin{bmatrix} \cos\delta \cos\alpha \\ \cos\delta \sin\alpha \\ \sin\delta \end{bmatrix}, \qquad \text{sep} = \arccos\!\left(\text{clamp}(\hat{\mathbf{u}}_\odot \cdot \hat{\mathbf{u}}_\mathbb{C}, -1, 1)\right)$$

3. **Eclipse Magnitude (Diameter Fraction):**
   $$\text{mag} = \max\!\left(0,\; \frac{s_\odot + s_\mathbb{C} - \text{sep}}{2 s_\odot}\right)$$

4. **Geometric Obscuration (Area Fraction):**
   The exact lens overlap area $A_{\text{overlap}}(s_\odot, s_\mathbb{C}, \text{sep})$ of two
   circular discs of radii $r_1 = s_\odot$, $r_2 = s_\mathbb{C}$ separated by $d = \text{sep}$ is:
   $$A_{\text{overlap}} = \begin{cases} 0 & d \ge r_1 + r_2 \\ \pi \min(r_1, r_2)^2 & d \le |r_1 - r_2| \\ r_1^2 \alpha_1 + r_2^2 \alpha_2 - \frac{1}{2}\sqrt{(-d+r_1+r_2)(d+r_1-r_2)(d-r_1+r_2)(d+r_1+r_2)} & \text{otherwise} \end{cases}$$
   where $\alpha_1 = \arccos\!\left(\frac{d^2 + r_1^2 - r_2^2}{2 d r_1}\right)$ and
   $\alpha_2 = \arccos\!\left(\frac{d^2 + r_2^2 - r_1^2}{2 d r_2}\right)$. Obscuration is then:
   $$\text{obscuration} = \frac{A_{\text{overlap}}}{\pi s_\odot^2}$$

5. **Strict Totality Criterion (`isTotal`):**
   Totality occurs if and only if the lunar disc completely encloses the solar disc (internal
   tangency):
   $$\text{isTotal} \iff (s_\mathbb{C} \ge s_\odot) \;\land\; (\text{sep} \le s_\mathbb{C} - s_\odot)$$
   *Note on partial-phase rounding:* Because a thin exposed solar crescent of $0.1\%$ area
   ($\text{obscuration} = 0.999$) still corresponds to a $\approx 16.6''$ separation from
   internal tangency ($\approx 33\text{ s}$ before C2 or after C3) and remains blindingly bright,
   the UI gates the `"TOTALITY"` state, corona diagram, and "safe to view without eclipse
   glasses" narration strictly on `isTotal` rather than an obscuration percentage threshold, and
   caps displayed partial obscuration at `99.9%` whenever `!isTotal`.

### 5.3 Smooth-Sphere Approximation vs. Lunar Limb Profile

- **No lunar limb profile (Kaguya / LRO topography):** Both bodies are modelled as smooth spheres.
  Real lunar mountains and valleys shift C2 and C3 contact times by $\pm 1\text{–}3\text{ s}$
  near the centreline and govern Baily's beads and grazing-zone phenomena.
- **Mean lunar radius vs. eclipse valley radius:** Standard Besselian element predictions
  (Espenak & Meeus 2006; *Astronomical Almanac*) adopt $k = 0.272281 R_\oplus$ ($R_\mathbb{C} \approx 1\,735.95\text{ km}$,
  the mean lunar valley radius, $\approx 1.45\text{ km}$ or $\approx 0.8''$ smaller than the IAU
  mean radius of $1\,737.4\text{ km}$) when computing umbral contacts so that sunlight shining
  through deep lunar valleys is excluded from nominal totality. Using the IAU mean radius in
  `astronomy-engine` makes computed totality durations $\approx 2\text{–}3\text{ s}$ longer than
  valley-radius predictions, matching the $+3\text{ s}$ difference observed at Dunedin C3 (§9).

---

## 6. Atmospheric and Terrestrial Refraction

At an altitude of $8^\circ\text{–}10^\circ$, atmospheric refraction is the largest optical
correction after raw terrain geometry. Both code paths (`index.html` and `build_viewpoints.py`)
apply a unified refraction model to the Sun and the terrain.

### 6.1 Astronomical Refraction of the Sun (`Refraction.Normal`)

`astronomy-engine`'s `Refraction.Normal` implements Bennett's (1982) empirical formula (Meeus,
*Astronomical Algorithms*, Ch. 16) for standard sea-level conditions ($P = 1010\text{ hPa}$,
$T = 10^\circ\text{C}$):
$$R_{\text{astro}} \text{ (arcminutes)} = \frac{1.02}{\tan\!\left(\alpha_{\text{geom}} + \frac{10.3}{\alpha_{\text{geom}} + 5.11}\right)}$$
(with $\alpha_{\text{geom}}$ in degrees, plus a smooth clamping ramp below the horizon). At
Dunedin maximum eclipse:
- Geometric solar altitude (`Airless`): $8.2852^\circ$
- Apparent refracted solar altitude (`Normal`): $8.3919^\circ$ (at `04:17:11.0Z`) / $8.3900^\circ$ (at `04:17:11.848Z`)
- Astronomical refraction lift: **$R_{\text{astro}} = +0.1067^\circ \approx +6.40'$**

### 6.2 Terrestrial Refraction of the Horizon ($k = 0.13$)

Light rays travelling nearly horizontally from a distant mountain ridge at ground distance $d$
are also bent downward by the vertical refractive-index gradient of the lower atmosphere, making
the distant ridge appear *higher* than its geometric elevation. Standard geodetic practice models
this with a terrestrial refraction coefficient $k = R_\oplus / R_{\text{ray}} \approx 0.13$,
which replaces the geometric Earth radius $R_\oplus = 6\,371\,000\text{ m}$ in the curvature drop
formula with an **effective Earth radius**:
$$R_{\text{eff}} = \frac{R_\oplus}{1 - k} \approx 7\,322\,989\text{ m}$$
The combined curvature-plus-refraction drop at distance $d$ is:
$$\text{drop}(d) = \frac{(1 - k)\, d^2}{2 R_\oplus} = \frac{d^2}{2 R_{\text{eff}}}$$
Compared to airless geometric drop ($d^2 / 2R_\oplus$), terrestrial refraction lifts the apparent
terrain angle by $\Delta\theta_{\text{terr}} \approx \frac{k\, d}{2 R_\oplus}$ radians:
- at $d = 10\text{ km}$: $+0.35' \approx +0.006^\circ$
- at $d = 30\text{ km}$: $+1.05' \approx +0.018^\circ$
- at $d = 45\text{ km}$: $+1.58' \approx +0.026^\circ$

### 6.3 Coupled Ray Geometry in Winter Basin Temperature Inversions

A natural meteorological question for an Otago eclipse at 16:17 NZST in July is whether cold-air
pooling and late-afternoon radiative temperature inversions ($\frac{dT}{dz} > 0$, which can raise
local boundary-layer $k$ from $0.13$ to $0.25\text{–}0.50$) invalidate standard refraction tables.

By Snell's law and the principle of optical reversibility in a stratified atmosphere, **any two
light rays arriving at the observer at the same apparent elevation angle trace the exact same
curved trajectory through the lower atmosphere**. If a mountain ridge at distance $d$ and height
$h_{\text{ridge}}$ is near the solar sightline, the grazing solar ray skims the ridge at height
$h_{\text{ridge}}$ and then traverses the final segment of length $d$ from the ridge to the
observer through the *exact same parcel of basin air* as the light from the ridge itself.

Consequently:
- Any anomalous boundary-layer refraction inside a cold Otago valley **below the obstructing
  ridge crest** bends the solar ray and the terrain sightline by the **exact same angle**,
  cancelling out of the clearance difference $\Delta\alpha = \alpha_{\odot,\text{app}} - \theta_{\text{terr,app}}$.
- Only the atmosphere *above* the ridge elevation $h_{\text{ridge}}$ contributes to differential
  refraction between the Sun and the ridge, and the free atmosphere above ridge crests follows a
  near-standard lapse rate where Bennett's formula is well-behaved.

---

## 7. Terrain Horizon Geometry and Ray-Marching

### 7.1 Probe Ray Discretisation

From the observer at $(\phi_1, \lambda_1)$ and eye height $h_{\text{obs}} = h_{\text{ground}} + 1.7\text{ m}$,
the sightline check marches outward along a great-circle initial bearing $A$ from inner distance
$d_{\min} = 100\text{ m}$ to outer distance $d_{\max} = 45\,000\text{ m}$ with adaptive geometric
spacing ($3\%$ growth per step):
$$d_{n+1} = d_n + \max(25\text{ m},\; 0.03\, d_n)$$
This produces $161$ radial samples per bearing: dense in the near-to-mid field ($25\text{ m}$ steps
at $100\text{ m}$, $150\text{ m}$ steps at $5\text{ km}$) where a sharp crest subtends a large
angle, and $\le 1.3\text{ km}$ at the $45\text{ km}$ outer boundary.

- **Why $d_{\min} = 100\text{ m}$:** A ~30 m DEM has a typical vertical uncertainty of $\sigma_z \approx 5\text{ m}$.
  At distance $d$, vertical DEM error induces an angular error of $\sigma_\theta \approx \arctan(\sigma_z / d)$:
  $\pm 32^\circ$ at $8\text{ m}$, $\pm 5.7^\circ$ at $50\text{ m}$, and $\pm 2.9^\circ$ at
  $100\text{ m}$ ($\approx 3.3\text{ pixels}$). Probing closer than $100\text{ m}$ samples
  bilinear self-interpolation and DEM noise rather than real topography, and represents local
  ground clutter an observer can walk a few metres to avoid.
- **Great-circle geodesic coordinates:** Both code paths trace a true great-circle ray:
  - In `index.html`, radial offsets $(d\sin A, d\cos A, 0)$ in the local East–North–Up tangent
    frame (`Cesium.Transforms.eastNorthUpToFixedFrame`) are projected onto the WGS84 ellipsoid.
  - In `precompute/build_viewpoints.py`, probe coordinates $(\phi_2, \lambda_2)$ are computed via
    the spherical forward geodesic equations with angular distance $\delta = d / R_\oplus$:
    $$\sin\phi_2 = \sin\phi_1 \cos\delta + \cos\phi_1 \sin\delta \cos A$$
    $$\lambda_2 = \lambda_1 + \arctan2(\sin A \sin\delta \cos\phi_1,\; \cos\delta - \sin\phi_1 \sin\phi_2)$$

### 7.2 Horizon Angle and Solar Disc Clearance

At each sample distance $d$ with terrain elevation $h_{\text{terrain}}(d)$, the apparent
elevation angle of the terrain is:
$$\theta(d) = \arctan2\!\left(h_{\text{terrain}}(d) - h_{\text{obs}} - \frac{d^2}{2 R_{\text{eff}}},\; d\right)$$
The horizon angle along bearing $A$ is $\theta_{\text{horiz}}(A) = \max_{d} \theta(d)$, and the
reported **clearance** at solar altitude $\alpha_\odot$ is:
$$\text{clearance} = \alpha_\odot - \theta_{\text{horiz}}(A)$$

**Solar centre vs. solar lower limb ($0.26^\circ$ threshold):**
Because $\alpha_\odot$ is the altitude of the **centre** of the Sun while the solar/lunar disc
has an apparent semi-diameter of $s_\odot \approx 0.26^\circ$ ($s_\mathbb{C} \approx 0.27^\circ$,
plus $\approx 0.25^\circ$ for the bright inner corona):
- $\text{clearance} \le 0^\circ$: the centre of the Sun (more than half the disc) is behind
  terrain (**Blocked**).
- $0^\circ < \text{clearance} < 0.26^\circ$: the centre of the Sun is visible, but the lower limb
  of the eclipsed disc grazes or is partially occulted by the ridge (**Grazing** — flagged
  explicitly in the sightline card).
- $\text{clearance} \ge 0.26^\circ$: the entire photospheric/lunar disc clears the terrain crest
  (and for $\text{clearance} \ge 0.5^\circ$, the bright inner corona clears as well).

### 7.3 Three-Contact Evaluation and Azimuth Fan

During the $\approx 2.2\text{ hours}$ from C1 to C4, the Sun sweeps $\approx 26.5^\circ$ in
azimuth across the north-western sky (and $\approx 0.6^\circ$ between C2 and C3 during totality).
- **Live check (`runSightlineCheck`):** Evaluates full-resolution ($3\%$ step) rays along the
  exact solar azimuths at **C1 (Start)**, **Maximum**, and **C4 (End)**, plus a $4^\circ$-spaced
  azimuth fan extending $\pm 10^\circ$ beyond the C1–C4 span to render the horizon profile chart.
  Phases where the Sun is already below the horizon ($\alpha_\odot \le 0^\circ$, such as C4 on
  the east coast) are reported as `"sun below horizon"` rather than counting as terrain
  obstructions.
- **Precomputed catalogue (`spots` and `pois`):** Evaluates full-resolution rays at **C2
  (`clearBegin`)**, **Maximum (`clearance`)**, and **C3 (`clearEnd`)**, setting
  `wholeTotality = (clearBegin > 0) and (clearance > 0) and (clearEnd > 0)`.
- **Precomputed town presets (`presets`):** Evaluates a $1^\circ$-stepped horizon profile across
  the full C1–C4 azimuth range padded by $\pm 12^\circ$, using a **dual-resolution DEM** ($z=13$,
  $\approx 6.8\text{ m/px}$ within $9\text{ km}$; $z=11$, $\approx 27\text{ m/px}$ from $9\text{ km}$
  to $45\text{ km}$) so sharp near-field ridges (e.g. Arrowtown at $775\text{ m}$ range) suffer no
  raster-smoothing bias.

---

## 8. Perceptual Scene Lighting Model

CesiumJS shades terrain from solar direction but has no native concept of lunar occultation. The
simulator modulates directional sunlight intensity, satellite imagery brightness/saturation, and
sky/globe atmospheric scattering using a non-linear power law of geometric obscuration:
$$\text{dim} = \text{clamp}(\text{obscuration}, 0, 1)^6$$
This is an **explicitly perceptual visualization model, not a radiometric one**. Because human
scotopic/mesopic adaptation compresses perceived brightness logarithmically, ambient daylight
appears to change very little up to $\sim 80\%$ obscuration ($\text{dim} = 0.8^6 \approx 0.26$)
and collapses rapidly past $95\%$ ($\text{dim} \to 1$). Any physical illuminance model would
additionally require solar limb darkening (neckel & Labs 1994) and 3D Monte Carlo scattering of
coronal and horizon-ring twilight outside the umbra.

---

## 9. Validation

### 9.1 Against Published Eclipse Predictions (Dunedin)

Comparison at Dunedin (`-45.8788°, 170.5028°`) against published reference tables (Espenak /
timeanddate):

| Event | Reference (NZST) | `astronomy-engine` (NZST) | $\Delta$ | Notes |
|---|---|---|---|---|
| First contact (C1) | `15:08:58` | `15:09:01` | $+3\text{ s}$ | Smooth-sphere + $\Delta T$ |
| Second contact (C2) | `16:15:45` | `16:15:44` | $-1\text{ s}$ | Mean lunar radius vs. valley radius + limb profile |
| **Maximum eclipse** | **`16:17:11`** | **`16:17:11`** | **$0\text{ s}$** | Exact agreement to the second |
| Third contact (C3) | `16:18:36` | `16:18:39` | $+3\text{ s}$ | Mean lunar radius ($1737.4\text{ km}$) vs. valley radius |
| Fourth contact (C4) | `17:17:00` (sunset) | `17:19:58` (alt $-0.09^\circ$) | $+3\text{ m}$ | Reference clamps partial end at local sunset |

### 9.2 Cross-Validation Between DEM Pipelines

Comparing the offline Python horizon scan (z13 near-field + z11 far-field Terrarium raster DEM)
against the live browser check (Cesium quantized-mesh at maximum detail) across all four preset
towns at all three contacts (12 bearings):

| Town | Ridge distance | C1 $\Delta\theta$ | Maximum $\Delta\theta$ | C4 $\Delta\theta$ | Verdict at maximum |
|---|---|---|---|---|---|
| **Queenstown** | $1.2\text{–}3.7\text{ km}$ | $-0.11^\circ$ | $+0.04^\circ$ | $-0.01^\circ$ | Blocked by $10.7^\circ$ (Ben Lomond / Bob's Peak) |
| **Arrowtown** | $\sim 775\text{ m}$ | $+0.02^\circ$ | $+0.07^\circ$ | $-0.13^\circ$ | Blocked by $5.3^\circ$ |
| **Cromwell** | distant | $+0.03^\circ$ | $-0.06^\circ$ | $-0.00^\circ$ | Clear by $2.5^\circ$ |
| **Dunedin** | distant | $-0.01^\circ$ | $-0.01^\circ$ | $-0.03^\circ$ | Clear by $1.7^\circ$ |

Worst-case discrepancy across all 12 town/contact checks is $0.13^\circ$ with zero-mean scatter.

---

## 10. Summary of Model Approximations and Error Budget

| Component | Model / Approximation | Quantitative Magnitude | Impact on Verdicts |
|---|---|---|---|
| **Ephemeris** | `astronomy-engine` (VSOP87 + ELP/MPP02) | $\sim 1\text{–}3''$ in 2028 ($\pm 1'$ multi-century bound) | $\pm 1\text{–}3\text{ s}$ on contact times; $< 0.001^\circ$ on altitude |
| **$\Delta T$ extrapolation** | Espenak & Meeus (2006) polynomial ($\approx 72.7\text{ s}$) | $\delta(\Delta T) \approx 2\text{–}3\text{ s}$ | $\approx 0.7\text{–}1.0\text{ km}$ longitudinal shift of umbral track |
| **Lunar limb profile** | Smooth sphere ($R_\mathbb{C} = 1737.4\text{ km}$), no Kaguya/LRO limb | $\approx 0.8''$ mean-to-valley radius + $\pm 1.5''$ topography | $\pm 1\text{–}3\text{ s}$ on C2/C3 near centreline; larger near grazing edge |
| **Solar refraction** | Bennett (1982) (`Refraction.Normal`, $1010\text{ hPa}, 10^\circ\text{C}$) | $+6.4'$ ($+0.107^\circ$) at $8.3^\circ$ altitude | Unified across both code paths; meteorological scatter $\sim \pm 0.5'$ |
| **Terrestrial refraction** | Effective Earth radius $R_{\text{eff}} = R_\oplus / (1 - k)$, $k = 0.13$ | $+0.35'$ at $10\text{ km}$, $+1.6'$ at $45\text{ km}$ | Unified across both code paths; basin anomalies cancel with solar ray below ridge |
| **Solar disc semi-diameter** | Sightline clearance measured to solar centre ($s_\odot \approx 0.26^\circ$) | $0.26^\circ$ photospheric limb ($0.5^\circ$ with inner corona) | Clearances in $(0^\circ, 0.26^\circ)$ flagged as lower-limb grazing |
| **Near-field DEM error** | Copernicus GLO-30 / Mapterhorn ($\sim 30\text{ m}$ horizontal, $\sigma_z \approx 5\text{ m}$) | $\pm 2.9^\circ$ at $100\text{ m}$; $\pm 0.3^\circ$ at $1\text{ km}$ | Dominant uncertainty for ridges closer than $\sim 1\text{ km}$ |
| **Above-ground clutter** | 30 m DSM smooths individual trees, buildings, and road cuts | A $15\text{ m}$ shelterbelt at $90\text{ m}$ subtends $9.5^\circ$ | Unmodelled; users are advised to inspect near-field obstructions on site |
| **Height datum** | WGS84 ellipsoidal height passed as orthometric ($N \approx 5\text{–}35\text{ m}$) | $< 0.04\text{ s}$ on contacts; cancels in relative terrain height | Negligible |
| **Grid interpolation** | `EclipseField` evaluated on $0.1^\circ$ grid at $h = 0\text{ m}$ | $< 0.01^\circ$ interpolation error; $1\text{–}2\text{ s}$ at $2000\text{ m}$ peaks | Hard 4-corner boundary prevents false-positive edge totality |

---

## 11. Code Reference

| Symbol | File | Purpose |
|---|---|---|
| `bodyAltAz`, `sunAltAz` | [`index.html`](index.html) | Topocentric $(\alpha, \delta) \to$ refracted $(\text{alt}, \text{az})$, apparent semi-diameter, sky unit vector |
| `eclipseAt` | [`index.html`](index.html) | Continuous magnitude, exact circle-overlap obscuration, and internal-tangency `isTotal` |
| `localCircumstances` | [`index.html`](index.html) | Per-observer C1, C2, max, C3, C4 via `SearchLocalSolarEclipse`, cached by coordinate |
| `timeAtObscuration` | [`index.html`](index.html) | 22-step bisection between C1 and peak for the $50\%$ arrival framing |
| `runSightlineCheck` | [`index.html`](index.html) | Adaptive $3\%$ ENU ray-march ($100\text{ m}\text{–}45\text{ km}$), $R_{\text{eff}}$ curvature reduction, grazing-limb check |
| `EclipseField` | [`precompute/build_viewpoints.py`](precompute/build_viewpoints.py) | $0.1^\circ$ circumstance grid, 4-corner totality mask, bilinear interpolation |
| `great_circle_step`, `horizon_angles` | [`precompute/build_viewpoints.py`](precompute/build_viewpoints.py) | Vectorised spherical geodesic ray-march and horizon reduction |
| `ray_horizon`, `preset_rows` | [`precompute/build_viewpoints.py`](precompute/build_viewpoints.py) | Dual-resolution ($z=13$ near / $z=11$ far) $1^\circ$ azimuth horizon profiles for town presets |
