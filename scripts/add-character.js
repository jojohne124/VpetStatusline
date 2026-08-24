#!/usr/bin/env node
'use strict';
/**
 * add-character.js — 把一隻新角色從「一堆 PNG」變成「跑得起來的角色」
 *
 * 存在的理由：這件事每隔一陣子就做一次，而每次都在重想同一批檢查 ——
 * 尤其是「這張圖的邏輯網格是幾格」。那個判斷寫在文件裡沒有用，下次還是會現場
 * 重寫一段 ad-hoc 檢查（而且可能寫錯），所以固化成程式。
 *
 * 判斷不了的事**刻意不做**：命名、power 給多少、要不要實裝、進化鏈怎麼接 ——
 * 那些本來就該由人決定，自動猜只會製造難查的錯。
 *
 * 用法：
 *   node scripts/add-character.js Sukamon --check              # 只偵測，什麼都不寫
 *   node scripts/add-character.js Sukamon --power 50           # 產 config + 轉檔 + 部署
 *   node scripts/add-character.js Sukamon --power 50 --bullet Agumon --implant
 *
 * 選項：
 *   --check            只偵測並回報，不寫任何檔
 *   --power N          基礎戰力（新角色必填；已有 config.json 則沿用）
 *   --stage S          覆寫自動推導的階段
 *   --bullet <Name>    借用某角色的子彈美術（預設：產暫代白球）
 *   --implant          加進 characters/roster.json（＝實裝，玩家會遇到）
 *   --no-deploy        不要同步到 ~/.claude/agumon-statusline/assets/
 *   --force            覆寫既有的 config.json
 */
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { execFileSync } = require('child_process');

const REPO   = path.resolve(__dirname, '..');
const CHARS  = path.join(REPO, 'characters');
const ASSETS = path.join(os.homedir(), '.claude', 'agumon-statusline', 'assets');
const TARGET = 16;                     // 邏輯網格邊長（= config.targetSize）
const FRAME_NAMES = ['Idle_1', 'Idle_2', 'Eat_1', 'Eat_2', 'Sleep_1', 'Sleep_2',
                     'Refuse', 'Happy', 'Angry', 'Hurt', 'Sad', 'Attack'];

const say  = (m) => console.log(m);
const die  = (m) => { console.log('✗ ' + m); process.exit(1); };

// ── 參數 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt  = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
// 逐一走過而不是 find + indexOf：indexOf 找的是**第一個**同名字串，
// 角色名剛好等於某個選項的值時就會抓錯（例如 --bullet Agumon 又要處理 Agumon）。
const TAKES_VALUE = new Set(['--power', '--stage', '--bullet']);
let name = null;
for (let i = 0; i < argv.length; i++) {
    if (TAKES_VALUE.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith('--')) continue;
    name = argv[i]; break;
}
if (!name) die('要指定角色資料夾名（characters/ 底下那個）。加 --check 只偵測。');

// 資料夾名不分大小寫比對 —— runtime 的 id 一律小寫，但 characters/ 底下是大寫開頭
function resolveDir(n) {
    if (!fs.existsSync(CHARS)) die(`找不到 ${CHARS}`);
    const hit = fs.readdirSync(CHARS).find(d => d.toLowerCase() === String(n).toLowerCase());
    return hit ? path.join(CHARS, hit) : null;
}
const dir = resolveDir(name);
if (!dir) die(`characters/ 底下找不到 ${name}`);
const dirName = path.basename(dir);
const id      = dirName.toLowerCase();

let sharp;
try { sharp = require('sharp'); } catch (e) { die('需要 sharp：npm i'); }

// ── 1. 邏輯網格偵測 ───────────────────────────────────────────────────
// **這是每次都在重寫的那一段。** PNG 的實體尺寸完全無所謂，重要的是「一格幾像素」——
// 手繪圖通常是把 16x16 的點陣放大成 48x48（一格 3x3）。若邏輯網格不等於 targetSize，
// char-cli 的中心點取樣就會取到格子邊緣，結果是「轉出來的圖跟原圖不一樣」而且很難看出原因。
//
// 做法：找出**最大**的 B（同時整除寬高）使得每個 B×B 區塊都同色。B=1 恆成立，
// 所以一定找得到答案；找最大的那個才是真正的一格。
function detectBlock(rgba, w, h, ch) {
    const same = (B) => {
        for (let by = 0; by < h / B; by++) for (let bx = 0; bx < w / B; bx++) {
            const i0 = ((by * B) * w + bx * B) * ch;
            for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
                const i = ((by * B + y) * w + bx * B + x) * ch;
                for (let k = 0; k < ch; k++) if (rgba[i + k] !== rgba[i0 + k]) return false;
            }
        }
        return true;
    };
    let best = 1;
    for (let B = 2; B <= Math.min(w, h); B++) if (w % B === 0 && h % B === 0 && same(B)) best = B;
    return best;
}

