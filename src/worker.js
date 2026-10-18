// Cloudflare Worker entry point for Otago Eclipse 3D.
//
// Static assets (HTML, CSS, viewpoints.json, icons) are served directly from the Workers
// asset store without invoking this script (`assets.run_worker_first = ["/api/*"]` in
// wrangler.jsonc), keeping static traffic free and unmetered.
//
// This Worker only runs on `/api/*` routes. Currently it handles anonymous, privacy-preserving
// usage metrics (`/api/metric`) backed by Cloudflare Workers Analytics Engine.
//
// Privacy by construction:
//   * No IP addresses, User-Agent strings, cookies, or referrer headers are read or stored.
//   * `event` and `detail` are validated against a closed allowlist (`ALLOWED_METRICS`).
//   * `spot` (blob3) is only permitted on public catalogue/preset events (`preset_select`,
//     `catalogue_select`, and `map_filter` with `open_3d`). On custom searches, map pins, and
//     geolocation events, `spot` is unconditionally forced to `""` so private addresses or
//     user coordinates can never be persisted.
//   * `sid` (blob4) accepts only an ephemeral 8-16 char lowercase hex token from
//     `sessionStorage` (wiped when the tab closes) so per-visit engagement can be measured
//     without cross-session tracking or cookies.

export const ALLOWED_METRICS = {
  page_view: new Set(["simulator", "map", "astronomy", "methods"]),
  preset_select: new Set(["Queenstown", "Arrowtown", "Cromwell", "Dunedin"]),
  catalogue_select: new Set(["poi", "grid"]),
  custom_search: new Set(["address", "coords"]),
  geolocation_use: new Set([""]),
  map_pin: new Set([""]),
  sightline_check: new Set(["clear", "partial", "blocked", "below"]),
  watch_playback: new Set([""]),
  view_mode: new Set(["eye", "overview"]),
  map_filter: new Set(["poi", "grid", "both", "open_3d"]),
};

const SPOT_ALLOWED_EVENTS = new Set(["preset_select", "catalogue_select"]);
const HEX_SID_RE = /^[0-9a-f]{8,16}$/;

function sanitizeSpot(event, detail, rawSpot) {
  if (event === "preset_select" && detail) {
    return detail;
  }
  const allowPublicSpot =
    SPOT_ALLOWED_EVENTS.has(event) || (event === "map_filter" && detail === "open_3d");
  if (!allowPublicSpot || typeof rawSpot !== "string") {
    return "";
  }
  return rawSpot.replace(/[\r\n\t]/g, " ").trim().slice(0, 80);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/metric") {
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }

      try {
        const body = await request.json();
        const event = typeof body?.event === "string" ? body.event : "";
        const rawDetail = typeof body?.detail === "string" ? body.detail : "";

        const allowedDetails = ALLOWED_METRICS[event];
        if (!allowedDetails) {
          return new Response(null, { status: 204 });
        }

        // Coerce any unrecognised detail to empty string so free-form text (addresses,
        // coordinates, URLs) can never be persisted.
        const detail = allowedDetails.has(rawDetail) ? rawDetail : "";
        const spot = sanitizeSpot(event, detail, body?.spot);
        const rawSid = typeof body?.sid === "string" ? body.sid : "";
        const sid = HEX_SID_RE.test(rawSid) ? rawSid : "";

        if (env.METRICS && typeof env.METRICS.writeDataPoint === "function") {
          env.METRICS.writeDataPoint({
            indexes: [event],
            blobs: [event, detail, spot, sid],
            doubles: [1],
          });
        }
      } catch {
        // Ignore malformed JSON payloads
      }

      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
