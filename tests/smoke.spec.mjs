// Playwright smoke tests. Run against a local static server (see package.json).
//
// Scope is chosen for reliability in CI: the overview map and the astronomy both run without
// WebGL, so they test deterministically. The 3D globe needs a GPU context that headless CI
// emulates inconsistently, so index.html is checked for load-time JS errors and correct
// wiring rather than for rendered pixels.

import { test, expect } from "@playwright/test";
import worker from "../src/worker.js";

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
  expect(d.cloudGrid, "catalogue must include cloudGrid").toBeDefined();
  expect(d.cloudGrid.cfcDay.length).toBeGreaterThan(0);
  expect(d.cloudGrid.years).toEqual([1979, 2026]);
  expect(d.pois[0].cloud).toBeGreaterThan(0);
  expect(d.pois[0].clearProb).toBeGreaterThan(0);
});

test("overview map opens on spots you can drive to and filters them", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/map.html");

  const count = () => page.locator("#count").textContent();
  const number = async () => parseInt((await count()).match(/\d+/)[0], 10);
  await expect.poll(count, { timeout: 20000 }).toMatch(/\d+ spots?, best first/);

  // Opens on Drive only; a filter that does nothing would be invisible here.
  await expect(page.locator("#chipRoad")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#chipFoot")).toHaveAttribute("aria-pressed", "false");
  const drive = await number();
  await page.locator("#chipFoot").click();
  const driveOrWalk = await number();
  expect(driveOrWalk).toBeGreaterThan(drive);
  await page.locator("#chipFoot").click();
  expect(await number()).toBe(drive);

  // Nothing selected says so, rather than showing an empty list with no reason.
  await page.locator("#chipRoad").click();
  await expect(page.locator("#count")).toContainText("at least one way");
  await page.locator("#chipRoad").click();

  // The marks are decluttered, so fewer are drawn than match, and they are reachable by keyboard.
  const drawn = await page.evaluate(() => layer.getLayers().length);
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(await page.evaluate(() => matching.length));
  await expect(page.locator('.mark[tabindex="0"]').first()).toBeVisible();
  await page.locator('.mark[tabindex="0"]').first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detailView")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#listView")).toBeVisible();

  // Unnamed scan spots stay off until asked for, and public land is the default.
  await page.locator("#moreFilters summary").click();
  await page.locator("#includeUnnamed").check();
  expect(await number()).toBeGreaterThan(drive);
  await page.locator("#includeUnnamed").uncheck();
  await page.locator("#publicOnly").uncheck();
  expect(await number()).toBeGreaterThan(drive);
  await page.locator("#publicOnly").check();

  // Cloud overlay and its filter.
  expect(await page.evaluate(() => cloudLayer.getLayers().length)).toBe(0);
  await expect(page.locator("#cloudLegend")).toBeHidden();
  await page.locator("#showCloud").check();
  expect(await page.evaluate(() => cloudLayer.getLayers().length)).toBe(1);
  await expect(page.locator("#cloudLegend")).toBeVisible();
  await page.locator("#showCloud").uncheck();
  expect(await page.evaluate(() => cloudLayer.getLayers().length)).toBe(0);

  const setRange = (id, v) => page.evaluate(([i, val]) => {
    const s = document.getElementById(i);
    s.value = val;
    s.dispatchEvent(new Event("input"));
  }, [id, v]);
  await setRange("minSky", "48");
  expect(await number()).toBeLessThan(drive);
  await expect(page.locator("#minSkyVal")).toHaveText("48%");
  await setRange("minSky", "30");
  await expect(page.locator("#minSkyVal")).toHaveText("Any");
  expect(await number()).toBe(drive);

  // A spot's detail links back into the 3D view with its coordinates.
  await page.locator("#spotList .row").first().click();
  await expect(page.locator("#detailView")).toBeVisible();
  await expect(page.locator("#open3d")).toHaveAttribute("href", /index\.html\?lat=/);
  await expect(page.locator("#detailBody .contacts")).toContainText("Totality begins");
  await expect(page).toHaveURL(/spot=/);
  await page.locator("#backToList").click();
  await expect(page.locator("#listView")).toBeVisible();

  // Towns carry the stored verdict (docs/adr/0001-precomputed-verdicts.md).
  await expect(page.locator(".town-label", { hasText: "Queenstown: blocked" })).toHaveCount(1);
  await expect(page.locator(".town-label", { hasText: "Dunedin: clear" })).toHaveCount(1);
  await page.evaluate(() => openDetail({ ...catalogue.presets.find((p) => p.name === "Queenstown"), isPreset: true }));
  await expect(page.locator("#detailBody")).toContainText("Totality not visible");
  await expect(page.locator("#goNearest")).toContainText("Halfway Remarkables");
  await page.locator("#goNearest").click();
  await expect(page.locator("#detailTitle")).toHaveText("Halfway Remarkables");
  await expect(page.locator("#detailBody")).toContainText("Clear through totality");

  expect(errs, "no JS errors on the map page").toEqual([]);
});

