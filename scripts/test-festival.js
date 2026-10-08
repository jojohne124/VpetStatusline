#!/usr/bin/env node
'use strict';
/**
 * 特殊節日（docs/festival-spec.md）：
 *   1. 期間：節日當天往前 7 天的 00:00 起，到當天 23:59:59 止；期間外沒有節日
 *   2. 配件：帽子戴在頭頂、旗子插在背後（依朝向）而且在身體後面、空圖不出錯
 *   3. 合成：opts.acc／每個人的 acc 會穿上去，acc=null 不穿；配件算在那隻身上（owner）
 *
 * 用法：node scripts/test-festival.js
 */
const os = require('os'), path = require('path');
const FEST = require('../src/shared/festival.js');
const P    = require('../src/daemon/plaza.js');
let core = null;
try { core = require(path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js')); } catch (e) {}

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
const id = (ms) => (FEST.active(ms) || {}).id || null;

console.log('— 期間 —');
ok(id(at(2026, 10, 2, 23, 59)) === null, '10/2 還不是雙十期間');
ok(id(at(2026, 10, 3, 0, 0)) === 'doubleten', '10/3 00:00 應該進入雙十（前一週）');
ok(id(at(2026, 10, 10, 23, 59)) === 'doubleten', '10/10 當天晚上還是雙十');
ok(id(at(2026, 10, 11, 0, 0)) === null, '10/11 雙十已經結束');
ok(id(at(2026, 10, 23, 23, 59)) === null, '10/23 還不是萬聖節期間');
ok(id(at(2026, 10, 24, 0, 0)) === 'halloween', '10/24 應該進入萬聖節');
ok(id(at(2026, 10, 31, 22, 0)) === 'halloween', '10/31 當天是萬聖節');
ok(id(at(2026, 11, 1, 0, 0)) === null, '11/1 萬聖節已經結束');
ok(id(at(2027, 10, 5)) === 'doubleten', '明年同一段也要算（不是寫死年份）');
ok(id(at(2026, 6, 1)) === null, '六月不該有節日');
ok((FEST.active(at(2026, 6, 1), 'halloween') || {}).id === 'halloween', '預覽參數應該蓋過日期');
ok(FEST.active(at(2026, 6, 1), 'nope') === null, '不存在的預覽 id 應該是沒有節日');
for (const f of FEST.FESTIVALS) ok(f.acc === 'hat' || f.acc === 'flag', `${f.id} 的配件不是帽子或旗子：${f.acc}`);

console.log('— 配件位置（假角色）—');
{
    // 10x12 的方塊身體，頭頂上有一根 1 格寬的角（帽子不能頂在角上）
    const body = [];
    for (let y = 0; y < 16; y++) body.push(new Array(16).fill(null));
    const C = [9, 9, 9];
    for (let y = 4; y < 16; y++) for (let x = 3; x < 13; x++) body[y][x] = C;
    body[2][5] = C; body[3][5] = C;                      // 角
    const opaque = (d) => { const out = []; d.dots.forEach((r, y) => r.forEach((c, x) => { if (c) out.push([x + d.ox, y + d.oy, c]); })); return out; };
    const isPal = (c, k) => c[0] === FEST.PAL[k][0] && c[1] === FEST.PAL[k][1] && c[2] === FEST.PAL[k][2];

    const hat = FEST.dress(body, 'hat', 'left');
    const brim = opaque(hat).filter(([, , c]) => isPal(c, 'K'));
    const brimY = Math.max(...brim.map(p => p[1]));
    ok(brimY === 4, '帽簷應該壓在頭頂（第一列夠寬的身體 y=4），實際 y=' + brimY);
    const hx = brim.filter(p => p[1] === brimY).map(p => p[0]);
    const cx = (Math.min(...hx) + Math.max(...hx)) / 2;
    ok(Math.abs(cx - 7.5) <= 1, '帽子應該置中在頭上（約 x=7.5），實際 ' + cx);
    ok(opaque(hat).some(([x, y, c]) => x === 3 && y === 10 && c === C), '戴帽子不該動到身體');

    for (const facing of ['left', 'right']) {
        const fl = FEST.dress(body, 'flag', facing);
        const pts = opaque(fl).filter(([, , c]) => c !== C);
        const red = pts.filter(([, , c]) => isPal(c, 'R'));
        const meanX = red.reduce((a, p) => a + p[0], 0) / red.length;
        // 朝左 → 背在右邊（x 大）；朝右 → 背在左邊
        ok(facing === 'left' ? meanX > 12 : meanX < 3, `朝${facing}時旗面應該在背後，旗面平均 x=${meanX}`);
        ok(Math.min(...pts.map(p => p[1])) < 4, '旗子應該高出頭頂');
        // 旗桿在身體後面：身體的每一格都還在
        let covered = 0;
        for (let y = 4; y < 16; y++) for (let x = 3; x < 13; x++) {
            const c = fl.dots[y - fl.oy][x - fl.ox];
            if (c !== C) covered++;
        }
        ok(covered === 0, `旗桿蓋到身體了（${covered} 格）—— 應該插在後面`);
    }
    const empty = [new Array(16).fill(null)];
    ok(FEST.dress(empty, 'hat', 'left').dots === empty, '全透明的圖不該出錯也不該加東西');
    ok(FEST.dress(body, null, 'left').dots === body, '沒有配件時原圖原樣回傳');
}

console.log('— 合成 —');
const hasArt = (() => { try { return !!P.loadArt(core, 'agumon'); } catch (e) { return false; } })();
if (!hasArt) console.log('  （沒有安裝版的角色美術，略過）');
else {
    const F = P.PLAZA_LIVE_FIELD;
    const occ = (acc) => [{ key: 'a', code: 'AA', char: 'agumon', seed: 1, joinStep: 0,
                            origin: { x: 30, y: 30 }, anchor: { x: 30, y: 30 }, acc }];
    const count = (out) => out.owner.flat().filter(z => z === 0).length;
    const plain = P.composePlaza(core, occ(null), 0, { npc: false, field: F, textLabels: false });
    const hat   = P.composePlaza(core, occ('hat'), 0, { npc: false, field: F, textLabels: false });
    const flag  = P.composePlaza(core, occ(undefined), 0, { npc: false, field: F, textLabels: false, acc: 'flag' });
    ok(count(hat) > count(plain), '戴了帽子，這隻佔的格子應該變多（配件算在牠身上）');
    ok(count(flag) > count(plain), '整場 opts.acc=flag 時應該插上旗子');
    const noAcc = P.composePlaza(core, occ(null), 0, { npc: false, field: F, textLabels: false, acc: 'flag' });
    ok(count(noAcc) === count(plain), '個人 acc=null（不給看）應該蓋過整場的配件');
    ok(hat.tags[0].top < plain.tags[0].top, '戴帽子之後頭頂（對話泡泡的位置）應該往上');
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
