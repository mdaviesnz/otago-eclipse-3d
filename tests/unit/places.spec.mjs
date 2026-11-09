// Finding and describing places. No browser needed: places.js is pure.

import { test, expect } from "@playwright/test";
import {
  inNzBounds, photonUrl, photonLabel, photonFeatures, parseCoords,
  compassName, compassShort, heightPhrase, handMeasure,
} from "../../places.js";

test("New Zealand bounds accept the country and refuse its neighbours", () => {
  expect(inNzBounds(-45.03, 168.66)).toBe(true);
  expect(inNzBounds(-33.87, 151.21)).toBe(false);
  expect(inNzBounds(NaN, 168.66)).toBe(false);
});

test("search requests are bounded to New Zealand and escaped", () => {
  const url = photonUrl("Mount Cook & Co", 5);
  expect(url).toContain("Mount%20Cook%20%26%20Co");
  expect(url).toContain("limit=5");
  expect(url).toContain("bbox=166,-47.6,179,-34");
});

test("labels drop repeated parts", () => {
  expect(photonLabel({ name: "Dunedin", city: "Dunedin", county: "Otago", country: "New Zealand" }))
    .toBe("Dunedin, Otago, New Zealand");
  expect(photonLabel({ housenumber: "10", street: "George St", city: "Dunedin" }))
    .toBe("10 George St, Dunedin");
});

test("search results outside New Zealand or without a name are dropped", () => {
  const feature = (name, lon, lat) => ({ properties: { name }, geometry: { coordinates: [lon, lat] } });
  const out = photonFeatures({ features: [
    feature("Queenstown", 168.66, -45.03), feature("Sydney", 151.2, -33.9), feature("", 168.66, -45.03),
    { properties: { name: "No geometry" } },
  ] });
  expect(out).toEqual([{ name: "Queenstown", lon: 168.66, lat: -45.03 }]);
});

test("coordinates parse with a comma or a space, and addresses do not", () => {
  expect(parseCoords("-45.03, 168.66")).toEqual({ lat: -45.03, lon: 168.66 });
  expect(parseCoords("-45.03 168.66")).toEqual({ lat: -45.03, lon: 168.66 });
  expect(parseCoords("10 George Street")).toBeNull();
});

test("bearings become compass directions", () => {
  expect(compassName(312)).toBe("north-west");
  expect(compassShort(312)).toBe("NW");
  expect(compassName(359)).toBe("north");
  expect(compassName(-90)).toBe("west");
});

test("angles are measured with a hand at arm's length", () => {
  expect(handMeasure(0.3)).toBe("less than a finger");
  expect(handMeasure(1.5)).toBe("about one finger");
  expect(handMeasure(5)).toBe("about three fingers");
  expect(handMeasure(10.8)).toBe("about one fist");
  expect(handMeasure(21)).toBe("about 2 fists");
});

test("heights are described in fists", () => {
  expect(heightPhrase(9.9)).toBe("about one fist above the horizon");
  expect(heightPhrase(5)).toBe("about half a fist above the horizon");
  expect(heightPhrase(20)).toBe("about 2 fists above the horizon");
  expect(heightPhrase(-1)).toBe("below the horizon");
});