async function readRaw(f) {
    const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
    return { data, w: info.width, h: info.height, ch: info.channels };
}

// ── 2. 版面偵測 ───────────────────────────────────────────────────────
function detectLayout() {
    const files = fs.readdirSync(dir);
    const byIndex = new Map();
    for (const f of files) {
        const m = /^(\d+)(?:_.*)?\.png$/i.exec(f);
        if (m) byIndex.set(parseInt(m[1], 10), f);
    }
    if (byIndex.size) return { layout: 'individual', frames: byIndex };
    if (files.some(f => f.toLowerCase() === 'sprite.png')) return { layout: 'strip', frames: null };
    return { layout: null, frames: null };
}

// CutIn 檔名大小寫要正規化。Windows 的檔案系統不分大小寫，所以本機看起來「有效」，
// 但 char-cli 找的是 CutIn.png，而 git 與 Linux 分大小寫 —— 換台機器就壞了。
function normaliseCutIn() {
    const f = fs.readdirSync(dir).find(x => x.toLowerCase() === 'cutin.png');
    if (!f) return null;
    if (f !== 'CutIn.png' && !flag('check')) {
        fs.renameSync(path.join(dir, f), path.join(dir, 'CutIn.png'));
        say(`  · 檔名正規化：${f} → CutIn.png（分大小寫的檔案系統上才找得到）`);
    }
    return path.join(dir, f === 'CutIn.png' || flag('check') ? f : 'CutIn.png');
}

async function inspect() {
    const { layout, frames } = detectLayout();
    if (!layout) die('找不到 0.png…11.png，也沒有 sprite.png');

    const report = { layout, id, dirName, issues: [] };
    if (layout === 'individual') {
        const idx = [...frames.keys()].sort((a, b) => a - b);
        report.frameCount = idx.length;
        if (idx.length !== FRAME_NAMES.length)
            report.issues.push(`幀數是 ${idx.length}，標準是 ${FRAME_NAMES.length}`);
        for (let i = 0; i < idx.length; i++)
            if (idx[i] !== i) { report.issues.push(`幀編號不連續（缺 ${i}）`); break; }

        // 每一幀都量，取**最小**的 B —— 空白或單色的幀會量出很大的 B，
        // 拿它當答案會把網格算得太粗。細節最多的那一幀才是真相。
        let minB = Infinity, dims = null;
        const hashes = new Map();
        for (const i of idx) {
            const f = path.join(dir, frames.get(i));
            const { data, w, h, ch } = await readRaw(f);
            if (!dims) dims = { w, h };
            else if (dims.w !== w || dims.h !== h) report.issues.push(`第 ${i} 幀尺寸不一致（${w}x${h}）`);
            minB = Math.min(minB, detectBlock(data, w, h, ch));
            // 重複幀：整張圖一模一樣 = 那個動作沒有動畫。Sukamon 第一版就是這樣，
            // 睡覺／待機全是靜止的，而那件事沒人會主動去檢查。
            const key = require('crypto').createHash('md5').update(data).digest('hex');
            if (!hashes.has(key)) hashes.set(key, []);
            hashes.get(key).push(FRAME_NAMES[i] || ('#' + i));
        }
        report.src  = dims;
        report.block = minB;
        report.grid = { w: dims.w / minB, h: dims.h / minB };
        report.dupes = [...hashes.values()].filter(g => g.length > 1);
    } else {
        // strip/grid 的「一格幾像素」跟 individual 不是同一回事（區塊會跨幀邊界），
        // 量出來的數字沒有意義，所以不量也不印 —— 印一個看起來像答案的錯數字更糟。
        const m = await sharp(path.join(dir, 'sprite.png')).metadata();
        report.src = { w: m.width, h: m.height };
        report.issues.push('sprite.png（strip/grid）版面：幀切法要在 config 自己指定，'
                         + '本腳本不驗網格也不比對，轉完請自行確認');
    }

    if (report.grid && (report.grid.w !== TARGET || report.grid.h !== TARGET))
        report.issues.push(`邏輯網格是 ${report.grid.w}x${report.grid.h}，必須是 ${TARGET}x${TARGET}`
                         + `（實體尺寸無所謂，格子數才重要）`);

    const cut = normaliseCutIn();
    if (!cut) report.issues.push('沒有 CutIn.png —— roster 成員都要有，缺了戰鬥會退回 v1 分鏡');
    else {
        const m = await sharp(cut).metadata();
        report.cutin = `${m.width}x${m.height}`;
        if (m.width % 32 || m.height % 16)
            report.issues.push(`CutIn ${m.width}x${m.height} 不能整除 32x16，取樣會歪`);
    }
    return report;
}

