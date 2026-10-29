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
// 愚人節：只有 4/1 當天（前一天、隔天都是兒童節的前一週），不換配件、改換角色
ok(id(at(2027, 4, 1)) === 'aprilfool' && id(at(2027, 4, 1, 23, 59)) === 'aprilfool', '4/1 當天要是愚人節（蓋過兒童節的前一週）');
ok(id(at(2027, 3, 31, 23, 59)) === 'children' && id(at(2027, 4, 2)) === 'children', '愚人節只有 4/1 當天（3/31、4/2 是兒童節）');
ok(FEST.active(0, 'aprilfool').acc === null && FEST.active(0, 'aprilfool').swap === 'ditto', '愚人節不戴配件、全部換成百變怪');
{
    const keys = Array.from({ length: 4000 }, (_, i) => 'p:' + i);
    const shiny = keys.filter(k => FEST.swapChar('ditto', k) === 'ditto_shining').length;
    ok(keys.every(k => /^ditto(_shining)?$/.test(FEST.swapChar('ditto', k))), 'swapChar 只能換成 ditto / ditto_shining');
    ok(Math.abs(shiny / keys.length - 0.2) < 0.03, `變色版機率應該約 20%（實際 ${(shiny / keys.length * 100).toFixed(1)}%）`);
}
ok(id(at(2027, 6, 9)) === 'dragonboat' && id(at(2027, 8, 8)) === 'qixi' && id(at(2027, 9, 15)) === 'midautumn', '2027 端午／七夕／中秋');
ok(id(at(2029, 2, 14, 12)) === 'valentine' && id(at(2029, 2, 15)) === 'lunarny', '2029 情人節是初二：正日當天情人節贏，隔天回春節');
ok(id(at(2028, 10, 3)) === 'midautumn' && id(at(2028, 10, 4)) === 'doubleten', '2028 中秋（10/3）跟雙十期間重疊：當天中秋、隔天雙十');
{
    // 每個節日每年都要輪得到至少一天（被別的節日整段蓋掉就等於沒做）
    for (let y = 2027; y <= 2029; y++) {
        const seen = new Set();
        for (let t = at(y, 1, 1, 12); t < at(y + 1, 1, 1); t += 864e5) { const f = id(t); if (f) seen.add(f); }
        const miss = FEST.FESTIVALS.filter(f => !f.dates && !seen.has(f.id)).map(f => f.id);   // 指定日期的（選舉、尾牙）不是每年都有
        ok(miss.length === 0, `${y} 年有節日一天都輪不到：${miss.join(',')}`);
    }
}

