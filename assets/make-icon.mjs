/**
 * Draws the app icon from the brand's own geometry — no design tool needed, and the mark cannot
 * drift from the one the top bar and the sign-in card draw.
 *
 * The icon is the shield knocked out of an accent tile: the same shield as the CSS `--mark-mask`
 * token, the same accent as the light theme's `--accent`.
 *
 *   node assets/make-icon.mjs [size]     # default 512, written to assets/icon.png
 *
 * The rasterizer is deliberately dependency-free: it flattens the path, supersamples 4x per axis
 * for the antialiasing, and writes the PNG with Node's own zlib + a CRC32 of our own.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

/* ---------- The mark ---------- */

// The shield, as the `--mark-mask` token has it: "M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26
// 9-5.45 9-11V7l-10-5z", in its own 24x24 coordinate space.
function shieldPoints(steps = 48) {
  const cubic = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  };
  const points = [[12, 2], [2, 7], [2, 17]]; // M, L, v10
  const left = cubic([2, 17], [2, 22.55], [5.84, 26.74], [11, 28], 0); // c0 5.55 3.84 9.74 9 11
  for (let i = 0; i <= steps; i++) points.push(cubic([2, 17], [2, 22.55], [5.84, 26.74], [11, 28], i / steps));
  for (let i = 0; i <= steps; i++) points.push(cubic([11, 28], [16.16, 26.74], [20, 22.55], [20, 17], i / steps));
  points.push([20, 7], [10, 2]); // V7, l-10-5, z
  void left;
  return points;
}

const insidePolygon = (points, x, y) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const insideRoundedSquare = (x, y, size, radius) => {
  const [left, top, right, bottom] = [0, 0, size, size];
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
};

/* ---------- Rasterize ---------- */

const ACCENT = [0x0f, 0x76, 0x6e]; // --accent, light theme
const MARK = [0xff, 0xff, 0xff];

/** RGBA pixels for the icon, 4x supersampled on each axis. */
function render(size) {
  const shield = shieldPoints();
  // Fit the 18x26 shield into the tile with a margin, centred.
  const fill = 0.58;
  const scale = (size * fill) / 26;
  const offsetX = (size - 18 * scale) / 2;
  const offsetY = (size - 26 * scale) / 2;
  const toTile = ([x, y]) => [offsetX + x * scale, offsetY + y * scale];
  const mark = shield.map(toTile);

  const radius = size * 0.22;
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4, total = samples * samples;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = px + (sx + 0.5) / samples;
          const y = py + (sy + 0.5) / samples;
          if (!insideRoundedSquare(x, y, size, radius)) continue;
          const [r0, g0, b0] = insidePolygon(mark, x, y) ? MARK : ACCENT;
          r += r0; g += g0; b += b0; a += 255;
        }
      }
      const at = (py * size + px) * 4;
      if (!a) continue;
      // Average the covered samples; the colour comes out premultiplied over the tile's alpha.
      pixels[at] = Math.round(r / (a / 255));
      pixels[at + 1] = Math.round(g / (a / 255));
      pixels[at + 2] = Math.round(b / (a / 255));
      pixels[at + 3] = Math.round(a / total);
    }
  }
  return pixels;
}

/* ---------- PNG ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

function toPng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = none) in front of every row.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- Write ---------- */

const size = Number(process.argv[2] || 512);
if (!Number.isInteger(size) || size < 64) throw new Error("size must be a whole number of 64 or more");
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "icon.png");
fs.writeFileSync(out, toPng(render(size), size));
console.log(`wrote ${path.relative(process.cwd(), out)} — ${size}x${size}`);
