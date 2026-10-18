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

// The Cloudflare Web Analytics beacon is live in the markup, so without this every CI run and
// every local `npx playwright test` would report a handful of visits against real traffic.
// Blocking it also keeps the tests hermetic; that the beacon is actually present is asserted
// statically by tests/check_static.py, which is the right layer for it.
test.beforeEach(async ({ page }) => {
  await page.route("**/beacon.min.js*", (route) => route.abort());
});

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

// A catalogue spot must be answered from viewpoints.json, not by re-probing terrain: the live
// check costs ~230 quantized-mesh tiles (~8 MB) from a best-effort third party, and clicking
// through a shortlist used to pay that per click. The matching and verdict logic is pure, so
// it tests without a GPU even when the globe itself does not come up in CI.
test("catalogue spots are answered from precomputed data", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/index.html");

  // `let catalogue` is a global lexical binding, not a property of window — reference the
  // bare identifier, never window.catalogue. Load it directly if the viewer never got there.
  await page.waitForFunction(() => typeof loadCatalogue === "function", null, { timeout: 20000 });
  await page.evaluate(() => (typeof catalogue !== "undefined" && catalogue ? null : loadCatalogue()));
  await page.waitForFunction(() => typeof catalogue !== "undefined" && !!catalogue,
    null, { timeout: 20000 });

  const r = await page.evaluate(() => {
    const p = catalogue.pois[0];
    const partial = [...catalogue.pois, ...catalogue.spots].find((s) => s.wholeTotality === false);
    // Every "Fly to" button must resolve to a preset row carrying a full horizon profile, or
    // it falls back to a live probe (no match) or a totality-only verdict (no profile).
    const presetHits = LOCATIONS.map((l) => {
      const hit = findCatalogueEntry(l.lat, l.lon);
      if (!hit) return { name: l.name, matched: null };
      const pr = hit.profile;
      const lo = pr && pr.azFrom;
      const hi = pr && lo + (pr.angles.length - 1) * pr.azStep;
      return {
        name: l.name, matched: hit.name, level: catalogueVerdict(hit).level,
        lens: pr && [pr.angles.length, pr.ridgeDist.length, pr.ridgeElev.length],
        // The app fans HORIZON_SPAN/2 either side of the sun's own azimuth range.
        spansSun: !!pr && lo <= hit.sunAz - 20 && hit.sunAz + 20 <= hi,
        // A lookup exactly on a stored bearing must return that bearing's own value.
        exactLookup: pr && profileAt(pr, lo + 3 * pr.azStep).angle,
        exactStored: pr && pr.angles[3],
        // ...and one halfway between two must land between them.
        midBetween: pr && (() => {
          const m = profileAt(pr, lo + 3.5 * pr.azStep).angle;
          return m >= Math.min(pr.angles[3], pr.angles[4])
              && m <= Math.max(pr.angles[3], pr.angles[4]);
        })(),
      };
    });
    return {
      exact: findCatalogueEntry(p.lat, p.lon) === p,
      rounded: findCatalogueEntry(+p.lat.toFixed(5), +p.lon.toFixed(5)) === p,
      far: findCatalogueEntry(p.lat + 0.05, p.lon),          // ~5.5 km away
      justOutside: findCatalogueEntry(p.lat + 0.00027, p.lon), // ~30 m away
      clearLevel: catalogueVerdict(p).level,
      partialLevel: partial && catalogueVerdict(partial).level,
      phaseKeys: catalogueVerdict(p).phases.map((x) => x.key),
      nullSafe: catalogueVerdict(null),
      presetHits,
    };
  });

  // Presets are unfiltered, so any of the three levels is legitimate — what matters is that
  // each button matches its own row, and that the row carries enough to render the full card
  // without touching the network.
  for (const h of r.presetHits) {
    expect(h.matched, `"${h.name}" must resolve to a precomputed preset`).toBe(h.name);
    expect(["clear", "partial", "blocked"]).toContain(h.level);
    expect(h.lens, `"${h.name}" must carry a horizon profile`).toBeTruthy();
    expect(new Set(h.lens).size, `"${h.name}" profile arrays must agree in length`).toBe(1);
    expect(h.spansSun, `"${h.name}" profile must cover the whole fan the chart draws`).toBe(true);
    expect(h.exactLookup).toBeCloseTo(h.exactStored, 6);
    expect(h.midBetween, `"${h.name}" profile interpolation must stay between samples`).toBe(true);
  }

  expect(r.exact, "a catalogue entry must match its own coordinates").toBeTruthy();
  expect(r.rounded, "5 dp coordinates, as shared links carry, must still match").toBeTruthy();
  expect(r.far, "5 km away is a different place").toBeNull();
  expect(r.justOutside, "30 m away is outside the 25 m match radius").toBeNull();
  expect(r.clearLevel).toBe("clear");
  expect(r.partialLevel, "wholeTotality:false must not read as fully clear").toBe("partial");
  // clearBegin/clearEnd are SECOND and THIRD contact (build_viewpoints.py reads them off
  // EclipseEvent.total_begin/total_end), not the partial phases. Labelling them with
  // partialBegin/partialEnd would sit an 8 deg totality clearance beside a 1 deg sun.
  expect(r.phaseKeys).toEqual(["totalBegin", "peak", "totalEnd"]);
  expect(r.nullSafe).toBeNull();

  expect(errs, "no JS errors while reading the catalogue").toEqual([]);
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

test("PWA manifest, icon, and service worker are served and valid", async ({ request }) => {
  const mRes = await request.get("/manifest.webmanifest");
  expect(mRes.ok()).toBeTruthy();
  const manifest = await mRes.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThan(0);

  const iRes = await request.get("/icon.svg");
  expect(iRes.ok()).toBeTruthy();

  const swRes = await request.get("/sw.js");
  expect(swRes.ok()).toBeTruthy();
  const swText = await swRes.text();
  expect(swText).toContain("viewpoints.json");
});

test("mobile viewport UX: drawers, floating verdict pill, and map filter collapse", async ({ page }) => {
  const errs = errors(page);
  await page.setViewportSize({ width: 375, height: 667 });

  // 1. Overview map collapses filters by default on mobile and toggles cleanly
  await page.goto("/map.html");
  await expect(page.locator("#mapFiltersBody")).toBeHidden();
  await page.locator("#toggleMapFilters").click();
  await expect(page.locator("#mapFiltersBody")).toBeVisible();
  await page.locator("#toggleMapFilters").click();
  await expect(page.locator("#mapFiltersBody")).toBeHidden();

  // 2. Simulator mobile drawers open/close via tabs and close buttons
  await page.goto("/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-panel", "none");
  await page.evaluate(() => revealUI());
  await page.locator("#tabPlaces").click();
  await expect(page.locator("body")).toHaveAttribute("data-panel", "places");
  await page.locator("#closePlacesDrawer").click();
  await expect(page.locator("body")).toHaveAttribute("data-panel", "none");

  await page.locator("#mobileVerdictBtn").click();
  await expect(page.locator("body")).toHaveAttribute("data-panel", "info");
  await page.locator("#closeInfoDrawer").click();
  await expect(page.locator("body")).toHaveAttribute("data-panel", "none");

  expect(errs, "no JS errors during mobile UX interactions").toEqual([]);
});

test("astronomy and methods pages load without JS errors and render diagrams/tables", async ({ page }) => {
  const errs = errors(page);

  await page.goto("/astronomy.html");
  await expect(page.locator("h1")).toContainText(/Astronomy.*Sightline/i);
  await expect(page.locator("svg").first()).toBeVisible();
  await expect(page.locator("table.data-table")).toHaveCount(1);
  await expect(page.locator('a[href="methods.html"]').first()).toBeVisible();

  await page.goto("/methods.html");
  await expect(page.locator("h1")).toContainText(/Astronomical|Geodetic|Specification/i);
  expect(await page.locator(".spec-section").count()).toBeGreaterThanOrEqual(5);
  expect(await page.locator("table.spec-table").count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator('a[href="astronomy.html"]').first()).toBeVisible();

  expect(errs, "no JS errors on astronomy.html or methods.html").toEqual([]);
});

test("service worker precaches the app shell and serves pages + catalogue offline", async ({ page, context }) => {
  const errs = errors(page);
  await page.goto("/astronomy.html");

  // Wait for the Service Worker to finish installing and precaching the shell.
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller && reg.active) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
        setTimeout(resolve, 1500);
      });
    }
  });

  await context.setOffline(true);
  try {
    await page.goto("/map.html");
    await expect(page.locator("#accessFilter")).toHaveCount(1);

    // Catalogue JSON must also be served from the Service Worker cache while offline.
    const catCount = await page.evaluate(async () => {
      const res = await fetch("/viewpoints.json");
      if (!res.ok) return 0;
      const d = await res.json();
      return (d.spots?.length || 0) + (d.pois?.length || 0);
    });
    expect(catCount).toBeGreaterThan(200);

    await page.goto("/methods.html");
    await expect(page.locator("h1")).toBeVisible();
  } finally {
    await context.setOffline(false);
  }

  expect(errs, "no JS errors during offline service worker navigation").toEqual([]);
});