console.log('— 指定日期的節日（選舉、尾牙）—');
{
    // 選舉：投票日 2026/11/28，前一週（11/21）起到當天
    ok(id(at(2026, 11, 20, 23, 59)) === 'shrimp' && id(at(2026, 11, 21, 0, 0)) === 'election', '選舉應該 11/21 00:00 開始（前一天是活蝦餐廳）');
    ok(id(at(2026, 11, 28, 23, 0)) === 'election' && id(at(2026, 11, 29, 0, 0)) === null, '選舉應該到投票日當天結束');
    ok(id(at(2027, 11, 25)) === null, '沒列的年份不該有選舉');
    ok(FEST.active(0, 'election').acc === null, '選舉不戴配件');
    // 尾牙：日期還沒定 → 平常不會出現，dev 預覽看得到；有日期時整段都圍爐
    const wy = FEST.FESTIVALS.find(f => f.id === 'weiya');
    ok(wy && wy.dates.length === 0 && (FEST.active(0, 'weiya') || {}).id === 'weiya', '尾牙應該只有 dev 預覽看得到');
    ok(FEST.feastOn(wy, at(2027, 1, 20, 19), true), '尾牙預覽要圍爐');
    const wy2 = { ...wy, dates: ['2027-01-22'] };
    ok(FEST.feastOn(wy2, at(2027, 1, 22, 12)) && !FEST.feastOn(wy2, at(2027, 1, 23, 0, 1)), '尾牙當天整天圍爐、隔天結束');
    // 尾牙的桌子不要紅色（2026-10-22 回報）；春節照舊紅桌巾。廣場、營地兩邊都要把節日帶進去
    const t = P.feastLayout(6).table, red = ([r, g, b]) => r > 120 && r > g * 2 && r > b * 2;
    const reds = (style) => P.feastTable(t, 0, style).dots.flat().filter(c => c && red(c)).length;
    ok(reds('weiya') < reds(undefined) / 5 && reds(undefined) > 50, `尾牙桌子還是紅的（紅點 ${reds('weiya')}，春節 ${reds(undefined)}）`);
    // 尾牙不是吃鍋，是桌菜（2026-10-22 回報）：沒有火鍋的湯色，有一尾魚
    const has = (style, rgb) => P.feastTable(t, 0, style).dots.flat().some(c => c && c.join() === rgb);
    ok(has(undefined, '222,96,40') && !has('weiya', '222,96,40') && has('weiya', '214,150,70'), '尾牙桌上還是火鍋（或沒有魚）');
    // 活蝦餐廳（2026-10-29）：11/19～11/20 兩天整段圍爐；桌子不是紅的、中間是一大盤蝦（不是魚）
    const sh = FEST.FESTIVALS.find(f => f.id === 'shrimp');
    ok(id(at(2026, 11, 18, 23, 59)) === null && id(at(2026, 11, 19, 0, 0)) === 'shrimp' && id(at(2026, 11, 20, 23, 59)) === 'shrimp'
       && id(at(2026, 11, 21, 0, 0)) === 'election', '活蝦餐廳應該是 11/19 00:00～11/20 整天，11/21 接選舉');
    ok(sh && sh.acc === null && FEST.feastOn(sh, at(2026, 11, 19, 9)) && FEST.feastOn(sh, at(2026, 11, 20, 23)) && !FEST.feastOn(sh, at(2026, 11, 21, 0, 1)),
       '活蝦餐廳兩天都要整天圍爐、11/21 結束');
    ok(reds('shrimp') < reds(undefined) / 5, `活蝦餐廳桌子還是紅的（紅點 ${reds('shrimp')}）`);
    ok(has('shrimp', '255,170,120') && has('shrimp', '196,64,44') && !has('shrimp', '214,150,70') && !has('shrimp', '222,96,40'),
       '活蝦餐廳中間不是一大盤蝦（還是魚或火鍋）');
    const dsrc = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), 'utf8');
    ok(/\} else if\(id==='shrimp'\)\{/.test(dsrc) && /\} else if\(festState\.id==='shrimp'\)\{\s*festShrimp\(g,ts,W,H\);/.test(dsrc), '活蝦餐廳沒有自己的地板／背景');
    ok((dsrc.match(/feast, feastStyle: fest && fest\.id/g) || []).length === 2, '廣場／營地沒把節日（feastStyle）帶給圓桌');
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

