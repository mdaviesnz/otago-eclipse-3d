// The skyline strip and the verdict sentence. No browser needed: skyline.js is pure.

import { test, expect } from "@playwright/test";
import {
  horizonAt, chartCeiling, skylineScales, skylinePath, splitByVisibility, secondsAtX,
  snapToContact, adjacentContact, verdictPredicate, verdictReason,
} from "../../skyline.js";
import { nearEdgeNote } from "../../catalogue.js";

const profile = [{ az: 300, angle: 10 }, { az: 310, angle: 20 }, { az: 320, angle: 10 }];

test.describe("the horizon", () => {
  test("interpolates between samples and holds at the ends", () => {
    expect(horizonAt(profile, 305)).toBeCloseTo(15);
    expect(horizonAt(profile, 310)).toBe(20);
    expect(horizonAt(profile, 290)).toBe(10);
    expect(horizonAt(profile, 330)).toBe(10);
  });
  test("the chart leaves room above the highest thing on it", () => {
    expect(chartCeiling(profile, [], [{ alt: 5 }])).toBe(23);
    expect(chartCeiling(null, [], [{ alt: 16.2 }])).toBe(20);
    expect(chartCeiling(null, null, [{ alt: 2 }])).toBe(12);
  });
});

test.describe("scales", () => {
  const { X, Y, base } = skylineScales({ width: 100, height: 120, topPad: 20, basePad: 20, azLo: 300, azHi: 320, yMax: 20 });
  test("bearing runs across and altitude runs up", () => {
    expect(X(300)).toBe(0);
    expect(X(320)).toBe(100);
    expect(base).toBe(100);
    expect(Y(0)).toBe(100);
    expect(Y(20)).toBe(20);
  });
  test("a sun below the horizon stays on the baseline", () => {
    expect(Y(-3)).toBe(100);
  });
  test("the skyline path visits every sample", () => {
    expect(skylinePath(profile, X, Y)).toBe("M0.0 60.0 L50.0 20.0 L100.0 60.0");
  });
});

test.describe("the sun's track", () => {
  const track = [
    { t: 0, az: 320, alt: 25 },
    { t: 100, az: 310, alt: 15 },
    { t: 200, az: 300, alt: 5 },
  ];
  const X = (az) => (az - 300) * 10;

  test("splits where it passes behind the ridge, sharing the join", () => {
    const runs = splitByVisibility(track, profile);
    expect(runs.map((r) => r.visible)).toEqual([true, false]);
    expect(runs[1].points[0]).toBe(runs[0].points[runs[0].points.length - 1]);
  });
  test("is one visible run when the skyline is unknown", () => {
    const runs = splitByVisibility(track, null);
    expect(runs).toHaveLength(1);
    expect(runs[0].visible).toBe(true);
  });
  test("position maps to time, even though the sun moves right to left", () => {
    expect(secondsAtX(track, X, 100)).toBeCloseTo(100);
    expect(secondsAtX(track, X, 50)).toBeCloseTo(150);
  });
  test("past either end the end holds", () => {
    expect(secondsAtX(track, X, 500)).toBe(0);
    expect(secondsAtX(track, X, -50)).toBe(200);
  });
  test("an empty track has no time", () => {
    expect(secondsAtX([], X, 10)).toBeNull();
  });
});

test.describe("contacts", () => {
  const contacts = [{ t: 100, x: 300 }, { t: 200, x: 200 }, { t: 300, x: 100 }];
  test("the pointer snaps to a contact within tolerance", () => {
    expect(snapToContact(208, contacts, 16)).toBe(contacts[1]);
    expect(snapToContact(250, contacts, 16)).toBeNull();
  });
  test("the nearest contact wins", () => {
    expect(snapToContact(150, [{ t: 1, x: 140 }, { t: 2, x: 155 }], 16).t).toBe(2);
  });
  test("next and previous step through them in time", () => {
    expect(adjacentContact(contacts, 150, 1).t).toBe(200);
    expect(adjacentContact(contacts, 150, -1).t).toBe(100);
    expect(adjacentContact(contacts, 200, 1).t).toBe(300);
    expect(adjacentContact(contacts, 300, 1)).toBeNull();
    expect(adjacentContact(contacts, 100, -1)).toBeNull();
  });
});

test.describe("the verdict sentence", () => {
  const say = (o) => verdictPredicate({ scope: "totality", hasPeak: true, grazing: false, ...o });
  test("inside the path it is about totality", () => {
    expect(say({ level: "clear" })).toBe(" sees totality.");
    expect(say({ level: "clear", grazing: true })).toBe(" sees totality, only just.");
    expect(say({ level: "partial" })).toBe(" loses part of totality.");
    expect(say({ level: "blocked" })).toBe(" loses totality.");
  });
  test("outside the path it never promises totality", () => {
    for (const level of ["clear", "partial", "blocked", "below"]) {
      expect(say({ level, scope: "eclipse" })).not.toContain("totality");
    }
    expect(say({ level: "clear", scope: "eclipse" })).toBe(" sees a partial eclipse only.");
    expect(say({ level: "clear", scope: "eclipse", hasPeak: false })).toBe(" sees no eclipse.");
  });
});

test.describe("the reason", () => {
  const base = { level: "clear", scope: "totality", peakPct: "93%", peakTime: "4:16 pm", totalitySeconds: 178, nearEdge: false };
  const focus = { az: 312, alt: 10, horizon: 1.9, ridgeDist: 0, blocked: false, below: false, grazing: false };

  test("a blocked town names the ridge and measures it in fists", () => {
    const r = verdictReason({ ...base, level: "blocked", focus: { ...focus, alt: 10, horizon: 20.8, ridgeDist: 1888, blocked: true } });
    expect(r).toBe("A ridge 1.9 km to the north-west stands about one fist above the sun at 4:16 pm.");
  });
  test("with no known ridge distance it says terrain", () => {
    const r = verdictReason({ ...base, level: "blocked", focus: { ...focus, horizon: 20.8, blocked: true } });
    expect(r).toContain("Terrain to the north-west");
  });
  test("a clear place says where to look and by how much", () => {
    const r = verdictReason({ ...base, focus: { ...focus, alt: 8.4, horizon: 6.9 } });
    expect(r).toBe("Look north-west, about one fist above the horizon. The sun clears the skyline by about one finger.");
  });
  test("outside the path the warning about glasses stays", () => {
    const r = verdictReason({ ...base, scope: "eclipse", focus });
    expect(r).toContain("93% of the sun is covered at 4:16 pm");
    expect(r).toContain("glasses");
  });
  test("near the edge it says totality is uncertain and where to go", () => {
    const r = verdictReason({ ...base, nearEdge: true, totalitySeconds: 48, focus });
    expect(r).toContain(nearEdgeNote(48));
    expect(r).toContain("about 48 seconds");
  });
  test("away from the edge it says nothing about it", () => {
    expect(verdictReason({ ...base, focus })).not.toContain("edge of the path");
  });
  test("a grazing sun says so", () => {
    expect(verdictReason({ ...base, focus: { ...focus, grazing: true } })).toContain("touches the skyline");
  });
});