test("a place on the map sorts spots by distance and can be shared", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/map.html?near=-45.0312,168.6626&place=Queenstown");
  await expect(page.locator("#hereName")).toHaveText("Near Queenstown", { timeout: 20000 });
  await expect(page.locator("#count")).toContainText("closest first");
  await expect(page.locator("#spotList .row-sub").first()).toContainText(/km/);
  await expect(page).toHaveURL(/near=-45\.0312/);
  await page.locator("#clearHere").click();
  await expect(page.locator("#count")).toContainText("best first");
  await expect(page).not.toHaveURL(/near=/);

  // A pasted coordinate pair is a place too; one outside New Zealand is refused.
  await page.locator("#placeSearch").fill("-33.8688, 151.2093");
  await page.locator("#placeSearch").press("Enter");
  await expect(page.locator("#searchStatus")).toContainText("within New Zealand");
  await page.locator("#placeSearch").fill("-45.0312, 168.6626");
  await page.locator("#placeSearch").press("Enter");
  await expect(page.locator("#hereName")).toContainText("-45.031");

  // A spot in the link opens directly.
  await page.goto("/map.html?spot=-45.02571,168.77750");
  await expect(page.locator("#detailTitle")).toHaveText("Halfway Remarkables", { timeout: 20000 });

  expect(errs, "no JS errors with a place set").toEqual([]);
});

// Both pages compute contacts live, and both must do it with the agreed ΔT of 69.2 s, not the
// library's own extrapolation (76.65 s), which runs every contact about 9 s early. The instants
// are the ones precompute/test_eclipse.py pins for the build, so stored and live times agree.
for (const path of ["/map.html", "/index.html"]) {
  test(`Dunedin's contacts on ${path} use the agreed ΔT`, async ({ page }) => {
    await page.goto(path);
    await page.waitForFunction(() => !!window.Astronomy && !!window.Catalogue, null, { timeout: 20000 });

    const r = await page.evaluate(() => {
      const A = window.Astronomy;
      const obs = new A.Observer(-45.8788, 170.5028, 0);
      const e = A.SearchLocalSolarEclipse(new A.AstroTime(new Date(Date.UTC(2028, 6, 21))), obs);
      const ms = (ev) => ev.time.date.getTime();
      return {
        kind: String(e.kind),
        peakAlt: e.peak.altitude,
        totalBegin: ms(e.total_begin),
        peak: ms(e.peak),
        totalEnd: ms(e.total_end),
      };
    });

    const secondsFrom = (ms, iso) => Math.abs(ms - Date.parse(iso)) / 1000;
    expect(r.kind.toLowerCase()).toContain("total");
    expect(secondsFrom(r.totalBegin, "2028-07-22T04:15:53.5Z")).toBeLessThan(0.5);
    expect(secondsFrom(r.peak, "2028-07-22T04:17:20.5Z")).toBeLessThan(0.5);
    expect(secondsFrom(r.totalEnd, "2028-07-22T04:18:47.5Z")).toBeLessThan(0.5);
    expect(r.peakAlt).toBeGreaterThan(8.0);
    expect(r.peakAlt).toBeLessThan(8.8);
  });
}

