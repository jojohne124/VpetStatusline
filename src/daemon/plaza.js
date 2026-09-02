'use strict';
/**
 * plaza.js — 廣場的合成與後端客戶端
 *
 * 刻意獨立於 daemon.js（見 docs/plaza-spec.md §七的警告）：daemon.js 已經很長且內嵌
 * 一大段 HTML template，廣場的邏輯全部塞進去會重蹈「什麼都往 daemon.js 丟」的覆轍。
 * daemon.js 只負責模式切換與 HTTP 路由，實際的「畫出廣場」在這裡。
 *
 * 走路演算法不在這裡 —— 在 src/shared/plaza-walk.js，因為那份要與（未來的）
 * 伺服器共用同一份程式碼才能保證每個 client 算出同一個畫面。
 */
const fs   = require('fs');
const path = require('path');       // 讀 assets/yard-layouts.json（編輯器存的自訂切法）
const W  = require('../shared/plaza-walk.js');

// ── dot ↔ cell 轉換 ──────────────────────────────────────────────────
// 既有的美術資料都是 cell 格式（1 cell = 1 dot 寬 × 2 dot 高，[ur,ug,ub,lr,lg,lb]，
// -1 = 透明）。但廣場要把 sprite 貼到任意 y，y 是奇數時 sprite 會跨半個 cell ——
// 直接在 cell 層貼會遇到「半格」問題。
//
// 解法是整個合成過程改在 **dot 層**做：先把每個 sprite 拆成 dot、貼到 dot 緩衝、
// 最後才打包回 cell。這樣 y 的奇偶完全不需要特別處理，代價只是多一次轉換。
// 若改用「y 只能是偶數」來迴避，垂直移動的最小單位會變成 2 dot（16 px），
// 跟水平的 1 dot 不對稱，走起來會怪。

/** cell rows -> dots[y][x] = [r,g,b] | null */
function cellsToDots(rows) {
    const dots = [];
    for (const row of rows) {
        const up = [], lo = [];
        for (const c of row) {
            if (!c) { up.push(null); lo.push(null); continue; }
            up.push(c[0] >= 0 ? [c[0], c[1], c[2]] : null);
            lo.push(c[3] >= 0 ? [c[3], c[4], c[5]] : null);
        }
        dots.push(up, lo);
    }
    return dots;
}

/** dots[y][x] -> cell rows（高度奇數時補一列透明） */
function dotsToCells(dots, w) {
    const rows = [];
    for (let y = 0; y < dots.length; y += 2) {
        const up = dots[y] || [], lo = dots[y + 1] || [];
        const row = [];
        for (let x = 0; x < w; x++) {
            const u = up[x] || null, l = lo[x] || null;
            row.push((!u && !l) ? null
                : [u ? u[0] : -1, u ? u[1] : -1, u ? u[2] : -1,
                   l ? l[0] : -1, l ? l[1] : -1, l ? l[2] : -1]);
        }
        rows.push(row);
    }
    return rows;
}

/**
 * 把 src dot 圖貼到 dst，透明處不覆蓋（painter's algorithm 的一筆）。
 *
 * owner 是可選的同尺寸「這個 dot 是誰畫的」緩衝。名牌要判斷自己有沒有被別人擋住
 * 就得知道這件事 —— 光看顏色分不出「這裡本來就是我的黑邊」還是「被前面的人蓋掉了」。
 */
function blit(dst, src, ox, oy, owner, id) {
    for (let y = 0; y < src.length; y++) {
        const ty = oy + y;
        if (ty < 0 || ty >= dst.length) continue;
        const srow = src[y], drow = dst[ty];
        for (let x = 0; x < srow.length; x++) {
            const px = srow[x];
            if (!px) continue;                 // 透明 -> 保留下層
            const tx = ox + x;
            if (tx < 0 || tx >= drow.length) continue;
            drow[tx] = px;
            if (owner) owner[ty][tx] = id;
        }
    }
}