// ── 3. config.json ───────────────────────────────────────────────────
function writeConfig(report) {
    const f = path.join(dir, 'config.json');
    if (fs.existsSync(f) && !flag('force')) {
        const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
        say(`  · config.json 已存在，沿用（power ${cfg.power} / ${cfg.stage}）。要重產加 --force`);
        return cfg;
    }
    const power = opt('power') != null ? Number(opt('power')) : null;
    if (power == null || !Number.isFinite(power)) die('新角色要用 --power 指定基礎戰力');
    const RULES = require(path.join(REPO, 'src', 'shared', 'evo-rules.js'));
    const stage = opt('stage') || RULES.stageForPower(power);
    // 推導出來的階段一定要回報。power 落在兩個 band 中間時推出來的結果會讓人意外，
    // 而 stage 直接決定 tier cap 與敵人配對 —— 猜錯了很久以後才會發現。
    say(`  · stage = ${stage}（由 power ${power} 推導${opt('stage') ? '，已被 --stage 覆寫' : ''}）`);

    const frames = {};
    FRAME_NAMES.forEach((n, i) => { frames[n.toUpperCase()] = i; });
    const cfg = {
        name: report.dirName, stage, power,
        frameCount: FRAME_NAMES.length, targetSize: TARGET,
        layout: report.layout,
        frameNames: FRAME_NAMES,
        frames,
        sleepFrames: [4, 5], sleepPeriod: 2,
        roarFrames: [11, 0, 11], tokenResetFrames: [7, 0, 7],
        exprs: [{ frames: [2] }, { frames: [8] }],
        evolvesTo: [],
    };
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
    say(`  · 已產 config.json`);
    return cfg;
}

