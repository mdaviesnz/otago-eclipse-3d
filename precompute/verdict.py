"""The sightline verdict for catalogue spots and presets. See GLOSSARY.md, "Verdicts".

Standard library only, so tests/check_static.py can import it in CI without the precompute
dependencies.

This is the totality-scope half of the rule in verdict.js. build_viewpoints.py uses it to write
`level` (and `grazing` when true) into viewpoints.json; the browser reads those fields instead
of judging the catalogue itself. tests/fixtures/verdict-cases.json pins the two implementations
together: change both, and the cases, or neither (docs/adr/0001-precomputed-verdicts.md).
"""

from __future__ import annotations

import math

SUN_RADIUS_DEG = 0.26  # apparent solar semi-diameter (~15.7 arcmin)

TOTALITY_CONTACTS = ("totalBegin", "peak", "totalEnd")


def contact_state(clearance: float | None) -> str:
    """'blocked', 'grazing' or 'clear' for one contact.

    Clearance of zero or less is blocked: the sun's centre is on or behind the skyline. A
    missing clearance (no such contact here) is blocked too.
    """
    if clearance is None or not math.isfinite(clearance) or clearance <= 0:
        return "blocked"
    return "grazing" if clearance < SUN_RADIUS_DEG else "clear"


def judge_totality(clearances: dict[str, float | None]) -> dict:
    """Verdict over second contact, maximum and third contact.

    `clearances` maps 'totalBegin', 'peak' and 'totalEnd' to the clearance in degrees, already
    rounded to what will be stored, so the stored level always agrees with the stored numbers.
    """
    states = [contact_state(clearances.get(k)) for k in TOTALITY_CONTACTS]
    n_blocked = states.count("blocked")
    level = ("clear" if n_blocked == 0
             else "blocked" if n_blocked == len(states)
             else "partial")
    return {"level": level, "grazing": "grazing" in states}


def verdict_fields(clear_begin: float | None, clearance: float | None,
                   clear_end: float | None) -> dict:
    """The verdict fields for one catalogue row: `level`, plus `grazing` only when true."""
    v = judge_totality({"totalBegin": clear_begin, "peak": clearance, "totalEnd": clear_end})
    return {"level": v["level"], **({"grazing": True} if v["grazing"] else {})}
