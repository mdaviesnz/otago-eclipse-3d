"""Final verification of viewpoints.json."""
import json
from collections import Counter
from pathlib import Path

d = json.loads((Path(__file__).parent.parent / "viewpoints.json").read_text(encoding="utf-8"))

print("generated :", d["generated"])
print("osmGaps   :", d["osmGaps"] or "(none)")
print("counts    : spots=%d  pois=%d" % (d["count"], d["poiCount"]))
print()
print("spot access mix:", dict(Counter(s["access"] for s in d["spots"])))
print("poi  access mix:", dict(Counter(p["access"] for p in d["pois"])))
print("poi  kinds     :", dict(Counter(p["kind"] for p in d["pois"])))
print()
for tier in ("sealed", "track", "foot"):
    for label, arr in (("spot", d["spots"]), ("poi ", d["pois"])):
        xs = [s for s in arr if s.get("access") == tier]
        if not xs:
            print("  best %s %-7s: none" % (label, tier))
            continue
        b = max(xs, key=lambda s: s["clearance"])
        name = b.get("name") or b.get("kind", "")
        print("  best %s %-7s: %.4f,%.4f  %4d m  +%.1f deg  %3ds  %s"
              % (label, tier, b["lat"], b["lon"], b["elev"], b["clearance"], b["totality"], name))
print()
partial = [p for p in d["pois"] if not p["wholeTotality"]]
print("POIs blocked for part of totality:", len(partial))
for p in partial[:5]:
    print("   %-28s clearBegin %+.1f  max %+.1f  clearEnd %+.1f"
          % ((p.get("name") or "(unnamed)")[:28], p["clearBegin"], p["clearance"], p["clearEnd"]))
