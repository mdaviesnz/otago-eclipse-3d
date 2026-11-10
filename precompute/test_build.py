"""Tests for the catalogue build (precompute/build_viewpoints.py).

These need the precompute dependencies, so they are not part of tests/check_static.py. Run
them before a catalogue rebuild:

    python -m unittest discover -s precompute -p "test_*.py"
"""

from __future__ import annotations

import unittest
from unittest import mock

import numpy as np

import build_viewpoints as build

TILE = np.full((4, 4), 100, dtype=np.int16)


def fetch_all_but(*lost):
    """A stand-in tile fetch that fails for the given (x, y) tiles, however often it is asked."""
    def fetch(z, x, y, session, retries=3):
        return None if (x, y) in lost else TILE
    return fetch


class MissingTerrain(unittest.TestCase):
    """A tile that cannot be fetched used to be filled with sea level, which lowers the horizon
    of every spot looking across it and can store a blocked place as clear."""

    def test_region_mosaic_refuses_to_build_with_a_tile_missing(self):
        with mock.patch.object(build, "fetch_tile", fetch_all_but((1985, 1311))):
            with self.assertRaises(build.MissingTiles) as raised:
                build.build_dem(11)
        self.assertEqual(raised.exception.tiles, [(11, 1985, 1311)])
        self.assertIn("11/1985/1311", str(raised.exception))

    def test_region_mosaic_builds_when_every_tile_arrives(self):
        with mock.patch.object(build, "fetch_tile", fetch_all_but()):
            dem = build.build_dem(11)
        self.assertEqual(float(dem.sample(np.array([-45.0]), np.array([169.0]))[0]), 100.0)

    def test_near_field_mosaic_refuses_too(self):
        with mock.patch.object(build, "fetch_tile", fetch_all_but((7933, 5245))):
            with self.assertRaises(build.MissingTiles):
                build.build_dem_bbox(13, -45.05, -45.0, 168.6, 168.7)

    def test_missing_tiles_are_recorded_when_explicitly_allowed(self):
        with mock.patch.object(build, "fetch_tile", fetch_all_but((1985, 1311))):
            build.MISSING_TILES.clear()
            build.build_dem(11, allow_missing=True)
        self.assertEqual(build.MISSING_TILES, ["11/1985/1311"])
        build.MISSING_TILES.clear()


class StoredTotality(unittest.TestCase):
    """Totality length falls away steeply near the edge of the path, so reading it off the
    0.1 degree field by interpolation ran up to 20 s short there."""

    def test_each_kept_row_stores_its_own_totality(self):
        beach = {"name": "All Day Beach", "lat": -45.2123543, "lon": 170.8848314, "elev": 3,
                 "totality": 20}                      # what interpolation gave
        rows = build.with_direct_totality([beach])
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["totality"], 41, delta=2)
        self.assertIsInstance(rows[0]["totality"], int)

    def test_a_row_with_no_totality_of_its_own_is_dropped_not_added(self):
        christchurch = {"lat": -43.53095, "lon": 172.63643, "elev": 8, "totality": 5}
        self.assertEqual(build.with_direct_totality([christchurch]), [])


if __name__ == "__main__":
    unittest.main()
