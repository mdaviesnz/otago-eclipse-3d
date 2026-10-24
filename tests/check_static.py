#!/usr/bin/env python3
"""Pre-deploy checks. No dependencies beyond the standard library.

These are deliberately aimed at the failure modes this project has actually hit, rather than
generic linting:

  * a Cesium ion token committed into a public file (happened, caught before launch)
  * a catalogue rebuilt with missing OSM coverage (happened, caught by osmGaps)
  * the 400 MB precompute cache getting committed (nearly happened)
  * a page referencing an asset that was renamed or never committed

Exit code 0 = safe to deploy.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
SITE_FILES = ["index.html", "map.html", "astronomy.html", "methods.html", "app.css",
              "viewpoints.json", "social-card.svg", "icon.svg", "manifest.webmanifest",
              "sw.js", "_headers"]

failures: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def ok(msg: str) -> None:
    notes.append(msg)


# ---------------------------------------------------------------------------------------
def check_required_files() -> None:
    for name in SITE_FILES:
        if not (ROOT / name).exists():
            fail(f"missing required file: {name}")
    if not failures:
        ok(f"all {len(SITE_FILES)} site files present")


def check_no_secrets() -> None:
    """No JWTs (Cesium ion tokens are JWTs) or obvious API keys in anything we ship."""
    jwt = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+")
    suspicious = re.compile(r"(api[_-]?key|secret|password)\s*[=:]\s*['\"][^'\"]{12,}", re.I)
    hits = 0
    for name in [*SITE_FILES, "src/worker.js"]:
        p = ROOT / name
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for m in jwt.findall(text):
            fail(f"{name}: looks like a JWT/ion token committed ({m[:24]}…)")
            hits += 1
        for m in suspicious.findall(text):
            fail(f"{name}: possible hardcoded credential ({m})")
            hits += 1
    if not hits:
        ok("no tokens or credentials in deployable files")


def check_analytics_beacon() -> None:
    """Web Analytics and Worker usage metrics live in the markup, so an edit can lose them.

    Cloudflare Pages injected the beacon from a per-project dashboard toggle; Workers has no
    equivalent, so it is inlined in all HTML pages instead. A dropped beacon is invisible — the
    site works perfectly and merely stops reporting — which is exactly the kind of silent
    regression this file exists to catch.
    """
    pattern = re.compile(r'data-cf-beacon=[\'"]\{"token":\s*"([0-9a-f]{32})"\}')
    pages = ("index.html", "map.html", "astronomy.html", "methods.html")
    tokens = set()
    bad = False
    for name in pages:
        text = (ROOT / name).read_text(encoding="utf-8", errors="replace")
        if "static.cloudflareinsights.com/beacon.min.js" not in text:
            fail(f"{name}: Cloudflare Web Analytics beacon is missing")
            bad = True
        elif m := pattern.search(text):
            tokens.add(m.group(1))
        else:
            fail(f"{name}: analytics beacon present but carries no valid 32-hex site token")
            bad = True
        if "/api/metric" not in text:
            fail(f"{name}: Worker usage metric endpoint (/api/metric) is missing")
            bad = True
    if len(tokens) > 1:
        fail(f"HTML pages report to different analytics sites: {sorted(tokens)}")
    elif not bad:
        ok(f"analytics beacon and /api/metric present on all {len(pages)} pages")


def check_worker_metrics() -> None:
    """Verify Worker entry point, narrow /api/* routing, and Analytics Engine binding."""
    wp = ROOT / "wrangler.jsonc"
    sp = ROOT / "src" / "worker.js"
    if not wp.exists():
        fail("missing wrangler.jsonc")
        return
    if not sp.exists():
        fail("missing src/worker.js")
        return

    w_text = wp.read_text(encoding="utf-8")
    # Strip // comments from JSONC to parse cleanly
    clean_json = re.sub(r"^\s*//.*$", "", w_text, flags=re.M)
    try:
        cfg = json.loads(clean_json)
    except json.JSONDecodeError as ex:
        fail(f"wrangler.jsonc is not valid JSONC: {ex}")
        return

    if cfg.get("main") != "src/worker.js":
        fail("wrangler.jsonc: 'main' must point to 'src/worker.js'")
    assets = cfg.get("assets") or {}
    if assets.get("run_worker_first") != ["/api/*"]:
        fail("wrangler.jsonc: 'assets.run_worker_first' must be ['/api/*'] so static assets stay free")
    datasets = cfg.get("analytics_engine_datasets") or []
    if not any(d.get("binding") == "METRICS" and d.get("dataset") for d in datasets):
        fail("wrangler.jsonc: missing analytics_engine_datasets binding 'METRICS'")

    s_text = sp.read_text(encoding="utf-8")
    if "ALLOWED_METRICS" not in s_text or "writeDataPoint" not in s_text:
        fail("src/worker.js: missing ALLOWED_METRICS allowlist or writeDataPoint call")
    else:
        ok("Worker metrics route (/api/metric) and Analytics Engine binding configured")