// The limits on the map are generated by precompute/build_path.py with the same library and ΔT
// as the page. If either changes without the other, the line no longer marks where the page's
// own calculation says totality stops.
test("the path limits drawn on the map are where totality stops", async ({ page }) => {
  await page.goto("/map.html");
  await page.waitForFunction(() => !!window.Astronomy && !!window.EclipsePath, null, { timeout: 20000 });

  const r = await page.evaluate(() => {
    const A = window.Astronomy;
    const { north, south } = window.EclipsePath.ECLIPSE_PATH;
    const latAt = (line, lon) => {
      const i = line.findIndex(([, x]) => x >= lon);
      const [la0, lo0] = line[i - 1], [la1, lo1] = line[i];
      return la0 + ((lon - lo0) / (lo1 - lo0)) * (la1 - la0);
    };
    const total = (lat, lon) => {
      const e = A.SearchLocalSolarEclipse(new A.AstroTime(new Date(Date.UTC(2028, 6, 21))),
        new A.Observer(lat, lon, 0));
      return !!(e.total_begin && e.total_end);
    };
    const nudge = 0.01;                    // degrees of latitude, about 1.1 km
    return [167.6, 169.1, 170.9].map((lon) => {
      const n = latAt(north, lon), s = latAt(south, lon);
      return {
        lon,
        insideNorth: total(n - nudge, lon), outsideNorth: total(n + nudge, lon),
        insideSouth: total(s + nudge, lon), outsideSouth: total(s - nudge, lon),
      };
    });
  });

  for (const cut of r) {
    expect(cut, `at ${cut.lon} E`).toMatchObject({
      insideNorth: true, outsideNorth: false, insideSouth: true, outsideSouth: false,
    });
  }

  // Where totality stops is only known to a kilometre or two, so each limit is drawn as a band
  // about 2 km wide, not a crisp line.
  const bands = await page.evaluate(() => {
    const { north } = window.EclipsePath.ECLIPSE_PATH;
    return pathLayer.getLayers()
      .filter((l) => l instanceof L.Polygon && l.options.fillOpacity > 0.1)
      .map((l) => {
        const ring = l.getLatLngs()[0];
        const i = north.findIndex(([, lon]) => lon === 169);
        const top = ring[i], bottom = ring[ring.length - 1 - i];
        return { sameMeridian: top.lng === bottom.lng, km: Math.abs(top.lat - bottom.lat) * 111.2 * Math.cos(37 * Math.PI / 180) };
      });
  });
  expect(bands).toHaveLength(2);
  for (const band of bands) {
    expect(band.sameMeridian).toBe(true);
    expect(band.km).toBeGreaterThan(1.5);
    expect(band.km).toBeLessThan(2.5);
  }
  expect(await page.evaluate(() => pathLayer.getLayers().some((l) => !(l instanceof L.Polygon) && l.options.weight >= 2)),
    "no crisp limit line").toBe(false);
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
    const partial = [...catalogue.pois, ...catalogue.spots].find((s) => s.level === "partial");
    // Every "Fly to" button must resolve to a preset row carrying a full horizon profile, or
    // it falls back to a live probe (no match) or a totality-only verdict (no profile).
    const presetHits = LOCATIONS.map((l) => {
      const hit = findCatalogueEntry(l.lat, l.lon);
      if (!hit) return { name: l.name, matched: null };
      const pr = hit.profile;
      const lo = pr && pr.azFrom;
      const hi = pr && lo + (pr.angles.length - 1) * pr.azStep;
      // Profile interpolation itself is unit-tested (horizonFromProfile, tests/unit).
      return {
        name: l.name, matched: hit.name, level: catalogueVerdict(hit).level,
        lens: pr && [pr.angles.length, pr.ridgeDist.length, pr.ridgeElev.length],
        // The app fans HORIZON_SPAN/2 either side of the sun's own azimuth range.
        spansSun: !!pr && lo <= hit.sunAz - 20 && hit.sunAz + 20 <= hi,
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
      // The verdict module reached the classic script through the module bridge.
      verdictModule: typeof Verdict === "object" && typeof Verdict.evaluateSightline === "function",
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
  }

  expect(r.exact, "a catalogue entry must match its own coordinates").toBeTruthy();
  expect(r.rounded, "5 dp coordinates, as shared links carry, must still match").toBeTruthy();
  expect(r.far, "5 km away is a different place").toBeNull();
  expect(r.justOutside, "30 m away is outside the 25 m match radius").toBeNull();
  expect(r.clearLevel).toBe("clear");
  expect(r.partialLevel, "a stored partial level must not read as fully clear").toBe("partial");
  expect(r.verdictModule, "verdict.js must load and reach the page script").toBe(true);
  // clearBegin/clearEnd are SECOND and THIRD contact (build_viewpoints.py reads them off
  // EclipseEvent.total_begin/total_end), not the partial phases. Labelling them with
  // partialBegin/partialEnd would sit an 8 deg totality clearance beside a 1 deg sun.
  expect(r.phaseKeys).toEqual(["totalBegin", "peak", "totalEnd"]);
  expect(r.nullSafe).toBeNull();

  // A catalogue spot's facts, and a working Google Maps link.
  const facts = await page.evaluate(() => {
    const p = catalogue.pois[0];
    return {
      html: spotFactsHtml({ ...p, isPoi: true }), none: spotFactsHtml(null),
      gmaps: gmapsUrl(p.lat, p.lon), lat: p.lat, lon: p.lon,
      dunedinCloud: sampleCloudClimatology(-45.8788, 170.5028),
      oobCloud: sampleCloudClimatology(0, 0),
    };
  });
  expect(facts.html).toContain("Getting there");
  expect(facts.none).toBe("");
  expect(facts.gmaps).toBe(`https://www.google.com/maps/search/?api=1&query=${facts.lat},${facts.lon}`);
  expect(facts.dunedinCloud).toBeTruthy();
  expect(facts.dunedinCloud.cloud).toBeGreaterThan(50);
  expect(facts.oobCloud).toBeNull();

  expect(errs, "no JS errors while reading the catalogue").toEqual([]);
});

// Pure logic again, so it runs without a GPU. These pin the promise that a place reads the same
// wherever you see it: the map shows the stored level, the simulator judges the same contacts.
// "Diamond ring" could be read as the cue to take eclipse glasses off, so it must not show while
// the sun is still a bright crescent, and never where there is no totality.
test("the phase readout says diamond ring only in the seconds around totality", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof updateReadouts === "function" && !!window.EclipseTime
    && !!window.Astronomy, null, { timeout: 20000 });

  const r = await page.evaluate(() => {
    const phaseAt = (j) => {
      updateReadouts(j, eclipseAt(j, activeGroundCartesian));
      return document.getElementById("phaseReadout").textContent;
    };
    const plus = (j, s) => Cesium.JulianDate.addSeconds(j, s, new Cesium.JulianDate());

    activeGroundCartesian = Cesium.Cartesian3.fromDegrees(170.5028, -45.8788, 2 + EYE_HEIGHT);   // Dunedin
    const c = localCircumstances(activeGroundCartesian);
    const dunedin = {
      minuteBefore: phaseAt(plus(c.totalBegin, -60)),
      justBefore: phaseAt(plus(c.totalBegin, -5)),
      during: phaseAt(c.peak),
      justAfter: phaseAt(plus(c.totalEnd, 5)),
      minuteAfter: phaseAt(plus(c.totalEnd, 60)),
    };

    activeGroundCartesian = Cesium.Cartesian3.fromDegrees(172.63643, -43.53095, 10 + EYE_HEIGHT); // Christchurch
    const chch = phaseAt(localCircumstances(activeGroundCartesian).peak);
    return { dunedin, chch };
  });

  expect(r.dunedin.minuteBefore).toMatch(/% covered$/);
  expect(r.dunedin.justBefore).toBe("Diamond ring");
  expect(r.dunedin.during).toBe("Totality");
  expect(r.dunedin.justAfter).toBe("Diamond ring");
  expect(r.dunedin.minuteAfter).toMatch(/% covered$/);
  expect(r.chch).toMatch(/% covered$/);
});

