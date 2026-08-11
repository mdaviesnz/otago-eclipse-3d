#!/usr/bin/env python3
"""
Precompute the best eclipse-viewing spots for the 22 July 2028 total solar eclipse.

Coverage is the land area from which totality is visible. Each candidate spot is scored on
whether terrain blocks the low (~8-10 deg) sun at maximum eclipse, how long totality lasts
there, and whether it is reachable -- within a set distance of a road or walking track.

Outputs viewpoints.json, which index.html loads directly.

Data sources
  Terrain   Re:Earth Terrain, Terrarium-encoded raster DEM  (CC BY 4.0, Mapterhorn)
  Roads     OpenStreetMap via the Overpass API              (ODbL)
  Astronomy astronomy-engine (local computation, no network)

Everything downloaded is cached under precompute/cache/ so re-runs are cheap. Be considerate:
both upstream services are free and best-effort.

Usage
  python build_viewpoints.py                 # full run with defaults
  python build_viewpoints.py --zoom 10       # coarser DEM, ~4x fewer tiles
  python build_viewpoints.py --spacing 1000  # fewer candidates
  python build_viewpoints.py --no-osm        # skip the access filter
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests
from PIL import Image

import astronomy as A

# ----------------------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------------------

# Land bbox covering the totality path over the South Island. The path itself is a ~270 km
# band sweeping north-east; most of its area is ocean, and the per-candidate totality test
# below discards anything outside it, so this only needs to be a generous land envelope.
REGION = dict(lat_min=-46.60, lat_max=-43.30, lon_min=166.00, lon_max=171.60)

ECLIPSE_SEARCH_FROM = datetime(2028, 7, 21, tzinfo=timezone.utc)

TERRARIUM_URL = "https://terrain.reearth.land/terrarium/elevation/{z}/{x}/{y}.png"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Road classes we treat as access, grouped from most to least civilised.
#
# Deliberately excludes footway/cycleway/service: those are dominated by urban pavements,
# driveways and car-park aisles, which are not meaningful "can I get there" access for eclipse
# viewing. They also made the Overpass query about 35x slower, since they outnumber real roads
# in built-up areas.
ACCESS_CLASSES = {
    "sealed": ["motorway", "trunk", "primary", "secondary", "tertiary",
               "unclassified", "residential"],
    "track": ["track"],
    "foot":  ["path", "bridleway"],
}
ACCESS_RANK = {"sealed": 3, "track": 2, "foot": 1, "none": 0}

# Named places people already go to look at things. These make far better recommendations than
# bare grid coordinates: they are known, usually signposted, and often have parking. Queried as
# nwr (node/way/relation) with "out center" so areas resolve to a centroid.
POI_SELECTORS = [
    ('["tourism"="viewpoint"]', "viewpoint"),
    ('["natural"="peak"]', "peak"),
    ('["tourism"="picnic_site"]', "picnic"),
    ('["tourism"="camp_site"]', "campsite"),
    ('["highway"="rest_area"]', "rest_area"),
    ('["man_made"="tower"]["tower:type"="observation"]', "tower"),
]
# Preference when the same spot matches more than one selector, and for display ordering.
POI_PRIORITY = {"viewpoint": 6, "tower": 5, "rest_area": 4, "picnic": 3, "campsite": 2, "peak": 1}

EARTH_R = 6371000.0        # m, mean radius, for curvature drop
EYE_HEIGHT = 1.7           # m
# Probe ray geometry, deliberately identical to the live check in index.html so the two
# implementations are directly comparable.
#
# The growth rate matters more than it looks: at 13% per step, samples 28 km out sit ~3.6 km
# apart, which strides straight over distant ridges and reports a falsely clear horizon. A
# validation run against the app disagreed by 1.3 deg for exactly this reason. 3% keeps the
# far-field spacing under ~1 km.
MIN_PROBE = 100.0          # m -- below this, DEM vertical error dominates the angle
MAX_PROBE = 45000.0        # m
PROBE_GROWTH = 0.03        # geometric ray spacing

CACHE = Path(__file__).parent / "cache"
OUT = Path(__file__).parent.parent / "viewpoints.json"


# ----------------------------------------------------------------------------------------
# Web Mercator tile helpers
# ----------------------------------------------------------------------------------------

def lon_to_tile_x(lon: float, z: int) -> float:
    return (lon + 180.0) / 360.0 * (1 << z)


def lat_to_tile_y(lat: float, z: int) -> float:
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * (1 << z)


def tile_y_to_lat(y: float, z: int) -> float:
    n = math.pi - 2 * math.pi * y / (1 << z)
    return math.degrees(math.atan(math.sinh(n)))


def tile_x_to_lon(x: float, z: int) -> float:
    return x / (1 << z) * 360.0 - 180.0


# ----------------------------------------------------------------------------------------
# DEM assembly
# ----------------------------------------------------------------------------------------

class Dem:
    """Terrarium DEM mosaic in Web Mercator pixel space, with bilinear sampling."""

    def __init__(self, grid: np.ndarray, z: int, px0: float, py0: float, tile_px: int):
        self.g = grid                  # int16 [rows, cols] metres
        self.z = z
        self.tile_px = tile_px
        self.px0 = px0                 # global mercator pixel of column 0
        self.py0 = py0                 # global mercator pixel of row 0
        self.scale = float(tile_px) * (1 << z)   # pixels around the globe

    def pixel_of(self, lat: np.ndarray, lon: np.ndarray):
        px = (lon + 180.0) / 360.0 * self.scale
        s = np.sin(np.radians(np.clip(lat, -85.0, 85.0)))
        py = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * self.scale
        return px - self.px0, py - self.py0

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        """Bilinear elevation lookup. Out-of-range coordinates come back as NaN."""
        x, y = self.pixel_of(np.asarray(lat, float), np.asarray(lon, float))
        rows, cols = self.g.shape
        ok = (x >= 0) & (y >= 0) & (x < cols - 1) & (y < rows - 1)
        xi = np.clip(x, 0, cols - 2)
        yi = np.clip(y, 0, rows - 2)
        x0 = xi.astype(np.int32)
        y0 = yi.astype(np.int32)
        fx = xi - x0
        fy = yi - y0
        g = self.g
        v00 = g[y0, x0].astype(np.float32)
        v10 = g[y0, x0 + 1].astype(np.float32)
        v01 = g[y0 + 1, x0].astype(np.float32)
        v11 = g[y0 + 1, x0 + 1].astype(np.float32)
        top = v00 + (v10 - v00) * fx
        bot = v01 + (v11 - v01) * fx
        out = top + (bot - top) * fy
        return np.where(ok, out, np.nan)

    def metres_per_pixel(self, lat: float) -> float:
        return (156543.03392 * 256.0 / self.tile_px) * math.cos(math.radians(lat)) / (1 << self.z)


def fetch_tile(z: int, x: int, y: int, session: requests.Session, retries: int = 3):
    """Fetch one Terrarium tile, caching the PNG on disk. Returns an int16 256x256 array."""
    cache_dir = CACHE / "terrarium" / str(z) / str(x)
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"{y}.png"
    data = None
    if path.exists() and path.stat().st_size > 0:
        data = path.read_bytes()
    else:
        url = TERRARIUM_URL.format(z=z, x=x, y=y)
        for attempt in range(retries):
            try:
                r = session.get(url, timeout=30)
                if r.status_code == 404:
                    return None            # outside coverage; treat as sea level
                r.raise_for_status()
                data = r.content
                path.write_bytes(data)
                break
            except Exception:
                if attempt == retries - 1:
                    return None
                time.sleep(1.5 * (attempt + 1))
    try:
        im = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None
    a = np.asarray(im, dtype=np.float32)
    # Terrarium: elevation = (R * 256 + G + B / 256) - 32768
    elev = (a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0) - 32768.0
    return np.rint(elev).astype(np.int16)


def build_dem(z: int, workers: int = 6) -> Dem:
    # Pad the mosaic so probe rays never run off its edge. The sun sits to the north-west, so
    # rays from candidates on the NW boundary reach up to MAX_PROBE beyond the region; without
    # padding those samples come back NaN and are treated as "no terrain", which would report a
    # falsely clear horizon.
    pad_lat = MAX_PROBE / 111132.0 + 0.02
    pad_lon = MAX_PROBE / (111320.0 * math.cos(math.radians(-45.0))) + 0.02
    x0 = int(math.floor(lon_to_tile_x(REGION["lon_min"] - pad_lon, z)))
    x1 = int(math.floor(lon_to_tile_x(REGION["lon_max"] + pad_lon, z)))
    y0 = int(math.floor(lat_to_tile_y(REGION["lat_max"] + pad_lat, z)))   # north -> smaller y
    y1 = int(math.floor(lat_to_tile_y(REGION["lat_min"] - pad_lat, z)))
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    total = nx * ny

    # Tile pixel size is a property of the service (Re:Earth serves 512 px), so probe rather
    # than assume the usual 256.
    probe = fetch_tile(z, x0, y0, SESSION)
    tile_px = probe.shape[0] if probe is not None else 512
    mpp = (156543.03392 * 256.0 / tile_px) * math.cos(math.radians(-45)) / (1 << z)
    print(f"  DEM: zoom {z}, {nx}x{ny} = {total} tiles of {tile_px}px "
          f"({nx * tile_px} x {ny * tile_px} px, ~{mpp:.0f} m/px)")

    grid = np.zeros((ny * tile_px, nx * tile_px), dtype=np.int16)
    done = 0

    def job(args):
        ix, iy = args
        return ix, iy, fetch_tile(z, x0 + ix, y0 + iy, SESSION)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for ix, iy, tile in pool.map(job, [(i, j) for j in range(ny) for i in range(nx)]):
            if tile is not None and tile.shape == (tile_px, tile_px):
                grid[iy * tile_px:(iy + 1) * tile_px, ix * tile_px:(ix + 1) * tile_px] = tile
            done += 1
            if done % 25 == 0 or done == total:
                print(f"\r  tiles {done}/{total}", end="", flush=True)
    print()
    return Dem(grid, z, x0 * float(tile_px), y0 * float(tile_px), tile_px)


# ----------------------------------------------------------------------------------------
# Eclipse circumstances on a coarse grid, then interpolated
# ----------------------------------------------------------------------------------------

class EclipseField:
    """Sun alt/az at maximum, totality duration, and totality flag on a coarse lat/lon grid.

    Circumstances vary smoothly over tens of kilometres, so a ~0.1 deg grid interpolated
    bilinearly is far cheaper than one ephemeris search per candidate -- and indistinguishable
    at the precision that matters here.
    """

    def __init__(self, step: float = 0.1):
        self.lats = np.arange(REGION["lat_min"], REGION["lat_max"] + step, step)
        self.lons = np.arange(REGION["lon_min"], REGION["lon_max"] + step, step)
        shape = (len(self.lats), len(self.lons))
        self.alt = np.full(shape, np.nan, np.float32)      # at maximum
        self.az = np.full(shape, np.nan, np.float32)
        self.altB = np.full(shape, np.nan, np.float32)     # at totality begin
        self.azB = np.full(shape, np.nan, np.float32)
        self.altE = np.full(shape, np.nan, np.float32)     # at totality end
        self.azE = np.full(shape, np.nan, np.float32)
        self.dur = np.zeros(shape, np.float32)
        self.total = np.zeros(shape, bool)
        self.step = step

        t0 = A.Time.Make(2028, 7, 21, 0, 0, 0)
        n = shape[0] * shape[1]
        print(f"  eclipse field: {shape[0]}x{shape[1]} = {n} ephemeris searches")
        for i, la in enumerate(self.lats):
            for j, lo in enumerate(self.lons):
                obs = A.Observer(float(la), float(lo), 0.0)
                try:
                    e = A.SearchLocalSolarEclipse(t0, obs)
                except Exception:
                    continue
                if e.peak is None:
                    continue
                def sun_az(t):
                    # astronomy-engine reports altitude at contacts but not azimuth.
                    eq = A.Equator(A.Body.Sun, t, obs, True, True)
                    return A.Horizon(t, obs, eq.ra, eq.dec, A.Refraction.Airless).azimuth

                self.alt[i, j] = e.peak.altitude
                self.az[i, j] = sun_az(e.peak.time)
                if e.total_begin is not None and e.total_end is not None:
                    self.total[i, j] = True
                    self.dur[i, j] = (e.total_end.time.ut - e.total_begin.time.ut) * 86400.0
                    # Second and third contact, so we can tell "clear for all of totality"
                    # from "clear only for part of it".
                    self.altB[i, j] = e.total_begin.altitude
                    self.azB[i, j] = sun_az(e.total_begin.time)
                    self.altE[i, j] = e.total_end.altitude
                    self.azE[i, j] = sun_az(e.total_end.time)
                else:
                    self.altB[i, j] = self.altE[i, j] = e.peak.altitude
                    self.azB[i, j] = self.azE[i, j] = self.az[i, j]
            print(f"\r  row {i + 1}/{shape[0]}", end="", flush=True)
        print()

    def _frac(self, lat, lon):
        fi = np.clip((lat - self.lats[0]) / self.step, 0, len(self.lats) - 1.001)
        fj = np.clip((lon - self.lons[0]) / self.step, 0, len(self.lons) - 1.001)
        return fi, fj

    def _bilinear(self, arr, lat, lon):
        fi, fj = self._frac(lat, lon)
        i0, j0 = fi.astype(np.int32), fj.astype(np.int32)
        di, dj = fi - i0, fj - j0
        a = arr[i0, j0]
        b = arr[i0, j0 + 1]
        c = arr[i0 + 1, j0]
        d = arr[i0 + 1, j0 + 1]
        return (a * (1 - dj) + b * dj) * (1 - di) + (c * (1 - dj) + d * dj) * di

    def interp(self, lat, lon):
        # Azimuths here sit near 310 deg with no wrap inside the region, so plain
        # interpolation is safe.
        alt = self._bilinear(self.alt, lat, lon)
        az = self._bilinear(self.az, lat, lon)
        altB = self._bilinear(self.altB, lat, lon)
        azB = self._bilinear(self.azB, lat, lon)
        altE = self._bilinear(self.altE, lat, lon)
        azE = self._bilinear(self.azE, lat, lon)
        dur = self._bilinear(self.dur, lat, lon)
        fi, fj = self._frac(lat, lon)
        # Totality is a hard boundary: require all four surrounding samples to be inside,
        # so candidates on the edge are not optimistically included.
        i0, j0 = fi.astype(np.int32), fj.astype(np.int32)
        tot = (self.total[i0, j0] & self.total[i0, j0 + 1]
               & self.total[i0 + 1, j0] & self.total[i0 + 1, j0 + 1])
        return dict(alt=alt, az=az, altB=altB, azB=azB, altE=altE, azE=azE, dur=dur, tot=tot)


# ----------------------------------------------------------------------------------------
# Horizon scan (vectorised over all candidates at once)
# ----------------------------------------------------------------------------------------

def probe_distances() -> np.ndarray:
    ds, d = [], MIN_PROBE
    while d <= MAX_PROBE:
        ds.append(d)
        d += max(MIN_PROBE * 0.25, d * PROBE_GROWTH)
    return np.array(ds, dtype=np.float32)


def horizon_angles(dem: Dem, lat: np.ndarray, lon: np.ndarray, az_deg: np.ndarray,
                   eye: np.ndarray) -> np.ndarray:
    """Max terrain elevation angle along each candidate's sun bearing, in degrees."""
    ds = probe_distances()
    az = np.radians(az_deg)
    # Local metres -> degrees, per candidate.
    dlat_per_m = 1.0 / 111132.0
    dlon_per_m = 1.0 / (111320.0 * np.cos(np.radians(lat)))
    best = np.full(lat.shape, -90.0, dtype=np.float32)
    for d in ds:
        plat = lat + (d * np.cos(az)) * dlat_per_m
        plon = lon + (d * np.sin(az)) * dlon_per_m
        h = dem.sample(plat, plon)
        drop = (d * d) / (2 * EARTH_R)
        ang = np.degrees(np.arctan2(h - eye - drop, d))
        np.maximum(best, np.nan_to_num(ang, nan=-90.0), out=best)
    return best


