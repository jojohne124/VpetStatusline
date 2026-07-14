// 啟動方式：node sprite_editor_server.js <character>
// 例：node sprite_editor_server.js agumon
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

const name = process.argv[2] || 'agumon';
const PORT = Number(process.env.SPRITE_EDITOR_PORT) || 3000;

// 戰鬥表演預覽：重用 runtime 的 decideBattleFrame + composeBattleScene，
// 確保預覽與實際 statusline 表演一致（子彈用編輯器當下的像素）。
// 必須用「已部署」的 core：它的 ASSETS_DIR 指向 ~/.claude/agumon-statusline/assets，
// loadCharacter/loadShared/chooseBattleEnemy 才讀得到角色資產。
let CORE = null;
for (const p of [
    path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js'),
    path.join(__dirname, '..', 'runtime', 'agumon-core.js'),
]) {
    try { if (fs.existsSync(p)) { CORE = require(p); break; } } catch (e) {}
}

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const CHAR_DIR    = path.join(REPO_ROOT, 'characters', name);
const HTML_PATH   = path.join(__dirname, 'sprite_editor.html');
const CHAR_CLI    = path.join(REPO_ROOT, 'src', 'tools', 'char-cli.js');

const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');
const ASSETS_DIR  = path.join(INSTALL_DIR, 'assets');
const STATE_DIR   = path.join(INSTALL_DIR, 'state');

if (!fs.existsSync(CHAR_DIR)) {
    console.error(`找不到角色資料夾：${CHAR_DIR}`);
    process.exit(1);
}

const SHARED_DIR     = path.join(REPO_ROOT, 'shared');
const SHARED_ART_DST = path.join(ASSETS_DIR, 'shared', 'art.json');
const SHARED_SRC_DST = path.join(ASSETS_DIR, 'shared', 'sprites.json');

// ── 角色解析（支援 UI 內切換，不重啟）─────────────────────────────
const CHARS_ROOT = path.join(REPO_ROOT, 'characters');
// query.char 合法且存在 → 用它；否則回退啟動角色
function resolveChar(query) {
    const c = query.char;
    if (c && /^[A-Za-z0-9_-]+$/.test(c) && fs.existsSync(path.join(CHARS_ROOT, c, 'config.json'))) return c;
    return name;
}
function listChars() {
    try {
        return fs.readdirSync(CHARS_ROOT, { withFileTypes: true })
            .filter(d => d.isDirectory() && fs.existsSync(path.join(CHARS_ROOT, d.name, 'config.json')))
            .map(d => d.name)
            .sort((a, b) => a.localeCompare(b));
    } catch(e) { return []; }
}
// 啟動參數可能是小寫（gatomon），對應到正規資料夾名（Gatomon），下拉才選得中
function canonicalChar(n) {
    return listChars().find(c => c.toLowerCase() === String(n).toLowerCase()) || n;
}

// ── mode 對應：character vs bullet vs shared vs cutin ─────────────
function modePaths(mode, charName) {
    const charDir = path.join(CHARS_ROOT, charName);
    const lc      = charName.toLowerCase();
    if (mode === 'bullet') {
        return {
            src:  path.join(charDir, 'bullet.json'),
            art:  path.join(charDir, 'bullet-art.json'),
            dstArt: path.join(ASSETS_DIR, lc, 'bullet-art.json'),
        };
    }
    if (mode === 'shared') {
        return {
            src:    path.join(SHARED_DIR, 'sprites.json'),
            art:    path.join(SHARED_DIR, 'art.json'),
            dstArt: SHARED_ART_DST,
            dstSrc: SHARED_SRC_DST,
            isShared: true,
        };
    }
    if (mode === 'cutin') {
        // cutin 沒有 pixels.json 中介檔；art.json 是唯一 source of truth
        return {
            art:    path.join(charDir, 'cutin-art.json'),
            dstArt: path.join(ASSETS_DIR, lc, 'cutin-art.json'),
            isCutin: true,
        };
    }
    return {
        src:  path.join(charDir, 'pixels.json'),
        art:  path.join(charDir, 'art.json'),
        dstArt: path.join(ASSETS_DIR, lc, 'art.json'),
    };
}

