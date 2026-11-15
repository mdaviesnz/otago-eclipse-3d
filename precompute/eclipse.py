"""The eclipse as the precompute sees it: one ΔT, and local circumstances for a place.

Importing this module fixes ΔT for every astronomy-engine call that follows, so import it
before computing anything.
"""

from __future__ import annotations

from typing import NamedTuple

import astronomy as A
import astronomy.astronomy as _engine

# ΔT (Terrestrial Time minus Universal Time) for the 22 July 2028 eclipse, in seconds.
#
# astronomy-engine extrapolates ΔT with the Espenak & Meeus polynomial, which gives 76.65 s for
# this date. Measured values put 2028 near 69 s. The difference runs every contact about 9 s
# early and puts the path of totality about 1.8 km too far north.
#
# The same number lives in eclipse-time.js for the browser. tests/check_static.py fails if they
# differ.
DELTA_T_SECONDS = 69.2


def _fixed_delta_t(ut: float) -> float:
    return DELTA_T_SECONDS


# The Python library has no public hook. Its time conversions call the module-level name
# `_DeltaT`; replacing the public-looking `DeltaT_EspenakMeeus` changes nothing.
if not hasattr(_engine, "_DeltaT"):
    raise RuntimeError("astronomy-engine no longer has _DeltaT, so ΔT cannot be fixed. "
                       "Check the pinned version against eclipse.py.")
_engine._DeltaT = _fixed_delta_t

SEARCH_FROM = A.Time.Make(2028, 7, 21, 0, 0, 0)


def local_eclipse(lat: float, lon: float, height: float = 0.0):
    """Contacts of the eclipse for an observer at this position and height in metres."""
    return A.SearchLocalSolarEclipse(SEARCH_FROM, A.Observer(float(lat), float(lon), float(height)))


def totality_seconds(lat: float, lon: float, height: float = 0.0) -> float:
    """Seconds between second and third contact for this observer, or 0 outside the path."""
    e = local_eclipse(lat, lon, height)
    if e.total_begin is None or e.total_end is None:
        return 0.0
    return (e.total_end.time.ut - e.total_begin.time.ut) * 86400.0


class PathCut(NamedTuple):
    """Where one meridian crosses the path of totality: latitudes in degrees, at sea level.

    `centre` is None where the centre line itself has run into sunset.
    """
    north: float
    centre: float | None
    south: float


# Latitudes to search for the path on a meridian. It is over 1 degree wide over land.
SEARCH_FROM_LAT, SEARCH_TO_LAT, SEARCH_STEP = -25.0, -56.0, 0.5
LIMIT_TOLERANCE = 1e-4     # degrees of latitude, about 11 m
CENTRE_TOLERANCE = 1e-3    # degrees of latitude, about 110 m
AT_THE_EDGE = 0.01         # a centre this close to a limit is the limit, not a centre


def totality_is_seen(lat: float, lon: float) -> bool:
    """Totality happens here at sea level, with the sun above the horizon at maximum.

    The library reports a totality wherever the moon's shadow reaches the ground, sun up or
    not. East of New Zealand the path runs into sunset, and there the edge of what anyone can
    see is the sunset line, not the edge of the shadow.
    """
    e = local_eclipse(lat, lon)
    return e.total_begin is not None and e.total_end is not None and e.peak.altitude > 0


def _edge(inside: float, outside: float, lon: float) -> float:
    """The latitude between an inside and an outside point where totality stops being seen."""
    while abs(inside - outside) > LIMIT_TOLERANCE:
        mid = (inside + outside) / 2.0
        if totality_is_seen(mid, lon):
            inside = mid
        else:
            outside = mid
    return (inside + outside) / 2.0


def _longest(south: float, north: float, lon: float) -> float:
    """The latitude between the limits where totality lasts longest."""
    lo, hi = south, north
    while hi - lo > CENTRE_TOLERANCE:
        a, b = lo + (hi - lo) / 3.0, hi - (hi - lo) / 3.0
        if totality_seconds(a, lon) < totality_seconds(b, lon):
            lo = a
        else:
            hi = b
    return (lo + hi) / 2.0


def path_at(lon: float) -> PathCut | None:
    """The northern limit, centre line and southern limit on this meridian, or None where the
    meridian misses the part of the path that sees totality."""
    lat = SEARCH_FROM_LAT
    while lat >= SEARCH_TO_LAT and not totality_is_seen(lat, lon):
        lat -= SEARCH_STEP
    if lat < SEARCH_TO_LAT:
        return None
    north = _edge(lat, lat + SEARCH_STEP, lon)
    while totality_is_seen(lat, lon):
        lat -= SEARCH_STEP
    south = _edge(lat + SEARCH_STEP, lat, lon)
    centre = _longest(south, north, lon)
    # Longest at the very edge means the true centre line lies beyond it, in the dark.
    if min(centre - south, north - centre) < AT_THE_EDGE:
        centre = None
    return PathCut(north, centre, south)
