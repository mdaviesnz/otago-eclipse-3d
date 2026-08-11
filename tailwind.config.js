/** @type {import('tailwindcss').Config} */
module.exports = {
  // Tailwind scans these for class names. Anything assembled at runtime from fragments
  // (`bg-${colour}-900`) is invisible to the scanner and would be stripped — the pages
  // deliberately use whole literal class strings instead. See renderSightlineResults().
  content: ["./index.html", "./map.html"],
  theme: { extend: {} },
  plugins: [],
};