// ── 角色美術 ─────────────────────────────────────────────────────────
// 別人養的角色本機可能沒有（新版才加的、或客製角色）→ 沿用 PvP 已經解過的黑影
// fallback，讀不到就用 Shadow 剪影，不要拒絕顯示。
const _artCache = new Map();

function loadArt(core, charId) {
    if (_artCache.has(charId)) return _artCache.get(charId);
    let out = null;
    for (const id of [charId, 'shadow']) {
        try {
            const ch  = core.loadCharacter(id);
            const art = JSON.parse(fs.readFileSync(ch.artFile, 'utf8'));
            out = { art, rightOffset: ch.charDef.RIGHT_OFFSET, F: ch.charDef.F,
                    shadow: id !== charId };
            break;
        } catch (e) { /* 下一個候選 */ }
    }
    _artCache.set(charId, out);
    return out;
}

/**
 * 某人在這一拍該用哪一幀的 dot 圖（含左右翻面）。
 *
 * IDLE_1 / IDLE_2 一律交替，**停下來時也照演**。初版停下時鎖 IDLE_1，
 * 結果是角色連動畫都停掉，看起來像整個畫面當掉而不是「站著休息」——
 * 家裡的桌寵沒走動時也是持續交替的，這裡沿用同一個處理。
 */
/**
 * @param {string|null} react 表情幀名（'HAPPY' / 'REFUSE' …）。給就蓋掉待機動畫，
 *   讓營地的摸摸能有反應。查不到那個幀就退回待機 —— 有些角色的美術不完整，
 *   寧可沒反應也不要畫出錯幀。
 */
function spriteDots(core, charId, step, facing, react) {
    const a = loadArt(core, charId);
    if (!a) return null;
    const F = a.F || {};
    const forced = react && F[react] != null ? F[react] : null;
    const frameIdx = forced != null ? forced : (step % 2 === 0 ? F.IDLE_1 : F.IDLE_2);
    const rows = core.getFacingRows(a.art, frameIdx ?? 0, facing, a.rightOffset);
    return rows ? cellsToDots(rows) : null;
}

// ── 合成 ─────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const WHITE    = '\x1b[38;2;235;235;245m';
// 自己的名牌用亮黃，別人白色 —— 20 個人時要能一眼找到自己。
const ME_COLOR = '\x1b[38;2;247;198;49m';

// ── NPC（無主的野生 vpet）─────────────────────────────────────────────
// 廣場沒人時空蕩蕩很難看，而且第一期本來就不會有幾個人在線。放幾隻無主的
// vpet 在場上散步，畫面隨時都有東西。
//
// NPC **不需要任何後端支援**：清單寫死、seed 寫死、joinStep 固定 0，
// 所以每個 client 各自算就會得到完全相同的 NPC 走位 —— 這是決定性走路演算法
// 順帶送的。伺服器只要管真人名單。
//
// 沒有 code → 不畫名牌（buildLabels 會跳過），一眼就分得出誰是玩家的寵物。
// seed 刻意用大質數且彼此相距很遠，避免和玩家的 seed 走出相似路徑。
const NPCS = [
    { key: 'npc:agumon',  char: 'agumon',  seed: 8675309 },
    { key: 'npc:gabumon', char: 'gabumon', seed: 5551212 },
];

/**
 * 把在場名單合成成一張廣場畫面。
 *
 * @param core       agumon-core（用它的 getFacingRows / loadCharacter / visLen）
 * @param occupants  [{code, char, seed, joinStep}]
 * @param step       目前是第幾拍（已用 serverNow 校正過）
 * @param opts       { caches: Map, bg: dots|null, me: code, npc: bool, field }
 * @returns          { lines, placed, labels }
 */