console.log('— 愚人節換角色 —');
const hasDitto = (() => { try { const a = P.loadArt(core, 'ditto'), b = P.loadArt(core, 'ditto_shining'); return a && b && !a.shadow && !b.shadow; } catch (e) { return false; } })();
ok(hasDitto, '安裝版讀不到 ditto / ditto_shining 的美術（會退回黑影）');
if (hasDitto && hasArt) {
    const F = P.PLAZA_LIVE_FIELD;
    const one = (key, char, swap) => [{ key, code: 'AA', char, seed: 1, joinStep: 0,
                                        origin: { x: 30, y: 30 }, anchor: { x: 30, y: 30 }, swap }];
    const lines = (o, opts = {}) => P.composePlaza(core, o, 0, { npc: false, field: F, textLabels: false, ...opts }).lines.join('\n');
    const ks = Array.from({ length: 50 }, (_, i) => 'k' + i);
    const kN = ks.find(k => FEST.swapChar('ditto', k) === 'ditto');
    const kS = ks.find(k => FEST.swapChar('ditto', k) === 'ditto_shining');
    ok(lines(one(kN, 'agumon')) !== lines(one(kN, 'ditto')), '（探針）亞古獸跟百變怪要畫得不一樣，下面幾條才有意義');
    ok(lines(one(kN, 'agumon', 'ditto')) === lines(one(kN, 'ditto')), '個人 swap=ditto 時應該畫成百變怪');
    ok(lines(one(kS, 'agumon', 'ditto')) === lines(one(kS, 'ditto_shining')), '抽到變色版的那隻應該畫成變色百變怪');
    ok(lines(one(kN, 'agumon', undefined), { swap: 'ditto' }) === lines(one(kN, 'ditto')), '整場 opts.swap（營地）時應該換成百變怪');
    ok(lines(one(kN, 'agumon', null), { swap: 'ditto' }) === lines(one(kN, 'agumon')), '個人 swap=null（不給看）應該蓋過整場');
    // 營地：swapSalt（每次進營地換一個）要真的參與抽籤 → 同一隻換個 salt 結果會變
    const kSalt = ks.find(k => FEST.swapChar('ditto', k + '|a') === 'ditto_shining' && FEST.swapChar('ditto', k + '|b') === 'ditto');
    ok(lines(one(kSalt, 'agumon', undefined), { swap: 'ditto', swapSalt: 'a' }) === lines(one(kSalt, 'ditto_shining'))
       && lines(one(kSalt, 'agumon', undefined), { swap: 'ditto', swapSalt: 'b' }) === lines(one(kSalt, 'ditto')),
       '營地的 swapSalt 沒有參與抽變色版（進出營地不會重抽）');
    // 拿在手上的那隻（前端畫）也要換，而且跟合成時同一隻（同一個 key、同一個 salt）
    // 挑一隻 salt=s1 會抽到變色版、不帶 salt／裸 id 是普通版的：key 或 salt 接錯才抓得到
    const ranchOf = (k) => ({ pets: [{ id: k, state: { characterId: 'agumon' } }] });
    const occKey = (k) => P.yardOccupants(core, ranchOf(k), null, null, null, core)[0].key;   // 合成時用的 key
    const rid = ks.find(k => FEST.swapChar('ditto', occKey(k) + '|s1') === 'ditto_shining'
                          && FEST.swapChar('ditto', k) === 'ditto' && FEST.swapChar('ditto', occKey(k)) === 'ditto');
    const ranch = ranchOf(rid);
    const g0 = P.yardSpriteFor(core, ranch, rid, 0, {});
    const g1 = P.yardSpriteFor(core, ranch, rid, 0, { swap: 'ditto', swapSalt: 's1' });
    const want = P.spriteDots(core, 'ditto_shining', 0, g1.facing, null);
    ok(JSON.stringify(g1.frames[0]) === JSON.stringify(want) && JSON.stringify(g0.frames[0]) !== JSON.stringify(want),
       '營地拿起來的那隻沒有換成百變怪（或跟畫面上不是同一隻）');
}

// daemon 有把換角色接到三個出口：營地合成、廣場每個人、營地拿起來那隻（都跟著節慶造型開關）
{
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), 'utf8');
    ok(/swap: fest && festOpt\.costume \? fest\.swap \|\| null : null,\s*swapSalt: new URL\(req\.url, 'http:\/\/x'\)\.searchParams\.get\('ds'\) \|\| null,\s*feast, feastStyle: fest && fest\.id \}\);/.test(src), '營地合成沒有帶 swap／swapSalt（或沒跟著節慶造型開關）');
    ok(/swapSalt: args\.ds \|\| null,/.test(src) && /const ga=\{which:hit\.id,ds:yardSalt[,}]/.test(src), '營地拿起來的那隻沒帶進場亂數（拿起來會變另一隻）');
    ok(/qs\.push\('ds='\+yardSalt\);/.test(src), '營地畫面沒有把進場亂數送給 /yard');
    ok(/if\(v==='yard' && view!=='yard'\) yardSalt=Math\.random\(\)/.test(src), '切進營地沒有重抽進場亂數');
    // 廣場對戰：打架的本體換成廣場上那隻（p:<id>），CutIn 不換
    ok(/FEST\.swapChar\(f\.swap, 'p:' \+ m\.id\)/.test(src) && /'p:' \+ m\.id, code: m\.name/.test(src), '廣場對戰的百變怪跟廣場上看到的不是同一個 key');
    ok(/const sw = inPlaza \? plazaBattleSwap\(\) : null;/.test(src)
       && /if \(swMe\)  \{ meArt = swMe\.a; meRightOffset = swMe\.off; \}/.test(src)
       && /if \(swOpp\) \{ enemyArt = swOpp\.a; enemyRightOffset = swOpp\.off; \}/.test(src), '廣場對戰沒有把打架的換成百變怪');
    ok(!/CutInArt\s*=\s*sw/.test(src), '廣場對戰的 CutIn 應該照原圖');
    ok(/swap: fest && m\.costume !== false && me\.costume !== false \? fest\.swap \|\| null : null,/.test(src), '廣場每個人沒有帶 swap（或沒跟著本人的開關）');
    ok(/acc: fest && m\.costume !== false && me\.costume !== false \? fest\.acc : null,/.test(src), '我關掉節慶造型，廣場上別人的造型還在');
    ok(/swap: \(\(\) => \{ const f = festNow\(Date\.now\(\), args\.fest\); return f && readFest\(\)\.costume \? f\.swap \|\| null : null; \}\)\(\),/.test(src), '營地拿起來的那隻沒有帶 swap');
}

