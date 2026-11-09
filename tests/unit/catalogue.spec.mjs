// The rules for reading the catalogue. No browser needed: catalogue.js is pure.

import { test, expect } from "@playwright/test";
import {
  haversineM, bearingDeg, matchesAccess, thinNearby, nearestClearSpot, betterSpotNearby, compareSpots,
  rankSpots, declutter,
} from "../../catalogue.js";

const spot = (over) => ({
  name: "Spot", lat: -45, lon: 169, level: "clear", clearance: 5, totality: 170, clearProb: 40,
  access: "sealed", accessSub: "sealed_road", kind: "viewpoint", publicAccess: true, ...over,
});

test.describe("distance and bearing", () => {
  test("one degree of latitude is about 111 km", () => {
    expect(haversineM(-45, 169, -46, 169) / 1000).toBeCloseTo(111.19, 1);
  });
  test("the same point is zero metres away", () => {
    expect(haversineM(-45.1, 169.2, -45.1, 169.2)).toBe(0);
  });
  test("bearings run clockwise from north", () => {
    expect(bearingDeg(-45, 169, -44, 169)).toBeCloseTo(0, 5);
    expect(bearingDeg(-45, 169, -46, 169)).toBeCloseTo(180, 5);
    expect(bearingDeg(-45, 169, -45, 170)).toBeGreaterThan(89);
    expect(bearingDeg(-45, 169, -45, 170)).toBeLessThan(91);
    expect(bearingDeg(-45, 169, -45, 168)).toBeGreaterThan(269);
  });
});

test.describe("access filters", () => {
  const sealed = spot({});
  const gravel = spot({ access: "track", accessSub: "gravel_road" });
  const fourWd = spot({ access: "track", accessSub: "4wd_track" });
  const gridTrack = spot({ access: "track", accessSub: undefined });
  const walk = spot({ access: "foot", accessSub: "walking_track" });
  const cycle = spot({ access: "foot", accessSub: "cycle_trail" });
  const offTrack = spot({ access: "none", accessSub: "off_track" });

  test("any keeps everything", () => {
    for (const s of [sealed, gravel, walk, offTrack]) expect(matchesAccess(s, "any")).toBe(true);
  });
  test("drive means sealed or unsealed road, never on foot", () => {
    expect([sealed, gravel, fourWd, walk, offTrack].map((s) => matchesAccess(s, "drive")))
      .toEqual([true, true, true, false, false]);
  });
  test("tiers are exclusive, so sealed excludes tracks", () => {
    expect(matchesAccess(gravel, "sealed")).toBe(false);
    expect(matchesAccess(sealed, "track")).toBe(false);
  });
  test("road means what a normal car can reach", () => {
    expect([sealed, gravel, fourWd, gridTrack, walk].map((s) => matchesAccess(s, "road")))
      .toEqual([true, true, false, false, false]);
  });
  test("the track tier includes gravel roads", () => {
    expect(matchesAccess(gravel, "track")).toBe(true);
    expect(matchesAccess(fourWd, "track")).toBe(true);
  });
  test("4WD only excludes gravel but keeps grid spots that cannot say", () => {
    expect(matchesAccess(fourWd, "4wd_track")).toBe(true);
    expect(matchesAccess(gravel, "4wd_track")).toBe(false);
    expect(matchesAccess(gridTrack, "4wd_track")).toBe(true);
  });
  test("sub-types match on their own", () => {
    expect(matchesAccess(cycle, "cycle_trail")).toBe(true);
    expect(matchesAccess(walk, "cycle_trail")).toBe(false);
    expect(matchesAccess(gravel, "gravel_road")).toBe(true);
  });
  test("a spot with no recorded access counts as off-track", () => {
    expect(matchesAccess(spot({ access: undefined, accessSub: undefined }), "none")).toBe(true);
  });
});

test.describe("thinNearby", () => {
  test("keeps the first of two names for one place", () => {
    const a = spot({ name: "Lookout" });
    const b = spot({ name: "Rest area", lat: -45.001 });     // ~111 m away
    expect(thinNearby([a, b])).toEqual([a]);
  });
  test("keeps different places", () => {
    const a = spot({ name: "North" });
    const b = spot({ name: "South", lat: -45.01 });          // ~1.1 km away
    expect(thinNearby([a, b])).toHaveLength(2);
  });
  test("the same name counts as one place out to 2 km", () => {
    const a = spot({ name: "Crown Range Road lookout" });
    const near = spot({ name: "Crown Range Road lookout", lat: -45.01 });
    const far = spot({ name: "Crown Range Road lookout", lat: -45.03 });  // ~3.3 km away
    expect(thinNearby([a, near, far])).toEqual([a, far]);
  });
});