# ----------------------------------------------------------------------------------------
# OpenStreetMap access
# ----------------------------------------------------------------------------------------

class OverpassFailure(Exception):
    """Raised when a bbox could not be fetched after all retries.

    This must never be swallowed: a cell that silently returns no ways looks identical to a
    cell with no roads, which would wrongly mark reachable candidates as inaccessible.
    """


def overpass_query(bbox, session: requests.Session, preferred_url: str | None = None):
    """Fetch highway geometry for one bbox, cached on disk. Returns list of (tag, coords).

    Raises OverpassFailure if every endpoint and retry fails.
    """
    s, w, n, e = bbox
    key = f"{s:.3f}_{w:.3f}_{n:.3f}_{e:.3f}".replace("-", "m")
    cache_dir = CACHE / "overpass"
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"{key}.json"
    if path.exists() and path.stat().st_size > 0:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass

    wanted = "|".join(v for group in ACCESS_CLASSES.values() for v in group)
    q = (f'[out:json][timeout:180];'
         f'way["highway"~"^({wanted})$"]({s},{w},{n},{e});'
         f'out geom;')
    last_err = None
    urls = OVERPASS_URLS if not preferred_url else (
        [preferred_url] + [u for u in OVERPASS_URLS if u != preferred_url])
    # Rotate endpoints with exponential backoff. 429/504 mean "busy", not "empty".
    for attempt in range(6):
        url = urls[attempt % len(urls)]
        try:
            r = session.post(url, data={"data": q}, timeout=240)
            if r.status_code in (429, 502, 503, 504):
                last_err = f"HTTP {r.status_code}"
                time.sleep(min(90, 10 * (attempt + 1)))
                continue
            r.raise_for_status()
            payload = r.json()
            ways = []
            for el in payload.get("elements", []):
                if el.get("type") != "way" or "geometry" not in el:
                    continue
                hw = el.get("tags", {}).get("highway")
                coords = [(p["lat"], p["lon"]) for p in el["geometry"]]
                if hw and len(coords) >= 2:
                    ways.append([hw, coords])
            path.write_text(json.dumps(ways), encoding="utf-8")
            return ways
        except Exception as ex:
            last_err = ex
            time.sleep(min(90, 8 * (attempt + 1)))
    raise OverpassFailure(f"{bbox}: {last_err}")


