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
sys.path.insert(0, str(ROOT / "precompute"))
import verdict  # noqa: E402  (precompute/verdict.py: standard library only)

SITE_FILES = ["index.html", "map.html", "astronomy.html", "methods.html", "app.css",
              "viewpoints.json", "verdict.js", "catalogue.js", "places.js", "contours.js", "skyline.js",
              "eclipse-time.js", "eclipse-path.js",
              "simulator.js", "map.js",
              "social-card.svg", "icon.svg", "manifest.webmanifest", "sw.js", "_headers",
              "font-piazzolla-latin.woff2", "font-piazzolla-latin-ext.woff2",
              "font-overpass-latin.woff2", "font-overpass-latin-ext.woff2",
              "font-licenses.txt"]

# The two app pages keep their code in a companion script.
PAGE_SCRIPTS = {"index.html": "simulator.js", "map.html": "map.js"}

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
        if not p.exists() or name.endswith(".woff2"):
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
        companion = ROOT / PAGE_SCRIPTS[name] if name in PAGE_SCRIPTS else None
        code = companion.read_text(encoding="utf-8", errors="replace") if companion else text
        if "/api/metric" not in code:
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
    """Every same-origin href/src/fetch/import target in the HTML must exist and be in SITE_FILES."""
    pattern = re.compile(r"""(?:href|src)=["']([^"'#?]+)["']|(?:fetch\(|import\s[^;"']*?from\s+)["']([^"'?]+)["']""")
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
    # Fonts are referenced from the built stylesheet, which the HTML scan above cannot see.
    for ref in re.findall(r"url\(([^)\"']+)\)", (ROOT / "app.css").read_text(encoding="utf-8")):
        if ref.startswith(("http", "data:", "#")):
            continue
        if not (ROOT / ref).exists():
            fail(f"app.css: references missing local file '{ref}'")
        elif ref not in site_set:
            fail(f"app.css: references '{ref}', which is missing from SITE_FILES")
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

    holes = d.get("missingTiles")
    if holes:
        fail(f"viewpoints.json was built with {len(holes)} terrain tile(s) missing, which read as "
             f"sea level and lower the horizons that cross them: {holes[:10]}")
    else:
        ok("catalogue was built with no terrain tiles missing")

    grid = d.get("cloudGrid") or {}
    if grid:
        first, last = grid["years"]
        if grid.get("count") == last - first + 1:
            ok(f"cloud climatology has one July per year, {first}-{last}")
        else:
            fail(f"viewpoints.json: cloudGrid has {grid.get('count')} months for {first}-{last} — "
                 "a non-July file was probably averaged in")

    required = {"lat", "lon", "elev", "sunAlt", "clearance", "clearBegin", "clearEnd",
                "totality", "access", "level"}
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

    check_stored_verdicts(d)
    check_presets(d, region)


