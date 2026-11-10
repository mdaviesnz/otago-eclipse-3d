// When the diamond ring shows. No browser needed: eclipse-time.js is pure.
//
// It used to be tied to how much of the sun was covered, which lit it up one to two minutes
// before totality. Someone reading it as the cue to take their eclipse glasses off would be
// looking at a sun that is still blinding.

import { test, expect } from "@playwright/test";
import { diamondRing, DIAMOND_RING_SECONDS } from "../../eclipse-time.js";

// Seconds on any clock: totality from 1000 to 1170.
const C2 = 1000, C3 = 1170;

test.describe("the diamond ring", () => {
  test("is not showing a minute before second contact", () => {
    expect(diamondRing(C2 - 60, C2, C3)).toBe(0);
  });

  test("is showing five seconds before second contact", () => {
    expect(diamondRing(C2 - 5, C2, C3)).toBeGreaterThan(0);
  });

  test("is not showing during totality", () => {
    expect(diamondRing((C2 + C3) / 2, C2, C3)).toBe(0);
    expect(diamondRing(C2, C2, C3)).toBe(0);
    expect(diamondRing(C3, C2, C3)).toBe(0);
  });

  test("is showing five seconds after third contact", () => {
    expect(diamondRing(C3 + 5, C2, C3)).toBeGreaterThan(0);
  });

  test("is over a minute after third contact", () => {
    expect(diamondRing(C3 + 60, C2, C3)).toBe(0);
  });

  test("never shows where there is no totality", () => {
    for (const now of [C2 - 5, C2, C3 + 5]) expect(diamondRing(now, null, null)).toBe(0);
  });

  test("lasts about ten seconds each side and is strongest at the contact", () => {
    expect(DIAMOND_RING_SECONDS).toBe(10);
    expect(diamondRing(C2 - DIAMOND_RING_SECONDS - 1, C2, C3)).toBe(0);
    expect(diamondRing(C2 - 1, C2, C3)).toBeGreaterThan(diamondRing(C2 - 8, C2, C3));
    expect(diamondRing(C3 + 1, C2, C3)).toBeGreaterThan(diamondRing(C3 + 8, C2, C3));
    expect(diamondRing(C2 - 0.001, C2, C3)).toBeLessThanOrEqual(1);
  });
});