def check_cache_not_tracked() -> None:
    try:
        out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True,
                             text=True, check=True).stdout.splitlines()
    except Exception as ex:                      # not a git checkout (e.g. tarball) — skip
        ok(f"skipped git checks ({ex.__class__.__name__})")
        return
    cached = [f for f in out if "precompute/cache/" in f]
    if cached:
        fail(f"{len(cached)} precompute/cache files are tracked by git — must be ignored")
    else:
        ok(f"{len(out)} files tracked, none from precompute/cache")


def check_local_references() -> None:
    """Every same-origin href/src/fetch target in the HTML must exist and be in SITE_FILES."""
    pattern = re.compile(r"""(?:href|src)=["']([^"'#?]+)["']|fetch\(["']([^"'?]+)["']""")
    site_set = set(SITE_FILES)
    for name in ("index.html", "map.html", "astronomy.html", "methods.html"):
        p = ROOT / name
        if not p.exists():
            continue
        for a, b in pattern.findall(p.read_text(encoding="utf-8", errors="replace")):
            ref = a or b
            if not ref or ref.startswith(("http://", "https://", "data:", "//", "mailto:", "/api/")):
                continue
            # Skip JS template literals — these pages build markup with `${...}` inside
            # href attributes, which is not a real file reference.
            if "${" in ref or "{{" in ref:
                continue
            target = (ROOT / ref.lstrip("./")).resolve()
            if not target.exists():
                fail(f"{name}: references missing local file '{ref}'")
                continue
            try:
                rel = target.relative_to(ROOT).as_posix()
            except ValueError:
                fail(f"{name}: references file outside repo root '{ref}'")
                continue
            if rel not in site_set:
                fail(f"{name}: references '{rel}', which exists on disk but is missing from SITE_FILES")
    ok("local asset references resolve and are included in SITE_FILES")


def check_catalogue() -> None:
    p = ROOT / "viewpoints.json"
    if not p.exists():
        return
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as ex:
        fail(f"viewpoints.json is not valid JSON: {ex}")
        return

    gaps = d.get("osmGaps")
    if gaps:
        fail(f"viewpoints.json has {len(gaps)} unfetched OSM bbox(es) — coverage is incomplete: {gaps}")
    else:
        ok("catalogue has no OSM coverage gaps")

    required = {"lat", "lon", "elev", "sunAlt", "clearance", "totality", "access",
                "wholeTotality"}
    region = d.get("region") or {}
    for key in ("spots", "pois"):
        rows = d.get(key) or []
        if not rows:
            fail(f"viewpoints.json: '{key}' is empty")
            continue
        missing = [i for i, r in enumerate(rows) if not required.issubset(r)]
        if missing:
            fail(f"viewpoints.json: {len(missing)} '{key}' entries missing required fields")
        if region:
            outside = [
                r for r in rows
                if not (region["lat_min"] <= r["lat"] <= region["lat_max"]
                        and region["lon_min"] <= r["lon"] <= region["lon_max"])
            ]
            if outside:
                fail(f"viewpoints.json: {len(outside)} '{key}' entries fall outside the declared region")
        bad = [r for r in rows if not (0 < r.get("totality", 0) <= 400)]
        if bad:
            fail(f"viewpoints.json: {len(bad)} '{key}' entries have implausible totality duration")
        ok(f"catalogue '{key}': {len(rows)} entries, fields and bounds OK")

    if not any(r.get("access") == "foot" for r in (d.get("spots") or [])):
        fail("viewpoints.json: no walk-in spots in 'spots' — the tier quota may have regressed")

    check_presets(d, region)