def check_stored_verdicts(d: dict) -> None:
    """The browser trusts the stored `level` and `grazing` rather than judging the catalogue
    itself, so every row must agree with the rule applied to its own stored clearances. A
    disagreement means the build and precompute/verdict.py have drifted apart."""
    wrong = []
    for key in ("spots", "pois", "presets"):
        for i, r in enumerate(d.get(key) or []):
            want = verdict.verdict_fields(r.get("clearBegin"), r.get("clearance"), r.get("clearEnd"))
            got = {k: r[k] for k in ("level", "grazing") if k in r}
            if got != want:
                wrong.append(f"{key}[{i}] {r.get('name', '')}: stored {got}, rule gives {want}")
            if "wholeTotality" in r:
                wrong.append(f"{key}[{i}] still carries wholeTotality, which `level` replaces")
    for w in wrong[:10]:
        fail(f"viewpoints.json: {w}")
    if len(wrong) > 10:
        fail(f"viewpoints.json: ...and {len(wrong) - 10} more stored verdict problems")
    if not wrong:
        ok("every stored catalogue and preset verdict agrees with precompute/verdict.py")


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
                "clearBegin", "clearEnd", "level", "totality"}
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
    source = (ROOT / "simulator.js").read_text(encoding="utf-8")
    block = re.search(r"const LOCATIONS = \[(.*?)\];", source, re.S)
    if not block:
        fail("simulator.js: could not find the LOCATIONS array to cross-check presets against")
        return
    app = {
        m.group("name"): (float(m.group("lat")), float(m.group("lon")))
        for m in re.finditer(
            r'\{\s*name:\s*"(?P<name>[^"]+)",\s*lon:\s*(?P<lon>-?[\d.]+),'
            r'\s*lat:\s*(?P<lat>-?[\d.]+)', block.group(1))
    }
    if not app:
        fail("simulator.js: LOCATIONS found but no entries parsed — the format has changed")
        return

    built = {p["name"]: (p["lat"], p["lon"]) for p in presets}
    if set(app) != set(built):
        fail(f"preset names differ — simulator.js has {sorted(app)}, "
             f"viewpoints.json has {sorted(built)}")
        return
    # 1e-5 is the rounding the catalogue writes at; anything larger is real drift.
    drifted = [n for n in app
               if abs(app[n][0] - built[n][0]) > 1e-5 or abs(app[n][1] - built[n][1]) > 1e-5]
    if drifted:
        fail(f"preset coordinates differ between simulator.js and viewpoints.json: {drifted} — "
             f"the app will fall back to a live terrain probe for these")
    else:
        ok(f"presets: {len(presets)} entries, fields OK, coordinates match simulator.js")


def check_verdict_cases() -> None:
    """The verdict rule lives twice: verdict.js for the live check, precompute/verdict.py for
    the catalogue. Both run the same hand-worked cases, so a threshold or boundary changed in
    one and not the other fails here and in tests/unit/verdict.spec.mjs."""
    cases = json.loads((ROOT / "tests/fixtures/verdict-cases.json").read_text(encoding="utf-8"))["cases"]
    run = [c for c in cases if c["scope"] == "totality"]
    wrong = []
    for c in run:
        v = verdict.judge_totality({k["contact"]: k["clearance"] for k in c["contacts"]})
        got = {"level": v["level"], "grazing": v["grazing"]}
        want = {"level": c["expect"]["level"], "grazing": c["expect"]["grazing"]}
        if got != want:
            wrong.append(f"{c['name']}: got {got}, want {want}")
    for w in wrong:
        fail(f"precompute/verdict.py disagrees with the shared verdict cases — {w}")
    if not wrong:
        ok(f"precompute/verdict.py passes all {len(run)} shared totality-scope verdict cases")


def check_delta_t() -> None:
    """The browser and the precompute each fix ΔT (TT - UT) for the eclipse. A second of
    disagreement moves every contact by a second, so the stored catalogue and the live
    calculation would quietly drift apart."""
    found = {}
    for name, pattern in (("eclipse-time.js", r"^export const DELTA_T_SECONDS\s*=\s*([0-9.]+)\s*;"),
                          ("precompute/eclipse.py", r"^DELTA_T_SECONDS\s*=\s*([0-9.]+)")):
        p = ROOT / name
        m = re.search(pattern, p.read_text(encoding="utf-8"), re.M) if p.exists() else None
        if not m:
            fail(f"{name}: could not find DELTA_T_SECONDS")
            return
        found[name] = float(m.group(1))
    js, py = found["eclipse-time.js"], found["precompute/eclipse.py"]
    if js != py:
        fail(f"ΔT differs: eclipse-time.js uses {js} s, precompute/eclipse.py uses {py} s")
    else:
        ok(f"browser and precompute use the same ΔT ({js} s)")

    # The path limits on the map are generated, and are only right for the ΔT they were made with.
    p = ROOT / "eclipse-path.js"
    m = re.search(r'"deltaT":([0-9.]+)', p.read_text(encoding="utf-8")) if p.exists() else None
    if not m:
        fail("eclipse-path.js: could not find the ΔT it was generated with")
    elif float(m.group(1)) != py:
        fail(f"eclipse-path.js was generated with ΔT {m.group(1)} s, but the precompute now uses "
             f"{py} s. Run precompute/build_path.py.")
    else:
        ok("the map's path limits were generated with the current ΔT")


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
    check_verdict_cases()
    check_delta_t()
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
