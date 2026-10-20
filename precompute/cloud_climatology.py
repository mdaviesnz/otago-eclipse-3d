#!/usr/bin/env python3
"""
Process EUMETSAT CM SAF CLARA-A3 NetCDF files to compute the 48-year (1979-2026)
July cloud climatology for the Otago eclipse path and integrate it into viewpoints.json.
"""

from __future__ import annotations

import glob
import json
from pathlib import Path

import netCDF4
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CMSAF_DIR = ROOT / "precompute" / "cache" / "cmsaf"
VIEWPOINTS_FILE = ROOT / "viewpoints.json"


def load_july_climatology():
    """Load all July monthly mean NetCDF files and compute multi-decadal means."""
    files = sorted(glob.glob(str(CMSAF_DIR / "*0701*.nc")))
    if not files:
        raise FileNotFoundError(f"No July NetCDF files found in {CMSAF_DIR}")

    ds0 = netCDF4.Dataset(files[0])
    lats = np.array(ds0.variables["lat"][:], dtype=float)
    lons = np.array(ds0.variables["lon"][:], dtype=float)
    ds0.close()

    day_stack = []
    low_stack = []
    tot_stack = []
    years = []

    for f in files:
        # e.g. CFCmm197907010000003UDAVPOS01UD.nc
        name = Path(f).name
        year_str = name.split("CFCmm")[1][:4]
        years.append(int(year_str))

        ds = netCDF4.Dataset(f)
        day_stack.append(np.ma.masked_equal(ds.variables["cfc_day"][0], -999))
        low_stack.append(np.ma.masked_equal(ds.variables["cfc_low"][0], -999))
        tot_stack.append(np.ma.masked_equal(ds.variables["cfc"][0], -999))
        ds.close()

    mean_day = np.ma.mean(day_stack, axis=0).filled(np.nan)
    mean_low = np.ma.mean(low_stack, axis=0).filled(np.nan)
    mean_tot = np.ma.mean(tot_stack, axis=0).filled(np.nan)

    return {
        "lats": lats,
        "lons": lons,
        "mean_day": mean_day,
        "mean_low": mean_low,
        "mean_tot": mean_tot,
        "years": (years[0], years[-1]),
        "count": len(files),
    }


def make_sampler(clim):
    """Return a bilinear interpolation function for coordinates (lat, lon)."""
    lats = clim["lats"]
    lons = clim["lons"]
    mean_day = clim["mean_day"]
    mean_low = clim["mean_low"]
    mean_tot = clim["mean_tot"]

    dlat = lats[1] - lats[0]
    dlon = lons[1] - lons[0]

    def interpolate(grid, lat, lon):
        y = (lat - lats[0]) / dlat
        x = (lon - lons[0]) / dlon

        y = max(0.0, min(float(len(lats) - 1), float(y)))
        x = max(0.0, min(float(len(lons) - 1), float(x)))

        y0 = int(np.floor(y))
        y1 = min(len(lats) - 1, y0 + 1)
        x0 = int(np.floor(x))
        x1 = min(len(lons) - 1, x0 + 1)

        fy = y - y0
        fx = x - x0

        v00 = grid[y0, x0]
        v01 = grid[y0, x1]
        v10 = grid[y1, x0]
        v11 = grid[y1, x1]

        val = (1.0 - fy) * ((1.0 - fx) * v00 + fx * v01) + fy * ((1.0 - fx) * v10 + fx * v11)
        return float(val)

    def sample(lat, lon):
        c_day = round(interpolate(mean_day, lat, lon), 1)
        c_low = round(interpolate(mean_low, lat, lon), 1)
        c_tot = round(interpolate(mean_tot, lat, lon), 1)
        clear_prob = round(max(0.0, min(100.0, 100.0 - c_day)), 1)
        return {
            "cloud": c_day,
            "clearProb": clear_prob,
            "cloudLow": c_low,
            "cloudTotal": c_tot,
        }

    return sample


def build_cloud_grid_payload(clim):
    """Serialize the regional grid into a compact JSON-serializable dictionary."""
    lats = clim["lats"]
    lons = clim["lons"]
    dlat = round(float(lats[1] - lats[0]), 3)
    dlon = round(float(lons[1] - lons[0]), 3)

    return {
        "latMin": round(float(lats[0]), 3),
        "latMax": round(float(lats[-1]), 3),
        "lonMin": round(float(lons[0]), 3),
        "lonMax": round(float(lons[-1]), 3),
        "dlat": dlat,
        "dlon": dlon,
        "rows": len(lats),
        "cols": len(lons),
        "lats": [round(float(v), 3) for v in lats],
        "lons": [round(float(v), 3) for v in lons],
        "cfcDay": [[round(float(v), 1) for v in row] for row in clim["mean_day"]],
        "cfcLow": [[round(float(v), 1) for v in row] for row in clim["mean_low"]],
        "cfcTotal": [[round(float(v), 1) for v in row] for row in clim["mean_tot"]],
        "years": list(clim["years"]),
        "count": clim["count"],
        "source": "EUMETSAT CM SAF CLARA-A3 & ICDR (1979-2026)",
    }


def enrich_catalogue(data, clim=None):
    """Enrich spots, pois, presets, and top-level metadata in data dict."""
    if clim is None:
        clim = load_july_climatology()
    sampler = make_sampler(clim)

    for s in data.get("spots", []):
        res = sampler(s["lat"], s["lon"])
        s["cloud"] = res["cloud"]
        s["clearProb"] = res["clearProb"]
        s["cloudLow"] = res["cloudLow"]

    for p in data.get("pois", []):
        res = sampler(p["lat"], p["lon"])
        p["cloud"] = res["cloud"]
        p["clearProb"] = res["clearProb"]
        p["cloudLow"] = res["cloudLow"]

    for pr in data.get("presets", []):
        res = sampler(pr["lat"], pr["lon"])
        pr["cloud"] = res["cloud"]
        pr["clearProb"] = res["clearProb"]
        pr["cloudLow"] = res["cloudLow"]

    data["cloudGrid"] = build_cloud_grid_payload(clim)

    attr = data.get("attribution", "")
    cmsaf_credit = "Cloud climatology: EUMETSAT CM SAF CLARA-A3 (1979-2026)."
    if cmsaf_credit not in attr:
        data["attribution"] = attr.rstrip(". ") + ". " + cmsaf_credit

    return data


def main():
    print("Loading EUMETSAT CM SAF July cloud climatology (1979-2026)...")
    clim = load_july_climatology()
    print(f"Loaded {clim['count']} July months from {clim['years'][0]} to {clim['years'][1]}.")
    print(f"Daytime cloud cover ranges from {np.nanmin(clim['mean_day']):.1f}% to {np.nanmax(clim['mean_day']):.1f}%.")

    if not VIEWPOINTS_FILE.exists():
        print(f"Error: {VIEWPOINTS_FILE} does not exist.")
        return 1

    print(f"Reading {VIEWPOINTS_FILE}...")
    data = json.loads(VIEWPOINTS_FILE.read_text(encoding="utf-8"))

    enrich_catalogue(data, clim)

    print(f"Enriched {len(data.get('spots', []))} spots, {len(data.get('pois', []))} POIs, {len(data.get('presets', []))} presets.")
    print("Writing updated viewpoints.json...")
    VIEWPOINTS_FILE.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"Done! File size: {VIEWPOINTS_FILE.stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