def check_presets(d: dict, region: dict) -> None:
    """The app's "Fly to" buttons are answered from viewpoints.json rather than by probing
    terrain, and it matches them by position. If the two coordinate lists drift apart the app
    does not break — it silently falls back to a live probe on the busiest control on the page,
    which is exactly the sort of quiet regression this file exists to catch."""
    presets = d.get("presets")
    if not presets:
        fail("viewpoints.json: 'presets' is missing or empty — the Fly to buttons will probe "
             "terrain on every click. Rebuild with precompute/build_viewpoints.py.")
        return

    # Presets are deliberately unfiltered, so no clearance assertion here: a blocked town is a
    # legitimate row. Everything the app reads must still be present.
    required = {"name", "lat", "lon", "elev", "sunAlt", "sunAz", "horizon", "clearance",
                "clearBegin", "clearEnd", "wholeTotality", "totality"}
    missing = [p.get("name", "?") for p in presets if not required.issubset(p)]
    if missing:
        fail(f"viewpoints.json: presets missing required fields: {missing}")
    if region:
        outside = [p["name"] for p in presets
                   if not (region["lat_min"] <= p["lat"] <= region["lat_max"]
                           and region["lon_min"] <= p["lon"] <= region["lon_max"])]
        if outside:
            fail(f"viewpoints.json: presets outside the declared region: {outside}")
    bad = [p["name"] for p in presets if not (0 < p.get("totality", 0) <= 400)]
    if bad:
        fail(f"viewpoints.json: presets with implausible totality duration: {bad}")

    # The horizon profile is what lets a preset render the full sightline card without touching
    # the network. Without it the app silently drops back to the totality-only verdict, so the
    # three parallel arrays must be present and the same length, and must span every bearing
    # the app can ask for: the sun's own azimuth range plus HORIZON_SPAN/2 = 10 deg either side.
    for p in presets:
        pr = p.get("profile") or {}
        arrays = [pr.get(k) for k in ("angles", "ridgeDist", "ridgeElev")]
        if not all(isinstance(a, list) and a for a in arrays):
            fail(f"preset '{p['name']}' has no usable horizon profile — the app will fall back "
                 f"to a totality-only verdict")
            continue
        if len({len(a) for a in arrays}) != 1:
            fail(f"preset '{p['name']}' profile arrays differ in length: "
                 f"{[len(a) for a in arrays]}")
            continue
        step = pr.get("azStep") or 0
        if step <= 0:
            fail(f"preset '{p['name']}' profile has a non-positive azStep")
            continue
        lo = pr["azFrom"]
        hi = lo + (len(pr["angles"]) - 1) * step
        # sunAz is the bearing at maximum; the sun wanders either side of it across the eclipse.
        if not (lo <= p["sunAz"] - 20 and p["sunAz"] + 20 <= hi):
            fail(f"preset '{p['name']}' profile spans {lo}..{hi} deg, too narrow around "
                 f"sunAz {p['sunAz']} — the app would extrapolate")
        if max(pr["angles"]) > 60 or min(pr["angles"]) < -90:
            fail(f"preset '{p['name']}' profile has implausible terrain angles "
                 f"({min(pr['angles'])}..{max(pr['angles'])} deg)")

    # The app's own list, parsed straight out of the markup it ships with.
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    block = re.search(r"const LOCATIONS = \[(.*?)\];", html, re.S)
    if not block:
        fail("index.html: could not find the LOCATIONS array to cross-check presets against")
        return
    app = {
        m.group("name"): (float(m.group("lat")), float(m.group("lon")))
        for m in re.finditer(
            r'\{\s*name:\s*"(?P<name>[^"]+)",\s*lon:\s*(?P<lon>-?[\d.]+),'
            r'\s*lat:\s*(?P<lat>-?[\d.]+)', block.group(1))
    }
    if not app:
        fail("index.html: LOCATIONS found but no entries parsed — the format has changed")
        return

    built = {p["name"]: (p["lat"], p["lon"]) for p in presets}
    if set(app) != set(built):
        fail(f"preset names differ — index.html has {sorted(app)}, "
             f"viewpoints.json has {sorted(built)}")
        return
    # 1e-5 is the rounding the catalogue writes at; anything larger is real drift.
    drifted = [n for n in app
               if abs(app[n][0] - built[n][0]) > 1e-5 or abs(app[n][1] - built[n][1]) > 1e-5]
    if drifted:
        fail(f"preset coordinates differ between index.html and viewpoints.json: {drifted} — "
             f"the app will fall back to a live terrain probe for these")
    else:
        ok(f"presets: {len(presets)} entries, fields OK, coordinates match index.html")