def fetch_pois(session: requests.Session, cell: float = 1.0):
    """Fetch named viewing POIs across the region, cached on disk.

    Returns (pois, failed_boxes). Failures are returned rather than swallowed so the caller can
    record them -- a throttled request must not masquerade as "no POIs in this area".
    """
    cache_dir = CACHE / "pois"
    cache_dir.mkdir(parents=True, exist_ok=True)
    union = "".join(f"  nwr{sel}({{bbox}});\n" for sel, _ in POI_SELECTORS)

    out = {}
    failures = []
    lat = REGION["lat_min"]
    boxes = []
    while lat < REGION["lat_max"]:
        lon = REGION["lon_min"]
        while lon < REGION["lon_max"]:
            boxes.append((lat, lon, min(lat + cell, REGION["lat_max"]),
                          min(lon + cell, REGION["lon_max"])))
            lon += cell
        lat += cell

    for n, (s, w, nn, e) in enumerate(boxes, 1):
        key = f"{s:.2f}_{w:.2f}_{nn:.2f}_{e:.2f}".replace("-", "m")
        path = cache_dir / f"{key}.json"
        elements = None
        if path.exists() and path.stat().st_size > 0:
            try:
                elements = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                elements = None
        if elements is None:
            bbox = f"{s},{w},{nn},{e}"
            q = ("[out:json][timeout:180];\n(\n"
                 + union.replace("{bbox}", bbox)
                 + ");\nout center;")
            elements = None
            last_err = None
            for attempt in range(6):
                url = OVERPASS_URLS[attempt % len(OVERPASS_URLS)]
                try:
                    r = session.post(url, data={"data": q}, timeout=240)
                    if r.status_code in (429, 502, 503, 504):
                        last_err = f"HTTP {r.status_code}"
                        time.sleep(min(90, 10 * (attempt + 1)))
                        continue
                    r.raise_for_status()
                    elements = r.json().get("elements", [])
                    path.write_text(json.dumps(elements), encoding="utf-8")
                    break
                except Exception as ex:
                    last_err = ex
                    time.sleep(min(90, 8 * (attempt + 1)))
            if elements is None:
                # Never treat a throttled request as "no POIs here".
                failures.append((s, w, nn, e))
                print(f"\n  ! POI fetch failed for ({s},{w},{nn},{e}): {last_err}")
                elements = []
            time.sleep(1.0)

        for el in elements:
            la = el.get("lat", (el.get("center") or {}).get("lat"))
            lo = el.get("lon", (el.get("center") or {}).get("lon"))
            if la is None or lo is None:
                continue
            tags = el.get("tags", {})
            kind = None
            if tags.get("tourism") == "viewpoint":
                kind = "viewpoint"
            elif tags.get("man_made") == "tower" and tags.get("tower:type") == "observation":
                kind = "tower"
            elif tags.get("highway") == "rest_area":
                kind = "rest_area"
            elif tags.get("tourism") == "picnic_site":
                kind = "picnic"
            elif tags.get("tourism") == "camp_site":
                kind = "campsite"
            elif tags.get("natural") == "peak":
                kind = "peak"
            if not kind:
                continue
            oid = f"{el.get('type', 'node')}/{el.get('id')}"
            prev = out.get(oid)
            if prev and POI_PRIORITY[prev["kind"]] >= POI_PRIORITY[kind]:
                continue
            out[oid] = {
                "id": oid,
                "kind": kind,
                "name": tags.get("name") or "",
                "lat": float(la),
                "lon": float(lo),
                "osmEle": tags.get("ele", ""),
            }
        print(f"\r  poi tiles {n}/{len(boxes)} ({len(out)} found)", end="", flush=True)
    print()
    return list(out.values()), failures