// If the terrain sample under the observer fails, there is no height to stand them at. Calling
// it 0 m would put them at sea level under the real ground and report the place as blocked.
test("a place whose ground height did not load is not judged, and can be tried again", async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof setObserver === "function" && !!window.Places
    && !!window.Astronomy, null, { timeout: 20000 });
  await page.evaluate(() => catalogueSettled);

  const r = await page.evaluate(async () => {
    const somewhere = { name: "A paddock", lat: -45.4012, lon: 169.3127 };   // not in the catalogue
    const real = sampleTerrain;
    const read = () => ({
      missing: groundHeightMissing,
      rest: document.getElementById("verdictRest").textContent,
      reason: document.getElementById("verdictReason").textContent,
      retryShown: !document.getElementById("drawSkyline").hidden,
      retryLabel: document.getElementById("drawSkyline").textContent,
      eye: Cesium.Cartographic.fromCartesian(activeGroundCartesian).height,
    });
    try {
      sampleTerrain = async () => [{}];              // the tile did not load
      await setObserver(somewhere);
      await runSightlineCheck();
      const failed = read();

      sampleTerrain = async () => [{ height: 0 }];   // a real beach
      await setObserver(somewhere);
      const atSeaLevel = read();

      sampleTerrain = async () => [{}];
      await setObserver(catalogue.presets[0]);                          // has its own elevation
      const preset = { ...read(), elev: catalogue.presets[0].elev };
      return { failed, atSeaLevel, preset };
    } finally {
      sampleTerrain = real;
    }
  });

  expect(r.failed.missing).toBe(true);
  expect(r.failed.rest).toBe("");
  expect(r.failed.reason).toMatch(/ground height .* did not load/i);
  expect(r.failed.retryShown).toBe(true);
  expect(r.failed.retryLabel).toMatch(/try again/i);

  expect(r.atSeaLevel.missing).toBe(false);
  expect(r.atSeaLevel.eye).toBeCloseTo(1.7, 1);

  expect(r.preset.missing).toBe(false);
  expect(r.preset.eye).toBeCloseTo(r.preset.elev + 1.7, 1);
  expect(r.preset.rest).not.toBe("");
});

// The verdict is worked out for an eye 1.7 m above the ground. From 10 m up, a ridge 775 m away
// sits 0.6 degrees lower in the frame, more than the sun's whole disc, so the picture could show
// the sun clear of a ridge the verdict says hides it.
test("the eye-level view is framed from the height the verdict assumes", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/index.html");
  const ready = await page.waitForFunction(() => typeof viewerReady !== "undefined" && viewerReady,
    null, { timeout: 45000 }).then(() => true, () => false);
  test.skip(!ready, "framing the view needs WebGL");

  const r = await page.evaluate(() => {
    const arrowtown = { name: "Arrowtown", lat: -44.9385, lon: 168.8306 };
    const ground = 409;
    activeGroundCartesian = Cesium.Cartesian3.fromDegrees(arrowtown.lon, arrowtown.lat, ground + EYE_HEIGHT);
    const view = frameEyeLevel(arrowtown, ground);
    return {
      eyeHeight: EYE_HEIGHT,
      cameraAboveGround: Cesium.Cartographic.fromCartesian(view.destination).height - ground,
    };
  });

  expect(r.eyeHeight).toBe(1.7);
  expect(r.cameraAboveGround).toBeCloseTo(r.eyeHeight, 2);
});

