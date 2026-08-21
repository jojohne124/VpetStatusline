#!/usr/bin/env node
'use strict';
/**
 * test-add-character.js — 釘住 add-character.js 的偵測邏輯
 *
 * 圖是現場合成的（暫時建在 characters/__TestCharNNN/，跑完刪掉），不碰任何既有角色 ——
 * 綁真角色的話，那隻美術一改測試就會無聲失效。部署一律關掉（--no-deploy），
 * 不會動到 ~/.claude/agumon-statusline/。
 *
 * 重點在兩件事：
 *   1. **邏輯網格偵測** —— 每次加角色都在重寫的那一段，也最容易寫錯
 *   2. **逐點比對必須 0 點不符** —— 偵測對了不代表轉檔對，而取樣偏一格看縮圖看不出來
 *
 * 用法：node scripts/test-add-character.js
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let sharp;
try { sharp = require('sharp'); }
catch (e) { console.log('（沒有 sharp，跳過）\n結果：0 passed, 0 failed'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const REPO   = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'add-character.js');
const CHARS  = path.join(REPO, 'characters');

// characters/ 底下建一隻臨時角色，跑完刪掉。
// 名字加 pid，同時跑兩份也不會互相踩。
const NAME = '__TestChar' + process.pid;
const DIR  = path.join(CHARS, NAME);
const cleanup = () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup);

/** 產一張「邏輯 grid×grid、每格 block×block 像素」的圖。dup=true 時所有幀都一樣。 */
async function frame(file, grid, block, seedv) {
    const w = grid * block, px = Buffer.alloc(w * w * 4);
    for (let gy = 0; gy < grid; gy++) for (let gx = 0; gx < grid; gx++) {
        // 每一格一個顏色；seedv 讓不同幀長得不一樣
        const on = ((gx * 7 + gy * 13 + seedv) % 5) !== 0;
        const c = [(gx * 16 + seedv * 3) % 256, (gy * 16) % 256, (seedv * 40) % 256, on ? 255 : 0];
        for (let y = 0; y < block; y++) for (let x = 0; x < block; x++) {
            const i = ((gy * block + y) * w + gx * block + x) * 4;
            px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
        }
    }
    await sharp(px, { raw: { width: w, height: w, channels: 4 } }).png().toFile(file);
}

async function build({ grid = 16, block = 3, dupFrom = null, cutin = 'CutIn.png',
                       cutinSize = [96, 48], frames = 12 } = {}) {
    cleanup();
    fs.mkdirSync(DIR, { recursive: true });
    for (let i = 0; i < frames; i++) {
        await frame(path.join(DIR, i + '.png'), grid, block, dupFrom != null ? dupFrom : i);
    }
    if (cutin) {
        const [cw, chh] = cutinSize;
        await sharp(Buffer.alloc(cw * chh * 4, 200), { raw: { width: cw, height: chh, channels: 4 } })
            .png().toFile(path.join(DIR, cutin));
    }
}

