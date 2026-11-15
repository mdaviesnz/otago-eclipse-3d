"""Tests for the precompute's astronomy (precompute/eclipse.py).

These need astronomy-engine, so they are not part of tests/check_static.py, which CI runs on
the standard library alone. Run them before a catalogue rebuild:

    python -m unittest discover -s precompute -p "test_*.py"
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

import eclipse

DUNEDIN = (-45.8788, 170.5028)


def utc(contact) -> datetime:
    return contact.time.Utc().replace(tzinfo=timezone.utc)


def seconds_from(contact, hh: int, mm: int, ss: float) -> float:
    want = datetime(2028, 7, 22, hh, mm, int(ss), int(round((ss % 1) * 1e6)), tzinfo=timezone.utc)
    return abs((utc(contact) - want).total_seconds())


class DeltaT(unittest.TestCase):
    def test_dunedin_contacts_use_the_agreed_delta_t(self):
        # With astronomy-engine's own extrapolation (76.65 s) totality runs 04:15:44.8 to
        # 04:18:39.1 UTC. At 69.2 s every contact is about 9 s later. tests/smoke.spec.mjs pins
        # the browser to the same three instants, each within half a second, so the two agree
        # within one.
        e = eclipse.local_eclipse(*DUNEDIN)
        self.assertLess(seconds_from(e.total_begin, 4, 15, 53.5), 0.5)
        self.assertLess(seconds_from(e.peak, 4, 17, 20.5), 0.5)
        self.assertLess(seconds_from(e.total_end, 4, 18, 47.5), 0.5)


class TotalityLength(unittest.TestCase):
    def test_a_place_near_the_northern_limit(self):
        # All Day Beach, 1.7 m above its 3 m ground. Interpolating the 0.1 degree field reads
        # 20 s here; the browser's copy of the library gives 41.2 s for the same observer.
        self.assertAlmostEqual(
            eclipse.totality_seconds(-45.2123543, 170.8848314, 4.7), 41.2, delta=2.0)

    def test_a_place_outside_the_path_has_none(self):
        self.assertEqual(eclipse.totality_seconds(-43.53095, 172.63643, 10.0), 0.0)   # Christchurch


class PathOfTotality(unittest.TestCase):
    """The limits the overview map draws, at sea level, on one meridian."""

    NUDGE = 0.01   # degrees of latitude, about 1.1 km

    def test_totality_starts_and_stops_at_the_limits(self):
        cut = eclipse.path_at(169.0)
        self.assertGreater(eclipse.totality_seconds(cut.north - self.NUDGE, 169.0), 0)
        self.assertEqual(eclipse.totality_seconds(cut.north + self.NUDGE, 169.0), 0)
        self.assertGreater(eclipse.totality_seconds(cut.south + self.NUDGE, 169.0), 0)
        self.assertEqual(eclipse.totality_seconds(cut.south - self.NUDGE, 169.0), 0)

    def test_limits_sit_just_south_of_the_old_hand_pasted_ones(self):
        # The map used to draw -44.180 and -46.120 at 169 E, from a KML made with a larger ΔT.
        # At 69.2 s both limits lie about 1.8 km (0.016 degrees) further south.
        cut = eclipse.path_at(169.0)
        self.assertAlmostEqual(cut.north, -44.196, delta=0.008)
        self.assertAlmostEqual(cut.south, -46.136, delta=0.008)

    def test_centre_line_is_where_totality_is_longest(self):
        cut = eclipse.path_at(169.0)
        self.assertTrue(cut.south < cut.centre < cut.north)
        longest = eclipse.totality_seconds(cut.centre, 169.0)
        for off in (-0.1, 0.1):
            self.assertGreater(longest, eclipse.totality_seconds(cut.centre + off, 169.0))

    def test_no_path_where_the_sun_has_set(self):
        self.assertIsNone(eclipse.path_at(190.0))

    def test_at_the_sunset_end_the_path_stops_where_the_sun_goes_down(self):
        # East of New Zealand the path runs into sunset. On 181 E the moon's shadow still
        # reaches the ground south of the drawn limit, but the sun has set by then.
        cut = eclipse.path_at(181.0)
        beyond = eclipse.local_eclipse(cut.south - self.NUDGE, 181.0)
        self.assertIsNotNone(beyond.total_begin)
        self.assertLess(beyond.peak.altitude, 0)
        inside = eclipse.local_eclipse(cut.south + self.NUDGE, 181.0)
        self.assertIsNotNone(inside.total_begin)
        self.assertGreater(inside.peak.altitude, 0)


if __name__ == "__main__":
    unittest.main()
