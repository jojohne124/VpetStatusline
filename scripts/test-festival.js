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
for (const f of FEST.FESTIVALS) {
    if (f.acc === null) continue;   // 只換背景（清明）
    const a = FEST.ACC[f.acc];
    ok(a && (a.kind === 'hat' || a.kind === 'flag'), `${f.id} 的配件 ${f.acc} 不存在或不是帽子／旗子`);
    if (!a) continue;
    ok(a.art.every(r => [...r].every(ch => ch === '.' || FEST.PAL[ch])), `${f.acc} 用了調色盤沒有的顏色`);
    if (a.kind === 'hat') ok(a.art.every(r => r.length <= (f.acc === 'chun' ? 9 : 7)), `${f.acc} 帽子太寬`);
}

console.log('— 新節日與重疊 —');
ok(id(at(2026, 12, 18)) === 'christmas' && id(at(2026, 12, 25, 23, 0)) === 'christmas', '12/18～12/25 是聖誕節');
ok(id(at(2026, 12, 26)) === 'newyear' && id(at(2026, 12, 31, 23, 59)) === 'newyear', '12/26～12/31 是跨年');
ok(id(at(2027, 1, 1, 20, 0)) === 'newyear', '元旦當天還是跨年（期間跨年份）');
ok(id(at(2027, 1, 2)) === null, '1/2 跨年已經結束');
ok(id(at(2027, 1, 30)) === 'lunarny' && id(at(2027, 2, 10, 23, 0)) === 'lunarny', '2027 春節：1/30（初一前一週）～2/10（初五）');
ok(id(at(2027, 2, 8)) === 'lunarny', '2027/2/8 春節跟情人節重疊 → 春節已經到正日，春節贏');
ok(id(at(2027, 2, 11)) === 'valentine', '2027/2/11 春節結束 → 情人節');
ok(id(at(2027, 2, 13)) === 'valentine', '2027/2/13 情人節跟元宵重疊 → 離情人節近');
ok(id(at(2027, 2, 15)) === 'lantern' && id(at(2027, 2, 20, 23, 0)) === 'lantern', '2027/2/15～2/20 是元宵');
ok(id(at(2027, 4, 4)) === 'children', '4/4 兒童節');
ok(id(at(2027, 4, 5)) === 'qingming' && id(at(2027, 4, 6, 23, 0)) === 'qingming' && id(at(2027, 4, 7)) === null, '2027 清明：4/5～4/6');
ok(id(at(2027, 4, 3)) === 'children', '清明前面那週還是兒童節');
ok(id(at(2028, 4, 4)) === 'qingming' && id(at(2028, 4, 3)) === 'children', '2028 清明跟兒童節同一天 → 當天清明、前一天兒童節');
ok(FEST.active(0, 'qingming').acc === null, '清明不換造型');
ok(id(at(2027, 6, 9)) === 'dragonboat' && id(at(2027, 8, 8)) === 'qixi' && id(at(2027, 9, 15)) === 'midautumn', '2027 端午／七夕／中秋');
ok(id(at(2029, 2, 14, 12)) === 'valentine' && id(at(2029, 2, 15)) === 'lunarny', '2029 情人節是初二：正日當天情人節贏，隔天回春節');
ok(id(at(2028, 10, 3)) === 'midautumn' && id(at(2028, 10, 4)) === 'doubleten', '2028 中秋（10/3）跟雙十期間重疊：當天中秋、隔天雙十');
{
    // 每個節日每年都要輪得到至少一天（被別的節日整段蓋掉就等於沒做）
    for (let y = 2027; y <= 2029; y++) {
        const seen = new Set();
        for (let t = at(y, 1, 1, 12); t < at(y + 1, 1, 1); t += 864e5) { const f = id(t); if (f) seen.add(f); }
        const miss = FEST.FESTIVALS.filter(f => !seen.has(f.id)).map(f => f.id);
        ok(miss.length === 0, `${y} 年有節日一天都輪不到：${miss.join(',')}`);
    }
}

console.log('— 農曆對照表 —');
{
    const L = FEST.LUNAR, years = Object.keys(L.lunarny).map(Number);
    // 表用完之前要先紅：明年的日期一定要在（元旦後一個月就是春節，來不及臨時補）
    const need = new Date().getFullYear() + 1;
    for (const k of Object.keys(L)) ok(L[k][need], `農曆表 ${k} 沒有 ${need} 年 —— 該往後補了`);
    for (const f of FEST.FESTIVALS.filter(f => f.lunar)) ok(L[f.id], `${f.id} 是農曆節日但對照表沒有它`);
    // 抄錯的保險：同一年內的農曆間隔有固定範圍（一個農曆月 29～30 天，閏月多一個月）
    const day = (k, y) => new Date(y, L[k][y][0] - 1, L[k][y][1]).getTime() / 864e5;
    const gap = (a, b, y) => day(b, y) - day(a, y);
    for (const y of years) {
        ok(gap('lunarny', 'lantern', y) === 14, `${y} 元宵應該是春節後 14 天，實際 ${gap('lunarny', 'lantern', y)}`);
        const d1 = gap('lunarny', 'dragonboat', y);
        ok((d1 >= 121 && d1 <= 123) || (d1 >= 150 && d1 <= 153), `${y} 春節→端午 ${d1} 天不合理`);
        const d2 = gap('dragonboat', 'qixi', y);
        ok((d2 >= 60 && d2 <= 62) || (d2 >= 89 && d2 <= 92), `${y} 端午→七夕 ${d2} 天不合理`);
        const d3 = gap('qixi', 'midautumn', y);
        ok(d3 >= 37 && d3 <= 39, `${y} 七夕→中秋 ${d3} 天不合理`);
        const d4 = (L.lunarny[y + 1] ? day('lunarny', y + 1) : NaN) - day('lunarny', y);
        if (L.lunarny[y + 1]) ok((d4 >= 353 && d4 <= 355) || (d4 >= 383 && d4 <= 385), `${y}→${y + 1} 春節相隔 ${d4} 天不合理`);
    }
}

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
    // 每一種配件都試穿：帽子的帽簷（最後一列）壓在頭頂 y=4、旗子在背後且不蓋身體
    for (const [k, a] of Object.entries(FEST.ACC)) {
        if (k === 'hat' || k === 'flag') continue;
        for (const facing of ['left', 'right']) {
            const d = FEST.dress(body, k, facing);
            const pts = opaque(d).filter(([, , c]) => c !== C);
            ok(pts.length > 0, `${k} 沒穿上去`);
            let covered = 0;
            for (let y = 4; y < 16; y++) for (let x = 3; x < 13; x++) if (d.dots[y - d.oy][x - d.ox] !== C) covered++;
            if (a.kind === 'hat') {
                ok(Math.max(...pts.map(p => p[1])) === 4, `${k} 帽簷應該在頭頂 y=4`);
                ok(covered <= 7, `${k} 只有帽簷那一列能蓋到身體，實際蓋了 ${covered} 格`);
            } else {
                const mx = pts.reduce((s2, p) => s2 + p[0], 0) / pts.length;
                ok(facing === 'left' ? mx > 11 : mx < 4, `${k} 朝${facing}時應該在背後（平均 x=${mx.toFixed(1)}）`);
                ok(covered === 0, `${k} 蓋到身體了（${covered} 格）`);
            }
        }
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