console.log('— 圍爐（春節前一週）—');
{
    // 期間：2027 春節 2/6 → 1/30（除夕前 6 天）～2/5（除夕）圍爐；初一起照常；不是春節不圍
    const f27 = (m, d) => { const ms = at(2027, m, d, 12); return FEST.feastOn(FEST.active(ms), ms); };
    ok(f27(1, 30) && f27(2, 5), '除夕前一週（1/30～2/5）應該圍爐');
    ok(!f27(2, 6) && !f27(2, 10), '初一～初五（放假）不圍爐');
    ok(!f27(1, 29), '春節期間以前不圍爐');
    ok(!FEST.feastOn(FEST.active(at(2027, 12, 25, 12)), at(2027, 12, 25, 12)), '聖誕節不圍爐');
    ok(FEST.feastOn(FEST.active(0, 'lunarny'), at(2027, 7, 1), true), '預覽春節應該直接看到圍爐');
    ok(!FEST.feastOn(FEST.active(0, 'christmas'), at(2027, 7, 1), true), '預覽別的節日不該圍爐');

    // 座位：每個人數都排得進畫布（含名牌那兩列）、面向桌子、人越多角色越小（但不小於 10）
    let prev = 99, bad = [];
    for (let n = 1; n <= 20; n++) {
        const L = P.feastLayout(n), S = L.size;
        if (S > prev) bad.push(n + ':變大'); prev = S;
        if (!P.FEAST_SIZES.includes(S)) bad.push(n + ':尺寸');
        for (const s of L.seats) {
            if (s.x < 0 || s.x + S > 69 || s.y < 0 || s.y + S > 54 - 2) bad.push(n + ':出界');
            const cx = s.x + S / 2;
            if (Math.abs(cx - L.table.cx) > 1 && s.facing !== (cx < L.table.cx ? 'right' : 'left')) bad.push(n + ':沒面向桌子');
        }
        if (S > P.FEAST_SIZES[P.FEAST_SIZES.length - 1]) for (let i = 1; i < n; i++) {   // 最小號擠不下也照排
            const a = L.seats[i - 1], b = L.seats[i];
            if (a.back === b.back && Math.abs(a.x - b.x) < S * 0.7) bad.push(n + ':疊太多');
        }
        // 正左正右不坐人（跟桌子沒有前後關係）：每個腳底離桌子中線至少 sin(40°) 個半徑
        const T = L.table;
        for (const s of L.seats) {
            const fy = s.y + S, fx = s.x + S / 2;
            if (Math.abs(fx - T.cx) > T.rx * Math.sin(P.FEAST_ARC_DEG * Math.PI / 180) + 1) bad.push(n + ':坐在正側邊');
            // 前排：腳在桌裙前面（不是站在桌上）；後排：腳在桌面後緣裡面或桌子外側
            const edge = Math.abs(fx - T.cx) <= T.rx ? T.ry * Math.sqrt(1 - ((fx - T.cx) / T.rx) ** 2) : -1;
            if (!s.back && edge >= 0 && fy <= T.cy + edge + 3) bad.push(n + ':前排站在桌上');
            if (s.back && edge >= 0 && fy <= T.cy - edge) bad.push(n + ':後排沒被桌子擋到');
        }
        if (L.seats.filter(s => s.back).length !== Math.ceil(n / 2)) bad.push(n + ':前後排人數');
    }
    ok(!bad.length, '圍爐座位不對：' + bad.slice(0, 5).join(', '));
    ok(P.feastLayout(6).size === 16, '6 個人不該縮小');
    ok(P.feastLayout(20).size < 16, '20 個人應該縮小');

    const occ = (n) => Array.from({ length: n }, (_, i) => ({ key: 'p:' + i, code: 'P' + i, char: 'agumon',
        walk: { seed: 100 + i, joinStep: 0, origin: { x: 20, y: 20, facing: 'left' }, anchor: null } }));
    const F = P.PLAZA_LIVE_FIELD;
    if (hasArt) {
        // 坐在座位上、縮到座位表的大小；名牌跟著縮小後的腳底
        const n = 20, L = P.feastLayout(n);
        const out = P.composePlazaLive(core, occ(n), 5, { feast: true, nowMs: 5 * 750 });
        const seatOf = Object.fromEntries(out.placed.map(p => [p.key, p]));
        ok(occ(n).every((o, i) => seatOf[o.key].x === L.seats[i].x && seatOf[o.key].y === L.seats[i].y), '圍爐沒有坐在座位上');
        ok(out.placed.every(p => p.size === L.size), '圍爐沒有縮成座位表的大小');
        ok(out.tags.every(t => { const p = seatOf[t.key]; return t.x === p.gx + L.size / 2 && t.y === p.gy + L.size; }), '名牌沒跟著縮小後的腳底');
        // 縮小真的有縮：每隻畫出來的範圍不超過 size（量 owner）
        const span = new Map();
        out.owner.forEach((row, y) => row.forEach((z, x) => { if (z < 0) return; const s = span.get(z) || { x0: 99, x1: -1 }; s.x0 = Math.min(s.x0, x); s.x1 = Math.max(s.x1, x); span.set(z, s); }));
        ok([...span.values()].every(s => s.x1 - s.x0 + 1 <= L.size), '角色沒有真的縮小');
        // 桌子：圍爐才有；不圍爐跟以前一樣
        const red = (ls) => ls.join('').includes('38;2;190;38;42') || ls.join('').includes('48;2;190;38;42');
        const tableIn = (o) => (o.layer || []).some(it => it.k === 1 && it.pal.includes('#be262a'));
        ok(tableIn(out), '圍爐沒有畫桌子');
        const plainOut = P.composePlazaLive(core, occ(3), 5, { nowMs: 5 * 750 });
        ok(!red(plainOut.lines) && !plainOut.layer, '不圍爐也畫了桌子／有圍爐圖層');
        // 縮小不丟像素：圍爐圖層裡每隻都是 16x16 原圖＋倍率 size/16（不是最近點縮過的小圖），
        // 而且角色和桌子都不再畫進 lines（不然縮小版會從原圖底下透出來）
        const pets = out.layer.filter(it => it.k !== 1);
        ok(pets.length === n && pets.every(it => it.w === 16 && it.h === 16 && it.k === L.size / 16), '圍爐角色不是原圖＋縮放倍率：' + JSON.stringify(pets.slice(0, 1).map(it => [it.w, it.h, it.k])));
        const orig = P.spriteDots(core, 'agumon', 5, out.placed.find(p => p.key === 'p:0').facing, undefined);
        const unpack = (it) => Array.from({ length: it.h }, (_, y) => Array.from({ length: it.w }, (_, x) => { const c = it.px.charCodeAt(y * it.w + x); return c === 46 ? null : it.pal[c - 48]; }));
        const hex = (d) => d.map(r => r.map(c => c && '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')));
        const p0 = out.layer.find(it => it.k !== 1 && it.x === out.placed.find(p => p.key === 'p:0').dx);
        ok(p0 && JSON.stringify(unpack(p0)) === JSON.stringify(hex(orig)), '圍爐圖層的角色跟原圖不一樣（像素被縮掉了？）');
        ok(!red(out.lines) && !out.lines.join('').includes('38;2'), '圍爐的角色／桌子還畫在 lines 裡');
        ok(out.layer.findIndex(it => it.k === 1) === out.tableZ, '圍爐圖層裡桌子的順序跟 tableZ 不一致');
        // 後排被桌子擋住下半身（坐在桌後）：最上面那個座位的腳底那一列有桌子的顏色蓋在牠身上
        const L3 = P.feastLayout(4), o4 = occ(4);
        const o3 = P.composePlazaLive(core, o4, 5, { feast: true, nowMs: 5 * 750 });
        const back = o3.placed.find(p => p.key === 'p:1');   // 座位 1 = 正上方（從最左邊順時針）
        const front = o3.placed.find(p => p.key === 'p:3');  // 座位 3 = 正下方
        // 畫的順序：後排在桌子之前（桌子蓋住下半身）、前排在桌子之後（身體蓋在桌上）
        ok(back.y === L3.seats[1].y && back.z < o3.tableZ && front.z >= o3.tableZ, '後排沒被桌子擋住／前排被桌子蓋住（tableZ=' + o3.tableZ + '）');
        // 而且桌面真的伸到後排的腳底後面（不然排在前面也擋不到）
        const T3 = L3.table;
        ok(T3.cy - T3.ry < back.y + L3.size, '桌面後緣沒伸到後排的腳底（看起來像站在桌子後面）');
        // 剛進場（畫面外）→ 從那裡走過來，幾秒後到座位；已經在場上的人第一眼就坐好
        const caches = new Map();
        const walker = { key: 'p:new', code: 'NEW', char: 'agumon', walk: { seed: 5, joinStep: require('../src/shared/plaza-walk.js').stepAt(1000), origin: { x: -20, y: 10, facing: 'right' }, anchor: { x: 10, y: 10 } } };
        const seat = P.feastLayout(2).seats[1];
        const t0 = P.composePlazaLive(core, [occ(1)[0], walker], 5, { feast: true, caches, nowMs: 1000 }).placed.find(p => p.key === 'p:new');
        const t1 = P.composePlazaLive(core, [occ(1)[0], walker], 5, { feast: true, caches, nowMs: 1500 }).placed.find(p => p.key === 'p:new');
        let t9 = null;
        for (let k = 2; k <= 20; k++) t9 = P.composePlazaLive(core, [occ(1)[0], walker], 5, { feast: true, caches, nowMs: 1000 + k * 500 }).placed.find(p => p.key === 'p:new');
        ok(t0.x === -20, '剛進場的人沒有從畫面外走過來（直接瞬移到座位）');
        ok(t1.x > t0.x && t1.facing === 'right', '走去座位的時候沒有往座位走／面向不對');
        ok(t9.x === seat.x && t9.y === seat.y, '走了 10 秒還沒到座位：' + JSON.stringify([t9.x, t9.y, seat]));
        const sat = P.composePlazaLive(core, occ(2), 5, { feast: true, caches: new Map(), nowMs: 1000 }).placed.find(p => p.key === 'p:1');
        ok(sat.x === P.feastLayout(2).seats[1].x, '已經在場上的人第一眼沒有直接坐好');
        // 手動模式的睡著不算（圍爐大家都醒著）
        const sleepy = { ...walker, key: 'p:z', walk: { mode: 'manual', x: 20, y: 20, facing: 'left', vx: 0, vy: 0, at: -1e9 } };
        ok(!P.composePlazaLive(core, [sleepy], 5, { feast: true, nowMs: 1000 }).placed[0].sleeping, '圍爐時手動模式放著太久還是睡著了');
        void F;
    }
    // 營地：yardOccupants 一樣走 composePlaza，圍爐座位不經過營地的走路換算
    if (hasArt) {
        const ranch = { pets: [1, 2, 3].map(i => ({ id: 'r' + i, state: { characterId: 'agumon' } })) };
        const y = P.composeYard(core, ranch, {}, P.yardJoinStep() + 3, { feast: true, nowMs: 1000 });
        const L = P.feastLayout(3);
        ok([1, 2, 3].every((k, i) => { const p = y.placed.find(q => q.key === 'ranch:r' + k); return p.dx === L.seats[i].x && p.dy === L.seats[i].y; }), '營地圍爐的位置不是座位（被走路座標換算過了？）');
    }
    // daemon：營地、廣場都接上；前端圍爐時不能拎、沒有自動／手動、WASD 不動
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), 'utf8');
    ok(/const feast = festOpt\.costume && festFeast\(fest, Date\.now\(\), festQ\);/.test(src) && /swapSalt: [^\n]*,\s*feast, feastStyle: fest && fest\.id \}\);/.test(src), '營地沒有接圍爐');
    ok(/const feast = me\.costume !== false && festFeast\(fest, nowS, festQ\);\s*const out = plaza\.composePlazaLive\(core, occ, step,\s*\{[^}]*feast, feastStyle: fest && fest\.id \}\);/.test(src), '廣場沒有接圍爐');
    ok(/const festFeast = \(f, ms, q\) => FEST\.feastOn\(f, ms, !IS_RELEASE && !!\(q \|\| process\.env\.VPET_FESTIVAL\)\);/.test(src), 'release 版也吃圍爐預覽');
    ok(/if\(lastYard&&lastYard\.feast\) return;/.test(src), '圍爐時營地還能拎走');
    // 廣場的 dev 節日預覽：只有這個畫面（/plaza?fest=），release 沒有
    ok(/const festQ = new URL\(req\.url, 'http:\/\/x'\)\.searchParams\.get\('fest'\);\s*const fest = festNow\(Date\.now\(\) \+ plazaClient\.skew\(\), festQ\);/.test(src), '廣場不吃節日預覽');
    ok(/\$\{IS_RELEASE \? '' : `\s*<div class="form" id="plazadevrow"[^>]*>\s*<label[^>]*><input type="checkbox" id="plazadev">[\s\S]{0,200}<label class="k devonly"[^>]*>節日預覽 <span class="devtag">dev<\/span><select id="plazafestsel">/.test(src), '廣場沒有 dev 節日預覽下拉（或 release 也有）');
    // dev 開關和節日預覽放在對話輸入框下方（使用者要求）
    const ci = src.indexOf('<input id="chatin"'), dr = src.indexOf('id="plazadevrow"');
    ok(ci > 0 && dr > ci && src.indexOf('id="plazadev"') > ci && src.indexOf('id="plazafestsel"') > ci, '廣場的 dev 開關／節日預覽不在對話輸入框下方');
    // 春節先不戴帽子（圍爐一桌人加帽子太雜）
    ok(FEST.active(at(2027, 2, 1, 12)).acc === null && FEST.active(at(2027, 2, 8, 12)).acc === null, '春節還戴著帽子');
    ok(/fetch\('\/plaza'\+\(pfs&&pfs\.value\?'\?fest='\+encodeURIComponent\(pfs\.value\):''\)/.test(src), '廣場畫面沒有把預覽送給 /plaza');
    ok(/plazamode'\)\.style\.display = plazaFeast \? 'none' : ''/.test(src), '圍爐時還有自動／手動鈕');
    ok(/plazaMode!=='manual'\|\|plazaFeast\|\|/.test(src), '圍爐時 WASD 還會送移動');
    ok(/s=p\.size\|\|S;/.test(src) && /size: p\.size \|\| plaza\.SPRITE/.test(src), '營地點擊沒用縮小後的大小');
    // 圍爐圖層：營地、廣場都送 layer，前端畫完 lines 接著畫（營地第二頁的對峙另外畫，所以 lines 前面可以多一段 sto）
    ok(/lines: (?:sto \? sto\.lines : )?out \? out\.lines : null, layer: out \? out\.layer : null/.test(src) && /lines: out\.lines, layer: out\.layer/.test(src), '營地／廣場沒有送圍爐圖層');
    ok(/if\(y\.lines\)\{ draw\(y\.lines\); drawLayer\(y\.layer\); \}/.test(src) && /draw\(p\.lines\); drawLayer\(p\.layer\);/.test(src)
       && /draw\(lastYard\.lines\); drawLayer\(lastYard\.layer\);/.test(src), '前端沒有畫圍爐圖層');
    ok(/const sw=it\.k\*DW, sh=it\.k\*DH/.test(src), '前端畫圍爐圖層沒有照倍率放大');
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