// ── 4. 轉檔 ───────────────────────────────────────────────────────────
function run(args) {
    execFileSync(process.execPath, [path.join(REPO, 'src', 'tools', 'char-cli.js'), ...args],
                 { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── 5. 驗證：轉出來的東西必須跟原圖一致 ────────────────────────────────
// directSample（individual 版面一律走這條）不做調色，所以應該是**逐點相同**。
// 有差就代表網格判斷錯了或取樣偏移，那種錯用肉眼看縮圖幾乎看不出來。
async function verify(cfg, report) {
    const art = JSON.parse(fs.readFileSync(path.join(dir, 'art.json'), 'utf8'));
    if (report.layout !== 'individual') return { skipped: true };
    const { frames } = detectLayout();
    let bad = 0, checked = 0, opaque = 0;
    const colours = new Set();
    const blank = [];
    for (let fi = 0; fi < cfg.frameCount; fi++) {
        const { data, w, ch } = await readRaw(path.join(dir, frames.get(fi)));
        const S = report.block, f = art.frames[fi];
        let any = false;
        for (let y = 0; y < TARGET; y++) for (let x = 0; x < TARGET; x++) {
            const i = ((y * S + ((S / 2) | 0)) * w + (x * S + ((S / 2) | 0))) * ch;
            const on = (ch === 4 ? data[i + 3] : 255) >= 128;
            const cell = f[y >> 1][x], off = (y % 2) ? 3 : 0;
            const has = !!(cell && cell[off] >= 0);
            checked++; if (on) { opaque++; any = true; }
            if (on !== has) { bad++; continue; }
            if (!has) continue;
            if (cell[off] !== data[i] || cell[off + 1] !== data[i + 1] || cell[off + 2] !== data[i + 2]) bad++;
            else colours.add(cell.slice(off, off + 3).join(','));
        }
        if (!any) blank.push(FRAME_NAMES[fi] || ('#' + fi));
    }
    return { bad, checked, opaque, colours: colours.size, blank };
}

// ── 6. 部署 / roster ─────────────────────────────────────────────────
function deploy() {
    const out = path.join(ASSETS, id);
    fs.mkdirSync(out, { recursive: true });
    let n = 0;
    for (const f of ['art.json', 'config.json', 'bullet-art.json', 'cutin-art.json']) {
        const src = path.join(dir, f);
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(out, f)); n++; }
    }
    say(`  · 已部署 ${n} 個檔到 assets/${id}/`);
}

function implant() {
    const f = path.join(CHARS, 'roster.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j.roster.includes(id)) { j.roster.push(id); j.roster.sort(); }
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
    if (!flag('no-deploy')) fs.copyFileSync(f, path.join(ASSETS, 'roster.json'));
    say(`  · 已加進 roster（共 ${j.roster.length} 隻）`);
}

// ── 主流程 ───────────────────────────────────────────────────────────
(async () => {
    say(`\n🥚 ${dirName}  →  id: ${id}`);
    const report = await inspect();

    say('\n— 偵測 —');
    say(`  版面      ${report.layout}${report.frameCount ? `（${report.frameCount} 幀）` : ''}`);
    say(`  來源尺寸  ${report.src.w}x${report.src.h}`);
    if (report.block) say(`  一格      ${report.block}x${report.block} px`);
    if (report.grid) {
        const okGrid = report.grid.w === TARGET && report.grid.h === TARGET;
        say(`  邏輯網格  ${report.grid.w}x${report.grid.h}  ${okGrid ? '✓' : '✗ 必須是 16x16'}`);
    }
    if (report.cutin) say(`  CutIn     ${report.cutin}`);
    if (report.dupes && report.dupes.length) {
        say('\n— 重複幀（那個動作不會動）—');
        for (const g of report.dupes) say('  ' + g.join(' = '));
    }
    if (report.issues.length) {
        say('\n— 要注意 —');
        for (const i of report.issues) say('  ⚠ ' + i);
    }

    if (flag('check')) { say('\n（--check：什麼都沒有寫）\n'); return; }
    if (report.grid && (report.grid.w !== TARGET || report.grid.h !== TARGET))
        die('邏輯網格不對，轉出來一定失真。先修圖再跑一次（--check 可重複檢查）。');

    say('\n— 產出 —');
    const cfg = writeConfig(report);
    run(['process', dirName]);
    say('  · art.json');
    if (report.cutin) { run(['cutin', dirName]); say('  · cutin-art.json'); }

    const borrow = opt('bullet');
    if (borrow) {
        const bdir = resolveDir(borrow);
        if (!bdir) die(`借不到子彈：找不到 ${borrow}`);
        for (const f of ['bullet.json', 'bullet-art.json'])
            if (fs.existsSync(path.join(bdir, f))) fs.copyFileSync(path.join(bdir, f), path.join(dir, f));
        say(`  · bullet-art.json（借用 ${path.basename(bdir)}）`);
    } else if (!fs.existsSync(path.join(dir, 'bullet-art.json'))) {
        execFileSync(process.execPath, [path.join(REPO, 'scripts', 'gen-bullet-placeholders.js')],
                     { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
        say('  · bullet-art.json（暫代白球）');
    }

    say('\n— 驗證 —');
    const v = await verify(cfg, report);
    if (v.skipped) say('  （非 individual 版面，跳過逐點比對）');
    else {
        say(`  逐點比對  ${v.checked} 點（不透明 ${v.opaque}）→ 與原圖不符 ${v.bad} 點`);
        say(`  用色      ${v.colours} 色`);
        if (v.blank.length) say(`  ⚠ 全空的幀：${v.blank.join(' ')}`);
        if (v.bad) die('轉出來跟原圖不一樣 —— 網格或取樣有問題，先別部署。');
    }

    if (flag('implant')) implant();
    if (!flag('no-deploy')) deploy();

    say('\n— 還沒做的（要人決定）—');
    if (!flag('implant')) say('  · 尚未實裝：確定要讓玩家遇到再加 --implant');
    say('  · 進化鏈：用進化路線編輯器接（node src/editor/route_editor_server.js）');
    if (!opt('bullet')) say('  · 子彈是暫代圖，之後要換');
    say('');
})().catch(e => die(e.message));