class AccessGrid:
    """Raster of best access class, stamped from OSM ways with a radius."""

    def __init__(self, cell_m: float, radius_m: float):
        self.cell = cell_m
        self.radius = radius_m
        self.lat0 = REGION["lat_min"]
        self.lon0 = REGION["lon_min"]
        self.dlat = cell_m / 111132.0
        self.dlon = cell_m / (111320.0 * math.cos(math.radians(-45.0)))
        self.rows = int((REGION["lat_max"] - self.lat0) / self.dlat) + 2
        self.cols = int((REGION["lon_max"] - self.lon0) / self.dlon) + 2
        self.g = np.zeros((self.rows, self.cols), dtype=np.uint8)
        print(f"  access grid: {self.rows}x{self.cols} cells at {cell_m:.0f} m, "
              f"radius {radius_m:.0f} m")

    def _idx(self, lat, lon):
        return ((lat - self.lat0) / self.dlat), ((lon - self.lon0) / self.dlon)

    def stamp(self, ways):
        rad_cells = max(1, int(round(self.radius / self.cell)))
        # Disc offsets so a point within `radius` of the way is marked.
        offs = [(dy, dx) for dy in range(-rad_cells, rad_cells + 1)
                for dx in range(-rad_cells, rad_cells + 1)
                if dy * dy + dx * dx <= rad_cells * rad_cells]
        for hw, coords in ways:
            cls = 0
            for name, vals in ACCESS_CLASSES.items():
                if hw in vals:
                    cls = ACCESS_RANK[name]
                    break
            if cls == 0:
                continue
            # Walk each segment at ~half-cell steps so there are no gaps.
            for (la1, lo1), (la2, lo2) in zip(coords, coords[1:]):
                r1, c1 = self._idx(la1, lo1)
                r2, c2 = self._idx(la2, lo2)
                steps = int(max(abs(r2 - r1), abs(c2 - c1)) * 2) + 1
                for t in np.linspace(0.0, 1.0, steps):
                    r = int(round(r1 + (r2 - r1) * t))
                    c = int(round(c1 + (c2 - c1) * t))
                    for dy, dx in offs:
                        rr, cc = r + dy, c + dx
                        if 0 <= rr < self.rows and 0 <= cc < self.cols:
                            if self.g[rr, cc] < cls:
                                self.g[rr, cc] = cls
        return self

    def lookup(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        r, c = self._idx(lat, lon)
        r = np.clip(np.rint(r).astype(np.int32), 0, self.rows - 1)
        c = np.clip(np.rint(c).astype(np.int32), 0, self.cols - 1)
        return self.g[r, c]


# ----------------------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------------------

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "otago-eclipse-2028-viewpoints/1.0 (precompute script)"})


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    # Re:Earth serves 512 px tiles, so zoom 11 gives ~27 m/px at this latitude — matching the
    # native ~30 m source (NASADEM / Copernicus GLO-30). Going finer only interpolates and
    # would quadruple the tile count for no real gain.
    ap.add_argument("--zoom", type=int, default=11, help="Terrarium zoom (default 11, ~27 m/px)")
    ap.add_argument("--spacing", type=float, default=250.0, help="candidate spacing in metres")
    ap.add_argument("--radius", type=float, default=100.0, help="max distance to a road/track, m")
    ap.add_argument("--top", type=int, default=400, help="how many spots to emit")
    ap.add_argument("--no-osm", action="store_true", help="skip all OSM queries")
    ap.add_argument("--no-poi", action="store_true", help="skip named viewing POIs")
    ap.add_argument("--min-clearance", type=float, default=0.0,
                    help="require the sun to clear terrain by at least this many degrees")
    args = ap.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    t_start = time.time()

    print("1/5  Building DEM from Re:Earth Terrarium tiles")
    dem = build_dem(args.zoom)

    print("2/5  Computing eclipse circumstances")
    field = EclipseField(step=0.1)

    print("3/5  Scanning candidates")
    dlat = args.spacing / 111132.0
    dlon = args.spacing / (111320.0 * math.cos(math.radians(-45.0)))
    lats = np.arange(REGION["lat_min"], REGION["lat_max"], dlat)
    lons = np.arange(REGION["lon_min"], REGION["lon_max"], dlon)
    LA, LO = np.meshgrid(lats, lons, indexing="ij")
    lat_f = LA.ravel()
    lon_f = LO.ravel()
    print(f"  {len(lats)}x{len(lons)} = {lat_f.size} candidate points at {args.spacing:.0f} m")

    ground = dem.sample(lat_f, lon_f)
    F = field.interp(lat_f, lon_f)

    # Keep only land inside totality with the sun above the horizon at maximum.
    keep = F["tot"] & np.isfinite(ground) & (ground > 0.5) & (F["alt"] > 0.5)
    print(f"  {int(keep.sum())} on land, inside totality, sun up at maximum")
    if keep.sum() == 0:
        print("  nothing to do")
        return

    lat_f, lon_f = lat_f[keep], lon_f[keep]
    ground = ground[keep]
    alt, az, dur = F["alt"][keep], F["az"][keep], F["dur"][keep]
    altB, azB, altE, azE = F["altB"][keep], F["azB"][keep], F["altE"][keep], F["azE"][keep]

    eye = ground + EYE_HEIGHT
    # Check all three contacts, not just maximum: the sun shifts in azimuth across totality,
    # so a spot can be clear at second contact and blocked by third.
    print("  computing horizons (2nd contact, maximum, 3rd contact)…")
    horizon = horizon_angles(dem, lat_f, lon_f, az, eye)
    clearance = alt - horizon
    clearB = altB - horizon_angles(dem, lat_f, lon_f, azB, eye)
    clearE = altE - horizon_angles(dem, lat_f, lon_f, azE, eye)

    ok = clearance > args.min_clearance
    whole = ok & (clearB > args.min_clearance) & (clearE > args.min_clearance)
    print(f"  {int(ok.sum())} clear at maximum, of which "
          f"{int(whole.sum())} are clear for the whole of totality")
    lat_f, lon_f, ground, alt, az, dur, horizon, clearance, clearB, clearE = (
        v[ok] for v in (lat_f, lon_f, ground, alt, az, dur, horizon, clearance, clearB, clearE))

    # Any OSM bbox we could not fetch is recorded in the output so gaps are never invisible.
    osm_gaps = []

    # --- Named POIs: viewpoints, peaks, picnic sites, campsites, lookouts ------------------
    pois = []
    if not args.no_osm and not args.no_poi:
        print("4/6  Fetching named viewing POIs from OpenStreetMap")
        raw, poi_fail = fetch_pois(SESSION)
        if poi_fail:
            osm_gaps.extend([[round(v, 3) for v in b] for b in poi_fail])
        if raw:
            p_lat = np.array([p["lat"] for p in raw], dtype=np.float64)
            p_lon = np.array([p["lon"] for p in raw], dtype=np.float64)
            p_ground = dem.sample(p_lat, p_lon)
            PF = field.interp(p_lat, p_lon)
            p_keep = PF["tot"] & np.isfinite(p_ground) & (PF["alt"] > 0.5)
            print(f"  {len(raw)} POIs found, {int(p_keep.sum())} inside totality with the sun up")
            if p_keep.any():
                idx = np.nonzero(p_keep)[0]
                pl, po = p_lat[idx], p_lon[idx]
                pg = np.nan_to_num(p_ground[idx], nan=0.0)
                pe = pg + EYE_HEIGHT
                pa, pz, pd = PF["alt"][idx], PF["az"][idx], PF["dur"][idx]
                p_hor = horizon_angles(dem, pl, po, pz, pe)
                p_cB = PF["altB"][idx] - horizon_angles(dem, pl, po, PF["azB"][idx], pe)
                p_cE = PF["altE"][idx] - horizon_angles(dem, pl, po, PF["azE"][idx], pe)
                for k, i in enumerate(idx):
                    r = dict(raw[i])
                    clr = float(pa[k] - p_hor[k])
                    r.update(elev=int(round(float(pg[k]))),
                             sunAlt=round(float(pa[k]), 2),
                             sunAz=round(float(pz[k]), 1),
                             horizon=round(float(p_hor[k]), 2),
                             clearance=round(clr, 2),
                             clearBegin=round(float(p_cB[k]), 2),
                             clearEnd=round(float(p_cE[k]), 2),
                             wholeTotality=bool(clr > 0 and p_cB[k] > 0 and p_cE[k] > 0),
                             totality=int(round(float(pd[k]))))
                    pois.append(r)
    else:
        print("4/6  Skipping POI fetch")

    access = np.zeros(lat_f.size, dtype=np.uint8)
    if not args.no_osm and lat_f.size:
        print("5/6  Fetching OpenStreetMap access (roads and tracks)")
        # Only query cells that actually contain surviving candidates or POIs -- this cuts the
        # number of Overpass requests dramatically over ocean and roadless wilderness.
        cell = 0.25
        keys = set(zip(np.floor(lat_f / cell).astype(int), np.floor(lon_f / cell).astype(int)))
        for p in pois:
            keys.add((int(math.floor(p["lat"] / cell)), int(math.floor(p["lon"] / cell))))
        print(f"  {len(keys)} Overpass tiles of {cell} deg to fetch")
        grid = AccessGrid(cell_m=max(50.0, args.radius), radius_m=args.radius)
        cells = sorted(keys)

        # Serial, one cell at a time. Parallel requests get this IP throttled (503/504), and a
        # throttled cell is indistinguishable from a roadless one -- which would silently mark
        # reachable spots as inaccessible. Correctness beats speed here; results are cached, so
        # an interrupted run resumes almost instantly.
        failed = []
        for n, (ky, kx) in enumerate(cells, 1):
            s, w = ky * cell, kx * cell
            box = (s, w, s + cell, w + cell)
            try:
                ways = overpass_query(box, SESSION)
                grid.stamp(ways)
                print(f"\r  overpass {n}/{len(cells)} ({len(ways)} ways)   ", end="", flush=True)
            except OverpassFailure as ex:
                failed.append(box)
                print(f"\n  ! retry queued: {ex}")
            time.sleep(1.0)          # be polite to a free service
        print()

        # One more sweep over anything that failed, after a cool-off.
        if failed:
            print(f"  retrying {len(failed)} failed cells after a pause…")
            time.sleep(30)
            still = []
            for box in failed:
                try:
                    grid.stamp(overpass_query(box, SESSION))
                except OverpassFailure:
                    still.append(box)
                time.sleep(2.0)
            if still:
                print(f"  !! {len(still)} cells could not be fetched. Spots in these areas may "
                      f"be wrongly marked inaccessible:")
                for box in still:
                    print(f"     {box}")
                osm_gaps.extend([[round(v, 3) for v in b] for b in still])
            else:
                print("  all retries succeeded")
        access = grid.lookup(lat_f, lon_f)
        reachable = access > 0
        print(f"  {int(reachable.sum())} of {lat_f.size} are within {args.radius:.0f} m "
              f"of a road or track")
        lat_f, lon_f, ground, alt, az, dur, horizon, clearance, access = (
            v[reachable] for v in
            (lat_f, lon_f, ground, alt, az, dur, horizon, clearance, access))

        # POIs keep their access class rather than being filtered out: a lookout with no
        # mapped road is still worth knowing about, it just needs a walk.
        if pois:
            rank_name_local = {3: "sealed", 2: "track", 1: "foot", 0: "none"}
            pa = grid.lookup(np.array([p["lat"] for p in pois]),
                             np.array([p["lon"] for p in pois]))
            for p, a in zip(pois, pa):
                p["access"] = rank_name_local[int(a)]
    else:
        print("5/6  Skipping OSM access filter")

    print("6/6  Ranking and writing output")
    if lat_f.size == 0:
        print("  no candidates survived")
        return

    # Reachability dominates. Ranking on clearance alone surfaces 2500 m alpine summits with
    # superb horizons and no way to get there, which is useless as a recommendation -- so the
    # access tier is worth far more than any number of degrees, and clearance orders within a
    # tier. The UI filter then narrows to the tier the user can actually manage.
    norm_dur = (dur - dur.min()) / max(1.0, (dur.max() - dur.min()))
    score = access.astype(np.float32) * 100.0 + clearance + norm_dur * 0.5
    order = np.argsort(-score)

    # Thin the list so the output is geographically spread rather than 400 points on one ridge.
    #
    # Also reserve quota per access tier. Without this, sealed-road spots fill the entire list
    # (there are thousands of them), so anyone choosing "including walking paths" — a chaser
    # willing to hike for a better horizon — would never actually see a walk-in spot.
    quota = {3: int(args.top * 0.5), 2: int(args.top * 0.3), 1: int(args.top * 0.2), 0: 0}
    picked = {3: 0, 2: 0, 1: 0, 0: 0}
    chosen, min_sep_deg = [], 2500.0 / 111132.0
    for i in order:
        if len(chosen) >= args.top:
            break
        tier = int(access[i]) if access.size else 0
        if picked[tier] >= quota.get(tier, 0):
            continue
        if all((abs(lat_f[i] - lat_f[j]) > min_sep_deg) or (abs(lon_f[i] - lon_f[j]) > min_sep_deg)
               for j in chosen):
            chosen.append(i)
            picked[tier] += 1

    # Named POIs are ranked on their own: a signposted lookout with a modest clearance is
    # usually a better recommendation than an anonymous grid point with a slightly better one.
    # Access tier dominates for the same reason as above -- otherwise the list fills with
    # 2500 m peaks like Mount Tutoko that nobody is driving to on eclipse afternoon.
    def poi_score(p):
        return (ACCESS_RANK.get(p.get("access", "none"), 0) * 100.0
                + p["clearance"]
                + POI_PRIORITY[p["kind"]] * 0.35
                + (0.4 if p["name"] else 0.0))

    poi_out = sorted(
        (p for p in pois if p.get("clearance", -99) > args.min_clearance),
        key=lambda p: -poi_score(p),
    )[:args.top]
    by_access = Counter(p.get("access", "none") for p in poi_out)
    print(f"  {len(poi_out)} named POIs with a clear view  {dict(by_access)}")

    rank_name = {3: "sealed", 2: "track", 1: "foot", 0: "none"}
    spots = [{
        "lat": round(float(lat_f[i]), 5),
        "lon": round(float(lon_f[i]), 5),
        "elev": int(round(float(ground[i]))),
        "sunAlt": round(float(alt[i]), 2),
        "sunAz": round(float(az[i]), 1),
        "horizon": round(float(horizon[i]), 2),
        "clearance": round(float(clearance[i]), 2),
        "clearBegin": round(float(clearB[i]), 2),
        "clearEnd": round(float(clearE[i]), 2),
        "wholeTotality": bool(clearance[i] > 0 and clearB[i] > 0 and clearE[i] > 0),
        "totality": int(round(float(dur[i]))),
        "access": rank_name[int(access[i])] if access.size else "unknown",
    } for i in chosen]

    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "eclipse": "2028-07-22 total solar eclipse, New Zealand",
        "region": REGION,
        "params": {
            "demZoom": args.zoom,
            "demMetresPerPixel": round(dem.metres_per_pixel(-45.0), 1),
            "candidateSpacingM": args.spacing,
            "accessRadiusM": args.radius,
            "minClearanceDeg": args.min_clearance,
            "probeMinM": MIN_PROBE,
            "probeMaxM": MAX_PROBE,
            "eyeHeightM": EYE_HEIGHT,
        },
        "attribution": ("Terrain: Re:Earth Terrain / Mapterhorn (CC BY 4.0). "
                        "Roads: OpenStreetMap contributors (ODbL). "
                        "Astronomy: astronomy-engine."),
        "caveats": ("Access means proximity to an OSM road or track, not a right of way. "
                    "Land may be private. Horizon angles come from a ~%d m DEM and should be "
                    "re-checked in the app at full resolution."
                    % round(dem.metres_per_pixel(-45.0))),
        "count": len(spots),
        "spots": spots,
        "poiCount": len(poi_out),
        "pois": poi_out,
        "osmGaps": osm_gaps,
    }
    if osm_gaps:
        print(f"  NOTE: {len(osm_gaps)} OSM bbox(es) missing — recorded as osmGaps in the JSON")
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {OUT} -- {len(spots)} spots, {OUT.stat().st_size / 1024:.0f} KB")
    print(f"done in {time.time() - t_start:.0f}s")

    if poi_out:
        print("\n  top named viewing spots:")
        for p in poi_out[:8]:
            label = p["name"] or f"(unnamed {p['kind']})"
            print(f"    {label[:34]:<34} {p['kind']:<9} {p['elev']:>4d} m  "
                  f"clear +{p['clearance']:.1f}deg  {p['totality']}s  {p.get('access','?')}")
    if spots:
        print("\n  top grid spots:")
        for s in spots[:5]:
            print(f"    {s['lat']:.4f},{s['lon']:.4f}  {s['elev']:>4d} m  "
                  f"clear +{s['clearance']:.1f}deg  totality {s['totality']}s  {s['access']}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted")
        sys.exit(1)
