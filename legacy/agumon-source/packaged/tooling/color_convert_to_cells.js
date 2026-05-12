const fs = require('fs');
const path = require('path');

const IN_JSON  = path.join(__dirname, '..', 'assets', 'agumon_pixels_color.json');
const OUT_JSON = path.join(__dirname, '..', 'assets', 'agumon_art_color.json');

const data = JSON.parse(fs.readFileSync(IN_JSON, 'utf8'));
const { frames, width, height } = data;

function frameToCells(pixels, w, h) {
  const rows = [];
  for (let y = 0; y < h; y += 2) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const up = pixels[y * w + x] || null;
      const lo = pixels[(y + 1) * w + x] || null;
      if (!up && !lo) row.push(null);
      else row.push([
        up ? up[0] : -1, up ? up[1] : -1, up ? up[2] : -1,
        lo ? lo[0] : -1, lo ? lo[1] : -1, lo ? lo[2] : -1,
      ]);
    }
    rows.push(row);
  }
  return rows;
}

const artFrames = frames.map((p) => frameToCells(p, width, height));

fs.writeFileSync(OUT_JSON, JSON.stringify({
  style: 'color-halfblock',
  width,
  height: Math.ceil(height / 2),
  frames: artFrames,
}));

console.log(`完成 → ${OUT_JSON}`);

