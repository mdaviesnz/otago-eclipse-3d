"""The shipped catalogue against a fresh calculation for every place in it.

Run after a rebuild, before committing viewpoints.json:

    python -m unittest discover -s precompute -p "test_*.py"

A failure here means the catalogue was built with a different ΔT or library than the code now
uses, or that a stored figure was interpolated where it should have been computed.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import eclipse

CATALOGUE = json.loads(
    (Path(__file__).parent.parent / "viewpoints.json").read_text(encoding="utf-8"))
EYE_HEIGHT = CATALOGUE["params"]["eyeHeightM"]


def label(row: dict) -> str:
    return f"{row.get('name') or 'grid spot'} ({row['lat']}, {row['lon']})"


class StoredAgainstLive(unittest.TestCase):
    def rows(self):
        for key in ("spots", "pois", "presets"):
            yield from CATALOGUE[key]

    def test_stored_totality_is_each_place_s_own(self):
        wrong = []
        for r in self.rows():
            live = eclipse.totality_seconds(r["lat"], r["lon"], r["elev"] + EYE_HEIGHT)
            if abs(live - r["totality"]) > 2.0:
                wrong.append(f"{label(r)}: stored {r['totality']} s, computed {live:.1f} s")
        self.assertEqual(wrong, [], f"{len(wrong)} entries differ by more than 2 s")

    def test_stored_sun_altitude_at_maximum(self):
        wrong = []
        for r in self.rows():
            live = eclipse.local_eclipse(r["lat"], r["lon"], r["elev"] + EYE_HEIGHT).peak.altitude
            if abs(live - r["sunAlt"]) > 0.05:
                wrong.append(f"{label(r)}: stored {r['sunAlt']}, computed {live:.2f}")
        self.assertEqual(wrong, [], f"{len(wrong)} entries differ by more than 0.05 degrees")


if __name__ == "__main__":
    unittest.main()
