# Deployment plan — Cloudflare Pages

Target: publish `index.html`, `map.html`, `app.css`, `viewpoints.json`, `social-card.svg` and
`_headers` to Cloudflare Pages, with automated checks gating every deploy and a preview URL per
pull request.

---

## Why Wrangler and not the Git integration

Cloudflare Pages offers two routes. They are not equivalent for this project.

| | Pages Git integration | **GitHub Actions → Wrangler** (chosen) |
|---|---|---|
| Setup | Connect repo in the dashboard, done | Two secrets + a workflow file |
| Build | Cloudflare pulls and deploys on push | Actions assembles `dist/` and uploads |
| **Do tests gate the deploy?** | **No** — it deploys regardless of check status | **Yes** — `deploy` needs `check` and `test` |
| What gets uploaded | Whole repo unless configured | Exactly the five site files |
| Preview per PR | Yes | Yes (`--branch`) |

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

### 2. Create the Pages project

The project must exist before the first deploy — Wrangler will not create it. Either use the
dashboard (**Workers & Pages** → **Create** → **Pages** → **Use direct upload**) or run:

```bash
npx wrangler pages project create otago-eclipse-3d --production-branch=main
```

The name must match `--project-name` in the workflow exactly. If it does not exist the deploy
fails with `Project not found [code: 8000007]`; the preflight step now detects this and prints
the command above.

Do *not* connect the project to GitHub — the Action pushes to it directly. Connecting both
causes two competing deploy paths.

### 3. Create an API token

Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** → template
**"Edit Cloudflare Workers"**, or a custom token with:

- Permissions: **Account → Cloudflare Pages → Edit**
- Account resources: your account only

Scope it to nothing more than that. It is a deploy key, not an admin key.

### 4. Add repository secrets

GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository
secret**:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard sidebar, or the URL after `/accounts/` |

### 5. Set the production branch

In the Pages project → **Settings** → **Builds & deployments** → production branch = `main`.
Any other branch deploys as a preview.

---

## Troubleshooting the deploy job

The `deploy` job fails until the four setup steps above are complete — that is expected on the
first push, and the test jobs still run and report normally.

A preflight step checks both secrets are present and prints the setup instructions if not, so
a missing secret does not surface as an opaque wrangler authentication error.

| Symptom | Cause |
|---|---|
| `Missing repository secret(s)` | Steps 3–4 not done |
| `Project not found` / `8000007` | Pages project missing, or its name is not `otago-eclipse-3d` |
| `Authentication error` / `10000` | Token lacks **Account → Cloudflare Pages → Edit**, or belongs to a different account than `CLOUDFLARE_ACCOUNT_ID` |
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

Assembles `dist/` from the five site files and uploads with `wrangler pages deploy`. Pull
requests deploy to a preview URL under the branch name; `main` deploys to production. Deploys
from forked PRs are skipped, since they cannot read secrets.

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

Pages project → **Custom domains** → add e.g. `eclipse.davies.net.nz`. If the domain is already
on Cloudflare, DNS is created automatically; otherwise add the CNAME it shows you. TLS is
provisioned automatically.

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
