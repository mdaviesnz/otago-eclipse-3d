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

ROOT = Path(__file__).resolve().parent.parent
SITE_FILES = ["index.html", "map.html", "app.css", "viewpoints.json", "social-card.svg",
              "_headers"]

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
    for name in SITE_FILES:
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
    """Every same-origin href/src/fetch target in the HTML must exist."""
    pattern = re.compile(r"""(?:href|src)=["']([^"'#?]+)["']|fetch\(["']([^"'?]+)["']""")
    for name in ("index.html", "map.html"):
        p = ROOT / name
        if not p.exists():
            continue
        for a, b in pattern.findall(p.read_text(encoding="utf-8", errors="replace")):
            ref = a or b
            if not ref or ref.startswith(("http://", "https://", "data:", "//", "mailto:")):
                continue
            # Skip JS template literals — these pages build markup with `${...}` inside
            # href attributes, which is not a real file reference.
            if "${" in ref or "{{" in ref:
                continue
            target = (ROOT / ref.lstrip("./")).resolve()
            if not target.exists():
                fail(f"{name}: references missing local file '{ref}'")
    ok("local asset references resolve")


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


def main() -> int:
    check_required_files()
    check_no_secrets()
    check_cache_not_tracked()
    check_local_references()
    check_catalogue()

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