test("the verdict answers totality inside the path and agrees with the catalogue", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof loadCatalogue === "function", null, { timeout: 20000 });
  await page.evaluate(() => (typeof catalogue !== "undefined" && catalogue ? null : loadCatalogue()));
  await page.waitForFunction(() => typeof catalogue !== "undefined" && !!catalogue, null, { timeout: 20000 });

  const r = await page.evaluate(() => {
    const standAt = (lat, lon, elev) => {
      activeGroundCartesian = Cesium.Cartesian3.fromDegrees(lon, lat, elev + EYE_HEIGHT);
      return localCircumstances(activeGroundCartesian);
    };
    const presets = catalogue.presets.map((p) => {
      const c = standAt(p.lat, p.lon, p.elev);
      const v = presetVerdict(p);
      return { name: p.name, stored: p.level, live: v.level, scope: verdictScope(c) };
    });
    const chch = verdictScope(standAt(-43.53095, 172.63643, 10));
    const towns = {};
    for (const p of catalogue.presets) towns[p.name] = betterPlaceFor(p, p);
    const names = Catalogue.thinNearby(catalogue.pois).map((s) => s.name);
    return { presets, chch, towns, names, button: !!document.getElementById("runSightline"),
      comfortable: Catalogue.COMFORTABLE_CLEARANCE };
  });

  for (const p of r.presets) {
    expect(p.scope, `${p.name} is inside the path`).toBe("totality");
    expect(p.live, `${p.name} must read the same in the simulator and on the map`).toBe(p.stored);
  }
  expect(r.presets.find((p) => p.name === "Queenstown").live).toBe("blocked");
  expect(r.chch, "Christchurch is outside the path").toBe("eclipse");
  expect(r.button, "presets answer on arrival, so there is no check button").toBe(false);

  // Each town but Wānaka has its own fixed suggestion. The app doesn't need the catalogue to show
  // it, but a rebuilt catalogue must still agree that each one is a public, sealed-road spot with
  // a comfortable clear view, or the choice needs revisiting.
  const picks = Object.fromEntries(Object.entries(r.towns).map(([n, t]) => [n, t && `${t.name} (${t.why})`]));
  expect(picks).toEqual({
    Queenstown: "Halfway Remarkables (clear)", Arrowtown: "The Zig Zag (clear)", "Wānaka": null,
    Cromwell: "Bruce Jackson Lookout (margin)", Dunedin: "Signal Hill Lookout (margin)",
  });
  for (const t of Object.values(r.towns).filter(Boolean)) {
    expect(t.cat && t.cat.name, `${t.name} is in the catalogue at its own coordinates`).toBe(t.name);
    expect(t.cat.publicAccess).toBe(true);
    expect(t.cat.access).toBe("sealed");
    expect(t.cat.level).toBe("clear");
    expect(t.cat.clearance).toBeGreaterThanOrEqual(r.comfortable);
  }

  // Two names for one place are thinned out of the list.
  expect(r.names).toContain("Halfway Remarkables");
  expect(r.names).not.toContain("Halfway Remarkables lookout");

  expect(errs, "no JS errors while judging presets").toEqual([]);
});

// End to end through the real cards. Needs the 3D viewer, which needs WebGL; skipped, with
// the reason, on a runner that cannot provide it. The rule itself is covered by tests/unit.
test("verdict cards render the shared verdict", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/index.html");
  const ready = await page.waitForFunction(
    () => typeof viewer !== "undefined" && !!viewer && typeof catalogue !== "undefined" && !!catalogue,
    null, { timeout: 30000 }).then(() => true, () => false);
  test.skip(!ready, "3D viewer did not initialise (no WebGL in this runner)");
  const card = page.locator("#detailBody");
  await page.evaluate(() => { document.getElementById("question").hidden = true; revealUI(); });

  // Preset, through the stored-profile adapter. First contact clears Queenstown's skyline but
  // totality does not, and totality is what the sentence answers.
  await page.evaluate(() => selectLocation(LOCATIONS.find((l) => l.name === "Queenstown"), false));
  await expect(page.locator("#verdictSentence")).toHaveText("Queenstown loses totality.", { timeout: 30000 });
  await expect(page.locator("#verdictReason")).toContainText("about one fist above the sun");
  await expect(page.locator("#goNearest")).toContainText("Halfway Remarkables");
  await expect(card).toContainText("Totality not visible");
  // The strip draws the real skyline, and says how far short the sun falls.
  await expect(page.locator("#stripSvg path").first()).toBeAttached();
  await expect(page.locator("#stripShort")).toContainText("short");
  await expect(page.locator("#drawSkyline")).toBeHidden();

  // Catalogue card, stored totality-scope verdict: Taieri Mouth Road lookout clears second
  // contact and maximum but third contact sits exactly on the skyline (0.00 deg).
  await page.evaluate(() => {
    const s = catalogue.pois.find((p) => p.name === "Taieri Mouth Road lookout");
    return selectLocation({ name: s.name, lat: s.lat, lon: s.lon, cat: s }, false);
  });
  await expect(card).toContainText("Part of totality blocked", { timeout: 30000 });
  await expect(card).toContainText("grazes the ridge");
  await expect(page.locator("#verdictSentence")).toContainText("loses part of totality");
  // A catalogue spot has no stored skyline, so it offers to draw one.
  await expect(page.locator("#drawSkyline")).toBeVisible();

  // Times and details open from the verdict.
  await page.locator("#openDetails").click();
  await expect(page.locator("body")).toHaveAttribute("data-panel", "details");
  await expect(card.locator("table.contacts")).toContainText("Totality begins");
  await page.locator("#closeDetails").click();

  expect(errs, "no JS errors while rendering verdict cards").toEqual([]);
});

