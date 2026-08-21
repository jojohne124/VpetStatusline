#!/usr/bin/env node
'use strict';
/**
 * gen-new-char-scaffold.js — 為 63 隻新角色建立轉檔前置：
 *   1. BlitzGreymon / CresGarurumon：sprite.png(144x240, 3欄×5列, 48x48格)切成
 *      individual 檔（00_Idle_1.png … 11_Attack.png + CutIn.png 96x48），對齊其他 61 隻格式。
 *   2. 全 63 隻：依 individual 模板 + 各角色 power 產 config.json（stage 由 power 自動推、會驗證；
 *      evolvesTo 先留空，待「實裝」階段再接鏈）。
 *
 * 不做轉檔本身（art.json）；那一步用 char-cli process / cutin。也不部署。
 *
 * ⚠️ **這是 2026 年那一批 63 隻的一次性腳本，已經沒有日常用途。**
 *    它會**無條件覆寫那 63 隻的 config.json**，包含已經接好的 evolvesTo ——
 *    跑一次就把進化鏈全部清空（實際發生過：只是想看它在做什麼，順手跑起來，
 *    63 個 config 當場被洗掉 996 行，靠 git 才救回來）。
 *    所以現在要 --yes 才會真的寫。加單隻角色請用 scripts/add-character.js。
 *
 * 用法：node scripts/gen-new-char-scaffold.js --yes
 */
if (!process.argv.includes('--yes')) {
    console.log('這支腳本會覆寫 63 隻角色的 config.json（含已接好的 evolvesTo），');
    console.log('是 2026 年那批新角色的一次性工具，日常不該跑。');
    console.log('');
    console.log('  加單隻新角色 →  node scripts/add-character.js <Name> --check');
    console.log('  真的要重跑   →  node scripts/gen-new-char-scaffold.js --yes');
    process.exit(0);
}
const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');

const CHARS = path.join(__dirname, '..', 'characters');

// 各角色基礎 power（來自規格）。stage 由 power band 推導 + 驗證。
const POWER = {
    Greymon_2010:75, MetalGreymon_2010:125, ZekeGreymon:170,
    Leomon:65, Shishimamon:115, SaberLeomon:165,
    Kuwagamon:60, Okuwamon:110, GranKuwagamon:165,
    Dolphmon:65, Whamon:115, Plesiomon:165,
    Xiquemon:70, Crowmon:120, Tengumon:170,
    Woodmon:65, Cherrymon:115, Puppetmon:165,
    Turuiemon:60, Antylamon:115, Dijiangmon:170,
    LadyDevimon:130, Lilithmon:175,
    Musyamon:60, Oboromon:110, Zanbamon:160,
    Godzilla_Jr:125, Godzilla_1994:180,
    BlitzGreymon:175, CresGarurumon:175,
    Blossomon:115, Hydramon:170,
    Pumpkinmon:120, NoblePumpkinmon:175,
    Syakomon:15, Shellmon:62, MarinBullmon:120, Ryugumon:170, Ariemon:165,
    Seadramon:58, MegaSeadramon:115, MetalSeadramon:160, Shagaramon:165,
    Commandramon:25, 'Hi-Commandramon':75, Cargodramon:125, Brigadramon:175,
    Loogamon:25, Loogarmon:75, Soloogarmon:125, Fenriloogamon:175,
    Pteromon:25, Galemon:75, GrandGalemon:125, Zephagamon:175,
    Angoramon:25, SymbareAngoramon:75, Lamortmon:125, Diarbbitmon:175,
    Jellymon:25, TeslaJellymon:75, Thetismon:125, Amphimon:175,
};
const SPECIAL = ['BlitzGreymon', 'CresGarurumon'];   // sprite.png 需先切片

const BANDS = [['Child',10,30],['Adult',55,80],['Perfect',110,130],['Ultimate',160,190]];
function stageOf(pw, name) {
    const b = BANDS.find(([,lo,hi]) => pw >= lo && pw <= hi);
    if (!b) throw new Error(`${name} power ${pw} 不在任何階級帶（檢查數值）`);
    return b[0];
}

const FRAME_NAMES = ['Idle_1','Idle_2','Eat_1','Eat_2','Sleep_1','Sleep_2','Refuse','Happy','Angry','Hurt','Sad','Attack'];
const FRAMES_MAP  = { IDLE_1:0,IDLE_2:1,EAT_1:2,EAT_2:3,SLEEP_1:4,SLEEP_2:5,REFUSE:6,HAPPY:7,ANGRY:8,HURT:9,SAD:10,ATTACK:11 };

function makeConfig(name, pw) {
    return {
        name: name.toLowerCase(),
        stage: stageOf(pw, name),
        power: pw,
        frameCount: 12,
        targetSize: 16,
        layout: 'individual',
        frameNames: FRAME_NAMES,
        frames: FRAMES_MAP,
        sleepFrames: [4,5],
        sleepPeriod: 2,
        roarFrames: [11,0,11],
        tokenResetFrames: [7,0,7],
        exprs: [{ frames:[2] }, { frames:[8] }],
        evolvesTo: [],   // 待實裝階段接鏈（需 win_rate 公式 + 是否接到現有角色的決定）
    };
}

// 切 144x240(3欄×5列,48x48) → individual 檔 + CutIn(欄1-2, 96x48)
async function sliceSpecial(name) {
    const dir = path.join(CHARS, name);
    const src = path.join(dir, 'sprite.png');
    const CELL = 48;
    for (let i = 0; i < 12; i++) {
        const col = i % 3, row = Math.floor(i / 3);
        const out = path.join(dir, `${String(i).padStart(2,'0')}_${FRAME_NAMES[i]}.png`);
        await sharp(src).extract({ left: col*CELL, top: row*CELL, width: CELL, height: CELL }).toFile(out);
    }
    // CutIn：第 5 列（top=192）欄 1-2（left=48, 寬 96）
    await sharp(src).extract({ left: CELL, top: 4*CELL, width: 2*CELL, height: CELL }).toFile(path.join(dir, 'CutIn.png'));
}

(async () => {
    const names = Object.keys(POWER);
    if (names.length !== 63) throw new Error(`POWER 表有 ${names.length} 筆，預期 63`);

    // 1. 切特殊格式
    for (const n of SPECIAL) {
        await sliceSpecial(n);
        console.log(`✂ 切片 ${n}: 12 幀 + CutIn.png`);
    }

    // 2. 寫 config.json
    const byStage = {};
    for (const n of names) {
        const dir = path.join(CHARS, n);
        if (!fs.existsSync(dir)) throw new Error(`找不到資料夾 characters/${n}`);
        const cfg = makeConfig(n, POWER[n]);
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
        byStage[cfg.stage] = (byStage[cfg.stage] || 0) + 1;
    }
    console.log(`✓ 已寫 ${names.length} 份 config.json`);
    console.log('  各階分佈:', JSON.stringify(byStage));
    console.log('  下一步：char-cli process + cutin 轉出 art.json（先別 install）');
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
