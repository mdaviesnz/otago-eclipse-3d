# Deployment plan — Cloudflare Workers

Target: publish `index.html`, `map.html`, `app.css`, `viewpoints.json`, `social-card.svg` and
`_headers` as a Cloudflare Workers static-asset site, with automated checks gating every deploy
and a preview URL per pull request.

---

## Why Workers and not Pages

The site ran on Pages until 2026-08-13. Moving it changed nothing about how the site is served:
static asset requests are free and unmetered on both products, the payload is ~385 KB, and
`_headers` is supported either way. Serving cost and speed were never the reason.

The reason is that everything still parked in [IDEAS.md](IDEAS.md) — caching Photon searches, a
contact form, telemetry beyond page views — is server-side code. On Pages that means Pages
Functions, which bill as Worker requests anyway and are the path Cloudflare has stopped
investing in. Migrating *before* the first function exists is a config change; migrating after
would mean porting working code as well.

`wrangler.jsonc` declares no `main`, so there is no Worker script yet — just an asset directory.

## Why Wrangler and not the Git integration

Cloudflare can also build from the repo directly (Workers Builds). It is not equivalent here.

| | Workers Builds | **GitHub Actions → Wrangler** (chosen) |
|---|---|---|
| Setup | Connect repo in the dashboard, done | Two secrets + a workflow file |
| Build | Cloudflare pulls and deploys on push | Actions assembles `dist/` and uploads |
| **Do tests gate the deploy?** | **No** — it deploys regardless of check status | **Yes** — `deploy` needs `check` and `test` |
| What gets uploaded | Whole repo unless configured | Exactly the six site files |
| Preview per PR | Yes | Yes (`versions upload`) |

The gating matters here more than it would for a typical static site. This app ships a
**generated data file**: `viewpoints.json` is the output of a 3½-hour pipeline, and a bad
rebuild is invisible by eye — the site still loads, the map still draws, the numbers are just
wrong. A regression like the OSM coverage gap we hit (a whole bbox silently missing) would sail
straight through the Git integration. `tests/check_static.py` fails the build on exactly that.

The second reason is narrower but real: the Git integration would upload `precompute/` and
`tests/` too. Assembling `dist/` keeps the public surface to what is meant to be public.

---

## One-time setup

### 1. Create the GitHub repo and push

```bash
git remote add origin https://github.com/<you>/otago-eclipse-3d.git
git push -u origin main
```

Identity is already set per-repo (`michael@davies.net.nz`), so commits will not carry your work
address.

### 2. Create an API token

Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** → template
**"Edit Cloudflare Workers"**, or a custom token with:

- Permissions: **Account → Workers Scripts → Edit**
- Account resources: your account only

Scope it to nothing more than that. It is a deploy key, not an admin key.

**If you are migrating from the Pages setup:** a token created with only
**Account → Cloudflare Pages → Edit** will authenticate and then fail at upload. Either
recreate it from the "Edit Cloudflare Workers" template or add Workers Scripts → Edit to the
existing one. The preflight step catches this before wrangler runs.

There is no separate "create the project" step. Unlike Pages, `wrangler deploy` creates the
Worker on first run, so the `Project not found [code: 8000007]` failure mode is gone.

**Do not connect the Worker to GitHub.** If the Worker is created through the dashboard's
"import a repository" flow, Cloudflare enables **Workers Builds** and starts deploying on every
push by itself. That is two competing deploy paths, and the Cloudflare one ships without running
the tests — the exact failure this project's deploy design exists to prevent. It also fails
immediately, because `dist/` is gitignored and assembled by the workflow rather than committed:

```
✘ [ERROR] The directory specified by the "assets.directory" field in your configuration
  file does not exist:  /opt/buildhome/repo/dist
```

That error is the *symptom*; the fix is not to make the Cloudflare build work but to turn it
off — Worker → **Settings** → **Build** → disconnect the repository. The Worker survives; only
the automatic builds stop.

### 3. Add repository secrets

GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository
secret**:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard sidebar, or the URL after `/accounts/` |

### 4. Enable Workers Analytics Engine (one-time per account)

Cloudflare requires a one-time click in the dashboard before any Worker on the account can bind an
`analytics_engine_datasets` dataset:

1. In the Cloudflare dashboard sidebar, go to **Compute (Workers) → Analytics Engine** (or open
   `https://dash.cloudflare.com/?to=/:account/workers/analytics-engine`).
2. Click **Enable Analytics Engine** (free tier includes 100,000 writes/day and 10,000 queries/day).

Once enabled on the account, individual datasets (like `otago_eclipse_usage`) are created
automatically on first write.

### 5. Merge to `main` once before opening a PR

`versions upload` — how PR previews are built — needs the Worker to already exist. The first
run must therefore be a production deploy from `main`. A PR raised before that will fail its
deploy step with a "script not found" error; the checks still run and report normally.

