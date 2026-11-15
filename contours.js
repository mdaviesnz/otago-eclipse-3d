// Contour drawing for a single spot's topo view, from Terrarium elevation tiles.
//
// Pure: callers fetch the tiles and paint the result. Web Mercator pixel maths, Terrarium
// decoding, and turning an elevation grid into an RGBA image of contour lines.

export const terrariumMetres = (r, g, b) => r * 256 + g + b / 256 - 32768;

// A point's position in the whole-world pixel grid at this zoom.
export function worldPixel(lat, lon, zoom, tileSize = 512) {
  const n = 2 ** zoom * tileSize;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n,
  };
}

// Ground size of one pixel at this latitude and zoom.
export function metresPerPixel(lat, zoom, tileSize = 512) {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** zoom * tileSize);
}

// Every tile that touches a world-pixel rectangle.
export function tilesCovering(x0, y0, x1, y1, tileSize = 512) {
  const out = [];
  for (let x = Math.floor(x0 / tileSize); x <= Math.floor(x1 / tileSize); x++) {
    for (let y = Math.floor(y0 / tileSize); y <= Math.floor(y1 / tileSize); y++) out.push({ x, y });
  }
  return out;
}

// Elevation between grid points. Coordinates past the edge hold the edge value.
export function sampleBilinear(grid, width, height, x, y) {
  const fx = Math.max(0, Math.min(width - 1, x));
  const fy = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const at = (a, b) => grid[b * width + a];
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) +
         (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}

const PAPER = [255, 255, 255];
const LINE = [200, 150, 112];
const INDEX_LINE = [150, 96, 58];

// RGBA pixels of contour lines on white. `elevationAt(px, py)` gives metres at an output pixel.
// A line falls wherever a pixel and its neighbour sit in different contour bands; every
// `indexEvery`th contour is darker and twice as thick so slopes can be counted.
export function contourImage({ width, height, elevationAt, interval = 50, indexEvery = 5 }) {
  const elev = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) elev[y * width + x] = elevationAt(x, y);
  }
  const major = interval * indexEvery;
  const crosses = (a, b, step) => Math.floor(a / step) !== Math.floor(b / step);
  const kind = new Uint8Array(width * height);       // 0 paper, 1 contour, 2 index contour
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const here = elev[i];
      const right = x + 1 < width ? elev[i + 1] : here;
      const below = y + 1 < height ? elev[i + width] : here;
      if (crosses(here, right, major) || crosses(here, below, major)) {
        kind[i] = 2;
        if (x + 1 < width) kind[i + 1] = 2;
        if (y + 1 < height) kind[i + width] = 2;
      } else if (kind[i] === 0 && (crosses(here, right, interval) || crosses(here, below, interval))) {
        kind[i] = 1;
      }
    }
  }
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < kind.length; i++) {
    const c = kind[i] === 2 ? INDEX_LINE : kind[i] === 1 ? LINE : PAPER;
    px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
  }
  return px;
}
