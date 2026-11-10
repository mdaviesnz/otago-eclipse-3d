"""The eclipse as the precompute sees it: one ΔT, and local circumstances for a place.

Importing this module fixes ΔT for every astronomy-engine call that follows, so import it
before computing anything.
"""

from __future__ import annotations

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