---

## Troubleshooting the deploy job

The `deploy` job fails until the setup steps above are complete — that is expected on the first
push, and the test jobs still run and report normally.

A preflight step checks both secrets are present and that the token can actually manage Workers,
so neither a missing secret nor a Pages-scoped token surfaces as an opaque wrangler error.

| Symptom | Cause |
|---|---|
| `Missing repository secret(s)` | Steps 2–3 not done |
| `Cloudflare rejected the API token for Workers` | Token lacks **Account → Workers Scripts → Edit** (common right after the Pages migration), or belongs to a different account than `CLOUDFLARE_ACCOUNT_ID` |
| `You need to enable Analytics Engine [code: 10089]` | Analytics Engine has not been toggled on for this Cloudflare account yet — see step 4 |
| `workers.script.not_found` on a PR | No production deploy has happened yet — see step 5 |
| `assets.directory ... does not exist: /opt/buildhome/repo/dist` | Not this workflow — Workers Builds is deploying from the repo. Disconnect it; see step 2 |
| Deploy skipped entirely | PR from a fork — forks cannot read secrets, by design |

Reading logs needs repo admin rights, so if you want someone else to diagnose a failure, either
paste the failing step's output or give them access.

## What runs on every push

```
push / PR ──┬── check   (Python, stdlib only, ~5 s)
            └── test    (Playwright + Chromium, ~1 min)
                          │
                          └── deploy  (only if both pass)
```

### `check` — `tests/check_static.py`

Aimed at failure modes this project has actually hit, not generic linting:

- **No JWT or credential** in any shipped file. A Cesium ion token was hardcoded in
  `index.html` and would have gone public; this fails the build if that recurs.
- **`osmGaps` is empty.** A rebuild with a throttled Overpass cell silently loses road coverage
  for a whole region. This is the single highest-value check here.
- **Catalogue integrity** — required fields present, every point inside the declared region,
  totality durations plausible, and walk-in spots still present (a ranking change once made
  every grid spot sealed-road, which quietly emptied the walking filter).
- **`precompute/cache/` is not tracked** — ~1,750 files and ~400 MB.
- **Local asset references resolve**, so a renamed file cannot 404 in production.
- **The Web Analytics beacon is on both pages, with the same site token.** Since the beacon
  lives in the markup rather than a dashboard toggle, an edit can drop it, and a dropped beacon
  is invisible — the site works and simply stops reporting.

### `test` — `tests/smoke.spec.mjs`

Deliberately scoped to what is *reliable* in CI rather than what is most impressive. The 3D
globe needs a GPU context that headless runners emulate inconsistently, so it is checked for
load-time JS errors and control wiring rather than rendered pixels. What is tested properly:

- **Astronomy** — asserts astronomy-engine still reproduces the published Dunedin contact times
  (totality 16:15:45–16:18:36, maximum 16:17:11, sun 8–8.8°). This is the app's core claim to
  correctness and needs no WebGL.
- **Overview map** — loads, plots markers, exclusive access filters genuinely change the set,
  and popups link back into the 3D view.
- **Catalogue over HTTP** — served, parses, no gaps, walk-in spots present.
- **No ion token** in the served HTML.

### `deploy`

Assembles `dist/` from the six site files and uploads it. On `main` that is `wrangler deploy`,
which goes live. On a pull request it is `wrangler versions upload`, which creates a version
with its own preview URL and takes no production traffic — the URL is written to the job
summary, since Workers does not surface it automatically the way Pages did. Versions are never
promoted; merging to `main` redeploys from scratch. Deploys from forked PRs are skipped, since
they cannot read secrets.

---

## Running the checks locally

```bash
python tests/check_static.py     # no dependencies
npm install && npx playwright install --with-deps chromium
npx playwright test              # starts its own static server on :8788
```

`package.json` and `playwright.config.mjs` are **dev-only**. The deployed site still has no
build step — `dist/` is a plain copy.

---

## Updating the catalogue

`viewpoints.json` is regenerated, not hand-edited:

```bash
cd precompute && python build_viewpoints.py     # ~4 min warm, ~3½ h cold
python verify_output.py                          # sanity-check the output
cd .. && python tests/check_static.py            # the CI gate, run locally
git add viewpoints.json && git commit -m "Rebuild viewpoint catalogue"
git push
```

`_headers` keeps `viewpoints.json` on a 5-minute revalidating cache, so a rebuild reaches users
without renaming the file.

---

## Custom domain (optional)

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**, e.g.
`eclipse.davies.net.nz`. If the domain is already on Cloudflare, DNS is created automatically;
otherwise add the CNAME it shows you. TLS is provisioned automatically.

Migrating a domain that was already on the Pages project means **removing it there first** — a
hostname cannot point at both. That is a brief outage, so do it once the Worker is confirmed
working on its `workers.dev` URL.

---

## Web Analytics