test("simulator loads without JS errors and wires up its controls", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/index.html");

  // Present in the markup regardless of whether WebGL initialises in CI.
  for (const id of ["timeScrub", "jumpTotality", "accessFilter",
                    "distFilter", "watchIt", "stripSvg", "verdictSentence", "question"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  // No ion token must ever ship.
  const html = await page.content();
  expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.eyJ/);

  expect(errs, "no JS errors on the simulator page").toEqual([]);
});

test("the opening question comes first, and a link to a place skips it", async ({ page }) => {
  const errs = errors(page);
  await page.goto("/index.html");
  await expect(page.locator("#questionTitle")).toContainText("Where will you be standing");
  await expect(page.locator("#question")).toBeVisible();
  await expect(page.locator("#splash")).toBeHidden();
  // The way out needs no 3D at all.
  await expect(page.locator('#question a[href="map.html"]')).toBeVisible();

  // A returning visitor is offered the place they left.
  await page.evaluate(() => localStorage.setItem("eclipseLastPlace",
    JSON.stringify({ name: "Cromwell", lat: -45.0382, lon: 169.203 })));
  await page.reload();
  await expect(page.locator("#questionBack")).toHaveText("Back to Cromwell");

  // A link to a place goes straight there; one outside New Zealand asks instead.
  await page.goto("/index.html?lat=-45.0312&lon=168.6626&name=Queenstown");
  await expect(page.locator("#question")).toBeHidden();
  await page.goto("/index.html?lat=-33.8688&lon=151.2093");
  await expect(page.locator("#question")).toBeVisible();
  await expect(page.locator("#questionStatus")).toContainText("outside New Zealand");

  // Coordinates typed into the question are checked the same way.
  await page.waitForFunction(() => typeof askByText === "function");
  await page.evaluate(() => askByText("-33.8688, 151.2093"));
  await expect(page.locator("#questionStatus")).toContainText("within New Zealand");

  // A place chosen sends the map's link along with it, unless it is the visitor's own position.
  const links = await page.evaluate(() => {
    syncMapLink({ name: "Queenstown", lat: -45.0312, lon: 168.6626 });
    const named = document.getElementById("navMap").getAttribute("href");
    syncMapLink({ name: "My location", lat: -45.0312, lon: 168.6626 });
    return { named, located: document.getElementById("navMap").getAttribute("href") };
  });
  expect(links.named).toBe("map.html?near=-45.0312,168.6626&place=Queenstown");
  expect(links.located).toBe("map.html");

  expect(errs, "no JS errors around the opening question").toEqual([]);
});

test("a chosen place loads behind a backdrop, and the camera stays where the app put it", async ({ page }) => {
  test.setTimeout(90000);
  const errs = errors(page);
  await page.goto("/index.html");
  const ready = await page.waitForFunction(() => typeof viewerReady !== "undefined" && viewerReady,
    null, { timeout: 45000 }).then(() => true, () => false);
  test.skip(!ready, "the 3D view needs WebGL");

  await page.click('[data-town="Dunedin"]');
  await expect(page.locator("#landscapeVeil")).toHaveAttribute("data-state", "on");
  await expect(page.locator("#landscapeStatus")).toHaveText("Loading the terrain around Dunedin…");

  // Cesium's push above loaded terrain is held off as each move is made, and a camera near the
  // ground asks for coarser detail than one looking down from the overview.
  await page.waitForFunction(() => typeof activeGroundCartesian !== "undefined" && !!activeGroundCartesian);
  const moves = await page.evaluate(() => {
    const g = Cesium.Cartographic.fromCartesian(activeGroundCartesian);
    const at = (h) => ({ destination: Cesium.Cartesian3.fromRadians(g.longitude, g.latitude, g.height + h),
                         orientation: { heading: 0, pitch: 0, roll: 0 } });
    const read = () => ({ collide: viewer.scene.screenSpaceCameraController.enableCollisionDetection,
                          detail: viewer.scene.globe.maximumScreenSpaceError });
    placeCamera(at(450)); const high = read();
    placeCamera(at(10)); const low = read();
    reframeCurrent();
    return { high, low };
  });
  expect(moves.high).toEqual({ collide: false, detail: 2 });
  expect(moves.low).toEqual({ collide: false, detail: 4 });

  // The backdrop lifts once the ground has loaded, or after 8 s at most.
  await expect(page.locator("#landscapeVeil")).toHaveAttribute("data-state", "off", { timeout: 20000 });
  const lift = await page.evaluate(() => {
    const cam = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC).height;
    return cam - Cesium.Cartographic.fromCartesian(activeGroundCartesian).height;
  });
  expect(lift, "the eye-level camera sits at the observer's eye, not on a coarse tile").toBeLessThan(5);

  expect(errs, "no JS errors while arriving").toEqual([]);
});

// Cesium is 1.5 MB. One script in the head without `defer` holds back the whole first paint.
test("no script holds back the first paint of the simulator or the map", async ({ page }) => {
  for (const path of ["/index.html", "/map.html"]) {
    await page.goto(path);
    const blocking = await page.evaluate(() =>
      [...document.querySelectorAll("script[src]")]
        .filter((s) => !s.defer && !s.async && s.type !== "module")
        .map((s) => s.src));
    expect(blocking, `${path} must defer every script`).toEqual([]);
  }
});