function check() {
    try {
        return execFileSync(process.execPath, [SCRIPT, NAME, '--check'],
                            { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

(async () => {
    console.log('— 邏輯網格偵測 —');
    // 這是整支腳本存在的理由：實體尺寸無所謂，格子數才重要。
    for (const [grid, block] of [[16, 3], [16, 1], [16, 16], [16, 5]]) {
        await build({ grid, block });
        const out = check();
        ok(out.includes(`一格      ${block}x${block} px`), `${grid * block}x${grid * block} 應偵測出一格 ${block}px`);
        ok(out.includes('邏輯網格  16x16  ✓'), `${grid * block}x${grid * block}（一格 ${block}px）應判定為 16x16 ✓`);
    }

    // 錯的網格要擋下來，而且要說得出實體尺寸不是重點
    await build({ grid: 24, block: 2 });
    {
        const out = check();
        ok(out.includes('24x24'), '應報出實際的邏輯網格 24x24');
        ok(out.includes('必須是 16x16'), '網格不對時應明講必須是 16x16');
    }

    console.log('— 重複幀 —');
    // 那個動作不會動。Sukamon 第一版就是這樣，是靠 md5 湊巧發現的，不在流程裡。
    await build({ dupFrom: 7 });
    {
        const out = check();
        ok(out.includes('重複幀'), '所有幀相同時應報重複幀');
        ok(out.includes('Idle_1 = Idle_2'), '應列出是哪些幀重複');
    }
    await build();
    ok(!check().includes('重複幀'), '每幀都不同時不該誤報重複幀');

    console.log('— CutIn —');
    await build({ cutin: null });
    ok(check().includes('沒有 CutIn.png'), '缺 CutIn 應提醒');
    await build({ cutinSize: [90, 50] });
    ok(check().includes('不能整除'), 'CutIn 尺寸不能整除 32x16 應提醒');
    await build();
    ok(check().includes('CutIn     96x48'), '正常的 CutIn 應回報尺寸');

    console.log('— 幀數 / 版面 —');
    await build({ frames: 8 });
    ok(check().includes('幀數是 8'), '幀數不足應提醒');
    await build();
    {
        const out = check();
        ok(out.includes('individual（12 幀）'), '應辨識出 individual 版面');
        ok(out.includes('（--check：什麼都沒有寫）'), '--check 不該寫任何東西');
        ok(!fs.existsSync(path.join(DIR, 'config.json')), '--check 卻產了 config.json');
        ok(!fs.existsSync(path.join(DIR, 'art.json')), '--check 卻產了 art.json');
    }

    console.log('— 完整跑一遍（不部署）—');
    // 偵測對了不代表轉檔對。這段真的跑完整流程，重點是**逐點比對必須 0 點不符** ——
    // directSample 不做調色，所以轉出來應該跟原圖一模一樣；有差就是網格或取樣偏了，
    // 那種錯看縮圖幾乎看不出來。
    await build();
    {
        let out;
        try {
            out = execFileSync(process.execPath,
                [SCRIPT, NAME, '--power', '70', '--no-deploy'],
                { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
        ok(/與原圖不符 0 點/.test(out), '逐點比對沒有全對：' + (out.match(new RegExp('與原圖不符 ' + String.fromCharCode(92) + 'd+ 點')) || ['(沒有比對輸出)'])[0]);
        ok(fs.existsSync(path.join(DIR, 'art.json')), '沒有產出 art.json');
        ok(fs.existsSync(path.join(DIR, 'cutin-art.json')), '沒有產出 cutin-art.json');
        ok(fs.existsSync(path.join(DIR, 'bullet-art.json')), '沒有產出 bullet-art.json');
        const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
        ok(cfg.power === 70, 'config.power 不對');
        ok(cfg.stage === 'Adult', `power 70 應推導成 Adult，得到 ${cfg.stage}`);
        ok(cfg.layout === 'individual', 'config.layout 不對');
        ok(Array.isArray(cfg.evolvesTo) && cfg.evolvesTo.length === 0,
           '新角色的 evolvesTo 應該是空的（進化鏈要人決定，不能自動接）');
        // --no-deploy 就真的不要碰 installed
        const deployed = path.join(require('os').homedir(), '.claude', 'agumon-statusline',
                                   'assets', NAME.toLowerCase());
        ok(!fs.existsSync(deployed), '--no-deploy 卻還是部署了');
        // 未實裝：不能自己混進 roster
        const roster = JSON.parse(fs.readFileSync(path.join(CHARS, 'roster.json'), 'utf8'));
        ok(!roster.roster.includes(NAME.toLowerCase()), '沒加 --implant 卻自己進了 roster');
    }

    console.log('— 找不到東西時不能靜默 —');
    {
        let out;
        try {
            out = execFileSync(process.execPath, [SCRIPT, '__NoSuchCharacter__', '--check'],
                               { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
        ok(out.includes('找不到'), '不存在的角色應明確報錯');
    }

    cleanup();
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { cleanup(); console.log('  ✗ 例外：' + e.message); process.exit(1); });
