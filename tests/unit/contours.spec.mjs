// Contour drawing. No browser needed: contours.js is pure.

import { test, expect } from "@playwright/test";
import {
  terrariumMetres, worldPixel, metresPerPixel, tilesCovering, sampleBilinear, contourImage,
} from "../../contours.js";

test("Terrarium pixels decode to metres", () => {
  expect(terrariumMetres(128, 0, 0)).toBe(0);
  expect(terrariumMetres(129, 54, 128)).toBeCloseTo(310.5, 3);
});

test("the world pixel of Queenstown lands in the right slippy-map tile", () => {
  const p = worldPixel(-45.0312, 168.6626, 11, 512);
  expect(Math.floor(p.x / 512)).toBe(1983);
  expect(Math.floor(p.y / 512)).toBe(1311);
});

test("a zoom 11 pixel is about 27 m at Otago's latitude", () => {
  expect(metresPerPixel(-45, 11, 512)).toBeCloseTo(27.0, 0);
});

test("a rectangle crossing a tile edge needs both tiles", () => {
  expect(tilesCovering(500, 10, 520, 20, 512)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  expect(tilesCovering(10, 10, 20, 20, 512)).toEqual([{ x: 0, y: 0 }]);
});

test("elevation interpolates between grid points and holds at the edge", () => {
  const grid = new Float32Array([0, 10, 20, 30]);
  expect(sampleBilinear(grid, 2, 2, 0.5, 0.5)).toBeCloseTo(15);
  expect(sampleBilinear(grid, 2, 2, 5, 5)).toBeCloseTo(30);
});

test("contours fall where elevation crosses a band, darker on the index line", () => {
  const W = 10;
  const colourAt = (px, x) => [...px.slice(x * 4, x * 4 + 3)];
  // A ramp rising 20 m per pixel: crosses 50 m near x=2 and 250 m near x=12 (off the image).
  const ramp = contourImage({ width: W, height: 1, elevationAt: (x) => x * 20 + 10 });
  expect(colourAt(ramp, 0)).toEqual([255, 255, 255]);
  expect(colourAt(ramp, 1)).toEqual([200, 150, 112]);       // 30 -> 50 m
  // Crossing 250 m is an index contour, and it is two pixels wide.
  const across = contourImage({ width: W, height: 1, elevationAt: (x) => 240 + x * 2 });
  expect(colourAt(across, 4)).toEqual([150, 96, 58]);       // 248 -> 250 m
  expect(colourAt(across, 5)).toEqual([150, 96, 58]);
  expect(colourAt(across, 0)).toEqual([255, 255, 255]);
});

test("flat ground draws no lines", () => {
  const px = contourImage({ width: 4, height: 4, elevationAt: () => 311 });
  for (let i = 0; i < px.length; i += 4) expect(px[i]).toBe(255);
});