test("the Skyline typefaces are self-hosted and cover macrons", async ({ page }) => {
  const foreign = [];
  page.on("request", (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) foreign.push(r.url()); });
  await page.goto("/map.html");
  const faces = await page.evaluate(async () => {
    const out = {};
    for (const family of ["Piazzolla", "Overpass"]) {
      const loaded = await document.fonts.load(`16px "${family}"`, "Wānaka Tūtoko");
      out[family] = loaded.map((f) => f.status);
    }
    return out;
  });
  // One file for the plain letters and one for the macrons, or the macrons fall back.
  expect(faces.Piazzolla).toEqual(["loaded", "loaded"]);
  expect(faces.Overpass).toEqual(["loaded", "loaded"]);
  expect(foreign, "fonts must not come from a third party").toEqual([]);
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
  expect(swText).toContain("simulator.js");
  expect(swText).toContain("contours.js");
  expect(swText).toContain("font-overpass-latin.woff2");
});

test("mobile viewport UX: drawers, floating verdict pill, and map filter collapse", async ({ page }) => {
  const errs = errors(page);
  await page.setViewportSize({ width: 375, height: 667 });

  // 1. On the overview map the sheet leaves the map in view, even with filters open
  await page.goto("/map.html");
  await expect(page.locator("#count")).toContainText("spots", { timeout: 20000 });
  const sheetTop = () => page.locator("#panel").evaluate((el) => el.getBoundingClientRect().top);
  expect(await sheetTop()).toBeGreaterThan(667 * 0.4);
  await page.locator("#moreFilters summary").evaluate((el) => el.click());
  expect(await sheetTop()).toBeGreaterThan(667 * 0.4);
  await expect(page.locator("#legend")).toBeVisible();
  await page.locator("#sheetHandle").click();
  await expect.poll(sheetTop).toBeLessThan(667 * 0.2);

  // 2. Simulator mobile drawers open/close via tabs and close buttons
  await page.goto("/index.html");
  await expect(page.locator("body")).toHaveAttribute("data-panel", "none");
  await page.evaluate(() => { document.getElementById("question").hidden = true; revealUI(); });
  await page.locator("#placeButton").click();
  await expect(page.locator("body")).toHaveAttribute("data-panel", "places");
  await page.locator("#closePlaces").click();
  await expect(page.locator("body")).toHaveAttribute("data-panel", "none");

  await page.locator("#openDetails").click();
  await expect(page.locator("body")).toHaveAttribute("data-panel", "details");
  await page.locator("#closeDetails").click();
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
    await expect(page.locator("#chipRoad")).toHaveCount(1);

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

test("usage metrics: Worker enforces strict allowlist and strips any address or coordinates", async () => {
  const handler = worker.default || worker;
  const points = [];
  const env = {
    METRICS: { writeDataPoint: (dp) => points.push(dp) },
  };
  const post = (body) =>
    handler.fetch(
      new Request("https://eclipse.example/api/metric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env
    );

  // 1. Valid preset + ephemeral hex session ID
  const r1 = await post({ event: "preset_select", detail: "Queenstown", spot: "Queenstown", sid: "a1b2c3d4" });
  expect(r1.status).toBe(204);
  expect(points).toHaveLength(1);
  expect(points[0]).toEqual({
    indexes: ["preset_select"],
    blobs: ["preset_select", "Queenstown", "Queenstown", "a1b2c3d4"],
    doubles: [1],
  });

  // 2. Valid catalogue POI records the public POI name in blob3
  await post({ event: "catalogue_select", detail: "poi", spot: "Crown Range Road lookout", sid: "a1b2c3d4" });
  expect(points).toHaveLength(2);
  expect(points[1]).toEqual({
    indexes: ["catalogue_select"],
    blobs: ["catalogue_select", "poi", "Crown Range Road lookout", "a1b2c3d4"],
    doubles: [1],
  });

  // 3. Valid custom_search + disallowed free-form detail/spot/sid must strip all PII to ""
  await post({
    event: "custom_search",
    detail: "10 George Street, Dunedin -45.874, 170.503",
    spot: "10 George Street, Dunedin",
    sid: "not-a-hex-token!",
  });
  expect(points).toHaveLength(3);
  expect(points[2]).toEqual({
    indexes: ["custom_search"],
    blobs: ["custom_search", "", "", ""],
    doubles: [1],
  });

  // 4. Unknown event is dropped completely
  await post({ event: "unknown_event", detail: "anything" });
  expect(points).toHaveLength(3);

  // 5. Non-POST on /api/metric returns 405
  const getRes = await handler.fetch(new Request("https://eclipse.example/api/metric"), env);
  expect(getRes.status).toBe(405);
});

test("usage metrics: browser interactions emit anonymous events, POI names, and ephemeral session ID", async ({ page }) => {
  const events = [];
  await page.addInitScript(() => {
    window.__TEST_METRICS = true;
  });
  await page.route("**/api/metric", async (route) => {
    const raw = route.request().postData() || "{}";
    events.push(JSON.parse(raw));
    await route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/map.html");
  await expect.poll(() => events.some((e) => e.event === "page_view" && e.detail === "map")).toBe(true);
  await page.locator("#moreFilters summary").click();
  await page.locator("#includeUnnamed").check();
  await expect.poll(() => events.some((e) => e.event === "map_filter" && e.detail === "both")).toBe(true);

  await page.goto("/index.html");
  await expect.poll(() => events.some((e) => e.event === "page_view" && e.detail === "simulator")).toBe(true);

  // Answering the opening question records the town's name in both detail and spot
  await page.waitForFunction(() => typeof wireQuestion === "function" && !window.__questionAnswer);
  await page.locator('[data-town="Dunedin"]').click();
  await expect.poll(() =>
    events.some((e) => e.event === "preset_select" && e.detail === "Dunedin" && e.spot === "Dunedin")
  ).toBe(true);

  // Clicked from script: arriving in Dunedin can close the panel at any moment here.
  await page.evaluate(() => {
    document.getElementById("question").hidden = true;
    revealUI();
    document.querySelector('#presetButtons button[data-name="Wānaka"]').click();
  });
  await expect.poll(() =>
    events.some((e) => e.event === "preset_select" && e.detail === "Wānaka" && e.spot === "Wānaka")
  ).toBe(true);

  // Entering coordinates records only { event: "custom_search", detail: "coords", spot: "" } — never the numbers
  await page.evaluate(() => {
    document.getElementById("customInput").value = "-45.0312, 168.6626";
    document.getElementById("customGo").click();
  });
  await expect.poll(() =>
    events.some((e) => e.event === "custom_search" && e.detail === "coords" && e.spot === "")
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("-45.0312");
  expect(JSON.stringify(events)).not.toContain("168.6626");

  // All events in the same tab share one ephemeral 8-hex session ID
  const sids = new Set(events.map((e) => e.sid));
  expect(sids.size).toBe(1);
  expect([...sids][0]).toMatch(/^[0-9a-f]{8}$/);
});

test("NZ bounds, partial-only eclipse UI (Christchurch), and map eclipse path overlay", async ({ page }) => {
  const errs = errors(page);

  // 1. The path is always on; the partial bands appear only once zoomed out far enough to see them
  await page.goto("/map.html");
  await expect(page.locator("#count")).toContainText("spots", { timeout: 20000 });
  expect(await page.evaluate(() => pathLayer.getLayers().length)).toBe(4); // polygon + 2 limits + centreline
  await expect(page.locator("#bandLegend")).toBeHidden();
  await page.evaluate(() => map.setZoom(5, { animate: false }));
  await expect.poll(() => page.evaluate(() => pathLayer.getLayers().length)).toBe(7);
  await expect(page.locator("#bandLegend")).toBeVisible();

  // 2. Partial-only location in NZ (Christchurch: ?lat=-43.53095&lon=172.63643)
  await page.goto("/index.html?lat=-43.53095&lon=172.63643");
  await page.waitForFunction(() => typeof inNzBounds === "function" && !!window.Astronomy, null, { timeout: 20000 });

  const state = await page.evaluate(async () => {
    // Call selectLocation directly so the test passes even if headless CI has no WebGL context
    await selectLocation({ name: "Christchurch", lat: -43.53095, lon: 172.63643 }, false);
    const jumpLabel = document.getElementById("jumpTotality")?.textContent;
    const phaseLabel = document.getElementById("phaseReadout")?.textContent;

    const boundsChecks = {
      chch: inNzBounds(-43.53095, 172.63643),
      auckland: inNzBounds(-36.8485, 174.7633),
      dunedin: inNzBounds(-45.8742, 170.5036),
      sydney: inNzBounds(-33.8688, 151.2093),
      london: inNzBounds(51.5074, -0.1278),
    };

    // Trying to enter Sydney coordinates in #customInput must be rejected by NZ bounds
    document.getElementById("customInput").value = "-33.8688, 151.2093";
    await goToCustom();
    const customStatus = document.getElementById("customStatus")?.textContent;

    // Switching to Dunedin (inside totality) restores "Totality" label
    await selectLocation({ name: "Dunedin", lat: -45.8742, lon: 170.5036 }, false);
    const dunedinJumpLabel = document.getElementById("jumpTotality")?.textContent;

    return {
      jumpLabel,
      phaseLabel,
      boundsChecks,
      customStatus,
      dunedinJumpLabel,
    };
  });

  expect(state.boundsChecks).toEqual({
    chch: true,
    auckland: true,
    dunedin: true,
    sydney: false,
    london: false,
  });
  expect(state.jumpLabel).toMatch(/4:19 pm, maximum/);
  expect(state.phaseLabel).toContain("covered");
  expect(state.customStatus).toContain("within New Zealand");
  expect(state.dunedinJumpLabel).toMatch(/4:17 pm, totality/);

  expect(errs, "no JS errors during NZ bounds and partial-only UI checks").toEqual([]);
});