function composePlaza(core, occupants, step, opts = {}) {
    const caches = opts.caches instanceof Map ? opts.caches : new Map();
    const field  = opts.field || W.PLAZA_FIELD;

    // 1. 空的 dot 緩衝（或底圖）+ 同尺寸的「這個 dot 是誰的」緩衝
    const dots = [], owner = [];
    for (let y = 0; y < field.h; y++) {
        dots.push(new Array(field.w).fill(null));
        owner.push(new Array(field.w).fill(-1));
    }
    if (opts.bg) blit(dots, opts.bg, 0, 0);

    // 2. 算出每個人（含 NPC）的位置
    const all = opts.npc === false
        ? occupants
        : [...occupants, ...NPCS.map(n => ({ ...n, joinStep: 0 }))];
    const placed = [];
    for (const o of all) {
        // key 而不是 code：NPC 沒有 code，全部共用一個快取槽會互相汙染
        const key = o.key || o.code;
        // o.field = 這一隻自己的可走範圍（營地分區）。沒帶就用整場（廣場一直是這樣）。
        // 畫布尺寸與名牌仍然吃外層的 field —— 分區只縮走路範圍，不縮畫面。
        const p = W.posAt({ seed: o.seed, joinStep: o.joinStep, origin: o.origin, anchor: o.anchor },
                          step, caches.get(key), o.field || field);
        caches.set(key, p.cache);
        placed.push({ ...o, key, x: p.x, y: p.y, facing: p.facing, moving: p.moving });
    }

    // 3. y 小的先畫 -> y 大的（比較靠近觀眾）蓋在上面。
    //    y 相同時用 key 排序，讓每個 client 的疊法一致（不然兩邊看到的遮擋會相反）。
    placed.sort((a, b) => (a.y - b.y) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    placed.forEach((p, i) => {
        const sp = spriteDots(core, p.char, step, p.facing, p.react);
        // 跳躍只影響**畫在哪**，不影響上面那個 y 排序，也不影響名牌（名牌釘在腳下的
        // 地面位置）。跳起來就切到別人前面、名牌跟著飛，兩個都不對。
        // 貼著上緣時往上頂會超出畫面 -> 夾住，那一下就看不到跳（很少見，可接受）。
        p.jumpDy = p.jump ? Math.min(p.jump, p.y - field.minY) : 0;
        if (sp) blit(dots, sp, p.x, p.y - p.jumpDy, owner, i);
        p.z = i;                                 // 繪製順序 = 前後關係
    });

    // 4. dot -> cell -> ANSI，名牌另外走文字層（見下）
    //    天氣**不在這裡**：做過「依天氣把角色調色」，實際看了拿掉 —— 16x16 的點陣圖
    //    顏色本來就少，一染就分不出誰是誰。天氣整層都在前端疊，不動角色本身。
    const cells  = dotsToCells(dots, field.w);
    const labels = buildLabels(placed, core, opts.me, owner, field);
    // labels 一併回傳：測試要驗「哪些字因為遮擋而沒畫」，從 ANSI 字串反推很脆弱
    return { lines: renderWithLabels(cells, labels), placed, labels };
}

/**
 * 名牌文字層：key = cell 列號，value = [{col, text, wide, me, z, code}]。
 * 每個項目是**一個字**，不是整條名牌 —— 遮擋要逐字判斷，見下。
 *
 * 為什麼不直接畫進 dot 緩衝：名牌是**文字**（要支援中文名牌），一個字佔一到兩個
 * cell，沒有 dot 級的字模。既有 PvP 名牌也是渲染成 ANSI 之後才貼字（captionRow），
 * 這裡沿用同樣的分層，只是位置從「畫面最底一列」改成「各自腳下」。
 */
function buildLabels(placed, core, me, owner, field = W.PLAZA_FIELD) {
    const lastRow = field.h / 2 - 1;
    const vis = (t) => (core && core.visLen ? core.visLen(t) : t.length);
    const rows = new Map();
    for (const p of placed) {
        if (!p.code) continue;
        const wide = vis(p.code);
        const col0 = Math.max(0, Math.min(field.w - wide,
                     p.x + Math.floor((W.SPRITE - wide) / 2)));

        // 名牌**一律標在腳下**（固定位置，不會忽上忽下）。腳下是慣例 ——
        // PvP 的名牌就在腳下，玩家對這個位置有既有預期。
        //
        // 走過的四版，都是看畫面才發現問題：
        //   1. 只放腳下、放不下就省略 → 走到最底時名牌整個消失（場地高 = 角色高 +
        //      可走範圍，y 頂到 MAX_Y 時腳正好貼下緣，那一列已在畫面外）。
        //   2. 腳下放不下就改標頭上 → 兩邊都看得到了，但角色一走動名牌就上下跳。
        //   3. 一律頭上 → 幾乎不會被遮擋（擋住我的人必定 y 比我大，構不到我頭頂
        //      那一列），顯示率 97~100%，但不合慣例。
        //   4. 一律腳下 + 場地底部保留一列（本版）→ 位置固定又合慣例。
        const row = Math.floor((p.y + W.SPRITE) / 2);
        if (row < 0 || row > lastRow) continue;

        // 遮擋逐「字」判斷，不是整條名牌一起消失。切在字的邊界上，不會出現半個字。
        //
        // ⚠️ 別期待這能救回顯示率：擋住你的 sprite 有 16 cell 寬，名牌才 2~3 cell，
        // 蓋到通常就是整條蓋住。實測逐字判斷只把「部分可讀」從 0% 拉到 2~8%，
        // 「完全看不到」的比例（5 人 15% / 20 人 55%）幾乎沒變。
        // 真正決定顯示率的是**名牌放哪裡**：腳下就是前排角色會站的地方。
        // 標在頭上可以到 97~100%（擋住我的人 y 必定比我大，構不到我頭頂），
        // 但那不合慣例 —— 這裡選擇合慣例，接受被站在前面的人擋住。
        let cx = col0;
        for (const ch of [...p.code]) {
            const w = vis(ch);
            if (!occluded(owner, row, cx, w, p.z)) {
                if (!rows.has(row)) rows.set(row, []);
                rows.get(row).push({ col: cx, text: ch, wide: w, me: p.code === me, z: p.z, code: p.code });
            }
            cx += w;
        }
    }
    // 同一列多人 -> 依 col 排序；重疊時保留站得比較前面（z 大）的那個，
    // 與遮擋規則一致 —— 前排的名字蓋掉後排的，而不是先來先贏。
    for (const [row, list] of rows) {
        list.sort((a, b) => a.col - b.col);
        const keep = [];
        for (const it of list) {
            const prev = keep[keep.length - 1];
            if (!prev || it.col > prev.col + prev.wide - 1) { keep.push(it); continue; }
            if (it.z > prev.z) keep[keep.length - 1] = it;   // 換成前排那個
        }
        rows.set(row, keep);
    }
    return rows;
}

/** 名牌要佔的那幾格裡，有沒有任何一個 dot 是「比我前面的人」畫的 */
function occluded(owner, row, col, wide, z) {
    if (!owner || z == null) return false;
    const y0 = row * 2, y1 = y0 + 1;
    for (let y = y0; y <= y1; y++) {
        const r = owner[y];
        if (!r) continue;
        for (let x = col; x < col + wide; x++) {
            if (r[x] > z) return true;
        }
    }
    return false;
}

function renderWithLabels(cells, labels) {
    const lines = [];
    for (let r = 0; r < cells.length; r++) {
        const row = cells[r];
        const lab = labels.get(r) || [];
        let line = '', x = 0, li = 0;
        while (x < row.length) {
            const it = lab[li];
            if (it && it.col === x) {
                line += (it.me ? ME_COLOR : WHITE) + it.text + R;
                x += it.wide; li++;
                continue;
            }
            line += cellToAnsi(row[x]);
            x++;
        }
        lines.push(line);
    }
    return lines;
}

// 與 core.renderCells 同一套規則，但這裡要能逐格插入名牌，所以拆成單格版。
function cellToAnsi(c) {
    if (!c) return '⠀';
    const [ur, ug, ub, lr, lg, lb] = c;
    const upOk = ur >= 0, loOk = lr >= 0;
    if (upOk && loOk) return `\x1b[38;2;${ur};${ug};${ub}m\x1b[48;2;${lr};${lg};${lb}m▀${R}`;
    if (upOk)         return `\x1b[38;2;${ur};${ug};${ub}m▀${R}`;
    if (loOk)         return `\x1b[38;2;${lr};${lg};${lb}m▄${R}`;
    return '⠀';
}

// ── 營地院子（docs/ranch-spec.md 階段 2）──────────────────────────────
// 與廣場的差別只有「名單從哪來」：廣場是伺服器發的在場名單，院子是本機 ranch.json。
// 畫面層（走路、y 排序、名牌、遮擋）完全共用，一行都不用改 —— 這正是先做營地
// 再做廣場的理由。
//
// seed 由每隻的 id 雜湊而來，不需要伺服器分配（那是廣場為了跨 client 一致才需要的）。
// 同一隻每次開院子的走位都一樣，看久了會有「這隻習慣待在那一角」的感覺。
// joinStep 一律用「這個 daemon 這次啟動的時間」，不是 0，也不是 keptAt。
//   joinStep = 0  → 要從 epoch 重播 24 億拍（實際踩過，daemon 直接卡死）
//   joinStep = keptAt → 收很久的那隻要重播數百萬拍，第一次開院子會頓一下
// 院子只有一個 client，不需要跨機器一致，所以「這次開機才開始走」完全夠用；
// 副作用是重開 daemon 大家會回到各自的起點，那反而像「早上剛出門」。
const SESSION_START = Date.now();

/**
 * 院子這次開機的起拍。導出純粹是為了讓測試餵得到有效的 step ——
 * 不知道這個數字就只會餵到 target = 0（負的被夾成 0），每一拍都算出同一個起點，
 * 斷言全部退化成「拿同一張圖跟自己比」而看起來是綠的。踩過：跳躍夾住那條就是這樣空掉的。
 */
function yardJoinStep() { return W.stepAt(SESSION_START); }

function yardOccupants(core, ranch, activeState, react, layout, coreForLayouts) {
    const base = W.stepAt(SESSION_START);
    void activeState;   // 現役不進院子（見下），保留參數是為了呼叫端不用改
    const list = [];
    // 每隻分到一塊自己的可走範圍，否則三隻擠在 37x25 裡有七成的時間互相蓋住。
    // ⚠️ 索引取自**完整名單**而不是過濾後的 list：拿在手上的那一隻會被 continue
    //    跳過，用 list.length 當索引的話，牠一被抓起來其他隻的區域就整組位移。
    const n = (ranch.pets || []).length;
    const zones = coreForLayouts ? yardZonesFor(coreForLayouts, n, layout)
                                 : W.yardZones(n, undefined, undefined, layout);
    let idx = -1;
    for (const p of (ranch.pets || [])) {
        idx++;
        const id = p.state && p.state.characterId;
        if (!id) continue;
        // 刻意不給 code —— buildLabels 看到沒有 code 就不畫名牌（與 NPC 同一條路）。
        // 院子只有 52 dot 寬，8 隻的名牌會互相擠掉一半；要知道是誰改用右鍵選單，
        // 那比一排彼此覆蓋的名字可靠。
        // 摸摸的反應。**只存在記憶體裡**（daemon 的 Map），不寫進 ranch.json ——
        // 營地是冰箱，反應是純表演，不該在快照裡留下任何痕跡。
        const r = react ? react.get(p.id) : null;
        // 拿在手上的那隻不進合成 —— 它由前端跟著游標畫在疊加層上。
        // 兩邊都畫的話會看到兩個分身（伺服器那張還停在被抓起的位置）。
        if (r && r.held) continue;
        list.push({
            key:      'ranch:' + p.id,
            ranchId:  p.id,
            name:     core.getDisplayName ? core.getDisplayName(id) : id,
            char:     id,
            seed:     W.hash2(hashStr(p.id), 0),
            // 開心的時候會原地跳，停走那幾拍要從時間軸扣掉，落地才不會瞬移
            // （holdSteps 的來由見 yard-touch.js settleHold）。
            // 被放下過的那隻改用落點當起點、落下那一拍當 joinStep（見 plaza-walk 的 origin）。
            joinStep: (r && r.anchor ? r.anchor.step : base) + (r ? r.holdSteps || 0 : 0),
            origin:   r && r.anchor ? r.anchor.origin : null,
            react:    r ? r.frame : null,
            jump:     r ? r.jump || 0 : 0,
            zoneIdx:  idx,
            field:    zones[idx] || W.YARD_FIELD,
            // 放下的落點在區域外時，先走回這裡再接回正常的鏈（見 plaza-walk 的 returnLeg）
            anchor:   W.zoneAnchor(zones[idx] || W.YARD_FIELD),
        });
    }
    // 現役**不**放進院子。草案原本要放（想說「不然院子會像少了一隻」），但那是搞混了
    // 兩件事：院子是「收起來的那些」，現役正在你身邊過生活，不在冰箱裡。
    // 兩邊都出現反而看不出「收進去」和「拿出來」的差別。
    return list;
}

/** 字串 → 32-bit 整數。id 是亂數字串，要先變成數字才能餵給 seed。 */
function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < String(s).length; i++) {
        h ^= String(s).charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

/**
 * 某一隻現在的位置、面向與**兩張待機幀**。抓起來的那一刻要把牠交給前端自己畫，
 * 所以得先問「牠現在在哪、朝哪邊、長什麼樣」。
 * 回傳 null = 這隻不在營地裡（或讀不到美術）。
 *
 * 為什麼給兩張而不是一張：拿在手上的那隻要繼續呼吸（IDLE_1/IDLE_2 輪替）。
 * 兩張一起傳只多約 2 KB、而且只在抓起的那一次 —— 換成讓前端每幀回頭問伺服器，
 * 就得把 /yard 拉到 60fps，完全不划算。
 *
 * 用 step 0 / 1 取兩張，而不是指定幀名字串：spriteDots 本來就用 step 的奇偶挑
 * IDLE_1/IDLE_2，走同一條路才不會有「這裡叫 IDLE_1、那裡叫 Idle_1」的分叉。
 *
 * 刻意不走 composeYard —— 那會為了一隻而合成整張圖，而且被抓著的那隻本來就被略過了。
 */
function yardSpriteFor(core, ranch, id, step, opts = {}) {
    // layout 要跟 composeYard 用同一個，否則抓起來那一下的位置會對不上畫面
    const pets = ranch.pets || [];
    const idx = pets.findIndex(p => p.id === id);
    const pet = pets[idx];
    const cid = pet && pet.state && pet.state.characterId;
    if (!cid) return null;
    // 一定要用**這一隻自己的區域**算 —— 用整場算的話，抓起來那一下回報的位置
    // 會跟畫面上的不一樣，游標一接手就跳一格。
    const zone = yardZonesFor(core, pets.length, opts.layout)[idx] || W.YARD_FIELD;
    const p = W.posAt({ seed: W.hash2(hashStr(id), 0),
                        joinStep: opts.joinStep != null ? opts.joinStep : W.stepAt(SESSION_START),
                        origin: opts.origin || null,
                        anchor: W.zoneAnchor(zone) },
                      step, null, zone);
    const a = spriteDots(core, cid, 0, p.facing, null);
    const b = spriteDots(core, cid, 1, p.facing, null);
    return a ? { frames: [a, b || a], x: p.x, y: p.y, facing: p.facing } : null;
}

// ── 編輯器存的自訂切法 ───────────────────────────────────────────────
// 內建表（plaza-walk 的 YARD_LAYOUTS）是出廠值；編輯器把改動存成資料檔，
// 這裡合併：同名覆蓋、新名字新增、default 可改指定哪一個。
// 放在 assets/ 而不是編進程式 —— 編輯器存完就生效，不用重跑 install
// （跟路線編輯器同一套作法）。檔案壞掉就當作沒有，不能讓院子開不起來。
const YARD_LAYOUTS_FILE = 'yard-layouts.json';
let _layoutCache = { mtime: 0, data: null };

function loadYardLayouts(core) {
    try {
        const p = path.join(core.ASSETS_DIR, YARD_LAYOUTS_FILE);
        const st = fs.statSync(p);
        if (_layoutCache.data && _layoutCache.mtime === st.mtimeMs) return _layoutCache.data;
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const data = { layouts: j.layouts || {}, default: j.default || {} };
        _layoutCache = { mtime: st.mtimeMs, data };
        return data;
    } catch (e) {
        _layoutCache = { mtime: 0, data: null };
        return { layouts: {}, default: {} };
    }
}

// 這個隻數有哪些切法可挑（內建 + 自訂），以及目前預設是哪一個
function yardLayoutsFor(core, n) {
    const over = loadYardLayouts(core);
    const names = [...new Set([...(W.yardLayoutNames(n) || []),
                               ...Object.keys((over.layouts || {})[n] || {})])];
    const def = (over.default || {})[n] || W.YARD_LAYOUT_DEFAULT[n] || null;
    return { names, def };
}

// 依名稱取出實際的區域。名稱查得到自訂就用自訂的矩形，否則交給內建表。
//
// ⚠️ 指名的切法查不到（網址參數打錯、或那個切法剛被刪）要退回**目前生效的**預設，
//    不是內建的預設 —— 後者的症狀是「刪掉自訂切法之後畫面靜靜跳回出廠值」，
//    而且 dev 下拉顯示的名字跟實際走的切法對不起來。
function yardZonesFor(core, n, layout) {
    const over = loadYardLayouts(core);
    const custom = (over.layouts || {})[n] || {};
    const builtin = W.YARD_LAYOUTS[n] || {};
    const known = (nm) => !!nm && !!(custom[nm] || builtin[nm]);
    const name = (known(layout) && layout)
              || (over.default || {})[n]
              || W.YARD_LAYOUT_DEFAULT[n] || null;
    return W.yardZones(n, W.YARD_FIELD, W.ZONE_MARGIN, custom[name] || name);
}

/**
 * 畫出院子。回傳 null 代表營地是空的 —— 呼叫端自己決定顯示什麼（不要畫一張空圖，
 * 那看起來像壞掉）。
 * NPC 一律關掉：院子是你自己的地方，不該有野生 vpet 亂入。
 */
function composeYard(core, ranch, activeState, step, opts = {}) {
    const occ = yardOccupants(core, ranch, activeState, opts.react, opts.layout, core);
    if (!occ.length) return null;
    return composePlaza(core, occ, step, { ...opts, npc: false, field: W.YARD_FIELD });
}

module.exports = {
    PLAZA_W: W.PLAZA_W, PLAZA_H: W.PLAZA_H, YARD_FIELD: W.YARD_FIELD, SPRITE: W.SPRITE,
    cellsToDots, dotsToCells, blit,
    loadArt, spriteDots,
    composePlaza, buildLabels, renderWithLabels, cellToAnsi, occluded, NPCS,
    yardOccupants, composeYard, hashStr, yardJoinStep, yardSpriteFor,
    yardZones: W.yardZones, zoneAnchor: W.zoneAnchor, ZONE_MARGIN: W.ZONE_MARGIN,
    yardLayoutNames: W.yardLayoutNames, YARD_LAYOUT_DEFAULT: W.YARD_LAYOUT_DEFAULT,
    YARD_LAYOUTS_FILE, loadYardLayouts, yardLayoutsFor, yardZonesFor,
};
