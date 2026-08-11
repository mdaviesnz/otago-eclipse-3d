// Playwright smoke tests. Run against a local static server (see package.json).
//
// Scope is chosen for reliability in CI: the overview map and the astronomy both run without
// WebGL, so they test deterministically. The 3D globe needs a GPU context that headless CI
// emulates inconsistently, so index.html is checked for load-time JS errors and correct
// wiring rather than for rendered pixels.

import { test, expect } from "@playwright/test";

const errors = (page) => {
  const found = [];
  page.on("pageerror", (e) => found.push(String(e)));
  page.on("console", (m) => {
    // Ignore network blips on third-party tiles; they are not our defects.
    if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) {
      found.push(m.text());
    }
  });
  return found;
};

test("catalogue is served and well-formed", async ({ request }) => {
  const res = await request.get("/viewpoints.json");
  expect(res.ok()).toBeTruthy();
  const d = await res.json();
  expect(d.osmGaps, "catalogue must have no OSM coverage gaps").toEqual([]);
  expect(d.spots.length).toBeGreaterThan(100);
  expect(d.pois.length).toBeGreaterThan(100);
  // Walk-in spots must survive the tier quota.
  expect(d.spots.some((s) => s.access === "foot")).toBeTruthy();
});

test("overview map plots spots and filters them", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/map.html");

  await expect.poll(
    () => page.evaluate(() => document.getElementById("count").textContent),
    { timeout: 20000 }
  ).toMatch(/\d+ of \d+ shown|\d+ shown/);

  const countFor = (v) =>
    page.evaluate((val) => {
      const s = document.getElementById("accessFilter");
      s.value = val;
      s.dispatchEvent(new Event("input"));
      return document.getElementById("count").textContent;
    }, v);

  const any = await countFor("any");
  const foot = await countFor("foot");
  expect(any).not.toEqual(foot);          // exclusive tiers must actually change the set

  // Reset the filter first: the previous assertion left it on "foot", so the top-ranked POI
  // (a sealed-road spot) is no longer on the layer and would not be found.
  await countFor("any");

  // Every marker links back into the 3D view with coordinates.
  const href = await page.evaluate(() => {
    const t = catalogue.pois[0];
    let out = null;
    layer.eachLayer((l) => {
      const ll = l.getLatLng();
      if (out === null && Math.abs(ll.lat - t.lat) < 1e-6) out = l.getPopup().getContent();
    });
    return out;
  });
  expect(href, "top POI marker should be on the layer and link into the 3D view").toContain("index.html?lat=");

  expect(errs, "no JS errors on the map page").toEqual([]);
});

test("astronomy reproduces the published Dunedin circumstances", async ({ page }) => {
  await page.goto("/map.html");           // any page will do; we load the library directly
  await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/astronomy-engine@2/astronomy.browser.min.js" });

  const r = await page.evaluate(() => {
    const A = window.Astronomy;
    const obs = new A.Observer(-45.8788, 170.5028, 0);
    const e = A.SearchLocalSolarEclipse(new A.AstroTime(new Date(Date.UTC(2028, 6, 21))), obs);
    const iso = (ev) => ev.time.date.toISOString();
    return {
      kind: String(e.kind),
      peakAlt: e.peak.altitude,
      totalBegin: iso(e.total_begin),
      peak: iso(e.peak),
      totalEnd: iso(e.total_end),
    };
  });

  // Published: totality 16:15:45–16:18:36 NZST, maximum 16:17:11, sun ~8 deg.
  expect(r.kind.toLowerCase()).toContain("total");
  expect(r.totalBegin).toContain("2028-07-22T04:15:4");
  expect(r.peak).toContain("2028-07-22T04:17:1");
  expect(r.totalEnd).toContain("2028-07-22T04:18:3");
  expect(r.peakAlt).toBeGreaterThan(8.0);
  expect(r.peakAlt).toBeLessThan(8.8);
});

test("simulator loads without JS errors and wires up its controls", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/index.html");

  // Present in the markup regardless of whether WebGL initialises in CI.
  for (const id of ["timeScrub", "jumpTotality", "runSightline", "accessFilter",
                    "distFilter", "modeToggle", "watchIt"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  // No ion token must ever ship.
  const html = await page.content();
  expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.eyJ/);

  expect(errs, "no JS errors on the simulator page").toEqual([]);
});
