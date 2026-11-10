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


def utc(event) -> datetime:
    return event.time.Utc().replace(tzinfo=timezone.utc)


def seconds_from(event, hh: int, mm: int, ss: float) -> float:
    want = datetime(2028, 7, 22, hh, mm, int(ss), int(round((ss % 1) * 1e6)), tzinfo=timezone.utc)
    return abs((utc(event) - want).total_seconds())


class DeltaT(unittest.TestCase):
    def test_dunedin_contacts_use_the_agreed_delta_t(self):
        # With astronomy-engine's own extrapolation (76.65 s) totality runs 04:15:44.8 to
        # 04:18:39.1 UTC. At 69.2 s every contact is about 9 s later. tests/smoke.spec.mjs pins
        # the browser to the same three instants.
        e = eclipse.local_eclipse(*DUNEDIN)
        self.assertLess(seconds_from(e.total_begin, 4, 15, 53.5), 1.0)
        self.assertLess(seconds_from(e.peak, 4, 17, 20.5), 1.0)
        self.assertLess(seconds_from(e.total_end, 4, 18, 47.5), 1.0)


if __name__ == "__main__":
    unittest.main()
