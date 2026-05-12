const sharp = require('sharp');
const fs = require('fs');

const TARGET_WIDTH = 32;
const TARGET_HEIGHT = 32;
const SPRITE_COUNT = 11;

const FRAME_NAMES = ['正常', '踏步', '高興', '生氣', '大吼', '瞪眼', '說話', '驚訝', '睡覺', '沮喪1', '沮喪2'];

async function main() {
    const imagePath = 'agumon_pixel.png';
    const metadata = await sharp(imagePath).metadata();

    console.log(`原始圖片尺寸: ${metadata.width}x${metadata.height}`);

    const frameWidth = Math.floor(metadata.width / SPRITE_COUNT);
    const frameHeight = metadata.height;

    console.log(`每幀原始大小: ${frameWidth}x${frameHeight}`);
    console.log(`目標縮放大小: ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
    console.log(`提取 ${SPRITE_COUNT} 幀...\n`);

    async function extractFrame(index) {
        const left = index * frameWidth;
        const safeWidth = Math.min(frameWidth, metadata.width - left);

        const { data } = await sharp(imagePath)
            .extract({ left, top: 0, width: safeWidth, height: frameHeight })
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .resize(TARGET_WIDTH, TARGET_HEIGHT, { kernel: 'nearest' })
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true });

        return Array.from(data).map(v => v < 128 ? 1 : 0);
    }

    const frames = [];
    for (let i = 0; i < SPRITE_COUNT; i++) {
        frames.push(await extractFrame(i));
        process.stdout.write(`\r提取中... ${i + 1}/${SPRITE_COUNT}`);
    }
    console.log('\n');

    fs.writeFileSync('agumon_pixels.json', JSON.stringify({ frames, width: TARGET_WIDTH, height: TARGET_HEIGHT }));

    // ASCII 預覽所有幀
    for (let i = 0; i < SPRITE_COUNT; i++) {
        printAscii(`Frame ${i}: ${FRAME_NAMES[i]}`, frames[i], TARGET_WIDTH, TARGET_HEIGHT);
    }

    console.log('\n請接著執行: node convert_to_braille.js');
}

function printAscii(label, pixels, w, h) {
    console.log(`\n--- ${label} ---`);
    for (let y = 0; y < h; y++) {
        let line = '';
        for (let x = 0; x < w; x++) {
            line += pixels[y * w + x] ? '██' : '  ';
        }
        console.log(line);
    }
}

main().catch(err => {
    console.error('錯誤:', err.message);
    process.exit(1);
});