// half-block art.json → flat pixel array（供 cutin 編輯時反解用）
function artToPixels(artData) {
    const w = artData.width, h = artData.height * 2;
    return artData.frames.map(rows => {
        const px = new Array(w * h).fill(null);
        for (let cy = 0; cy < rows.length; cy++) {
            const row = rows[cy] || [];
            for (let cx = 0; cx < row.length; cx++) {
                const cell = row[cx];
                if (!cell) continue;
                if (cell[0] !== -1) px[(cy * 2)     * w + cx] = [cell[0], cell[1], cell[2]];
                if (cell[3] !== -1) px[(cy * 2 + 1) * w + cx] = [cell[3], cell[4], cell[5]];
            }
        }
        return px;
    });
}

// 從 manifest.json 反推出每個 frame 的名稱（encounter[0] → encounter1，等）
function sharedFrameNames() {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'manifest.json'), 'utf8'));
        const names = {};
        for (const [spriteName, def] of Object.entries(m.sprites || {})) {
            const idxs = def.indices || [];
            const uniq = [...new Set(idxs)];
            idxs.forEach((idx, i) => {
                if (!(idx in names)) {
                    // 單幀 sprite：純粹用名稱（dna_end）；多幀：加序號（dna1, dna2...）
                    names[idx] = uniq.length === 1 ? spriteName : `${spriteName}${i + 1}`;
                }
            });
        }
        const max = Math.max(-1, ...Object.keys(names).map(Number));
        return Array.from({ length: max + 1 }, (_, i) => names[i] || `frame${i}`);
    } catch(e) { return null; }
}

// pixels (flat array, RGB or null) → half-block cell rows
function pixelsToArt(pixels, w, h) {
    const rows = [];
    for (let y = 0; y < h; y += 2) {
        const row = [];
        for (let x = 0; x < w; x++) {
            const up = pixels[y * w + x] || null;
            const lo = pixels[(y + 1) * w + x] || null;
            if (!up && !lo) { row.push(null); continue; }
            row.push([
                up ? up[0] : -1, up ? up[1] : -1, up ? up[2] : -1,
                lo ? lo[0] : -1, lo ? lo[1] : -1, lo ? lo[2] : -1,
            ]);
        }
        rows.push(row);
    }
    return rows;
}

