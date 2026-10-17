#!/usr/bin/env python3
"""Enrich unnamed POIs in viewpoints.json using Photon reverse-geocoding and NZ spot-height conventions.

Can be run standalone to enrich an existing viewpoints.json without rebuilding the full DEM/Overpass dataset.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
VIEWPOINTS_FILE = ROOT / "viewpoints.json"
CACHE_DIR = ROOT / "precompute" / "cache" / "photon"

KIND_LABELS = {
    "viewpoint": "lookout",
    "rest_area": "rest area",
    "picnic": "picnic area",
    "tower": "observation tower",
    "campsite": "campsite",
    "peak": "peak",
}


def reverse_geocode_photon(lat: float, lon: float, session_headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Query Photon reverse geocoder with disk caching."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_key = f"{lat:.5f}_{lon:.5f}".replace("-", "m")
    cache_file = CACHE_DIR / f"{cache_key}.json"

    if cache_file.exists() and cache_file.stat().st_size > 0:
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    headers = session_headers or {"User-Agent": "otago-eclipse-2028-viewpoints/1.0 (precompute script)"}
    url = f"https://photon.komoot.io/reverse?lat={lat:.5f}&lon={lon:.5f}"

    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                cache_file.write_text(json.dumps(data), encoding="utf-8")
                return data
        except Exception as ex:
            time.sleep(min(30, 2 * (attempt + 1)))

    return {}


def clean_geo_string(text: str) -> str:
    """Clean and standardize geographic place and street strings."""
    # Strip leading non-alphanumeric characters (e.g. '#')
    text = re.sub(r"^[^\w]+", "", text)
    # Remove parking/camping restrictions from amenity names (e.g. ' - SC only', ' - SC')
    text = re.sub(r"\s*-\s*SC(?:\s+only)?\b", "", text, flags=re.I)
    # If the text is all lowercase, title-case words
    if text.islower():
        text = text.title()
    return text.strip()


def synthesize_poi_name(poi: dict[str, Any], photon_data: dict[str, Any] | None = None) -> str:
    """Generate a clean, human-readable name for an unnamed POI."""
    kind = poi.get("kind", "viewpoint")
    kind_label = KIND_LABELS.get(kind, "spot")

    # 1. Peaks: NZ Topographic Spot-Height Convention
    if kind == "peak":
        osm_ele = str(poi.get("osmEle") or "").strip()
        if osm_ele:
            ele_num = re.sub(r"[^\d.]", "", osm_ele)
            if ele_num:
                return f"Pt {ele_num}"
        elev = poi.get("elev")
        if elev:
            return f"Peak {elev}m"
        return f"Peak ({poi['lat']:.3f}, {poi['lon']:.3f})"

    # 2. Roadside & Amenity POIs: Reverse-Geocoded Context
    props = {}
    if photon_data:
        features = photon_data.get("features", [])
        if features:
            props = features[0].get("properties", {}) or {}

    raw_name = props.get("name")
    street = props.get("street")
    district = props.get("district")
    city = props.get("city")
    locality = props.get("locality")
    county = props.get("county")
    osm_key = props.get("osm_key")
    p_type = props.get("type")

    # Filter out unhelpful building/house names like "Workshop 9" or numbers
    is_generic_house = p_type == "house" or osm_key in ("building", "place")
    if is_generic_house and raw_name and re.search(r"\b(workshop|house|building|shed|unit|lot)\b|\d", raw_name, re.I):
        raw_name = None

    # Pick the best geographic descriptor
    geo = None
    if raw_name and (not is_generic_house or osm_key in ("natural", "tourism", "highway", "leisure", "historic")):
        geo = raw_name
    elif street:
        geo = street
    elif raw_name and not is_generic_house:
        geo = raw_name
    elif locality or district or city:
        geo = locality or district or city
    elif county and "district" in county.lower():
        geo = re.sub(r"\s+District$", "", county, flags=re.I)
    elif county:
        geo = county

    if not geo:
        return f"{kind_label.capitalize()} ({poi['lat']:.3f}, {poi['lon']:.3f})"

    geo = clean_geo_string(geo)
    geo_lower = geo.lower()

    if kind == "viewpoint":
        if any(w in geo_lower for w in ("lookout", "viewpoint", "overlook", "outlook")):
            return geo
        return f"{geo} lookout"
    elif kind == "rest_area":
        if "rest area" in geo_lower or "rest stop" in geo_lower or "lookout" in geo_lower:
            return geo
        loc = city or district or locality
        if loc and loc.lower() not in geo_lower and street and geo == street:
            return f"{geo} rest area ({loc})"
        return f"{geo} rest area"
    elif kind == "picnic":
        if "picnic" in geo_lower:
            return geo
        if any(w in geo_lower for w in ("reserve", "domain", "park", "garden")):
            return f"{geo} picnic area"
        return f"{geo} picnic area"
    elif kind == "tower":
        if "tower" in geo_lower:
            return geo
        return f"{geo} observation tower"
    elif kind == "campsite":
        if any(w in geo_lower for w in ("camp", "campsite", "camping", "holiday park")):
            return geo
        return f"{geo} campsite"

    return f"{geo} {kind_label}"


def enrich_viewpoints(data: dict[str, Any], dry_run: bool = False) -> tuple[dict[str, Any], int]:
    """Enrich unnamed POIs in viewpoints data."""
    pois = data.get("pois", [])
    unnamed_count = 0
    enriched_count = 0

    print(f"Scanning {len(pois)} POIs...")
    for p in pois:
        if p.get("name") and not p.get("synthetic"):
            p["synthetic"] = False
            continue

        unnamed_count += 1
        photon_data = None
        if p.get("kind") != "peak":
            photon_data = reverse_geocode_photon(p["lat"], p["lon"])

        title = synthesize_poi_name(p, photon_data)
        p["name"] = title
        p["synthetic"] = True
        enriched_count += 1

    print(f"Enriched {enriched_count} unnamed POIs.")
    return data, enriched_count


def main() -> None:
    if not VIEWPOINTS_FILE.exists():
        print(f"Error: {VIEWPOINTS_FILE} not found.")
        return

    data = json.loads(VIEWPOINTS_FILE.read_text(encoding="utf-8"))
    enriched_data, count = enrich_viewpoints(data)

    if count > 0:
        VIEWPOINTS_FILE.write_text(json.dumps(enriched_data, separators=(",", ":")), encoding="utf-8")
        print(f"Successfully updated {VIEWPOINTS_FILE} with {count} enriched POI names.")


if __name__ == "__main__":
    main()
