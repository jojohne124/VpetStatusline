const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const TARGET_WIDTH = 32;
const TARGET_HEIGHT = 32;
const SPRITE_COUNT = 11;

const IN_PNG = path.join(__dirname, 'input', 'agumon_pixel.png');
const OUT_JSON = path.join(__dirname, '..', 'assets', 'agumon_pixels.json');

async function main() {
  if (!fs.existsSync(IN_PNG)) {
    console.error(`找不到輸入檔：${IN_PNG}`);
    console.error('請把黑白原圖放到 packaged/tooling/input/agumon_pixel.png');
    process.exit(1);
  }

  const metadata = await sharp(IN_PNG).metadata();
  console.log(`原始圖片尺寸: ${metadata.width}x${metadata.height}`);

  const frameWidth = Math.floor(metadata.width / SPRITE_COUNT);
  const frameHeight = metadata.height;
  console.log(`每幀原始大小: ${frameWidth}x${frameHeight}`);
  console.log(`目標縮放大小: ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
  console.log(`提取 ${SPRITE_COUNT} 幀...\n`);

  async function extractFrame(index) {
    const left = index * frameWidth;
    const safeWidth = Math.min(frameWidth, metadata.width - left);

    const { data } = await sharp(IN_PNG)
      .extract({ left, top: 0, width: safeWidth, height: frameHeight })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(TARGET_WIDTH, TARGET_HEIGHT, { kernel: 'nearest' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return Array.from(data).map(v => (v < 128 ? 1 : 0));
  }

  const frames = [];
  for (let i = 0; i < SPRITE_COUNT; i++) {
    frames.push(await extractFrame(i));
    process.stdout.write(`\r提取中... ${i + 1}/${SPRITE_COUNT}`);
  }
  console.log('\n');

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({ frames, width: TARGET_WIDTH, height: TARGET_HEIGHT }));
  console.log(`完成 → ${OUT_JSON}`);
  console.log('接著執行：node bw_convert_to_braille.js');
}

main().catch(err => {
  console.error('錯誤:', err.message);
  process.exit(1);
});