def check_pwa_and_headers() -> None:
    """Ensure manifest.webmanifest, sw.js, and _headers stay in sync with SITE_FILES."""
    site_set = set(SITE_FILES)
    html_pages = [f for f in SITE_FILES if f.endswith(".html")]

    # 1. manifest.webmanifest
    mp = ROOT / "manifest.webmanifest"
    if mp.exists():
        try:
            manifest = json.loads(mp.read_text(encoding="utf-8"))
            refs: list[str] = []
            if "start_url" in manifest:
                refs.append(manifest["start_url"])
            for icon in manifest.get("icons") or []:
                if "src" in icon:
                    refs.append(icon["src"])
            for sc in manifest.get("shortcuts") or []:
                if "url" in sc:
                    refs.append(sc["url"])
                for icon in sc.get("icons") or []:
                    if "src" in icon:
                        refs.append(icon["src"])
            bad_m = [r for r in refs if r.lstrip("./") not in site_set]
            if bad_m:
                fail(f"manifest.webmanifest references file(s) not in SITE_FILES: {bad_m}")
            else:
                ok(f"manifest.webmanifest: all {len(refs)} asset/shortcut references in SITE_FILES")
        except json.JSONDecodeError as ex:
            fail(f"manifest.webmanifest is not valid JSON: {ex}")

    # 2. sw.js PRECACHE_SHELL and canonicalHtmlPath
    swp = ROOT / "sw.js"
    if swp.exists():
        sw_text = swp.read_text(encoding="utf-8")
        m = re.search(r"const\s+PRECACHE_SHELL\s*=\s*\[(.*?)\];", sw_text, re.S)
        if not m:
            fail("sw.js: could not find PRECACHE_SHELL array")
        else:
            entries = re.findall(r'["\']([^"\']+)["\']', m.group(1))
            normalized = {e.lstrip("./") for e in entries if e != "./"}
            missing_in_site = sorted(normalized - site_set)
            missing_html = [h for h in html_pages if h not in normalized]
            if missing_in_site:
                fail(f"sw.js PRECACHE_SHELL lists file(s) not in SITE_FILES: {missing_in_site}")
            elif missing_html:
                fail(f"sw.js PRECACHE_SHELL is missing HTML page(s): {missing_html}")
            else:
                ok(f"sw.js PRECACHE_SHELL covers all {len(html_pages)} HTML pages and matches SITE_FILES")
        for h in html_pages:
            if h not in sw_text:
                fail(f"sw.js does not reference '{h}' in canonicalHtmlPath")

    # 3. _headers clean-URL rules and sw.js no-cache rule
    hp = ROOT / "_headers"
    if hp.exists():
        h_text = hp.read_text(encoding="utf-8")
        rule_paths = {
            line.strip()
            for line in h_text.splitlines()
            if line and not line[0].isspace() and not line.lstrip().startswith("#")
        }
        for h in html_pages:
            clean = "/" if h == "index.html" else "/" + h.removesuffix(".html")
            if clean not in rule_paths:
                fail(f"_headers: missing Cache-Control rule for clean URL '{clean}' ({h})")
        if "/sw.js" not in rule_paths or not re.search(r"^/sw\.js\s*\n\s+Cache-Control:.*max-age=0", h_text, re.M):
            fail("_headers: '/sw.js' must have a Cache-Control rule with max-age=0")
        else:
            ok("_headers covers all clean HTML routes and sets max-age=0 on /sw.js")


def main() -> int:
    check_required_files()
    check_no_secrets()
    check_analytics_beacon()
    check_worker_metrics()
    check_cache_not_tracked()
    check_local_references()
    check_catalogue()
    check_pwa_and_headers()

    for n in notes:
        print(f"  ok   {n}")
    for f in failures:
        print(f"  FAIL {f}")
    print()
    if failures:
        print(f"{len(failures)} check(s) failed — not safe to deploy")
        return 1
    print(f"all checks passed ({len(notes)} ok)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
