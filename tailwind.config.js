/** @type {import('tailwindcss').Config} */
module.exports = {
  // Tailwind scans these for class names. Anything assembled at runtime from fragments
  // (`bg-${colour}-900`) is invisible to the scanner and would be stripped — the pages
  // deliberately use whole literal class strings instead. See renderSightlineResults().
  content: ["./index.html", "./map.html", "./astronomy.html", "./methods.html"],

  // The scanner is greedy: it treats any bare word in the file as a candidate class, including
  // words inside URLs and comments. The Cloudflare Web Analytics beacon is served from
  // `static.cloudflareinsights.com`, and that hostname alone was enough to mint
  // `.static{position:static}` and fail CI's stale-stylesheet check. Nothing on either page
  // uses `static` as a class — position: static is the CSS default — so block it rather than
  // ship a rule no element can ever match.
  blocklist: ["static"],
  theme: { extend: {} },
  plugins: [],
};