Cloudflare Web Analytics is enabled for this site, and the way it was enabled does **not**
survive the migration cleanly. On Pages the beacon is injected by a per-project dashboard
toggle; a Worker has no such toggle. Automatic injection only continues to work if it was set up
against a custom hostname proxied through Cloudflare, in which case it is keyed to the hostname
rather than to the Pages project and keeps working once that hostname points at the Worker.

Rather than depend on knowing which of those applies, the beacon is inlined at the end of
`index.html` and `map.html`:

```html
<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js"
        data-cf-beacon='{"token": "…"}'></script>
```

The site token is public by design — it identifies the site, it does not authorise anything.
Taking the manual route means analytics is version-controlled and survives any future hosting
change. Two things follow from it:

- `check_static.py` asserts the beacon is on both pages and that both carry the *same* token.
  A dropped beacon is otherwise invisible: the site keeps working and simply stops reporting.
- `smoke.spec.mjs` aborts requests to `beacon.min.js`, so CI runs and local test runs do not
  report themselves as visits.

If Web Analytics was ever also set up automatically against the custom hostname, turn that
off — otherwise the beacon loads twice and every visit is counted twice.

---

## Anonymous Usage Metrics (`src/worker.js` + Analytics Engine)

Beyond basic page views, the app tracks coarse, privacy-preserving interaction counts via
`POST /api/metric` backed by **Cloudflare Workers Analytics Engine** (dataset:
`otago_eclipse_usage`, bound as `env.METRICS` in `wrangler.jsonc`).

### Keeping static assets free (`run_worker_first`)

`wrangler.jsonc` sets `"run_worker_first": ["/api/*"]` under `assets`. Static files (`index.html`,
`map.html`, `app.css`, `viewpoints.json`, icons) continue to be served directly from Cloudflare's
asset edge **without invoking `src/worker.js`**, so static asset traffic remains free and
unmetered. Only `/api/*` requests invoke the Worker.

### Privacy by construction

`src/worker.js` enforces strict rules on every field written to `otago_eclipse_usage`:
- **`blob1` (`event`) & `blob2` (`detail`)**: Validated against `ALLOWED_METRICS`. Any unrecognised
  `detail` is stripped to `""`.
- **`blob3` (`spot`)**: Only recorded for public catalogued places (`preset_select`,
  `catalogue_select`, and `map_filter` with `open_3d`). On `custom_search`, `map_pin`, and
  `geolocation_use`, `spot` is unconditionally forced to `""` so private addresses or user
  coordinates can never be stored.
- **`blob4` (`sid`)**: An ephemeral 8-character hex token stored in `sessionStorage` (`eclipseMetricSid`).
  It lives only in the current browser tab, is wiped as soon as the tab closes, uses no cookies or
  IP addresses, and lets you measure how many spots a visitor explores in a single session.

### Querying usage in Cloudflare

Analytics Engine datasets can be queried via the Cloudflare SQL API
(`https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql`) or dashboard:

```sql
-- 1. Event breakdown over the last 7 days
SELECT
  blob1 AS event,
  blob2 AS detail,
  COUNT(DISTINCT blob4) AS unique_sessions,
  SUM(_sample_interval) AS total_events
FROM otago_eclipse_usage
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY event, detail
ORDER BY total_events DESC;

-- 2. Most popular presets and catalogued POIs
SELECT
  blob1 AS source_event,
  blob3 AS spot,
  COUNT(DISTINCT blob4) AS unique_sessions,
  SUM(_sample_interval) AS clicks
FROM otago_eclipse_usage
WHERE blob1 IN ('preset_select', 'catalogue_select') AND blob3 != ''
GROUP BY source_event, spot
ORDER BY clicks DESC
LIMIT 25;

-- 3. How many locations each session explores
SELECT
  blob4 AS session_id,
  SUM(_sample_interval) AS locations_checked
FROM otago_eclipse_usage
WHERE blob1 IN ('preset_select', 'catalogue_select', 'custom_search', 'map_pin', 'geolocation_use')
  AND blob4 != ''
GROUP BY session_id
ORDER BY locations_checked DESC;
```

---

## After launch — worth watching

- **Photon** (address search) is free with fair-use terms. If search stops responding under
  traffic, that is the likely cause; a self-hosted Photon or a paid geocoder is the fallback.
- **Re:Earth Terrain** is explicitly best-effort with no SLA. It is the hard dependency for the
  3D view; there is no automatic fallback if it goes down.
- **Esri imagery** uses a keyless endpoint that can throttle.
- **Tailwind is prebuilt** into `app.css` (~15 KB) and committed. CI rebuilds it and fails if
  it has drifted from the markup, so a class added to the HTML cannot silently ship without its
  styles. Rebuild locally with `npm run build:css`.

None of these have an SLA, which is acceptable for an educational site but worth knowing before
it is linked from anywhere with real traffic.