test.describe("nearestClearSpot", () => {
  const near = (over) => spot({ name: "Close", lat: -45.01, ...over });
  const cat = (...pois) => ({ pois });

  test("picks the closest qualifying spot and says how far and which way", () => {
    const r = nearestClearSpot(cat(spot({ name: "Far", lat: -45.2 }), near({})), -45, 169);
    expect(r.spot.name).toBe("Close");
    expect(r.km).toBeCloseTo(1.11, 1);
    expect(r.bearing).toBeCloseTo(180, 5);
  });
  for (const [why, over] of [
    ["not verified as public", { publicAccess: false }],
    ["of unknown tenure", { publicAccess: undefined }],
    ["not on a sealed road", { access: "track" }],
    ["partly blocked", { level: "partial" }],
    ["a campsite", { kind: "campsite" }],
    ["a summit", { kind: "peak" }],
    ["short of a comfortable margin", { clearance: 2.9 }],
    ["short on totality", { totality: 119 }],
    ["named after its own coordinates", { name: "Lookout (-45.062, 168.462)" }],
    ["unnamed", { name: "" }],
  ]) {
    test(`never suggests a spot that is ${why}`, () => {
      expect(nearestClearSpot(cat(near(over)), -45, 169)).toBeNull();
    });
  }
  test("lookout towers and picnic areas qualify", () => {
    expect(nearestClearSpot(cat(near({ kind: "tower" })), -45, 169)).not.toBeNull();
    expect(nearestClearSpot(cat(near({ kind: "picnic" })), -45, 169)).not.toBeNull();
  });
  test("copes with no catalogue", () => {
    expect(nearestClearSpot(null, -45, 169)).toBeNull();
  });
});

test.describe("betterSpotNearby", () => {
  const cat = (...pois) => ({ pois });
  const at = (km, over) => spot({ name: `${km} km`, lat: -45 - km / 111.19, ...over });
  const better = (here, ...pois) => betterSpotNearby(cat(...pois), here, -45, 169);

  test("from a blocked place, the nearest clear spot", () => {
    const r = better({ level: "blocked", clearance: -8, totality: 178 }, at(9), at(4));
    expect([r.spot.name, r.why]).toEqual(["4 km", "clear"]);
  });
  test("from outside the path, a spot with totality at all", () => {
    expect(better({ level: "clear", clearance: 6, totality: 0 }, at(40)).why).toBe("clear");
  });
  test("from a tight margin, the nearest spot with room to spare", () => {
    const here = { level: "clear", clearance: 1.4, totality: 174 };
    const r = better(here, at(1, { clearance: 2.9 }), at(2, { clearance: 5, totality: 174 }));
    expect([r.spot.name, r.why]).toEqual(["2 km", "margin"]);
  });
  test("from a comfortable margin, the nearest spot with a longer totality", () => {
    const here = { level: "clear", clearance: 7.5, totality: 150 };
    const r = better(here, at(1, { totality: 152 }), at(38, { totality: 177 }));
    expect([r.spot.name, r.why]).toEqual(["38 km", "longer"]);
  });
  test("nothing, when the only gains are a few seconds or a better chance of clear sky", () => {
    const here = { level: "clear", clearance: 8, totality: 178, clearProb: 43 };
    expect(better(here, at(1, { totality: 177, clearProb: 60 }), at(2, { clearance: 12 }))).toBeNull();
  });
});

test.describe("declutter", () => {
  const at = (x, y, name) => ({ x, y, name });
  const project = (s) => s;
  test("keeps the first spot in each cell", () => {
    const a = at(5, 5, "best"), b = at(20, 20, "worse"), c = at(40, 5, "elsewhere");
    expect(declutter([a, b, c], project, 34)).toEqual([a, c]);
  });
  test("a smaller cell keeps more", () => {
    const list = [at(5, 5), at(20, 20), at(40, 5)];
    expect(declutter(list, project, 10)).toHaveLength(3);
  });
});

test.describe("ranking", () => {
  test("enough clearance beats a longer totality", () => {
    const good = spot({ clearance: 3, totality: 120 });
    const tight = spot({ clearance: 0.9, totality: 180 });
    expect(compareSpots(good, tight)).toBeLessThan(0);
  });
  test("past the comfortable margin, more clearance adds nothing", () => {
    const three = spot({ clearance: 3, clearProb: 50 });
    const twelve = spot({ clearance: 12, clearProb: 40 });
    expect(rankSpots([twelve, three])[0]).toBe(three);
  });
  test("longer totality beats a better chance of clear sky", () => {
    const long = spot({ totality: 178, clearProb: 30 });
    const short = spot({ totality: 150, clearProb: 55 });
    expect(rankSpots([short, long])[0]).toBe(long);
  });
  test("totalities within one 15 s step count as equal, so the weather decides", () => {
    const longer = spot({ totality: 178, clearProb: 30 });
    const clearer = spot({ totality: 174, clearProb: 50 });
    expect(rankSpots([longer, clearer])[0]).toBe(clearer);
  });
  test("a partly blocked spot ranks last however large its clearance", () => {
    const partial = spot({ level: "partial", clearance: 8, totality: 180, clearProb: 55 });
    const tight = spot({ clearance: 0.5, totality: 100, clearProb: 30 });
    expect(rankSpots([partial, tight])[1]).toBe(partial);
  });
  test("a missing chance of clear sky ranks below a known one", () => {
    const unknown = spot({ clearProb: undefined });
    expect(rankSpots([unknown, spot({ clearProb: 20 })])[1]).toBe(unknown);
  });
  test("rankSpots leaves its input in place", () => {
    const list = [spot({ clearance: 0.5 }), spot({ clearance: 5 })];
    const first = list[0];
    rankSpots(list);
    expect(list[0]).toBe(first);
  });
});