function parseQuery(url) {
    const q = url.split('?')[1] || '';
    const out = {};
    for (const kv of q.split('&')) {
        if (!kv) continue;
        const [k, v] = kv.split('=');
        out[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    return out;
}

const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const query   = parseQuery(req.url);
    const mode    = query.mode === 'bullet' ? 'bullet'
                   : query.mode === 'shared' ? 'shared'
                   : query.mode === 'cutin'  ? 'cutin'
                   : 'character';
    const charName = resolveChar(query);   // ?char= 指定，否則啟動角色

    if (req.method === 'GET' && urlPath === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(HTML_PATH));
    }
    else if (req.method === 'GET' && urlPath === '/chars') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ chars: listChars(), current: canonicalChar(charName) }));
    }
    else if (req.method === 'GET' && urlPath === '/meta') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        let frameNames = null, rightOffset = null, displayName = charName;
        if (mode === 'shared') {
            frameNames = sharedFrameNames();
            displayName = 'shared';
        } else if (mode === 'cutin') {
            // 第 0 幀左向、第 1 幀右向（若有）；用 rightOffset 讓 label 自動加 →
            frameNames = ['CutIn'];
            try {
                const { art } = modePaths(mode, charName);
                const a = JSON.parse(fs.readFileSync(art, 'utf8'));
                if (a.frames && a.frames.length >= 2) rightOffset = 1;
            } catch(e) {}
        } else {
            try {
                const cfg = JSON.parse(fs.readFileSync(path.join(CHARS_ROOT, charName, 'config.json'), 'utf8'));
                frameNames = cfg.frameNames || null;
                rightOffset = cfg.rightOffset ?? null;
            } catch(e) {}
        }
        res.end(JSON.stringify({ name: displayName, frameNames, rightOffset }));
    }
    else if (req.method === 'GET' && urlPath === '/data') {
        if (mode === 'cutin') {
            const { art } = modePaths(mode, charName);
            if (!fs.existsSync(art)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `cutin-art.json not found。請先放 CutIn.png 進 characters/${charName}/ 並執行：node src/tools/char-cli.js cutin ${charName}` }));
                return;
            }
            const a = JSON.parse(fs.readFileSync(art, 'utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ width: a.width, height: a.height * 2, frames: artToPixels(a) }));
            return;
        }
        const { src } = modePaths(mode, charName);
        if (!fs.existsSync(src)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `${path.basename(src)} not found` }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(fs.readFileSync(src));
    }
    else if (req.method === 'POST' && urlPath === '/save') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { src, art, dstArt } = modePaths(mode, charName);

                // cutin 沒有 src（直接編 art.json）
                if (src && fs.existsSync(src)) fs.copyFileSync(src, src + '.bak');
                if (src) fs.writeFileSync(src, body);

                let convertOut = '';
                if (mode === 'bullet' || mode === 'shared' || mode === 'cutin') {
                    // 直接從 pixels 編譯 art.json（不走 char-cli）
                    try {
                        const data = JSON.parse(body);
                        const w = data.width || 16, h = data.height || 16;
                        if (mode === 'cutin' && fs.existsSync(art)) fs.copyFileSync(art, art + '.bak');
                        const frames = data.frames.map(px => pixelsToArt(px, w, h));
                        const artData = { style: 'color-halfblock', width: w, height: h / 2, frames };
                        fs.writeFileSync(art, JSON.stringify(artData));
                        convertOut = `${path.basename(art)} written (${frames.length} frame)`;
                    } catch(e) { convertOut = mode + ' compile error: ' + e.message; }
                } else {
                    try {
                        convertOut = execFileSync('node', [CHAR_CLI, 'build', charName], { encoding: 'utf8' });
                    } catch(e) { convertOut = 'build error: ' + e.message; }
                }

                // 部署到 statusline runtime
                const assetDir = path.dirname(dstArt);
                try {
                    if (!fs.existsSync(assetDir)) fs.mkdirSync(assetDir, { recursive: true });
                    fs.copyFileSync(art, dstArt);
                    // shared 模式還要同步 sprites.json（pixels）
                    const { dstSrc } = modePaths(mode, charName);
                    if (dstSrc && src) fs.copyFileSync(src, dstSrc);
                } catch(e) { convertOut += '\ncopy error: ' + e.message; }

                // 不要動 state.json：art.json 每次 refresh 都會重讀，沒有 in-memory cache。
                // 砍 state 會造成 (a) 角色倒退 fallback 到 agumon、(b) lastEvolveTriggerTs/lastBattleTriggerTs
                // 跟著消失導致 force 內未過期的 trigger 被誤認為新 trigger 重觸發進化/戰鬥動畫。

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, convert: convertOut.trim(), mode }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
    }
    else if (req.method === 'POST' && urlPath === '/battle-frames') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                if (!CORE) throw new Error('agumon-core 載入失敗，無法預覽');
                const data    = JSON.parse(body);          // 編輯器當下像素（未存也行）
                const win     = query.win !== 'lose';       // 預設我方勝
                const meId    = charName.toLowerCase();      // assets 資料夾為小寫

                // 我方子彈＝目前編輯中的那一幀（runtime 只用 frames[0]，這裡用選取幀當它）
                const w = data.width || 16, h = data.height || 16;
                const fi = Math.max(0, Math.min((data.frames?.length || 1) - 1, data.frameIdx | 0));
                const meBulletArt = {
                    style: 'color-halfblock', width: w, height: h / 2,
                    frames: [pixelsToArt(data.frames[fi], w, h)],
                };

                // 我方 / 共用資源（自 installed assets 讀）
                const me      = CORE.loadCharacter(meId);
                const meArt   = JSON.parse(fs.readFileSync(me.artFile, 'utf8'));
                const shared  = CORE.loadShared();
                const F       = me.charDef.F;
                const meRO    = me.charDef.RIGHT_OFFSET ?? null;

                // 對手：指定 ?enemy=（小寫化對到 assets 資料夾）；否則同階隨機，
                // ?seed= 讓「換對手」每次換一個（決定性、可重現）
                const seed = Number(query.seed) || 1;
                const enemyId = query.enemy
                    ? query.enemy.toLowerCase()
                    : CORE.chooseBattleEnemy(meId, seed, null);
                let enemyArt = null, enemyBulletArt = null, enemyCutInArt = null, enemyRO = null;
                try {
                    const en = CORE.loadCharacter(enemyId);
                    enemyArt       = JSON.parse(fs.readFileSync(en.artFile, 'utf8'));
                    enemyBulletArt = fs.existsSync(en.bulletArtFile) ? JSON.parse(fs.readFileSync(en.bulletArtFile, 'utf8')) : null;
                    enemyCutInArt  = fs.existsSync(en.cutinArtFile)  ? JSON.parse(fs.readFileSync(en.cutinArtFile, 'utf8'))  : null;
                    enemyRO        = en.charDef.RIGHT_OFFSET ?? null;
                } catch (e) {
                    // 對手沒安裝 → 黑影
                    try {
                        const sh = CORE.loadCharacter('shadow');
                        enemyArt       = CORE.silhouetteArt(JSON.parse(fs.readFileSync(sh.artFile, 'utf8')));
                        enemyBulletArt = fs.existsSync(sh.bulletArtFile) ? CORE.silhouetteArt(JSON.parse(fs.readFileSync(sh.bulletArtFile, 'utf8'))) : null;
                        enemyRO        = sh.charDef.RIGHT_OFFSET ?? null;
                    } catch (e2) {}
                }

                const meCutInArt = fs.existsSync(me.cutinArtFile) ? JSON.parse(fs.readFileSync(me.cutinArtFile, 'utf8')) : null;
                const version = CORE.pickBattleVersion(meId, enemyId);
                const useCutIn = version === 2;
                const length = CORE.battleLength(version);

                const frames = [];
                for (let elapsed = 0; elapsed < length; elapsed++) {
                    const f = CORE.decideBattleFrame(elapsed, win, enemyId, F, useCutIn);
                    const buffer = CORE.composeBattleScene({
                        frame: f, meArt, enemyArt, meBulletArt, enemyBulletArt,
                        meCutInArt, enemyCutInArt, shared,
                        meRightOffset: meRO, enemyRightOffset: enemyRO,
                        returnCells: true,
                    });
                    frames.push(buffer);
                }

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: true, width: CORE.BATTLE_SCENE_WIDTH, height: CORE.BATTLE_SCENE_HEIGHT,
                    stepMs: 1000, frames, enemy: enemyId, version, win,
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
    }
    else { res.writeHead(404); res.end('Not found'); }
});

server.listen(PORT, () => {
    console.log(`\n✓ Sprite editor [${name}] → http://localhost:${PORT}\n`);
    console.log('  上方可切換「角色 / 子彈 / 共用」編輯模式');
    console.log('  編輯完按 Ctrl+S 或「儲存」');
    console.log('  儲存時自動：備份 source、重建 art、部署到 ~/.claude/agumon-statusline/、清除快取');
    console.log('\n  Ctrl+C 結束\n');
});
