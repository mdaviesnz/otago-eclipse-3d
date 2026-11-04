// Unit tests for the sightline verdict. Pure: no page, no browser, no network.
//
// The shared cases in tests/fixtures/verdict-cases.json are also run against
// precompute/verdict.py by tests/check_static.py, so the browser and the build cannot
// disagree about what counts as clear (docs/adr/0001-precomputed-verdicts.md).

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { judge, evaluateSightline, horizonFromProfile } from "../../verdict.js";

const { cases } = JSON.parse(
  readFileSync(new URL("../fixtures/verdict-cases.json", import.meta.url), "utf8"));

test.describe("shared verdict cases", () => {
  for (const c of cases) {
    test(c.name, () => {
      const v = judge({ scope: c.scope, contacts: c.contacts, totalitySeconds: c.totalitySeconds });
      expect(v.level).toBe(c.expect.level);
      expect(v.grazing).toBe(c.expect.grazing);
      expect(v.scope).toBe(c.scope);
      if ("nearEdge" in c.expect) expect(v.nearEdge).toBe(c.expect.nearEdge);
    });
  }
});

// The sun's track through a Queenstown-like eclipse: high in the north-west, sinking west.
const SUN = [
  { contact: "partialBegin", sunAlt: 18.0, sunAz: 330 },
  { contact: "totalBegin",   sunAlt: 10.1, sunAz: 312.2 },
  { contact: "peak",         sunAlt: 10.0, sunAz: 312 },
  { contact: "totalEnd",     sunAlt: 9.9,  sunAz: 311.8 },
  { contact: "partialEnd",   sunAlt: 1.0,  sunAz: 296 },
];
const flat = (angle) => () => ({ angle, ridgeDist: 5000, ridgeHeight: 100 });

test.describe("evaluateSightline", () => {
  test("open horizon: clear, with each contact's clearance and ridge", () => {
    const v = evaluateSightline({ scope: "eclipse", contacts: SUN, horizonAt: flat(0.5), totalitySeconds: 150 });
    expect(v.level).toBe("clear");
    const peak = v.contacts.find((c) => c.contact === "peak");
    expect(peak.horizon).toBe(0.5);
    expect(peak.clearance).toBeCloseTo(9.5, 9);
    expect(peak.ridgeDist).toBe(5000);
    expect(peak.ridgeHeight).toBe(100);
    expect(v.focus).toBe(peak);
  });

  test("a ridge on the sun's bearing at maximum blocks totality but not first contact", () => {
    // 20.6 deg of skyline between 300 and 320 deg, as behind Queenstown.
    const ridge = (az) => ({ angle: az >= 300 && az <= 320 ? 20.6 : 2.0, ridgeDist: 1200, ridgeHeight: 1700 });
    const v = evaluateSightline({ scope: "eclipse", contacts: SUN, horizonAt: ridge, totalitySeconds: 150 });
    expect(v.level).toBe("partial");
    expect(v.focus.blocked).toBe(true);
    expect(v.focus.clearance).toBeCloseTo(-10.6, 9);
    expect(v.partialTotality).toBe(true);
    expect(v.contacts.find((c) => c.contact === "partialBegin").blocked).toBe(false);
  });

  test("outside the eclipse the focus is the single 'now' contact", () => {
    const v = evaluateSightline({ scope: "eclipse", contacts: [{ contact: "now", sunAlt: 30, sunAz: 0 }],
      horizonAt: flat(1) });
    expect(v.level).toBe("clear");
    expect(v.focus.contact).toBe("now");
    expect(v.nearEdge).toBe(false);
  });
});

test.describe("horizonFromProfile", () => {
  const profile = { azFrom: 300, azStep: 1, angles: [5, 6, 8, 7], ridgeDist: [900, 1000, 2000, 3000], ridgeElev: [500, 600, 700, 800] };
  const at = horizonFromProfile(profile);

  test("a bearing on a stored sample returns that sample", () => {
    expect(at(302)).toEqual({ angle: 8, ridgeDist: 2000, ridgeHeight: 700 });
  });

  test("between samples the angle interpolates and the ridge comes from the nearer one", () => {
    const h = at(301.25);
    expect(h.angle).toBeCloseTo(6.5, 9);
    expect(h.ridgeDist).toBe(1000);
    expect(h.ridgeHeight).toBe(600);
  });

  test("beyond either end it holds the end value rather than extrapolating", () => {
    expect(at(290).angle).toBe(5);
    expect(at(310).angle).toBe(7);
  });
});
