'use strict';
// ── PoC 步驟 2：獨立時鐘 daemon ──────────────────────────────────────────────
//
// 目的：證明「把時鐘從 statusLine 指令裡拆出來」可行——本行程自己每秒 tick 一次，
//       跑既有 decideAgumon 表演管線，資料源吃 token-source.js（讀 JSONL），
//       完全不依賴 Claude Code 是否呼叫 statusLine，因此分頁 idle / 背景也照跑。
//       開一個 localhost 頁面即時顯示 pet + 時鐘 + token，肉眼驗證。
//
// ⚠️ PoC 隔離：用「獨立的 daemon-state.json」，不碰真正的 color-state.json，
//    避免跟現有 statusLine 搶寫、污染正式進度。要 discard 只需刪這兩個檔 + 停行程。
//    正式版才需決定「單一寫入者」（daemon 當家或 statusLine 唯讀）。
//
// 用法：node src/daemon/daemon.js        （預設埠 3010，可用 AGUMON_DAEMON_PORT 覆蓋）
//       瀏覽器開 http://localhost:3010

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Worker } = require('worker_threads');
const { spawnSync, spawn } = require('child_process');   // spawn：起走動範圍編輯器（dev）

// 優先用「已安裝」的 core（跟 statusLine 同一份權威），抓不到再退回 repo 內。
let core;
const INSTALLED_CORE = path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js');
try { core = require(INSTALLED_CORE); }
catch (e) { core = require(path.join(__dirname, '..', 'runtime', 'agumon-core.js')); }

const { computeUsage } = require('./token-source');
const plaza = require('./plaza');   // 廣場／院子的合成器（走路在 ../shared/plaza-walk.js）
const PW    = require('../shared/plaza-walk.js');   // 拍子換算（摸摸要把停走的拍數扣掉）
const YT    = require('./yard-touch');              // 營地摸摸的狀態機（輪詢間隔也從這裡取）
const WX    = require('../shared/weather.js');
const wxSrc = require('./weather-source.js');
const PlazaClient = require('./plaza-client');
const PlazaServer = require('./plaza-server');   // 只拿常數（聊天字數上限），不在 daemon 裡起伺服器     // 廣場（docs/plaza-spec.md）：連內網主機的那一端

const {
    STATE_DIR, EVO_LENGTH, MAX_POS,
    loadState, saveState, decideAgumon, checkEvolution,
    loadCharacter, loadShared, getSharedFrame, isHighTierStarter,
    renderCells, composeSleepScene, composeStatusCard, composeTreeScene,
    getFacingRows, composeBattleScene, composeEvoScene, composeDropScene,
    silhouetteArt, updateEvoHistory,
    applyForceFlags, applyForceTriggers, clearForceCharacter,
    getCharacterStage, computeInheritedPower, resetStageStats, recordAlbumIfChanged,
    alignWalkPhase,
} = core;

// 模式：預設「隔離」(寫 daemon-state.json，不接管、不寫 heartbeat) → 純顯示/PoC，跑了也不影響 statusLine。
//       --authoritative → 「當家」：寫真 color-state.json + 每拍寫 heartbeat，statusLine 偵測到就退唯讀。
//
// daemon-only 安裝（install.js --daemon-only 留下的 DAEMON_ONLY 標記）→ 預設當家。
// 那種環境根本沒有 statusLine 在跑，隔離模式只會寫進沒人讀的 daemon-state.json，
// 使用者會看到「pet 完全不動、指令都沒反應」而找不到原因。--isolated 可強制覆寫回隔離。
const DAEMON_ONLY   = fs.existsSync(path.join(core.INSTALL_ROOT, 'DAEMON_ONLY'));
const AUTHORITATIVE = process.argv.includes('--isolated') ? false
                    : (process.argv.includes('--authoritative') || DAEMON_ONLY);
const STATE_FILE     = path.join(STATE_DIR, AUTHORITATIVE ? 'color-state.json' : 'daemon-state.json');
const HEARTBEAT_FILE = path.join(STATE_DIR, 'daemon-heartbeat.json');
const FORCE_FILE     = path.join(STATE_DIR, 'force-char.json');   // vpet 指令；當家時由 daemon 讀

// release 版 gate：與 statusline-cheat 同一個標記檔。強制戰鬥在 CLI 是開發指令
// （release 只留 battle on/off），UI 按鈕自然也要一致 → release 不顯示、且伺服器端擋掉。
// 只隱藏按鈕是不夠的：/cmd 是公開端點，必須在伺服器端一起擋。
const IS_RELEASE = fs.existsSync(path.join(core.INSTALL_ROOT, 'RELEASE'));
// 與 statusline-cheat.js 的 release gate 對齊（那邊是 blockedCmd / blockedBattle / blockedSwitch）。
// 兩份名單必須一致，否則會出現「按鈕在網頁上看得到、按下去子行程回一句『此版本未提供此指令』」。
const DEV_ONLY   = new Set(['battle', 'evolve', 'stats', 'switch', 'pvp-server', 'zoneedit']);

// UI 上要露出的快捷鈕（一鍵、不用填參數）。**只影響版面，不影響功能** ——
// 沒列在這裡的指令照樣能用（CLI `vpet <cmd>`，或直接 POST /cmd），只是不佔畫面。
//   摸摸 → 直接點角色就好，按鈕多餘
//   hide/show/pin/unpin → statusline 顯示專屬，daemon 沒有狀態列可隱藏／釘住，不做
// confirm：按下去要先二次確認（重抽會直接換掉現在的桌寵）
// dev: 只在非 release 露出。
// ⚠️ 這是「UI 露不露臉」，跟下面伺服器端的 DEV_ONLY 是兩回事 —— sleep/wake 在 CLI
//    的 release 版是開放的（vpet help 的玩家區就有），所以不能進 DEV_ONLY，否則
//    會變成「終端機打得動、網頁 POST 卻被擋」。這裡只是不把按鈕擺出來。
// scope：這顆鈕在哪個畫面出現。'home' = 只在前線、'both' = 兩邊都有。
// 前線的鈕多半是對「現役那一隻」下指令（卡片、進化樹、睡覺…），在營地畫面按了
// 只會影響一隻根本沒顯示在畫面上的桌寵 —— 那比按鈕消失更難懂。
// when：第三個維度 —— 條件成立才露臉（見前端的 WHEN）。目前只有合體進化用：
//       沒有成立的組合時整顆不出現，而不是灰掉 —— 灰掉的鈕會讓人一直想點點看為什麼。
// accent：醒目色。合體是少見、而且做了就回不去的事，要讓人一眼看到「現在可以了」。
const UI_BUTTONS = [
    // 合體進化（docs/jogress-spec.md 第 2 期）。玩家功能：不是 dev、不進 DEV_ONLY。
    // 文字由前端依候選換成「🧬 合體進化 → Mastemon」。
    // 只在前線：進化演出在前線，在營地按下去只會看到營地少一隻，牠變身的那一刻看不到。
    ['jogress', '🧬 合體進化', { scope: 'home', when: 'jogress', accent: true }],
    ['card',   '🪪 卡片'],
    ['tree',   '🌳 進化樹'],
    ['album',  '📖 圖鑑', { scope: 'both' }],
    ['yard',   '⛺ 營地', { scope: 'both' }],
    // 廣場（docs/plaza-spec.md）：帶前線那隻去。只在前線出現；進去之後只剩「離開」。
    ['plaza',      '🏛 廣場',     { scope: 'home' }],
    ['plazaLeave', '🚪 離開廣場', { scope: 'plaza' }],
    ['sleep',  '😴 睡覺', { dev: true }],
    ['wake',   '☀ 喚醒', { dev: true }],
];

// 進階摺疊區：不常用的開關 + 需要填參數的指令。避免主畫面被塞爆。
//   buttons: 同一列多顆鈕（開/關這種成對的開關）
//   fields : 輸入框；沒有欄位就只有一顆「執行」
//   dev    : 開發限定（release 不露出；若同時列在 DEV_ONLY，伺服器端也會擋）
const UI_FORMS = [
    { label: '🎲 重抽桌寵', action: 'reset', fields: [],
      confirm: '重抽會換掉現在的桌寵，且無法復原。確定嗎？' },
    { label: '🧊 進化凍結', buttons: [['freeze', '凍結'], ['unfreeze', '解除']] },
    { label: '⚔ 自動戰鬥', buttons: [['battleOn', '開'], ['battleOff', '關']] },
    { label: '📋 營地清單', action: 'ranch',     fields: [], scope: 'both' },
    { label: '📥 收進營地', action: 'keep',      fields: [], scope: 'both',
      confirm: '會把現役收進營地，並抽一隻新的桌寵。收進去的隨時可以換回來。確定嗎？' },
    { label: '🔄 換出營地', action: 'swap',      fields: [['which', '編號或角色名']], scope: 'both' },
    { label: '🗑 放生',     action: 'release',   fields: [['which', '編號或角色名']], scope: 'both',
      confirm: '放生會**永久刪除**那一隻，救不回來。確定嗎？' },
    { label: '🖼 舞台底圖', action: 'bg',        fields: [] },
    { label: '⛺ 走動範圍', action: 'zoneedit',  fields: [], scope: 'both', dev: true },
    { label: '🩺 doctor',   action: 'doctor',    fields: [], scope: 'both' },
    // 幽靈對戰（vpet pvp / pvp-setup）的兩列拿掉了：對戰改在廣場裡做（規格 §十）。
    // CLI 打 vpet pvp 仍可用（開發者用），只是不再擺入口。名牌留著 —— 它現在是廣場的名牌。
    { label: '🏷 名牌',     action: 'code',      fields: [['name', '新名牌（留空＝查看目前）']] },
    { label: '🔀 切換角色', action: 'switch',    fields: [['name', '角色名或編號']], dev: true },
    { label: '✨ 立即進化', action: 'evolve',    fields: [['name', '進化目標角色名']], dev: true },
    { label: '⚔ 指定戰鬥', action: 'battle',    fields: [['enemy', '敵人（留空＝隨機）'], ['result', 'win / lose（留空＝依機率）']], dev: true },
    { label: '📊 隱藏統計', action: 'stats',     fields: [], dev: true },
];
const PORT           = parseInt(process.env.AGUMON_DAEMON_PORT || '3010', 10);
// 節奏參數只有一份，在 core（見那邊的說明）。daemon 若從 repo 跑、載到的卻是還沒有這個
// export 的舊安裝版 core，就退回舊 core 的 1000 —— 一定要跟**實際載入的那份 core** 一致，
// 不然這裡的 commit 跟 decideAgumon 會對「表演播到第幾拍」各說各話。
const STEP_MS        = core.STEP_MS || 1000;

function tryLoadArt(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }

// 走路位移：statusline 靠 aguCol+pos 把角色擺到不同欄；daemon 沒有狀態列，改把角色畫到一個
// 固定寬「舞台」上、左邊墊 pos 個空欄，角色就會左右踱步（pos 0..MAX_POS）。舞台寬固定 →
// canvas 每幀同寬、不抖動。
// 舞台寬度必須是「固定值」，不能算成 MAX_POS + spriteW。
// 睡覺場景經 composeSleepScene 後是 24 欄（角色 16 + Zzz 8），算出來會變 60 欄 = 480px，
// 超過 #stage 的 416px → canvas 的 max-width:100% 把它縮到 86.7%，而 height:auto 讓高度
// 跟著縮成 111px，置中後角色就浮起來約 2 dot（地平線對不上，看起來像飄在半空）。
// 固定 BASE_COLS 後所有 single 場景同寬同高，地平線永遠貼齊 padding 的那 1 dot。
function padWalkStage(rows, pos) {
    if (!rows || !rows.length) return rows;
    const spriteW = rows[0].length;
    const stageW  = Math.max(BASE_COLS, spriteW);
    // 較寬的場景（睡覺）可移動範圍相應變小，避免右緣溢出舞台
    const off     = Math.max(0, Math.min(pos | 0, stageW - spriteW));
    return rows.map(row => {
        const out = new Array(stageW).fill(null);
        for (let c = 0; c < row.length; c++) out[off + c] = row[c];
        return out;
    });
}

// 從 JSONL token-source 合成一份「像 statusLine 輸入」的物件餵給表演管線。
// 只有 cost / session_id 是玩法真正吃的（updateEvoSpend）；其餘為顯示用。
function buildInput(usage) {
    const a = usage.activeSessionUsage;
    // context% 為 PoC 近似（JSONL 不直接帶 context 佔用），用近 10 分鐘 output 粗估，純顯示。
    const ctxApprox = Math.min(95, Math.round((usage.burn10m.output || 0) / 1200));
    return {
        render_width_chars: 120,
        session_id: usage.activeSession || 'daemon',
        cost:  { total_cost_usd: a ? a.costUSD : 0 },
        model: { display_name: 'Claude ⟨daemon⟩' },
        context_window: { used_percentage: ctxApprox },
        cwd: (a && a.cwd) || process.cwd(),
        rate_limits: {},   // JSONL 無 rate-limit % → PoC 顯示 0%（正式版要另接）
    };
}

// 表演分派：忠實複製 statusline-agumon-color.js 的 decide→compose 流程，
// 但拿掉 cheat/force、pids/watchdog（daemon 是常駐單行程，不需要那套孤兒防護）。
// 回傳 { kind, petLines(ANSI array|null) }。狀態列不在這演（daemon 有自己的 token 面板）。
// yardTouch 在檔案後段才 const 宣告。第一拍已經延後到模組載完才跑（見 doTick 底下），
// 這裡再包一層是保險：有人把 doTick 改回同步呼叫時，壞的是「這一拍看不到誰被拿著」，
// 而不是整拍失敗。剛啟動時也不可能有誰被拿著。
function heldYardIds() { try { return yardTouch.heldIds(); } catch (e) { return null; } }

function renderTick(i, st, now) {
    const step = Math.floor(now / STEP_MS);

    // 0. 當家模式：讀 force-char.json 套 vpet 指令（與 statusLine 共用同一份核心邏輯）
    // heldIds：合體進化不能拿「正被長壓抓著」的那隻（只有 daemon 知道誰被抓著）
    if (AUTHORITATIVE) applyForceFlags(st, FORCE_FILE, undefined, { heldIds: heldYardIds() });

    // 1. 進化 commit（必須在 loadCharacter 之前）
    if (st.evoStartStep != null && st.evoStartStep >= 0) {
        const targetElapsed = step - st.evoStartStep;
        const wouldAdvance  = Math.min(targetElapsed, (st.evoShownElapsed ?? -1) + 1);
        if (wouldAdvance >= EVO_LENGTH) {
            const prevCharId = st.characterId;
            st.characterId = st.evoNextCharId || st.characterId;
            // SU：戰力繼承「進化前基礎 power + 訓練值」（須在 delete trainingBonus 之前算）
            if (getCharacterStage(st.characterId) === 'Super-Ultimate') {
                st.inheritedPower = computeInheritedPower(st, prevCharId);
            } else {
                delete st.inheritedPower;
            }
            st.evoStartStep = -1; st.evoNextCharId = null; st.evoShownElapsed = -1;
            // 走路相位接回表演位置（與 statusline 的 commit 同一套；漏了新角色會瞬移）
            alignWalkPhase(st, step, st.lastPos ?? 0, st.lastFacing);
            delete st.exprStartStep; delete st.roarStartStep; delete st.lastStepSeen; delete st.happyStartStep;
            resetStageStats(st);   // 訓練值/勝率/隱藏統計歸零 + 記錄 lastEvolveAt（與 statusLine 共用）
            if (AUTHORITATIVE) clearForceCharacter(FORCE_FILE);   // 清 force.character 免無限迴圈
        }
    }

    if (!st.characterId) st.characterId = 'agumon';
    const { charDef, artFile, bulletArtFile, cutinArtFile, config } = loadCharacter(st.characterId);
    updateEvoHistory(st);
    recordAlbumIfChanged(st);   // 圖鑑：只在角色變動時碰磁碟

    // 1.5 + 2. force 觸發（drop/強制進化）
    if (AUTHORITATIVE) applyForceTriggers(st, step);

    // 在廣場（docs/plaza-spec.md §六）：人不在家 → 飼育全部暫停。
    // 進化、訓練值、自動戰鬥都不動；廣場自己發起的對戰（第 3 期）走 force 那條路，不受影響。
    const inPlaza = plazaClient.active();
    if (inPlaza) {
        st.plaza = { id: plazaClient.me().id, at: now };   // 給 CLI 看（擋指令用），不是持久在場
        st._noAutoBattle = true;
    } else {
        delete st.plaza;
    }

    // 2. 自然進化觸發（freeze 凍結時跳過，與 statusLine 一致）
    if (!(st.evoStartStep >= 0) && !st._freezeEvolve && !inPlaza) {
        const nextChar = checkEvolution(st, i, config);
        if (nextChar) {
            st.evoStartStep = step; st.evoNextCharId = nextChar; st.evoShownElapsed = -1;
            st.battleStartStep = -1; st.battleEnemy = null; st.battlePending = false;
            delete st.exprStartStep; delete st.roarStartStep; delete st.happyStartStep;
        }
    }

    // 廣場對戰：伺服器已經決定好對手與勝負，這裡把它變成一場前線的戰鬥（演出沿用前線那套），
    // 頁面把演出疊在廣場上。直接設 st 的旗標而不是寫 force 檔 —— 隔離模式不讀 force，
    // 而且這場戰鬥是 daemon 自己發起的，不該經過「指令通道」。
    // 不計戰績（battleNoCount）；心情、上一場敵人在收尾時還原，打完不留任何痕跡。
    if (inPlaza && plazaBattle && plazaBattle.pending) {
        if (Date.now() - plazaBattle.got > PLAZA_BATTLE_STALE_MS) plazaBattle = null;
        else if (!(st.battleStartStep >= 0) && !(st.evoStartStep >= 0) && !(st.dropStartStep >= 0)) {
            plazaBattle.snap = { mood: st.mood, lastBattleEnemy: st.lastBattleEnemy };
            st._forceBattle = true;
            st._forceBattleWin = !!plazaBattle.win;
            st._forceBattleEnemy = plazaBattle.opp.char;
            st._pvpOppLabel = plazaBattle.opp.name;
            st._pvpMeLabel = plazaClient.me() ? plazaClient.me().name : null;
            st._battleNoCount = true;
            plazaBattle.pending = false;
        }
    }
    const trainBefore = st.trainingBonus;
    const result = decideAgumon(i, st, now, charDef, { allowBattle: true });
    if (plazaBattle && !plazaBattle.pending) {
        if (result.kind === 'battle') plazaBattle.seen = true;
        else if (plazaBattle.seen || Date.now() - plazaBattle.got > PLAZA_BATTLE_STALE_MS) {
            const sn = plazaBattle.snap || {};
            if (sn.mood === undefined) delete st.mood; else st.mood = sn.mood;
            if (sn.lastBattleEnemy === undefined) delete st.lastBattleEnemy; else st.lastBattleEnemy = sn.lastBattleEnemy;
            plazaBattle = null;
        }
    }
    if (inPlaza) {
        // hook 照常寫（那是 Claude Code 的脈搏，不該擋），但這段期間的訊息不加訓練值、
        // 不武裝自動戰鬥。武裝要「標成已開過」而不是只清掉 pending —— 不然一回前線，
        // 那個早就過了延遲的武裝會立刻開打。
        if (trainBefore === undefined) delete st.trainingBonus; else st.trainingBonus = trainBefore;
        st.battlePending = false;
        st.battleFiredHookTs = st.battleArmHookTs;
        st.lastActivityAt = now;   // 在外面走動，不會在家睡著；回前線時也不會一回來就倒頭睡
    }
    let petLines = null;

    if (result.kind === 'battle') {
        const enemyId = result.enemyId || 'godzilla_1999';
        let enemyChar = null;
        try { enemyChar = loadCharacter(enemyId); } catch (e) {}
        const meArt        = tryLoadArt(artFile);
        let enemyArt       = enemyChar ? tryLoadArt(enemyChar.artFile) : null;
        const meBulletArt  = tryLoadArt(bulletArtFile);
        let enemyBulletArt = enemyChar ? tryLoadArt(enemyChar.bulletArtFile) : null;
        const meCutInArt   = tryLoadArt(cutinArtFile);
        let enemyCutInArt  = enemyChar ? tryLoadArt(enemyChar.cutinArtFile) : null;
        let enemyRightOffset = enemyChar?.charDef?.RIGHT_OFFSET ?? null;
        if (!enemyArt) {   // 黑影 fallback
            let sChar = null; try { sChar = loadCharacter('shadow'); } catch (e) {}
            if (sChar) {
                enemyArt = tryLoadArt(sChar.artFile); enemyBulletArt = tryLoadArt(sChar.bulletArtFile);
                enemyCutInArt = tryLoadArt(sChar.cutinArtFile); enemyRightOffset = sChar?.charDef?.RIGHT_OFFSET ?? null;
            }
            if (!enemyArt) {
                try {
                    const a = loadCharacter('agumon');
                    enemyArt = silhouetteArt(tryLoadArt(a.artFile));
                    enemyBulletArt = silhouetteArt(tryLoadArt(a.bulletArtFile));
                    enemyCutInArt = null; enemyRightOffset = a?.charDef?.RIGHT_OFFSET ?? null;
                } catch (e) {}
            }
        }
        petLines = composeBattleScene({
            frame: result, meArt, enemyArt, meBulletArt, enemyBulletArt, meCutInArt, enemyCutInArt,
            shared: loadShared(), meRightOffset: charDef.RIGHT_OFFSET, enemyRightOffset,
            oppLabel: st.pvpOppLabel || null, meLabel: st.pvpMeLabel || null,
        });
    }
    if (result.kind === 'evo' && !petLines) {
        const charId = result.useNewChar ? st.evoNextCharId : st.characterId;
        let evoChar = null; try { evoChar = loadCharacter(charId); } catch (e) {}
        petLines = composeEvoScene({
            frame: result, charArt: evoChar ? tryLoadArt(evoChar.artFile) : null,
            shared: loadShared(), charRightOffset: evoChar?.charDef?.RIGHT_OFFSET ?? null,
        });
    }
    if (result.kind === 'drop' && !petLines) {
        const art = tryLoadArt(artFile);
        const idle = charDef.F?.IDLE_1 ?? 0;
        const charRows = art ? getFacingRows(art, idle, 'left', charDef.RIGHT_OFFSET) : null;
        const dustName = isHighTierStarter(st.characterId) ? 'dust_hi' : 'dust';
        const dustRows = getSharedFrame(loadShared(), dustName, 0);
        petLines = composeDropScene({ charRows, dustRows, elapsed: result.elapsed });
    }
    if (result.kind === 'card' && !petLines) {
        petLines = composeStatusCard({ charId: st.characterId, st, cutInArt: tryLoadArt(cutinArtFile), dim: result.dim });
    }
    if (result.kind === 'tree' && !petLines) {
        petLines = composeTreeScene(st, { dim: result.dim });
    }
    if (result.kind === 'single' && !petLines) {
        const art = tryLoadArt(artFile);
        if (art) {
            let rows = getFacingRows(art, result.frameIdx, result.facing, charDef.RIGHT_OFFSET);
            if (rows && result.sleepFx) {
                rows = composeSleepScene(rows, getSharedFrame(loadShared(), result.sleepFx, 0));
            }
            if (rows) petLines = renderCells(padWalkStage(rows, result.pos ?? 0));   // 套走路位移
        }
    }

    saveState(STATE_FILE, st);
    // cutIn：只有真正在演 cut-in 的那幾拍才是 true（decideBattleFrame 的 elapsed 0~4），
    // 打鬥過程的拍數不算。前端據此決定要不要塗上下黑邊 —— 用 kind 判斷會整場戰鬥都塗到。
    return { kind: result.kind, petLines, cutIn: !!(result.meCutIn || result.enemyCutIn) };
}

// ── token 掃描：搬到 worker thread，每 5 秒刷新一次，主迴圈只讀快取 ──────────────
// 當初是走路跳幀的根治：computeUsage 整份重掃 JSONL 要 ~2.1s > 1s tick，
// 在主迴圈跑會拖慢每秒 render → step 跳 2 → 走路跳幀。
//
// token-source 改成增量掃描之後（2026-08-24），單次已經降到 ~4ms，
// 主迴圈其實跑得動了 —— 但 worker 保留：冷啟動那一次仍要 ~1.5s，而且「掃描多久」
// 取決於使用者累積了多少 transcript，不該由主迴圈去賭那個數字。
// 主迴圈永遠只讀 cachedUsage。
function emptyBucket() { return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, costUSD: 0, messages: 0 }; }
function emptyUsage() {
    return {
        scannedFiles: 0, uniqueMessages: 0, totals: emptyBucket(), byModel: {}, sessions: 0,
        activeSession: null, activeSessionUsage: null, today: emptyBucket(), last5h: emptyBucket(),
        burn10m: emptyBucket(), lastActivityAgoSec: null,
    };
}
let cachedUsage = emptyUsage();
const USAGE_REFRESH_MS = 5000;
function startUsageWorker() {
    let worker;
    try { worker = new Worker(path.join(__dirname, 'token-worker.js')); }
    catch (e) { console.log('   ⚠️ token worker 起不來，退回主迴圈掃描（可能偶爾跳幀）：' + e.message);
                setInterval(() => { try { cachedUsage = require('./token-source').computeUsage({ now: Date.now() }); } catch (e2) {} }, USAGE_REFRESH_MS);
                try { cachedUsage = require('./token-source').computeUsage({}); } catch (e2) {} return; }
    worker.on('message', (m) => { if (m && m.ok && m.usage) cachedUsage = m.usage; });
    worker.on('error', () => {});
    worker.unref();   // 別讓 worker 卡住行程退出
    const req = () => { try { worker.postMessage({ now: Date.now() }); } catch (e) {} };
    req();
    setInterval(req, USAGE_REFRESH_MS).unref();
}
startUsageWorker();

// ── 時鐘 ──
let tick = 0;
// 院子用的走路快取（key -> 走到第幾拍的快照）。長駐在 daemon 上，不必每次請求重播。
const yardCaches = new Map();


// 院子的拍子由 plaza-walk 自己定（目前與家裡同為 750ms，但兩者是分開的參數），而且不依賴 daemon 的 tick 計數 ——
// 用牆鐘算，重開 daemon 也接得上，日後接共用廣場時同一條式子還要加上 serverNow 校正。
const plazaStep = () => require('../shared/plaza-walk.js').stepAt(Date.now());

// ── 廣場（docs/plaza-spec.md）─────────────────────────────────────────
// 連線就是在場：斷線重試失敗 → onLost → 回前線，並留一句話給頁面顯示。
// 「在廣場」只活在這個行程裡（state.plaza 只是給 CLI 看的影子），所以重開 daemon = 回前線。
let plazaNotice = null;   // { text, at }：頁面顯示一次就好
const plazaCaches = new Map();
const plazaClient = PlazaClient.create({
    log: (m) => console.log('   🏛 ' + m),
    onLost: (reason) => { plazaNotice = { text: reason + '，已回到前線。', at: Date.now() }; plazaCaches.clear(); plazaBattle = null; },
    // 我是對戰的一方 → 下一拍在前線開演（見 renderTick 的「廣場對戰」）
    onBattle: (b) => { plazaBattle = { ...b, pending: true, seen: false, got: Date.now() }; },
    onInviteClose: (c) => {
        const why = { declined: '對方拒絕了對戰邀請', timeout: '對方沒有回應對戰邀請', left: '對方離開了廣場，邀請取消' }[c.reason];
        if (c.mine && why) plazaNotice = { text: why, at: Date.now() };
    },
});
// 廣場對戰（規格 §八）：{ opp:{id,name,char}, win, pending, seen, snap }
//   pending：還沒開演（下一拍 renderTick 會把它變成一場前線戰鬥）
//   seen   ：已經看到 kind === 'battle'（之後不是 battle 了 = 演完，收尾）
let plazaBattle = null;
const PLAZA_BATTLE_STALE_MS = 40000;   // 保險：卡住（例如正在進化而一直開不了打）就放棄
// 與 CLI 的 INSTALL_ROOT/state/pvp.json 是同一份（正式環境 STATE_DIR 就是那裡）；
// 用 STATE_DIR 是為了吃 AGUMON_STATE_DIR —— 測試不能讀寫使用者真正的名牌。
const PVP_FILE = path.join(STATE_DIR, 'pvp.json');
// 名牌沿用 `vpet code`（state/pvp.json 的 code）。沒設過就請 CLI 產一個 —— 規則只在 CLI 那份。
function plazaName() {
    const read = () => { try { return JSON.parse(fs.readFileSync(PVP_FILE, 'utf8')).code || null; } catch (e) { return null; } };
    let code = read();
    if (!code) { runCli(['code']); code = read(); }
    return code;
}
// 進場前的擋法：正在演進化／戰鬥／空降、或強制睡覺中，都不能離開前線。
// 跟「進化演出中不能切營地」是同一個理由 —— 那一刻是要看的。
function plazaBlocked() {
    const k = latest && latest.kind;
    if (k === 'evo')    return '進化表演中，等牠變完再去廣場。';
    if (k === 'battle') return '戰鬥中，打完再去廣場。';
    if (k === 'drop')   return '牠才剛落地，等一下再去廣場。';
    if (forceSleeping)  return '牠在睡覺（vpet wake 叫醒之後才能出門）。';
    return null;
}
async function plazaJoin() {
    if (plazaClient.active()) return { ok: true, action: 'plazaJoin' };
    const why = plazaBlocked();
    if (why) return { ok: false, error: why };
    const name = plazaName();
    if (!name) return { ok: false, error: '還沒有名牌，先在進階區設定「🏷 名牌」。' };
    const st = loadState(STATE_FILE);
    const char = st.characterId || 'agumon';
    let stage = 'Child', power = 0;
    try { stage = getCharacterStage(char) || stage; } catch (e) {}
    try { power = core.getCharacterPower(char) || 0; } catch (e) {}
    // 對戰用的戰力：跟前線、幽靈對戰同一套 = min(基礎 + 訓練值, 階級上限)
    let str = power + (st.trainingBonus || 0);
    try { str = Math.min(core.getBasePower(st, char) + (st.trainingBonus || 0), core.getTierCap(stage)); } catch (e) {}
    const r = await plazaClient.join({ name, color: readProfile().color, char, stage,
                                       card: { power, train: st.trainingBonus || 0, str } });
    if (!r.ok) return { ok: false, error: r.error };
    plazaNotice = null; plazaCaches.clear();
    return { ok: true, action: 'plazaJoin', output: '進入廣場（' + plazaClient.url() + '）' };
}
// 名牌與名牌顏色在廣場上隨時可改。來源只有一個：pvp.json 的 code / color
// （`vpet code` 與網頁「🏷 名牌」都寫這裡）。每 2 秒對一次，不一樣就請伺服器改 ——
// 這樣終端機打 `vpet code 新名字` 也會即時反映，不必每個入口各自通知廣場。
// 被拒的那組記下來，不要每 2 秒重送同一個失敗請求。
const readProfile = () => {
    try { const j = JSON.parse(fs.readFileSync(PVP_FILE, 'utf8')); return { code: j.code || null, color: j.color || null }; }
    catch (e) { return { code: null, color: null }; }
};
let plazaRenameRejected = null;
let plazaRenaming = false;
async function plazaSyncName() {
    if (!plazaClient.active() || plazaRenaming) return null;
    const { code, color } = readProfile();
    const me = plazaClient.me();
    const patch = {};
    if (code && code !== me.name) patch.name = code;
    if ((color || null) !== (me.color || null)) patch.color = color || null;
    const key = JSON.stringify(patch);
    if (!Object.keys(patch).length || key === plazaRenameRejected) return null;
    plazaRenaming = true;
    try {
        const r = await plazaClient.update(patch);
        if (!r.ok) { plazaRenameRejected = key; plazaNotice = { text: r.error, at: Date.now() }; }
        else plazaRenameRejected = null;
        return r;
    } finally { plazaRenaming = false; }
}
setInterval(() => { plazaSyncName().catch(() => {}); }, 2000).unref();
// 名牌顏色：直接寫 pvp.json（CLI 沒有這個指令；CLI 改名時是讀整份再寫回，不會把顏色洗掉）
async function plazaColor(color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color || '')) return { ok: false, error: '顏色不合法' };
    let p = {};
    try { p = JSON.parse(fs.readFileSync(PVP_FILE, 'utf8')); } catch (e) {}
    p.color = color.toLowerCase();
    try { fs.mkdirSync(path.dirname(PVP_FILE), { recursive: true }); fs.writeFileSync(PVP_FILE, JSON.stringify(p, null, 2)); }
    catch (e) { return { ok: false, error: '存不了名牌顏色：' + e.message }; }
    plazaRenameRejected = null;
    const r = await plazaSyncName();
    if (r && !r.ok) return { ok: false, error: r.error };
    return { ok: true, action: 'plazaColor', output: '名牌顏色改好了' };
}
// 網頁的改名：交給 CLI 存（格式檢查、大小寫正規化都在那裡），存完立刻同步到廣場。
// 先看場上有沒有人用了 —— 不然 CLI 已經把名牌改掉，伺服器才說撞名，兩邊就對不上了。
async function plazaRename(name) {
    if (!name) return { ok: false, error: '要填新名牌' };
    const taken = plazaClient.active()
        && plazaClient.roster().some(m => m.id !== plazaClient.me().id && m.name.toUpperCase() === name.toUpperCase());
    if (taken) return { ok: false, error: `廣場上已經有人叫「${name}」了` };
    const cli = runCli(['code', name]);
    if (!cli.ok) return Object.assign({ action: 'plazaRename' }, cli);
    plazaRenameRejected = null;
    const r = await plazaSyncName();
    if (r && !r.ok) return { ok: false, error: r.error };
    return { ok: true, action: 'plazaRename', output: '名牌改好了' };
}

// 在廣場裡不能做的事（規格 §六）。伺服器端也要擋：/cmd 是公開端點，只藏按鈕不夠。
const PLAZA_BLOCKED_CMDS = new Set(['yard', 'yardPet', 'yardGrab', 'yardDrop', 'pet', 'battle', 'evolve',
    'switch', 'reset', 'keep', 'swap', 'release', 'jogress', 'pvp', 'drop', 'sleep']);

// 天氣。daemon 唯一的對外連線（見 weather-source.js 開頭的規則）——
// get() 永遠立刻回傳快取，需要更新時在背景抓，/yard 這條路徑不等網路。
const weather = wxSrc.create({
    installRoot: core.INSTALL_ROOT,
    stateDir:    STATE_DIR,
    log:         (m) => console.log('   ' + m),
});
// 天氣預覽：?w=rain 之類的參數強制指定，讓五種表演不用等真的下雨才看得到。
// 只影響回傳的畫面，不寫進任何檔案，也不影響真實天氣的抓取。
function weatherFor(q) {
    // 日夜嚴格說不是天氣，但前端要靠它決定「晴天的光柱要不要畫」，而且它跟天氣
    // 一樣是**伺服器說了算**的場景狀態（之後長成廣場時，大家的天色必須一致，
    // 不能各自看自己的時鐘）。跟 weather 一起送，前端只要讀一份。
    const real = { ...weather.get(), night: WX.isNight() };
    // 開發專屬。跟其他 dev 功能同一條規矩：只把 UI 藏起來是不夠的，
    // /yard 是公開端點，伺服器端必須一起擋，否則 release 版照樣能用網址切天氣。
    if (!q || IS_RELEASE) return real;
    // 分隔符同時吃 + 與空白：查詢字串的 + 本來就會被解碼成空白，
    // 直接在網址列手打 ?w=clear+cold 的人不該踩到這個坑。
    //
    // 不規定順序、也不規定一定要指定天空：cold 是**獨立旗標**，跟任何天空都能組。
    // 現實中「陰・寒流」「雨・寒流」才是台灣冬天的常態，晴・寒流反而少見 ——
    // 預覽若只給幾個寫死的組合，等於把資料模型講錯了。
    //   ?w=cold       → 真實天空 + 強制寒流
    //   ?w=rain+cold  → 雨 + 寒流（順序隨意）
    //   ?w=night      → 強制入夜（day 則強制白天；不寫就跟著真實時鐘）
    //                   —— 沒有這個就得等到 18:00 才驗得了「夜裡不該有陽光」。
    const parts = String(q).trim().toLowerCase().split(/[+ ]+/).filter(Boolean);
    const sky   = parts.find(x => WX.SKY_ORDER.includes(x)) || null;
    const cold  = parts.includes('cold');
    const night = parts.includes('night') ? true
                : parts.includes('day')   ? false
                : real.night;
    if (!sky && !cold && night === real.night) return real;   // 看不懂的參數一律忽略
    return { ...real, sky: sky || real.sky, cold, night, preview: true };
}

let startedAt = Date.now();
let latest = { tick: 0, kind: 'init', petLines: null, usage: null, at: startedAt, err: null };

// 現在成立的合體組合，給前端決定按鈕露不露臉、確認文案要寫誰。
// 看的是 color-state.json —— 跟 CLI 同一份。隔離模式下 daemon 自己的 daemon-state.json
// 只是顯示用的分身，拿它算的話會出現「按鈕亮著，按下去 CLI 說不成立」。
// 凍結看 force（同 CLI）；拿在手上的那隻不列（只有 daemon 知道誰被拿著）。
// 回 null = 算不出來（舊的安裝版 core 沒有這組函式）→ 前端當成沒有候選。
const COLOR_STATE_FILE = path.join(STATE_DIR, 'color-state.json');
function jogressInfo(ranch, st) {
    try {
        if (typeof core.jogressCandidates !== 'function') return null;
        const real = AUTHORITATIVE ? st : loadState(COLOR_STATE_FILE);
        if (!real || !real.characterId) return null;
        let frozen = false;
        try { frozen = !!JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8')).freezeEvolve; } catch (e) {}
        const held = heldYardIds();
        const list = core.jogressCandidates(real, ranch, { frozen, heldIds: held || undefined });
        const name = (id) => { try { return core.getDisplayName(id); } catch (e) { return id; } };
        const pets = ranch.pets || [];
        return {
            front: real.characterId, frontName: name(real.characterId),
            options: list.map(c => ({
                id: c.petId, num: pets.findIndex(p => p.id === c.petId) + 1,
                camp: c.camp, campName: name(c.camp), to: c.to, toName: name(c.to),
            })),
        };
    } catch (e) { return null; }
}

function doTick() {
    const now = Date.now();
    try {
        const usage = cachedUsage;   // 讀快取，不在主迴圈掃 JSONL → tick 保持輕量、走路不跳幀
        const i  = buildInput(usage);
        const st = loadState(STATE_FILE);
        if (!st.characterId) st.characterId = 'agumon';
        const out = renderTick(i, st, now);
        forceSleeping = !!st._forceSleep;   // 給 petTouch 判斷「叫不動」
        // 自然 idle 睡：給 petTouch 判斷「這一下是叫醒，不是摸摸」。
        // 規則向 core 借（core.isIdleSleeping），兩邊各寫一份遲早會對不起來。
        // typeof 防呆：daemon 可能從 repo 樹跑、core 卻是舊的安裝版（見檔頭的 require）。
        idleSleeping  = !forceSleeping && typeof core.isIdleSleeping === 'function'
                        && core.isIdleSleeping(st, now);
        // 當家模式：render 成功才寫 heartbeat → statusLine 據此退唯讀。tick 若拋錯就不更新，
        // heartbeat 4 秒過期 → statusLine 自動接管（daemon 壞掉的 failsafe）。
        if (AUTHORITATIVE) { try { fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: now, pid: process.pid })); } catch (e) {} }
        // 營地人數也帶出去：「收進營地」這顆鈕在兩個分頁都有，但只有院子分頁會打 /yard。
        // 沒有這一份的話，家裡分頁沒辦法在按下去之前就知道滿了。
        let ranchInfo = null, jogress = null;
        try {
            const ranchNow = core.loadRanch();
            ranchInfo = { kept: (ranchNow.pets || []).length, cap: core.ranchCap() };
            jogress = jogressInfo(ranchNow, st);
        } catch (e) {}
        latest = {
            tick: ++tick,
            at: now,
            ranch: ranchInfo,
            jogress,
            kind: out.kind,
            cutIn: !!out.cutIn,                           // 正在演 cut-in 的拍 → 前端塗黑邊
            petLines: out.petLines,                       // ANSI 陣列（瀏覽器解析）
            usage: {
                activeSession: usage.activeSession,
                activeCostUSD: usage.activeSessionUsage ? usage.activeSessionUsage.costUSD : 0,
                totalCostUSD:  usage.totals.costUSD,
                // 各來源小計（Claude Code / Codex…）。totals 是合計 —— 桌寵的「花費」
                // 語意是「你在所有 AI 上燒了多少」，面板要能看出是誰貢獻的。
                bySource: Object.fromEntries(
                    Object.entries(usage.bySource || {}).map(([k, b]) => [k, b.costUSD])),
                burn10mTokens: usage.burn10m.tokens,
                burn10mCostUSD: usage.burn10m.costUSD,
                lastActivityAgoSec: usage.lastActivityAgoSec,
                uniqueMessages: usage.uniqueMessages,
                scannedFiles: usage.scannedFiles,
            },
            character: st.characterId,
            err: null,
        };
    } catch (e) {
        latest = Object.assign({}, latest, { tick: ++tick, at: now, err: e.message });
    }
}

// ⚠️ 第一拍一定要等模組整個載完才跑（setImmediate），不能在這裡同步呼叫。
//    renderTick 會碰到很多在檔案**後段**才 const 宣告的東西（BASE_COLS、yardTouch…），
//    同步呼叫就撞 TDZ。doTick 有 try/catch 所以不會當掉，只是當家模式的第一拍
//    **一律失敗** —— 而且失敗在 applyForceFlags 之後、存檔之前：營地已經寫了、state 沒寫。
//    啟動那一秒若剛好有 swap / 合體排著，被換進來的那隻就從營地消失了。
setImmediate(doTick);
setInterval(doTick, STEP_MS);   // ← 獨立時鐘：跟 Claude Code 有沒有呼叫指令無關

// 跨行程收屍：平常是每個新啟動的 statusline 在做，但 daemon-only 安裝根本沒部署
// statusline-agumon-color.js → hook 若被凍結成孤兒就沒人清。daemon 是常駐的，補上這一輪。
// 只收屍、不登記自己（長駐行程一登記就會被當成「活著又逾時」的卡死孤兒殺掉）。
// 兩者都在跑時重複收屍無害：判定準則相同，且只殺「確認卡死」的。
const REAP_INTERVAL_MS = 30000;
const PIDS_DIR = path.join(STATE_DIR, 'pids');
setInterval(() => { try { core.reapStalePids(PIDS_DIR); } catch (e) {} }, REAP_INTERVAL_MS);

// ── 補一輪「看作業系統行程表」的收屍 ──────────────────────────────────────
// 上面那輪只看 state/pids/ 這份登記表，而**有一整類孤兒不在登記表裡**：
//
//   statusline 的 watchdog 8 秒後呼叫 process.exit(0)，'exit' handler 會刪掉自己的
//   pid 檔（deregister）—— 但如果它在那之後卡在收尾出不去（多半是往已經斷掉的 stdout
//   flush），行程就活著、登記卻已經撤銷。實測這種孤兒的樣貌是 **1 個執行緒、0 CPU、
//   working set 0**：worker 執行緒都拆光了，只剩主執行緒卡住。
//   一台開機 126 小時的機器上累積了 20 個，約每天 4 個。
//
// 換句話說：登記是由「快死的行程自己」撤銷的，一旦死到一半卡住就從名單上消失。
// 唯一看得到它們的是作業系統行程表 —— 那正是 doctor 在做的事，所以直接叫 doctor，
// 不重寫一份掃描邏輯（判定條件分兩份寫遲早會分叉）。
//
// ⚠️ 一定要 spawn 成獨立行程：doctor 的掃描是同步的 PowerShell CIM 查詢，實測 2.4 秒。
//    在 daemon 主迴圈跑會卡掉兩三拍 → 走路跳幀，那正是當初把 token 掃描搬去 worker 的原因。
const ORPHAN_SWEEP_MS = 10 * 60 * 1000;   // 每天才長 4 個，10 分鐘一輪綽綽有餘（≈0.4% 一顆核心）
function sweepOrphans() {
    const doctor = path.join(core.INSTALL_ROOT, 'doctor.js');
    if (!fs.existsSync(doctor)) return;    // 沒安裝 doctor（例如直接跑 repo）就跳過
    try {
        // ⚠️ Windows 上 detached:true 會**開一個新的 console 視窗** —— 使用者看到的就是
        //    「每隔一陣子跳出小黑窗、不到一秒就關掉」。這裡本來就不需要 detached：
        //    unref() 已經足夠讓它不擋住 daemon 退出，而 Windows 殺父本來就不會連帶殺子
        //    （這個 repo 別處也是這個前提）。windowsHide 再保一層，doctor 內部還會叫
        //    powershell。同樣的旗標 runCli 早就在用了。
        const child = require('child_process')
            .spawn(process.execPath, [doctor], { stdio: 'ignore', windowsHide: true });
        child.unref();                     // 別讓它擋住 daemon 退出
        child.on('error', () => {});
    } catch (e) { /* 收屍失敗不該影響任何其他功能 */ }
}
setInterval(sweepOrphans, ORPHAN_SWEEP_MS).unref();
// 啟動時先掃一輪：daemon 剛起來時往往正是「上一輪累積了一堆」的時候。
// 但**延後**再做 —— 這行在 server.listen 之前，直接呼叫等於把一次 CreateProcess
// 塞進啟動路徑。實測讓 test-daemon-page 的固定 2 秒等待偶爾不夠而連不上；
// 收屍是家務事，沒有任何理由排在「開始服務」前面。
setTimeout(sweepOrphans, 3000).unref();

// ── UI 指令 → force-char.json（跟 vpet CLI 同一個指令通道）───────────────────
// 當家時 daemon 自己讀套用；隔離時 statusLine 讀 → UI 等於「圖形版 vpet 指令」，兩模式皆可用。
// merge 寫入（保留其他欄位），與 statusline-cheat 寫法一致。
// force.json 是**累積**的：這裡是 merge 進既有內容，不是覆寫。
// 所以「這次沒指定某個參數」必須寫成明確的刪除（patch 裡給 null），不能只是不寫 ——
// 不寫等於沿用上一次的值。踩過：指定過一次敵人之後，「留空＝隨機」的戰鬥
// 全部照著上次那隻打（見 COMMANDS.battle）。
function writeForce(patch) {
    let f = {};
    try { f = JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8')); } catch (e) {}
    for (const k of Object.keys(patch)) {
        if (patch[k] === null) delete f[k]; else f[k] = patch[k];
    }
    try {
        fs.mkdirSync(path.dirname(FORCE_FILE), { recursive: true });
        fs.writeFileSync(FORCE_FILE, JSON.stringify(f));
        return true;
    } catch (e) { return false; }
}
// ── 觸碰互動：正常摸摸 → happy；短時間連戳 → refuse 鬧脾氣 ─────────────────────
// 計數必須在這層（HTTP 收到點擊的當下）做：daemon 每秒才 tick 一次，1 秒內連點好幾下
// 只會被 tick 看到最後一筆 → 放到 tick 層永遠偵測不到連點。
const TOUCH_WINDOW_MS = 3000;   // 判定窗口
const TOUCH_LIMIT     = 5;      // 窗口內達此次數 → 生氣
const SULK_MS         = 3000;   // 生氣後鬧脾氣：這段期間再戳也不理

// ── 營地的摸摸 ─────────────────────────────────────────────────────
// 純表演：只換一幀表情、開心時原地跳，**不動心情值、不寫 ranch.json**。
// 營地是冰箱，裡面的東西不會因為你戳牠而成長或變壞 —— 這是使用者明確要的分界。
//
// 狀態機本體在 ./yard-touch.js。抽出去唯一的理由是可測試：daemon.js 一 require
// 就 server.listen，測試載不進來，而停走的拍數要累加、結清、還要跨反應保管，
// 那種帳不該只靠肉眼在瀏覽器上驗。
//
// 連戳判定跟現役那隻共用同一組門檻（TOUCH_WINDOW_MS / TOUCH_LIMIT / SULK_MS），
// 但計數是**每隻各自獨立**的：戳 A 五下不該讓 B 也生氣。
const yardTouch = YT.create({
    windowMs: TOUCH_WINDOW_MS, limit: TOUCH_LIMIT, sulkMs: SULK_MS, stepAt: PW.stepAt,
});
const yardPetTouch = (id) => ({ ok: true, action: 'yardPet', mood: yardTouch.pet(id) });
const yardReactMap = (alive) => yardTouch.react(alive);
let touchTimes = [];
let sulkUntil  = 0;
let forceSleeping = false;   // 由每拍的 doTick 更新（vpet sleep 狀態）
let idleSleeping  = false;   // 同上：自然 idle 睡（超過 IDLE_MS 沒活動）
function petTouch() {
    const now = Date.now();
    // vpet sleep 強制睡：叫不動。回明確訊息，避免使用者以為點擊壞了；也不累計連戳。
    if (forceSleeping) return { ok: true, action: 'pet', mood: 'asleep' };
    // 自然 idle 睡：這一下是叫醒，不是摸摸 —— core 那邊已經擋掉表情與心情，
    // 前端也不該回「摸摸 ♥」。連戳計數同樣不累計：叫醒不該讓牠之後比較容易生氣。
    // petMood 照送 happy：core 會自己重算在不在睡，萬一那一拍牠已經醒了就走原本的摸摸。
    if (idleSleeping) {
        writeForce({ petTriggerTs: now, petMood: 'happy' });
        return { ok: true, action: 'pet', mood: 'wake' };
    }
    if (now < sulkUntil) return { ok: true, action: 'pet', mood: 'sulking' };   // 鬧脾氣中，不回應
    touchTimes = touchTimes.filter(t => now - t < TOUCH_WINDOW_MS);
    touchTimes.push(now);
    let mood = 'happy';
    if (touchTimes.length >= TOUCH_LIMIT) {
        mood = 'refuse';
        sulkUntil  = now + SULK_MS;
        touchTimes = [];
    }
    writeForce({ petTriggerTs: now, petMood: mood });
    return { ok: true, action: 'pet', mood };
}

// 快路徑：純粹寫一個 force 旗標就成立的指令。回 null = 這次帶了參數，快路徑處理不了，
// 讓 applyCommand 往下落到 CLI_ACTIONS（那邊才會把參數帶進 vpet CLI）。
const COMMANDS = {
    // 指定敵人／勝負一定要走 CLI —— 這裡只寫 battleTriggerTs，敵人欄位是 CLI 在填的
    // （forceBattleEnemy / forceBattleWin）。踩過：網頁的「指定戰鬥」填了敵人照樣
    // 隨機開打，因為 COMMANDS 排在 CLI_ACTIONS 前面，參數整包被吃掉，而且回 ok:true。
    // ⚠️ 留空 ≠ 什麼都不用寫。force.json 是累積的，上一次指定過的敵人／勝負還躺在裡面，
    //    只寫 battleTriggerTs 的話下一場「隨機」會照著上次那隻打 —— 回報過。
    //    CLI 那條路徑（statusline-cheat.js 的 --battle）本來就會把這五個欄位刪乾淨，
    //    快路徑漏了同一套清理就是分叉。這裡要跟它一字不差。
    battle:    (a) => (a.enemy || a.result) ? null : ({
        battleTriggerTs: Date.now(),
        forceBattleEnemy: null, forceBattleWin: null,
        pvpOppLabel: null, pvpMeLabel: null,   // 手動戰鬥非 PvP，清掉腳下名牌
        battleNoCount: null,                   // 手動戰鬥照常計入勝率
    }),
    card:      () => ({ cardTriggerTs:   Date.now() }),
    tree:      () => ({ treeTriggerTs:   Date.now() }),
    drop:      () => ({ dropTriggerTs:   Date.now() }),   // 空降演出（非真 reset 抽角色）
    sleep:     () => ({ forceSleep: true }),
    wake:      () => ({ forceSleep: false }),
    freeze:    () => ({ freezeEvolve: true }),
    unfreeze:  () => ({ freezeEvolve: false }),
    battleOff: () => ({ autoBattleOff: true }),
    battleOn:  () => ({ autoBattleOff: false }),
};
// ── 需要參數／需要輸出／不只是寫 force 的指令 → 轉呼叫 vpet CLI 子行程 ────────────
// 為什麼不在 daemon 重寫一份：reset 的加權抽選、pvp 的連線、doctor 的行程掃描，
// 邏輯都在 statusline-cheat.js（567 行的 top-level if-chain，不是函式庫）。抄一份過來
// 就會變成兩套實作，改一邊忘一邊 → 「終端機打 vpet reset 和網頁按重抽，抽到的不一樣」。
// 這個 repo 已經吃過複製品分叉的虧（進化 commit 兩份，害相位重對齊漏了一邊）。
// 代價是每次多開一個 node 行程（實測約 140ms）—— 這些都是低頻操作，按鈕感覺不出來。
//
// 安全性：/cmd 是 localhost 公開端點。用陣列形式 spawn（不經 shell）→ 參數不會被當指令解析；
// action 一律走白名單，只有下面 CLI_ACTIONS 列出的能執行。
const CHEAT_CLI = path.join(core.INSTALL_ROOT, 'statusline-cheat.js');
const CLI_TIMEOUT_MS = 15000;   // doctor 掃行程可能久一點；卡住就中止，不要吊死 HTTP

// action → 組出 CLI 參數。回 null = 參數不合法。
const CLI_ACTIONS = {
    reset:       ()  => ['reset'],
    album:       ()  => ['album'],
    bg:          ()  => ['bg'],        // 舞台底圖編輯器（另開頁面，寫的是使用者自己的 bg.png）
    doctor:      ()  => ['doctor', '--check'],   // 只診斷不清，避免網頁一按就殺行程
    stats:       ()  => ['stats'],
    pvp:         (a) => a.name ? ['pvp', a.name] : ['pvp'],
    code:        (a) => a.name ? ['code', a.name] : ['code'],
    'pvp-setup': (a) => (a.url && a.key) ? ['pvp-setup', a.url, a.key, ...(a.name ? [a.name] : [])] : null,
    switch:      (a) => a.name ? [a.name] : null,          // 裸角色名/編號
    evolve:      (a) => a.name ? ['evolve', a.name] : null,
    // result 只收 win / lose：亂填的字串會被 CLI 的參數迴圈當成敵人名（或直接忽略），
    // 兩種都是「按了沒事發生」，不如當場擋掉講清楚。
    battle:      (a) => {
        const res = (a.result || '').toLowerCase();
        if (res && res !== 'win' && res !== 'lose') return null;
        return ['battle', ...(a.enemy ? [a.enemy] : []), ...(res ? [res] : [])];
    },
    // 營地（docs/ranch-spec.md）。release 一律補 yes —— CLI 的二次確認是為終端機使用者
    // 設計的，網頁這邊由 data-confirm 的對話框負責，不能讓 subprocess 吊在等輸入。
    ranch:       ()  => ['ranch'],
    keep:        ()  => ['keep'],
    swap:        (a) => a.which ? ['swap', a.which] : null,
    release:     (a) => a.which ? ['release', a.which, 'yes'] : null,
    // 合體進化：which 是營地 id（營地可能有兩隻同角色，名稱不唯一）。補 yes 的理由同上。
    jogress:     (a) => a.which ? ['jogress', a.which, 'yes'] : null,
};

// ── 走動範圍編輯器（dev）─────────────────────────────────────────────
// 不走 CHEAT_CLI：那條路是給部署樹的頁面（圖鑑／底圖）用的，而編輯器住在
// src/editor/，install 不部署它 —— 跟 daemon 自己一樣是從 repo 樹跑的，
// 所以直接從隔壁目錄起就好，路徑也不會有第二種可能。
const ZONE_EDITOR_PORT = 3005;
const ZONE_EDITOR_JS   = path.join(__dirname, '..', 'editor', 'zone_editor_server.js');
let zoneEditorProc = null;
function openZoneEditor() {
    if (!fs.existsSync(ZONE_EDITOR_JS)) {
        return { ok: false, error: '找不到 src/editor/zone_editor_server.js（release 樹沒有編輯器）' };
    }
    const url = 'http://localhost:' + ZONE_EDITOR_PORT;
    // 已經起過而且還活著就不要再起一個 —— 第二個會 EADDRINUSE 然後靜靜地死掉。
    // 若是使用者自己用 zone-editor.bat 起的（我們沒有 handle），這裡會多 spawn 一次，
    // 那一次同樣會 EADDRINUSE 收場，第一個照常服務，網址仍然開得起來。
    if (zoneEditorProc && zoneEditorProc.exitCode === null && !zoneEditorProc.killed) {
        return { ok: true, action: 'zoneedit', url, output: '編輯器已在執行 → ' + url };
    }
    try {
        zoneEditorProc = spawn(process.execPath, [ZONE_EDITOR_JS],
                               { detached: true, stdio: 'ignore', windowsHide: true });
        zoneEditorProc.unref();
    } catch (e) {
        return { ok: false, error: '啟動編輯器失敗：' + e.message };
    }
    return { ok: true, action: 'zoneedit', url, output: '編輯器已啟動 → ' + url };
}

function runCli(args) {
    const r = spawnSync(process.execPath, [CHEAT_CLI, ...args],
                        { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, windowsHide: true });
    if (r.error) return { ok: false, error: `執行失敗：${r.error.message}` };
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    // CLI 用 exit code 1 表示「找不到角色 / 此版本未提供」之類的拒絕，輸出仍要帶回去給使用者看
    return { ok: r.status === 0, output: out || '(無輸出)' };
}

function applyCommand(action, args = {}) {
    if (IS_RELEASE && DEV_ONLY.has(action)) return { ok: false, error: '此版本未提供此指令' };
    // 廣場：進場要連網路，所以回 Promise（/cmd 那邊會 await）
    if (action === 'plazaJoin')  return plazaJoin();
    if (action === 'plazaLeave') return plazaClient.leave().then(() => ({ ok: true, action, output: '回到前線' }));
    if (action === 'plazaRename') return plazaRename(args.name);
    if (action === 'plazaColor')  return plazaColor(args.color);
    // 自動／手動與 WASD。/cmd 只收字串，方向在這裡轉回 -1/0/1。
    if (action === 'plazaMode') {
        if (args.mode !== 'auto' && args.mode !== 'manual') return { ok: false, error: '模式只有 auto / manual' };
        return plazaClient.move({ mode: args.mode }).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'plazaInvite') {
        if (!args.to) return { ok: false, error: '要指定邀請誰' };
        return plazaClient.invite(args.to).then(r => (r.ok ? { ok: true, action, output: '已送出對戰邀請' } : r));
    }
    if (action === 'plazaAnswer') {
        if (!args.inviteId) return { ok: false, error: '沒有邀請' };
        return plazaClient.answer(args.inviteId, args.accept === '1').then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'plazaChat') {
        if (!args.text) return { ok: false, error: '沒有內容' };
        return plazaClient.say(args.text).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'plazaMove') {
        const vx = Number(args.vx), vy = Number(args.vy);
        return plazaClient.move({ vx, vy }).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (plazaClient.active() && PLAZA_BLOCKED_CMDS.has(action)) {
        return { ok: false, error: '在廣場中，先離開廣場。' };
    }
    if (action === 'pet') return petTouch();   // 觸碰要即時計數，走專用路徑
    // 營地的摸摸：純表演，不動心情也不寫任何檔。args.which = ranch entry 的內部 id。
    if (action === 'yardPet') {
        if (!args.which) return { ok: false, error: '要指定是哪一隻' };
        return yardPetTouch(args.which);
    }

    // 長壓把 vpet 拿起來。拿在手上的那隻**改由前端畫**（跟著游標，60fps 疊加層），
    // 所以這裡要把牠的點陣交出去 —— 只在抓起的這一次傳，約 2 KB。
    // 若走輪詢讓伺服器每幀重畫，就得把 /yard 拉到 60fps（15 KB x 60），完全不划算。
    if (action === 'yardGrab') {
        if (!args.which) return { ok: false, error: '要指定是哪一隻' };
        const ranch = core.loadRanch();
        const r = yardReactMap().get(args.which);
        const sp = plaza.yardSpriteFor(core, ranch, args.which, plazaStep(), {
            joinStep: (r && r.anchor ? r.anchor.step : plaza.yardJoinStep())
                    + (r ? r.holdSteps || 0 : 0),
            origin: r && r.anchor ? r.anchor.origin : null,
        });
        if (!sp) return { ok: false, error: '這隻不在營地裡' };
        if (!yardTouch.grab(args.which)) return { ok: false, error: '已經拿在手上了' };
        // 兩張待機幀交給前端輪替 —— 拿在手上也要繼續呼吸，不是定格
        // 前端在細格裡拖（營地畫小一號）—— 起點換成畫出來的位置
        const at = plaza.yardToDraw(sp.x, sp.y);
        return { ok: true, action: 'yardGrab', frames: sp.frames, x: at.x, y: at.y, facing: sp.facing };
    }

    // 放開。落點成為新的起點，那隻從那裡開始走一條全新的鏈（見 plaza-walk 的 origin）。
    if (action === 'yardDrop') {
        if (!args.which) return { ok: false, error: '要指定是哪一隻' };
        const F = plaza.YARD_FIELD;
        // ⚠️ /cmd 的白名單**只收字串**（刻意的：那些值會被送進 CLI 的 argv）。
        //    座標所以是以字串傳過來的，這裡才轉數字。第一版直接讀 args.x 拿到 undefined，
        //    落點永遠變成 (0,0) —— 而且 grab/drop 都回 ok:true，完全看不出哪裡錯。
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : NaN; };
        const x = num(args.x), y = num(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '落點座標不合法' };
        // 前端送來的是畫出來的位置（細格），走路在粗格上算 —— 換回來再夾
        const back = plaza.yardFromDraw(x, y);
        const cx = PW.clamp(back.x, F.minX, F.maxX);
        const cy = PW.clamp(back.y, F.minY, F.maxY);
        if (!yardTouch.drop(args.which, cx, cy, args.facing)) {
            return { ok: false, error: '這隻沒有被拿著' };
        }
        // 回**畫出來**的位置（細格）：前端手上那份要先對齊到這一格，再交棒給伺服器的畫面，
        // 不然交接那一刻會看到牠往旁邊挪一格（細格不是每一格都對得到走路的格子）。
        const at = plaza.yardToDraw(cx, cy);
        return { ok: true, action: 'yardDrop', x: at.x, y: at.y };
    }

    // 快路徑：純粹寫一個旗標的指令直接寫 force，省掉 140ms 的行程開銷。
    // 這些在 CLI 那邊也只是寫同樣的欄位，沒有額外邏輯，不會分叉。
    if (action === 'zoneedit') return openZoneEditor();

    const fn = COMMANDS[action];
    if (fn) {
        const force = fn(args || {});
        if (force) return { ok: writeForce(force), action };   // null → 往下走 CLI
    }

    const build = CLI_ACTIONS[action];
    if (!build) return { ok: false, error: 'unknown action: ' + action };
    const argv = build(args || {});
    if (!argv) return { ok: false, error: '參數不足或不合法' };
    return Object.assign({ action }, runCli(argv));
}

// ── HTTP 顯示層 ──
// 畫布格點：每個終端字元 = 1px 寬 × 2px 高（▀ 把字元切成上/下兩個像素）。
// 要像素方正 → CH = 2×CW，否則每個半格 8×4 會把角色壓扁。CW=8 → 半格 8×8 方正。
// BASE_COLS/BASE_ROWS = 一般表演的尺寸，用來當舞台底盤的下限（見 #stage 的說明）：
//   走路 52×8、卡片 52×8、戰鬥 52×8（BATTLE_SCENE_WIDTH/HEIGHT）都是這個大小，
//   進化表演只有 16×8（比較小 → 置中），進化樹 35~92×9（比較大 → 撐寬底盤）。
// 這些值同時給 CSS 與前端 JS 用，只有這一份，不要在下面的 <script> 裡另外寫死。
const CW = 8, CH = 16;
const BASE_COLS = 52, BASE_ROWS = 8;
const PAD_DOTS  = 1;    // 舞台上下各留幾個 dot（1 dot = 半格 = CH/2 px）

// 舞台底圖（選配）。放了就當灰白面板用，沒放就維持原本的深灰純色。
const BG_FILE   = path.join(core.INSTALL_ROOT, 'bg.png');
const HAS_BG    = fs.existsSync(BG_FILE);

// 整份前端都塞在這個 template literal 裡，所以裡面的反斜線會被吃掉一層 ——
// 連註解也一樣。要在前端字串裡放換行，用 String.fromCharCode(10)，不要寫跳脫字元，
// 否則組出來的是「字串字面值中間有真的換行」，瀏覽器整個 script 直接 SyntaxError
// （伺服器端完全正常，node --check 也過，只有頁面死掉）。
// scripts/test-daemon-page.js 會把頁面拉下來做語法檢查，釘住這類壞法。
// ── 寒風用的點陣 ─────────────────────────────────────────────────────
// 直接借天狐獸的子彈美術（使用者指名的參考）。它本來就是一團青色的風 ——
// 中心亮、外圍青、周圍散幾點閃光，那幾點閃光是這個造型好看的關鍵，自己畫很難拿捏。
//
// 借現成的還有一個好處：它是**點陣**。先前用向量畫的螺旋是畫面上唯一不是像素風的
// 東西，就算形狀對了也還是格格不入。
//
// 抽成 [dx,dy,r,g,b] 的扁平清單再內嵌進頁面：只有數字，不含反斜線，
// 塞進 template literal 是安全的（見 HTML 常數上方的警告）。
function loadWindArt() {
    try {
        const f = path.join(core.ASSETS_DIR, 'tenkomon', 'bullet-art.json');
        const rows = JSON.parse(fs.readFileSync(f, 'utf8')).frames[0];
        const out = [];
        rows.forEach((row, r) => (row || []).forEach((c, x) => {
            if (!c) return;
            if (c[0] >= 0) out.push([x, r * 2,     c[0], c[1], c[2]]);
            if (c[3] >= 0) out.push([x, r * 2 + 1, c[3], c[4], c[5]]);
        }));
        if (!out.length) throw new Error('空的');
        return packWind(out);
    } catch (e) {
        // 美術不在（換過角色表、精簡過 release）也不能讓營地開不起來 ——
        // 退回一小團青色方塊，形狀差一點但不會是空白。
        const P = [[1,0],[2,0],[0,1],[1,1],[2,1],[3,1],[1,2],[2,2],[5,0],[6,3]];
        return packWind(P.map(([x, y]) => [x, y, 117, 232, 240]));
    }
}

/**
 * [x,y,r,g,b] → 依顏色分組的 [{c:'rgb(...)', p:[x,y,x,y,...]}]。
 * 分組是為了前端每幀只設三次 fillStyle 而不是 49 次；順便把左上角推到 (0,0)，
 * 前端就不用管原圖的留白。
 */
function packWind(dots) {
    const mx = Math.min(...dots.map(d => d[0])), my = Math.min(...dots.map(d => d[1]));
    const by = new Map();
    for (const [x, y, r, g, b] of dots) {
        const key = r + ',' + g + ',' + b;
        if (!by.has(key)) by.set(key, []);
        by.get(key).push(x - mx, y - my);
    }
    const w = Math.max(...dots.map(d => d[0])) - mx + 1;
    return { w, groups: [...by.entries()].map(([c, p]) => ({ c: 'rgb(' + c + ')', p })) };
}
const WIND_ART = loadWindArt();

const HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>Vpet daemon</title>
<style>
  body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,Consolas,monospace;margin:0;padding:20px}
  h1{font-size:15px;color:#58a6ff;margin:0 0 12px}
  #wrap{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}
  /* 深灰而非純黑：角色有黑色描邊，純黑背景會讓輪廓糊掉分不出來 */
  #petbox{background:rgb(30,30,30);border:1px solid #444c56;border-radius:8px;padding:12px;image-rendering:pixelated;max-width:100%;overflow:hidden}
  /* 舞台底線：canvas 每幀依內容大小重建，直接放進 petbox 會讓深灰底盤忽大忽小
     （最明顯的是進化表演只有 16 字元寬，底盤瞬間縮到三分之一）。
     用 min-width/min-height 釘住一般表演的尺寸（52×8 = 走路／卡片／戰鬥），
     canvas 維持原生大小置中；只有進化樹（35~92×9）需要時才把底盤撐寬。
     不用固定 width：那會讓一般表演永遠佔著五格進化樹的寬度，版面太空。 */
  /* width:fit-content 是關鍵 —— #stage 是 block，預設會撐滿 #petbox 的內容寬，
     而 #petbox 是 #wrap（flex + wrap）的項目，可用寬度隨視窗變動 → 舞台跟著變寬變窄，
     底圖是 center/cover，寬度一動就重新裁切，看起來就是「拉視窗背景會微微變」。
     改成 fit-content 後舞台只跟內容走：一般表演固定 min-width，只有進化樹才撐寬。
     也刻意不留 max-width:100% —— 那會在窄視窗把 canvas 縮小，地平線又會對不上
     （就是先前睡覺角色浮起來那個 bug）。窄到放不下就由 #petbox 的 overflow:hidden 裁掉。 */
  #stage{width:fit-content;min-width:${BASE_COLS * CW}px;min-height:${BASE_ROWS * CH}px;
         /* 上下各留 ${PAD_DOTS} dot（1 dot = 半格 = ${CH / 2}px）。用 padding 而不是墊高 min-height，
            這樣進化樹那種比較高的場景也一樣有留白，不會頂到邊。底圖會鋪滿含 padding 的範圍。 */
         padding:${PAD_DOTS * (CH / 2)}px 0;
         position:relative;
         display:flex;align-items:center;justify-content:center;
         border-radius:4px;overflow:hidden;${HAS_BG ? `
         /* 灰白面板（比照原版）：底圖已在 make-bg.js 壓好亮度帶，這裡不再加濾鏡。
            要現場微調就在 devtools 加 filter，定案後回去改 make-bg.js 的 lo/hi 重烘。 */
         background:#d2d2d2 url(/bg) center/cover;` : ''}}
  canvas{image-rendering:pixelated;display:block;cursor:pointer;max-width:100%;height:auto}
  /* 院子是 96 欄（768px），比家裡的 52 欄寬。canvas 的 max-width:100% 在窄視窗會把它
     縮小，而縮小後 1 dot 不再是整數個 px，像素風會糊掉 —— 家裡那邊為了地平線對齊
     已經踩過一次。院子寧可讓 petbox 裁掉右邊，也不要非整數倍縮放。 */
  body.yard canvas{max-width:none}
  body.yard #petbox{overflow:auto}
  /* 院子不鋪底圖：那張圖是為家裡 52x8 的橫幅舞台烘的（center/cover），
     放到 96x24 會被裁成完全不同的一塊，看起來像另一張圖。等院子有自己的美術再說。 */
  body.yard #stage{background:rgb(24,24,24)}
  /* 廣場：96x24 欄（768px），同院子的理由：寧可捲動也不要非整數倍縮放 */
  body.plaza canvas{max-width:none}
  body.plaza #petbox{overflow:auto}
  body.plaza #stage{background:rgb(24,24,24)}
  body.plaza #adv{display:none}
  /* 天氣層：疊在角色畫布正上方，只有營地會出現。
     刻意不用 image-rendering:pixelated —— 雨絲、光線是向量畫的，柵格化反而變鋸齒。
     pointer-events:none 是必要的，否則它會吃掉右鍵選單的命中判定。 */
  #wx{position:absolute;display:none;pointer-events:none;z-index:2}
  body.yard #wx,body.plaza #wx{display:block}
  /* 右上角的日期／時間／天氣。用 HTML 疊層而不是畫點陣字：52 dot 寬塞一整行日期
     會佔掉整列又糊掉，而這裡本來就不是像素風的一部分，是「看板」。 */
  #hud{position:absolute;display:none;top:6px;right:8px;z-index:3;text-align:right;
       pointer-events:none;font-size:11px;line-height:1.4;color:#e6edf3;
       text-shadow:0 1px 3px #000, 0 0 6px #000, 0 0 2px #000}
  body.yard #hud,body.plaza #hud{display:block}
  #hud .wx{font-size:13px;font-weight:600;letter-spacing:.5px}
  #hud .prev{color:#d29922;font-size:10px}
  /* 左上角曾經放過一顆日／月，拿掉了：右上的看板已經有時鐘，晴夜的圖示也是月亮，
     早晚本來就看得出來 —— 多一顆只是把同一件事講第二次。 */
  #wxsel{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;
         font:inherit;font-size:11px;padding:1px 4px;margin-left:6px}
  /* 黑邊：只蓋上下那 ${PAD_DOTS} dot 的留白，不動中間 —— 這樣戰鬥的非 cut-in 拍
     仍然看得到底圖，只有邊緣被收乾淨。用偽元素而不是換整片 background，
     否則整個舞台會變黑、底圖在戰鬥期間整段消失。 */
  #stage.letterbox::before,#stage.letterbox::after{
    content:'';position:absolute;left:0;right:0;height:${PAD_DOTS * (CH / 2)}px;background:#000;z-index:1}
  #stage.letterbox::before{top:0} #stage.letterbox::after{bottom:0}
  .panel{font-size:13px;line-height:1.7}
  .k{color:#8b949e} .v{color:#e6edf3;font-weight:600}
  .big{font-size:22px;color:#3fb950}
  .warn{color:#d29922}
  pre{margin:6px 0 0;color:#8b949e;font-size:12px;white-space:pre}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;background:#1f6feb;color:#fff;font-size:12px}
  /* 按鈕列暫時隱藏（試乾淨版面）。要拿回來：把 display:none 改成 flex。
     隱藏不影響功能——按鈕仍在 DOM、事件照綁，點角色摸摸也照常運作。 */
  #controls{display:flex;margin-top:10px;gap:6px;flex-wrap:wrap;max-width:480px}
  #controls button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
  #controls button:hover{background:#30363d;border-color:#8b949e}
  /* 醒目鈕（合體進化）：少見、而且做了就回不去，要讓人一眼看到「現在可以了」 */
  #controls button.accent{background:#3b1f6b;border-color:#a371f7;color:#e9dcff;font-weight:600}
  #controls button.accent:hover{background:#4c2889;border-color:#c8a6ff}
  #jgsel{background:#161b22;color:#c9d1d9;border:1px solid #a371f7;border-radius:6px;
         font:inherit;font-size:12px;padding:3px 4px}
  /* 提示字 3 秒後淡出；min-height 保留讓版面不會跳動 */
  #cmdmsg{margin-top:6px;min-height:16px;color:#3fb950;font-size:12px;opacity:0;transition:opacity .5s}
  /* 進階區：要填參數的指令。預設收起，避免主畫面被塞爆 */
  #adv{margin-top:8px;max-width:480px}
  #adv summary{cursor:pointer;color:#8b949e;font-size:12px;user-select:none}
  #adv summary:hover{color:#c9d1d9}
  .form{display:flex;gap:4px;align-items:center;margin-top:6px;flex-wrap:wrap}
  .form .lbl{font-size:12px;color:#8b949e;min-width:74px}
  .form input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;
              padding:3px 7px;font:inherit;font-size:12px;width:120px}
  .form input:focus{outline:none;border-color:#58a6ff}
  .form button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;
               padding:3px 9px;font:inherit;font-size:12px;cursor:pointer}
  .form button:hover{background:#30363d;border-color:#8b949e}
  .devtag{color:#d29922;font-size:11px}
  /* 指令輸出：子行程的 stdout 原樣顯示（doctor / stats / code 這種有回應的） */
  #cmdout{margin-top:8px;max-width:480px;display:none;background:#0d1117;border:1px solid #30363d;
          border-radius:6px;padding:8px 10px;font-size:12px;color:#c9d1d9;
          white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto}
  /* 右鍵選單。position:fixed + 依點擊座標定位，不塞進舞台裡 ——
     舞台有 overflow:hidden，選單擺進去會被裁掉。 */
  /* 廣場下方那一列（自動／手動、改名）：跟上面的按鈕同一個樣式，不要瀏覽器預設的白鈕 */
  #plazabar button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;
                   padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
  #plazabar button:hover{background:#30363d;border-color:#8b949e}
  #plazabar input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;
                  padding:3px 7px;font:inherit;font-size:12px;width:120px}
  /* 聊天室：寬度對齊廣場畫布，舊訊息往上捲 */
  #chatlog{margin-top:6px;max-width:414px;height:130px;overflow-y:auto;background:#0d1117;
           border:1px solid #30363d;border-radius:6px;padding:5px 8px;font-size:12px;line-height:1.55;
           color:#c9d1d9;word-break:break-all;scrollbar-color:#30363d #0d1117}
  #chatlog .sys{color:#8b949e;font-style:italic}
  #chatlog .who{font-weight:600}
  #chatin{width:300px !important}
  #plazabar input[type=color]{width:34px;height:24px;padding:1px;vertical-align:middle;cursor:pointer}
  /* 廣場對戰：疊在廣場上的一層（壓暗 + 中間是前線的戰鬥畫面），不換畫面 */
  #battlebox{position:absolute;inset:0;z-index:4;display:none;align-items:center;justify-content:center;
             background:rgba(0,0,0,.6);transition:opacity .4s}
  #battlebox canvas{image-rendering:pixelated;max-width:none;border:1px solid #444c56;border-radius:4px;
                    background:rgb(30,30,30)}
  #plazainvite{display:none;margin-top:6px;padding:6px 8px;border:1px solid #a371f7;border-radius:6px;
               background:#1b1530;font-size:12px;color:#e9dcff;max-width:398px}
  #plazainvite button{margin-left:6px}
  #ctx{position:fixed;z-index:50;display:none;min-width:150px;background:#161b22;
       border:1px solid #30363d;border-radius:6px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.5)}
  #ctx .hd{padding:4px 8px;font-size:12px;color:#c9d1d9;border-bottom:1px solid #30363d;margin-bottom:4px}
  #ctx .hd .k2{color:#8b949e;font-size:11px}
  #ctx button{display:block;width:100%;text-align:left;margin:0;border:0;background:none;
              color:#c9d1d9;padding:6px 8px;border-radius:4px;font-size:12px;cursor:pointer}
  #ctx button:hover{background:#21262d}
  #ctx button.danger{color:#f85149}
</style></head><body>
<div id="ctx"></div>
<h1>🥚 Vpet daemon</h1>
<div id="wrap">
  <div id="petbox"><div id="stage"><canvas id="pet" width="480" height="200"></canvas><canvas id="wx"></canvas><div id="battlebox"><canvas id="battlecv"></canvas></div><div id="hud"><div id="hudTime">–</div><div class="wx" id="hudWx">–</div></div></div>
    <div id="controls">
      ${UI_BUTTONS.filter(([c, , o]) => !(IS_RELEASE && ((o && o.dev) || DEV_ONLY.has(c))))
                  .map(([c, label, o]) => `<button data-cmd="${c}" data-scope="${(o && o.scope) || 'home'}"${o && o.when ? ` data-when="${o.when}"` : ''}${o && o.accent ? ' class="accent"' : ''}${o && o.confirm ? ` data-confirm="${o.confirm}"` : ''}${o && o.scope === 'plaza' ? ' style="display:none"' : ''}>${label}${o && o.dev ? ' <span class="devtag">dev</span>' : ''}</button>`)
                  .join('\n      ')}
      <select id="jgsel" data-scope="home" data-when="jogressMulti" title="營地裡有好幾隻能合體，選一隻"></select>
    </div>
    <div id="yardbar" style="display:none;margin-top:6px;font-size:12px;color:#8b949e">
      <span id="yardinfo">–</span>
      <span class="k">（點一下摸摸、按右鍵開選單）</span>
${IS_RELEASE ? '' : `
      <label class="k">天氣預覽 <span class="devtag">dev</span><select id="wxsel">
        <option value="">自動（實際天氣）</option>
        <option value="clear">晴</option>
        <option value="cloudy">陰</option>
        <option value="rain">雨</option>
        <option value="storm">大雨</option>
        <option value="thunder">雷雨</option>
      </select></label>
      <label class="k"><input type="checkbox" id="wxcold"> 寒流</label>
      <label class="k"><input type="checkbox" id="wxnight"> 夜晚</label>
      <label class="k"><input type="checkbox" id="zonebox"> 走動範圍 <span class="devtag">dev</span></label>
      <label class="k">切法 <select id="zonelayout"><option value="">預設</option></select></label>`}
    </div>
    <div id="plazabar" style="display:none;margin-top:6px;font-size:12px;color:#8b949e">
      <button id="plazamode" title="自動：隨機散步／手動：WASD 或方向鍵移動">🚶 自動</button>
      <div id="plazainvite"></div>
      <div class="form" style="margin-top:4px">
        <span class="lbl">🏷 名牌</span><input id="plazaname" placeholder="新名牌"><button id="plazarename">改名</button>
        <label class="k" title="名牌顏色">顏色 <input type="color" id="plazacolor" value="${plaza.NAME_DEFAULT_COLOR}"></label>
      </div>
      <div id="chatlog"></div>
      <div class="form" style="margin-top:4px">
        <input id="chatin" maxlength="${PlazaServer.CHAT_MAX}" placeholder="說點什麼…（Enter 送出）"><button id="chatsend">送出</button>
      </div>
    </div>
    <div id="cmdmsg"></div>
    <details id="adv"><summary>⚙ 進階指令</summary>
      ${UI_FORMS.filter(f => !(IS_RELEASE && (f.dev || DEV_ONLY.has(f.action))))
                .map(f => `<div class="form" data-scope="${f.scope || 'home'}"${f.action ? ` data-cmd="${f.action}"` : ''}>
        <span class="lbl">${f.label}${f.dev ? ' <span class="devtag">dev</span>' : ''}</span>
        ${(f.fields || []).map(([k, ph]) => `<input data-f="${k}" placeholder="${ph}">`).join('')}
        ${f.buttons ? f.buttons.map(([a, t]) => `<button data-cmd="${a}">${t}</button>`).join('')
                    : `<button${f.confirm ? ` data-confirm="${f.confirm}"` : ''}>執行</button>`}
      </div>`).join('\n      ')}
    </details>
    <div id="cmdout"></div></div>
  <div class="panel">
    <div>daemon tick：<span class="big" id="tick">–</span> <span class="badge" id="kind">–</span></div>
    <div class="k">（背景／切走這個分頁再回來，tick 仍持續跳 = 時鐘不依賴前景）</div>
    <div style="height:10px"></div>
    <div><span class="k">角色：</span><span class="v" id="char">–</span></div>
    <div><span class="k">daemon uptime：</span><span class="v" id="uptime">–</span></div>
    <div><span class="k">此頁距上次抓取：</span><span class="v" id="fetchAge">–</span></div>
    <div style="height:10px"></div>
    <div class="k">── JSONL token 資料源 ──</div>
    <div><span class="k">活躍 session：</span><span class="v" id="asess">–</span></div>
    <div><span class="k">本 session cost：</span><span class="v" id="acost">–</span></div>
    <div><span class="k">全域 cost（所有 AI）：</span><span class="v" id="tcost">–</span></div>
    <div class="k" id="bysrc" style="padding-left:12px"></div>
    <div><span class="k">近 10m burn：</span><span class="v" id="burn">–</span></div>
    <div><span class="k">最近活躍：</span><span class="v" id="lastact">–</span></div>
    <div><span class="k">掃描：</span><span class="v" id="scan">–</span></div>
    <div class="warn" id="err"></div>
  </div>
</div>
<script>
// 一個 dot 畫多大。前線由伺服器端同一組常數帶入（見 daemon.js 頂部）。
// 營地畫小一號（6px 而不是 8px）：4 隻擠在同一塊場地上，角色 128px 太占位置。
// 場地與走動範圍的 dot 數都沒變，所以整個營地畫面等比例縮成 75% —— 這一步只改
// 「畫多大」，要真的變寬敞得另外把 YARD_FIELD 加大（那會動到存好的走動範圍）。
// 隨畫面切換（setView）；所有換算 dot↔px 的地方（命中判定、拎起、範圍框）都讀這兩個，
// 所以只要切換的時機對，其餘一行都不用改。CH 必須維持 2×CW，dot 才是正方形。
const HOME_CW=${CW}, HOME_CH=${CH};
const YARD_CW=6, YARD_CH=12;
let CW=HOME_CW, CH=HOME_CH;
// 寒風的點陣（天狐獸的子彈，依顏色分好組）。伺服器端抽好再內嵌，見 loadWindArt。
const WIND_ART=${JSON.stringify(WIND_ART)};
// 風往哪邊吹：+1 = 由左至右，-1 = 由右至左。
// 造型會跟著轉向（見 wxGust），所以改這一個數字就好，不用動美術也不用動繪圖。
// 子彈原圖是朝右的（角色預設朝右發射），所以 +1 時不鏡射。
const WIND_DIR=1;
function parseAnsi(line){
  // 回傳每個 cell：半格 {top,bot}、真文字 {ch,col}（卡片數值/PvP名牌）、空白 null。
  const cells=[]; let fg=null,bg=null,idx=0;
  while(idx<line.length){
    if(line[idx]==='\\x1b'){
      const m=/^\\x1b\\[([0-9;]*)m/.exec(line.slice(idx));
      if(m){
        const parts=m[1].split(';').map(Number);
        if(m[1]===''||parts[0]===0){fg=null;bg=null;}
        else if(parts[0]===38&&parts[1]===2){fg=[parts[2],parts[3],parts[4]];}
        else if(parts[0]===48&&parts[1]===2){bg=[parts[2],parts[3],parts[4]];}
        idx+=m[0].length; continue;
      }
    }
    const ch=line[idx];
    if(ch==='▀'){cells.push({top:fg,bot:bg});}
    else if(ch==='▄'){cells.push({top:null,bot:fg});}
    else if(ch==='⠀'||ch===' '){cells.push(null);}   // 空白
    else {cells.push({ch:ch,col:fg});}               // 真文字（半格以外一律當文字畫）
    idx++;
  }
  return cells;
}
function draw(petLines, target){
  const cv=target||document.getElementById('pet'),ctx=cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  if(!petLines){return;}
  const rows=petLines.map(parseAnsi);
  const maxW=Math.max(0,...rows.map(r=>r.length));
  cv.width=Math.max(1,maxW*CW); cv.height=Math.max(1,rows.length*CH);
  ctx.textBaseline='top'; ctx.font='13px ui-monospace, Consolas, monospace';
  // 半格像素
  for(let r=0;r<rows.length;r++){
    for(let c=0;c<rows[r].length;c++){
      const cell=rows[r][c]; if(!cell||cell.ch!==undefined)continue;
      const x=c*CW,y=r*CH;
      if(cell.top){ctx.fillStyle='rgb('+cell.top.join(',')+')';ctx.fillRect(x,y,CW,CH/2);}
      if(cell.bot){ctx.fillStyle='rgb('+cell.bot.join(',')+')';ctx.fillRect(x,y+CH/2,CW,CH/2);}
    }
  }
  // 文字（卡片欄位 / 進化樹名稱 / PvP 名牌）：整段一起畫，再水平縮放到剛好 = 該段格數×CW。
  // 逐字 fillText 會壞掉：格距只有 8px，但 13px 字型的字寬更寬 → 互相擠壓，
  // 且最後一個字會超出 canvas 右緣被切掉（進化樹名字被截就是這個原因）。
  const colOf = c => c && c.col ? 'rgb('+c.col.join(',')+')' : '#c9d1d9';
  for(let r=0;r<rows.length;r++){
    let c=0;
    while(c<rows[r].length){
      const cell=rows[r][c];
      if(!cell||cell.ch===undefined){c++;continue;}
      const start=c, style=colOf(cell);
      let txt='';
      while(c<rows[r].length){
        const k=rows[r][c];
        if(!k||k.ch===undefined||colOf(k)!==style)break;   // 換色就斷段
        txt+=k.ch; c++;
      }
      const target=(c-start)*CW;
      const w=ctx.measureText(txt).width;
      ctx.save();
      ctx.translate(start*CW, r*CH+1);
      if(w>0)ctx.scale(target/w,1);        // 精準塞進格子寬度
      ctx.fillStyle=style;
      // 深色 halo：卡片欄位與進化樹名字都沒帶 ANSI 顏色，走的是預設淺灰 —— 那是為
      // 深色底盤挑的，一旦鋪了灰白底圖就等於隱形。描邊讓文字在任何亮度的底圖上都讀得到。
      // shadowBlur 走裝置座標、不受上面的水平 scale 影響；連畫兩次是為了把 halo 加厚
      // （單次的 alpha 太淡壓不住亮底），最後一次關掉 shadow 畫出乾淨的字面。
      ctx.shadowColor='rgba(0,0,0,.95)'; ctx.shadowBlur=4;
      ctx.fillText(txt,0,0);
      ctx.fillText(txt,0,0);
      ctx.shadowBlur=0; ctx.shadowColor='transparent';
      ctx.fillText(txt,0,0);
      ctx.restore();
    }
  }
  // dev：走動範圍。畫在最後 → 蓋在角色上面，被框住的是誰一眼看得出來。
  if(!target&&view==='yard'&&showZones) drawZones(ctx);
}
// dev「走動範圍」：把每隻的可走範圍與定位點畫出來。純顯示，不影響任何計算。
// 存在的理由是分區看不見 —— 角色為什麼不往那邊走，不畫出來只能用猜的。
let zoneBoxes=null, showZones=false;
const ZONE_COLORS=['#58a6ff','#3fb950','#d29922'];
function drawZones(ctx){
  if(!zoneBoxes||!zoneBoxes.length)return;
  // 1 dot = CW 寬、CH/2 高（半格）。框畫在 dot 的外緣，+SPRITE 是因為
  // 可走範圍講的是**左上角**能站到哪，角色本身還要再佔 16 dot。
  const DW=CW, DH=CH/2, S=yardSprite||16;
  ctx.save();
  ctx.lineWidth=1; ctx.setLineDash([]);
  zoneBoxes.forEach((z,i)=>{
    const col=ZONE_COLORS[i%ZONE_COLORS.length];
    ctx.strokeStyle=col; ctx.fillStyle=col;
    // 框 = 身體實際會蓋到的範圍。可走範圍講的是**左上角**能站到哪，所以寬高要各
    // 加一個角色（16 dot）。只畫左上角範圍的話，框會縮在該區的左上角，
    // 跟角色實際走的地方對不起來 —— 看起來就像框畫錯位置。
    ctx.globalAlpha=.85;
    ctx.strokeRect(z.minX*DW+.5, z.minY*DH+.5, (z.maxX-z.minX+S)*DW, (z.maxY-z.minY+S)*DH);
    // 定位點 = 框的中心（放下超出範圍時要走回去的目標）
    if(z.anchor){ ctx.globalAlpha=1;
      const ax=(z.anchor.x+S/2)*DW, ay=(z.anchor.y+S/2)*DH;
      ctx.beginPath(); ctx.arc(ax,ay,2.5,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(ax-6,ay); ctx.lineTo(ax+6,ay);
      ctx.moveTo(ax,ay-6); ctx.lineTo(ax,ay+6); ctx.stroke(); }
  });
  ctx.restore();
}
let yardSprite=16;
let lastFetch=Date.now();
// 視圖：家（statusline 那個舞台）／院子（營地成員在 96x24 的場地散步）。
// 只是「這個瀏覽器分頁在看哪裡」，不是 daemon 的狀態 —— 開兩個分頁可以一個看家、
// 一個看院子，daemon 不需要知道。
let view = 'home';
// 這個元素在目前的畫面要不要出現。廣場是例外：進去之後**只剩**廣場自己的東西
// （規格 §六：在廣場不能切畫面、不能做會改變角色的事），'both' 的鈕也一律藏起來。
// 廣場不是「這個分頁在看哪裡」而是 daemon 的狀態 —— 每個分頁都會被帶進去（見 poll）。
function inScope(sc){
  if(view==='plaza') return sc==='plaza';
  return !sc || sc==='both' || sc===view;
}
function setView(v){
  view = v;
  // 要在 poll() 之前換：下一次畫的就是這個畫面的大小
  // 廣場比照營地：同一張細格、同樣小一號的角色
  const small = (v==='yard' || v==='plaza');
  CW = small ? YARD_CW : HOME_CW;
  CH = small ? YARD_CH : HOME_CH;
  document.body.classList.toggle('yard', v==='yard');
  document.body.classList.toggle('plaza', v==='plaza');
  document.querySelectorAll('[data-scope]').forEach(el=>{
    el.style.display = inScope(el.dataset.scope) ? '' : 'none';
  });
  document.getElementById('yardbar').style.display = (v==='yard') ? '' : 'none';
  document.getElementById('plazabar').style.display = (v==='plaza') ? '' : 'none';
  document.querySelectorAll('[data-cmd="yard"]').forEach(b=>{
    // 「家」在這裡有兩個意思會打架：廣場那邊的「回家」是從廣場回到自己的舞台，
    // 營地這邊按了是回到現役那隻。用「前線」指現役、「營地」指收藏，不會混。
    b.textContent = (v==='yard') ? '⚔ 前線' : '⛺ 營地';
  });
  applyWhen();
  hudTick();
  poll();
}

// ── 天氣表演 ────────────────────────────────────────────────────────────
// 分兩層：**色調**在後端（跑在 dot 緩衝上，會吃到角色身上 —— 陽光照在怪身上、
// 寒流把怪凍得發青），**會動的粒子**在這裡。理由是節奏：/yard 是 500ms 輪詢、
// 走路 750ms 一拍，用那個節奏畫雨會變成一格一格瞬移的點，完全不像下雨。
// 這一層走 requestAnimationFrame，跟輪詢完全脫鉤。
//
// 雨滴位置用固定種子起始，重整看到同一場雨；但之後**不需要**跨 client 一致
// （沒有人分得出你我的雨滴有沒有對齊），所以接廣場時這段原封不動就能用。
// 走路那邊就不一樣了，那個必須逐拍決定性，見 shared/plaza-walk.js。
const wxState = {sky:'clear', cold:false, night:false};
let wxParts=null, wxLast=0, wxSeed=1;
function wxRand(){ wxSeed=(Math.imul(wxSeed,1664525)+1013904223)>>>0; return wxSeed/4294967296; }

// 天氣畫布要精準疊在角色畫布上。角色畫布每次 draw() 都會依內容重建尺寸，
// 所以每次畫完都要重新對位一次。
function syncWx(){
  const pet=document.getElementById('pet'), wx=document.getElementById('wx');
  const w=pet.offsetWidth, h=pet.offsetHeight;
  wx.style.left=pet.offsetLeft+'px'; wx.style.top=pet.offsetTop+'px';
  if(wx.width!==w||wx.height!==h){ wx.width=w; wx.height=h; }
}

function wxBuild(w,h){
  wxSeed=20260821;
  const P={w:w,h:h,shaft:[],cloud:[],drop:[],wind:[]};
  for(let i=0;i<3;i++)  P.shaft.push({x:wxRand()*w, w:16+wxRand()*26});
  for(let i=0;i<8;i++)  P.cloud.push({x:wxRand()*w, y:2+wxRand()*(h*0.20),
                                      w:24+wxRand()*44, h:2.5+wxRand()*3.5,
                                      v:3+wxRand()*5, a:0.05+wxRand()*0.06});
  // 雨滴池的大小**從 WXR 推出來**，不要寫死。
  // 寫死 120 而雷雨要 150 → 迴圈讀到 P.drop[120] 是 undefined 就丟例外，
  // 而例外發生在雲畫完之後 → 畫面看起來就只有雲，跟陰天一模一樣。
  // （requestAnimationFrame 在函式開頭就排好了，所以它每一幀都照丟，不會停也不會有紅字。）
  const DROPS=Math.max(...Object.values(WXR).map(r=>r.n));
  for(let i=0;i<DROPS;i++)P.drop.push({x:wxRand()*w, y:wxRand()*h, s:0.7+wxRand()*0.6});
  // 冷風：數量刻意少。每一陣都是一個看得出來的造型，這種東西一多就變成一團毛球
  // —— 密度要靠「還認得出單一個形狀」來定。
  // 尺寸對著角色抓：畫布 416x320，一隻角色 16 dot = 128px 高。
  // 子彈點陣約 10x10 dot，每 dot 畫 4~7px → 一陣風 40~70px，約角色的一半。
  // s 取整數，方塊才會對齊像素格。
  for(let i=0;i<5;i++)  P.wind.push({x:wxRand()*w, y:16+wxRand()*(h-72),
                                     s:4+Math.floor(wxRand()*4),
                                     v:34+wxRand()*40, a:0.42+wxRand()*0.28,
                                     vy:(wxRand()-0.5)*5});
  return P;
}

// 密度／速度全部集中在這裡，方便實測後調。場地只有 52x20 格（416x320px），
// 粒子稍微多一點畫面就會爛成雜訊、看不出誰是誰 —— 寧可保守。
// 光柱／雲落在角色身上時多疊幾層（見 wxDraw）。1 = 不加濃（跟背景上一樣淡，看起來像在角色後面）。
const WX_ON_PET = 3;
const WXR = { rain:{n:40,  vy:175, vx:-28, len:9,  a:0.30, lw:1},
              storm:{n:110, vy:300, vx:-52, len:15, a:0.42, lw:1.4},
              thunder:{n:150, vy:360, vx:-64, len:19, a:0.48, lw:1.6} };
// 閃電：間隔多久打一次（隨機落在這個範圍內）。
// 場地只有 416x320，整片白閃很容易變成騷擾 —— 峰值壓在 0.28、每次只有兩百毫秒，
// 而且刻意做成「雙閃」（真的閃電多半閃兩下），比單次長閃自然又不刺眼。
const WXBOLT_MIN=5000, WXBOLT_MAX=13000;
let wxBoltNext=0, wxBoltAt=0;

// 一陣風 = 天狐獸子彈的點陣，s 是每個 dot 畫幾 px。
// 起點取整數、s 也是整數 → 每個方塊都對齊在整數像素上，邊緣不會被反鋸齒糊掉。
// 這是它跟先前那個向量螺旋最大的差別：畫面上其他東西全是像素，
// 只有天氣是平滑曲線的話，形狀再對也還是格格不入。
// 拿在手上的那隻。dots 是 [ [r,g,b]|null x16 ] x16，一個 dot = CW 寬 x CH/2 高，
// 跟伺服器合成用的是同一套座標，所以放開時的落點不用換算。
function drawHeld(g){
  if(!drag||!drag.frames||drag.wait) return;   // wait：伺服器那張裡牠還在地上，先別畫第二份
  // 待機動畫跟著**伺服器的拍子**走（lastYard.step 的奇偶），不是自己另外計時 ——
  // 這樣手上那隻跟場上其他人是同一個呼吸節奏，而不是各跳各的。
  const st=(lastYard&&lastYard.step)||0;
  const dots=drag.frames[st%2] || drag.frames[0];
  const lift=liftNow(), k=Math.min(1,Math.abs(lift)/LIFT_DOTS);
  // 對齊到整數像素：位置是跟著游標的浮點 dot，直接畫會落在半個像素上，
  // 點陣圖被 anti-alias 糊掉（同樣的理由見 wxGust 的整數對齊）。
  const px=Math.round(drag.x*CW), py=Math.round((drag.y+lift)*(CH/2));
  // 影子留在**地面**（drag.y），身體才往上浮 —— 這是離地感的來源，
  // 而且影子順便標出放開後會落在哪裡。影子跟著升高的話就只是整隻平移，看不出被拿起來。
  g.save();
  g.globalAlpha=0.25*(1-0.5*k); g.fillStyle='#000';
  g.beginPath();
  g.ellipse(px+8*CW, drag.y*(CH/2)+17*(CH/2), (7-2*k)*CW, (1.6-0.4*k)*(CH/2), 0, 0, Math.PI*2);
  g.fill();
  g.restore();
  for(let y=0;y<dots.length;y++){
    const row=dots[y];
    for(let x=0;x<row.length;x++){
      const c=row[x]; if(!c) continue;
      g.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')';
      g.fillRect(px+x*CW, py+y*(CH/2), CW, CH/2);
    }
  }
}

function wxGust(g,x,y,s){
  const gx=Math.round(x), gy=Math.round(y), flip=WIND_DIR<0, W=WIND_ART.w;
  for(const grp of WIND_ART.groups){
    g.fillStyle=grp.c;
    const p=grp.p;
    for(let i=0;i<p.length;i+=2){
      const dx=flip?(W-1-p[i]):p[i];
      g.fillRect(gx+dx*s, gy+p[i+1]*s, s, s);
    }
  }
}

function wxDraw(ts){
  requestAnimationFrame(wxDraw);
  const cv=document.getElementById('wx');
  if((view!=='yard'&&view!=='plaza')||!cv.width||!cv.height){ wxLast=ts; return; }
  const dt=Math.min(0.1,(ts-wxLast)/1000)||0; wxLast=ts;
  const w=cv.width, h=cv.height, g=cv.getContext('2d');
  if(!wxParts||wxParts.w!==w||wxParts.h!==h) wxParts=wxBuild(w,h);
  const P=wxParts, sky=wxState.sky;
  g.clearRect(0,0,w,h);

  // 光柱與雲先畫在一張暫存畫布上，再疊兩次：一次照舊鋪滿，一次**只蓋在角色身上**而且加濃。
  // 為什麼：這兩種都很淡（雲 5~11%、光 13%），在深色背景上看得到，落到角色比較亮的
  // 像素上幾乎看不出來 —— 結果邊緣在角色身上「斷掉」，看起來像從角色後面經過（回報過）。
  // 天氣層其實一直在角色上面，問題是視覺上沒有蓋過去。
  if(!P.fx){ P.fx=document.createElement('canvas'); P.mk=document.createElement('canvas'); }
  if(P.fx.width!==w||P.fx.height!==h){ P.fx.width=P.mk.width=w; P.fx.height=P.mk.height=h; }
  const fg=P.fx.getContext('2d');
  fg.clearRect(0,0,w,h);
  let fxUsed=false;

  // 晴：斜射的光柱。用 lighter 疊加，只加亮不遮擋 —— 光線蓋住角色會很怪。
  // ⚠️ 夜裡一定要關掉。光柱是**陽光**，天黑了還有幾道斜射的亮帶，看起來不是
  //    「晚上的晴天」而是「畫面壞了」。晴朗的夜空就該是空的，沒有粒子。
  if(sky==='clear'&&!wxState.night){
    fxUsed=true;
    fg.globalCompositeOperation='lighter';
    for(const f of P.shaft){
      f.x+=7*dt; if(f.x>w+h) f.x-=w+h+80;
      const grd=fg.createLinearGradient(f.x,0,f.x+h*0.55,h);
      grd.addColorStop(0,'rgba(255,238,180,0.13)');
      grd.addColorStop(1,'rgba(255,238,180,0)');
      fg.fillStyle=grd;
      fg.beginPath();
      fg.moveTo(f.x,0); fg.lineTo(f.x+f.w,0);
      fg.lineTo(f.x+f.w+h*0.55,h); fg.lineTo(f.x+h*0.55,h);
      fg.closePath(); fg.fill();
    }
    fg.globalCompositeOperation='source-over';
  }

  // 陰／雨／大雨：最上方一層薄雲。越糟的天氣雲越厚、飄越快。
  if(sky!=='clear'){
    const heavy=(sky==='storm'||sky==='thunder');
    const boost=sky==='thunder'?2.1:sky==='storm'?1.8:sky==='rain'?1.35:1;
    const speed=sky==='thunder'?3.0:heavy?2.4:sky==='rain'?1.5:1;
    fxUsed=true;
    for(const c of P.cloud){
      c.x+=c.v*speed*dt; if(c.x-c.w>w) c.x=-c.w*2;
      fg.fillStyle='rgba(202,210,222,'+(c.a*boost).toFixed(3)+')';
      fg.beginPath(); fg.ellipse(c.x,c.y,c.w,c.h,0,0,6.2832); fg.fill();
    }
  }
  if(fxUsed){
    g.drawImage(P.fx,0,0);                         // 照舊：鋪滿整個畫面
    // 只蓋在角色身上的那一份：同一張再疊 WX_ON_PET 次（加濃），用角色畫布的 alpha 當遮罩
    const pet=document.getElementById('pet'), mg=P.mk.getContext('2d');
    mg.globalCompositeOperation='source-over'; mg.clearRect(0,0,w,h);
    for(let i=0;i<WX_ON_PET;i++) mg.drawImage(P.fx,0,0);
    mg.globalCompositeOperation='destination-in';
    mg.drawImage(pet,0,0,w,h);
    mg.globalCompositeOperation='source-over';
    g.drawImage(P.mk,0,0);
  }

  // 雨／大雨。
  // ⚠️ 規格原本寫「最上方一些淺淺的雨」，這裡改成**整片**由上落下 ——
  //    只在上緣下雨看起來像天花板漏水，不像下雨。改用低透明度控制存在感，
  //    角色一樣看得清楚。要回到只在上方，把 d.y 的範圍夾住即可。
  if(sky==='rain'||sky==='storm'||sky==='thunder'){
    const r=WXR[sky];
    g.strokeStyle='rgba(155,192,255,'+r.a+')'; g.lineWidth=r.lw;
    g.beginPath();
    for(let i=0;i<r.n;i++){
      const d=P.drop[i];
      d.y+=r.vy*d.s*dt; d.x+=r.vx*d.s*dt;
      if(d.y>h){ d.y-=h+r.len; d.x=wxRand()*w; }
      if(d.x<-r.len) d.x+=w+r.len;
      g.moveTo(d.x,d.y); g.lineTo(d.x+r.vx/r.vy*r.len, d.y+r.len);
    }
    g.stroke();
  }

  // 雷雨：在大雨之上加閃電。畫在所有粒子之後 = 蓋住整個畫面，那才像整片天空亮起來。
  //
  // 為什麼雷雨是第五個 sky 而不是像寒流那樣的旗標：打雷一定伴隨下雨，它跟雨是同一個
  // 軸上更嚴重的一格，不是另一個軸。寒流不一樣，晴天也會冷。
  if(sky==='thunder'){
    if(ts>wxBoltNext){ wxBoltNext=ts+WXBOLT_MIN+wxRand()*(WXBOLT_MAX-WXBOLT_MIN); wxBoltAt=ts; }
    const e=ts-wxBoltAt;
    // 雙閃：0~70ms 主閃、130~230ms 較弱的第二下。中間那段暗下來才有「閃」的感覺，
    // 一路線性淡出的話只會像整片畫面在呼吸。
    let a=0;
    if(e<70)                a=0.28*(1-e/70);
    else if(e>=130&&e<230)  a=0.16*(1-(e-130)/100);
    if(a>0){ g.fillStyle='rgba(228,238,255,'+a.toFixed(3)+')'; g.fillRect(0,0,w,h); }
  }

  // 寒流：橫向吹過的冷風。這是**疊加**在天空狀態上的，不是另一種天空 ——
  // 台灣冬天「寒流 + 下雨」是常態，做成互斥的話那天只能二選一。
  // 寒流：少少幾陣「捲」橫著吹過。疊加在任何天空狀態上。
  //
  // 走過三版：
  //   1. 26 條細直線、alpha 0.05~0.17 → 等於看不見，回報「寒流沒顯示」。
  //   2. 40 條加粗加亮 → 看得見了，但變成流星雨。密的直線一律讀成「掉落物」，
  //      不管它是水平的還是垂直的。
  //   3. 5 陣向量畫的螺旋 → 風要靠形狀認不是靠數量，這點對了；但它是畫面上
  //      唯一的平滑曲線，跟滿場的像素格格不入。
  //   4. 5 陣天狐獸子彈的點陣（本版）→ 借現成的美術：中心亮、外圍青、周圍散幾點
  //      閃光。那幾點閃光是造型的關鍵，而且它本來就是點陣，總算跟場景同一種語言。
  //
  // ⚠️ 造型是有方向性的（尾巴上的散點在後面），所以**吹的方向與圖必須一致**。
  //    第一次接的時候風往左吹、圖卻朝右，尾巴跑到前面去了 —— 一眼就看得出怪。
  //    現在由 WIND_DIR 同時決定移動方向與要不要鏡射，不可能再對不上。
  if(wxState.cold){
    for(const k of P.wind){
      const wide=WIND_ART.w*k.s;
      k.x+=k.v*WIND_DIR*dt; k.y+=k.vy*dt;
      // 出畫面（或被垂直漂移帶出上下緣）就從逆風那一側重新進場
      if(k.y<0||k.y+wide>h||(WIND_DIR>0 ? k.x>w : k.x+wide<0)){
        k.x=(WIND_DIR>0 ? -wide-wxRand()*90 : w+wxRand()*90);
        k.y=16+wxRand()*(h-72); k.vy=(wxRand()-0.5)*5;
      }
      g.globalAlpha=k.a;
      wxGust(g,k.x,k.y,k.s);
    }
    g.globalAlpha=1;
  }
  // 拿在手上的那隻畫在最後 = 蓋在天氣之上。牠在你手裡，雨不該蓋過牠。
  drawHeld(g);
}
requestAnimationFrame(wxDraw);

// 右上角的日期／時間。時間走本機時鐘、每秒自己跳，不跟著 /yard 輪詢 ——
// 500ms 輪詢一次就為了更新分鐘數太浪費，而且斷線時時鐘不該跟著停。
const WXWD=['日','一','二','三','四','五','六'];
function hudTick(){
  if(view!=='yard'&&view!=='plaza') return;
  const d=new Date(), p2=n=>(n<10?'0':'')+n;
  document.getElementById('hudTime').textContent =
    d.getFullYear()+'/'+p2(d.getMonth()+1)+'/'+p2(d.getDate())+' ('+WXWD[d.getDay()]+')　'
    + p2(d.getHours())+':'+p2(d.getMinutes());
}
setInterval(hudTick,1000);

// 天氣：營地與廣場共用（伺服器給一份，這裡套到粒子層與右上看板）
function applyWeather(w){
  if(!w) return;
  wxState.sky = w.sky; wxState.cold = !!w.cold;
  // 日夜跟著伺服器走，不看自己的時鐘 —— 右上的時間是看板（本機時鐘、每秒自己跳），
  // 天色是場景狀態。兩邊各判各的話，預覽夜晚時會變成「月亮出來了但陽光還在」。
  wxState.night = !!w.night;
  document.getElementById('hudWx').innerHTML =
    w.icon+' '+w.label+(w.temp?'　'+w.temp:'')
    + (w.city?' <span class="k">'+w.city+'</span>':'')
    + (w.preview?' <span class="prev">預覽</span>'
       : w.stale?' <span class="prev">離線</span>':'');
}
async function pollYard(){
  // ⚠️ 一定要 encodeURIComponent：查詢字串裡的 + 會被解碼成空白，
  //    clear+cold 送出去在伺服器端會變成 "clear cold"，比對不到就整個退回真實天氣
  //    —— 症狀是「選了寒流卻什麼都沒發生」。踩過一次。
  // 寒流是獨立的勾選框，不是下拉裡的組合選項 —— 它本來就跟天空正交，
  // 混進同一份清單會讓人以為「寒流」是某種天空，也組不出陰・寒流那類常見情況。
  const es = document.getElementById('wxsel');
  const ec = document.getElementById('wxcold');
  const en = document.getElementById('wxnight');
  const parts=[]; if(es&&es.value) parts.push(es.value); if(ec&&ec.checked) parts.push('cold');
  if(en&&en.checked) parts.push('night');
  const q = parts.join('+');
  const zl = document.getElementById('zonelayout');
  const qs = [];
  if(q) qs.push('w='+encodeURIComponent(q));
  if(zl&&zl.value) qs.push('zl='+encodeURIComponent(zl.value));
  const y = await (await fetch('/yard'+(qs.length?'?'+qs.join('&'):''),
                               {cache:'no-store'})).json();
  if(!y.ok){ document.getElementById('err').textContent='⚠️ '+y.error; return; }
  if(y.inPlaza){ setView('plaza'); return; }
  lastYard=y;
  dragHandoff(y);   // 要跟下面的 draw(y.lines) 在同一個 task 裡（中間不能有 await）
  zoneBoxes = y.zones || null;
  if(y.sprite) yardSprite = y.sprite;
  // 下拉的選項跟著隻數換（2 隻與 3 隻能選的切法不同）。只在清單真的變了時重建，
  // 不然每 250ms 重建一次會把使用者正在展開的選單關掉。
  if(zl && y.layouts){
    const want='|'+y.layouts.join('|');
    if(zl.dataset.opts!==want){
      zl.dataset.opts=want; const keep=zl.value;
      zl.innerHTML='<option value="">預設（'+(y.layout||'-')+'）</option>'
        + y.layouts.map(n=>'<option value="'+n+'">'+n+'</option>').join('');
      zl.value = y.layouts.includes(keep) ? keep : '';
    }
  }
  document.getElementById('yardinfo').textContent = y.kept
    ? '營地 '+y.kept+'/'+y.cap+'　'+y.pets.map(p=>p.code).join('　')
    : '營地是空的 —— 進階區的「📥 收進營地」可以把現役收進來（隨時換得回去）';
  document.getElementById('kind').textContent='yard';
  document.getElementById('tick').textContent='#'+y.step;
  applyWeather(y.weather);
  if(y.lines){ draw(y.lines); }
  else {
    // 空營地：仍然把畫布撐成完整的場地大小再清空。
    // 只 clearRect 不改尺寸的話，畫布會停在上一次畫過的家裡舞台（52 欄），
    // 空營地就變成一個小方塊，看起來像壞掉而不是「這裡還沒有東西」。
    const cv=document.getElementById('pet');
    cv.width=y.cols*CW; cv.height=y.rows*CH;
    cv.getContext('2d').clearRect(0,0,cv.width,cv.height);
  }
  syncWx();
}

let lastState=null;   // 最後一次 /state（家裡分頁靠它知道營地滿了沒）

// ── 合體進化（docs/jogress-spec.md 第 2 期）──
// 候選來自伺服器的 /state。按鈕只在前線（進化演出在前線），所以營地的 /yard 不帶。
// 前端不自己判定成不成立 —— 那是 core.jogressCandidates 的事，各寫一份就會出現
// 「按鈕亮著但 CLI 說不成立」。
let lastJogress=null;
function jgOptions(){ return (lastJogress && Array.isArray(lastJogress.options)) ? lastJogress.options : []; }
// 下拉選中的那一組；只有一組時就是它
function jgPicked(){
  const o=jgOptions(); if(!o.length) return null;
  const sel=document.getElementById('jgsel');
  return (o.length>1 && sel && sel.value) ? (o.find(x=>x.id===sel.value)||o[0]) : o[0];
}
// 確認文案（規格決策 3）：要講是**哪一隻**、而且救不回來、前線會變成誰。
// 營地那隻不在畫面上（按鈕在前線），所以編號與名字一定要寫出來。
function jogressConfirmText(o){
  const front=(lastJogress && lastJogress.frontName) || '現役';
  return '合體進化會永久消耗營地的 #'+o.num+' '+o.campName+'（救不回來），'
       + '前線的 '+front+' 會變成 '+o.toName+'。確定嗎？';
}
// data-when 的條件。不成立 = 整顆不出現（不是灰掉：灰掉的鈕會讓人一直想點點看為什麼）。
const WHEN={
  jogress:      ()=>jgOptions().length>0,
  jogressMulti: ()=>jgOptions().length>1,   // 不止一組才需要選
};
function applyWhen(){
  document.querySelectorAll('[data-when]').forEach(el=>{
    const f=WHEN[el.dataset.when];
    el.style.display=(inScope(el.dataset.scope) && f && f()) ? '' : 'none';
  });
}
// 候選變了 → 換按鈕文字、重建下拉。下拉只在清單真的變了才重建，
// 不然每 500ms 重建一次會把使用者正在展開的選單關掉（同切法下拉的做法）。
function syncJogress(j){
  lastJogress=j||null;
  const o=jgOptions();
  const targets=[...new Set(o.map(x=>x.toName))];
  document.querySelectorAll('[data-cmd="jogress"]').forEach(b=>{
    b.textContent = targets.length===1 ? '🧬 合體進化 → '+targets[0] : '🧬 合體進化';
  });
  const sel=document.getElementById('jgsel');
  if(sel){
    const want=o.map(x=>x.id+':'+x.to).join('|');
    if(sel.dataset.opts!==want){
      sel.dataset.opts=want; const keep=sel.value;
      sel.innerHTML=o.map(x=>'<option value="'+x.id+'">#'+x.num+' '+x.campName+' → '+x.toName+'</option>').join('');
      if(o.some(x=>x.id===keep)) sel.value=keep;
    }
  }
  applyWhen();
}

// 能不能從前線切去營地。回 null = 可以；回字串 = 不行，字串就是要給使用者看的理由。
// 進化表演中不給切：牠正在變身，這是要看的那一刻 —— 切走回來就錯過了，而合體進化時
// 營地那隻已經被消耗，切過去只會看到「少一隻」，讀起來像東西不見了。
// 只擋「去營地」，不擋「回前線」：人在營地時才開始進化的話，要能回來看牠變身。
// 用的是家裡分頁每 500ms 拿到的 /state —— 人在前線時它就是最新的。
function yardBlocked(){
  if(lastState && lastState.kind==='evo') return '進化表演中，等牠變完再去營地。';
  return null;
}

// 營地滿了沒。院子分頁的 /yard 比較新，優先用它；家裡分頁退回 /state。
// 回 null = 還不知道（剛開頁面），那就別擋，讓指令照送、由 CLI 那道去擋。
function ranchFull(){
  const src = (lastYard && lastYard.cap) ? lastYard
            : (lastState && lastState.ranch) ? lastState.ranch : null;
  if(!src || !src.cap) return null;
  return { full: src.kept >= src.cap, kept: src.kept, cap: src.cap };
}

// 命中判定用「這一拍畫出來的位置」，所以要記住最後一次 /yard 的結果。
// 位置每拍都在動，若改成點下去再問伺服器，回來時已經是下一拍的位置，會抓錯人。
let lastYard=null;
function closeCtx(){ document.getElementById('ctx').style.display='none'; }
document.addEventListener('click',closeCtx);
document.addEventListener('scroll',closeCtx,true);

// 滑鼠事件 → 點到哪一隻（沒點到回 null）。左鍵摸摸與右鍵選單共用同一份判定，
// 分兩份寫遲早會分叉成「右鍵選到 A、左鍵摸到 B」。
// 滑鼠事件 -> dot 座標。命中判定與拖曳共用同一份換算 ——
// 分兩份寫遲早會差一格，而「差一格」的症狀是「看起來明明點到了卻沒反應」。
function evDot(ev){
  const cv=document.getElementById('pet'), r=cv.getBoundingClientRect();
  // 畫布可能被 CSS 縮放過 → 用 width/rect 的比例換回內部座標，再換成 dot
  return { dx:(ev.clientX-r.left)*(cv.width/r.width)/CW,
           dy:(ev.clientY-r.top )*(cv.height/r.height)/(CH/2) };
}
function yardHit(ev){
  if(view!=='yard'||!lastYard||!lastYard.pets||!lastYard.pets.length) return null;
  const {dx,dy}=evDot(ev);
  const S=lastYard.sprite||16;
  // 由後往前找 = 從畫在最上層的那隻開始，跟眼睛看到的一致
  for(let i=lastYard.pets.length-1;i>=0;i--){
    const p=lastYard.pets[i];
    if(dx>=p.x&&dx<p.x+S&&dy>=p.y&&dy<p.y+S) return p;
  }
  return null;
}

// dev「走動範圍」開關。切換後直接用上一次的畫面重畫 —— 等輪詢的話最多要 250ms
// 才看得到反應，會讓人以為勾了沒用。
{
  const zb=document.getElementById('zonebox');
  if(zb) zb.addEventListener('change',()=>{
    showZones=zb.checked;
    if(view==='yard'&&lastYard&&lastYard.lines) draw(lastYard.lines);
  });
}

document.getElementById('pet').addEventListener('contextmenu',ev=>{
  const hit=yardHit(ev);
  if(!hit) return;
  ev.preventDefault();
  const el=document.getElementById('ctx');
  const wr=hit.winPct==null?'尚無戰績':(hit.wins+'/'+hit.battles+'　'+hit.winPct+'%');
  // 選單表頭就把該講的都講完了（名字 / 階段 / 戰力 / 勝率 / 收進來的時間），
  // 所以不再給一顆「名片」鈕—— 那顆鈕是把同一份資料倒到畫布下方的 #cmdout，
  // 而營地畫面的畫布是滿尺寸、外層會捲動，輸出區常常落在看不到的位置，
  // 看起來就像「按了沒反應」。
  el.innerHTML='<div class="hd"><b>'+hit.name+'</b>'+
               (hit.wasName?' <span class="k2">（原：'+hit.wasName+'）</span>':'')+
               '<br><span class="k2">'+
               hit.stage+'　戰力 '+hit.power+'　'+wr+'<br>收於 '+
               new Date(hit.keptAt).toLocaleString()+'</span></div>';
  const add=(txt,fn,cls)=>{const b=document.createElement('button');b.textContent=txt;
    if(cls)b.className=cls;b.onclick=e=>{e.stopPropagation();closeCtx();fn();};el.appendChild(b);};
  add('🔄 換出來（與現役交換）',()=>sendCmd('swap',{which:hit.id}));
  add('🗑 放生（永久刪除）',()=>{ if(confirm('放生「'+hit.name+'」？永久刪除，救不回來。'))
      sendCmd('release',{which:hit.id}); },'danger');
  el.style.display='block';
  el.style.left=Math.min(ev.clientX, innerWidth-el.offsetWidth-8)+'px';
  el.style.top =Math.min(ev.clientY, innerHeight-el.offsetHeight-8)+'px';
});

// ── 廣場 ──
// 「被帶回前線」的原因只顯示一次：記住看過的最後一則（at），之後的輪詢不再重複跳。
// 起始值是開頁的時間 —— 開頁之前發生的事不用補講。
let plazaNoticeSeen=Date.now();
function plazaNoticeCheck(n){
  if(n && n.at>plazaNoticeSeen){ plazaNoticeSeen=n.at; flashCmdMsg(n.text,'#d29922'); }
}
async function pollPlaza(){
  const p=await (await fetch('/plaza',{cache:'no-store'})).json();
  if(!p.ok){ document.getElementById('err').textContent='⚠️ '+p.error; return; }
  plazaNoticeCheck(p.notice);
  if(!p.active){ setView('home'); return; }
  plazaMode=p.mode||'auto';
  document.getElementById('plazamode').textContent = plazaMode==='manual' ? '🎮 手動（WASD）' : '🚶 自動';
  // 名牌輸入框：沒在打字時才跟著伺服器的名字走，不然會把正在輸入的字蓋掉
  const ni=document.getElementById('plazaname');
  if(ni && document.activeElement!==ni && ni.dataset.cur!==p.me){ ni.value=p.me; ni.dataset.cur=p.me; }
  const ci=document.getElementById('plazacolor');
  // 選色器顯示的就是別人看到的顏色（沒選過 = 預設色）
  const mine=p.myColor||'${plaza.NAME_DEFAULT_COLOR}';
  if(ci && document.activeElement!==ci && ci.value!==mine) ci.value=mine;
  applyWeather(p.weather);
  document.getElementById('kind').textContent='plaza';
  document.getElementById('tick').textContent='#'+p.step;
  document.getElementById('err').textContent='';
  draw(p.lines);
  lastPlazaTags=p.tags||[]; lastPlazaMe=p.me;
  drawNameTags(p.tags);
  drawBubbles(p.tags, p.chat, p.serverNow);
  renderChat(p.chat);
  renderInvite(p.invite);
  renderBattle(p.battle);
  syncWx();
}
// ── 對戰 ──
// 點別人的 vpet → 選單「⚔ 邀請對戰」。命中判定用伺服器給的名牌資料（x = 中心、top～y = 身體）。
let lastPlazaTags=[], lastPlazaMe=null;
function plazaHit(ev){
  const {dx,dy}=evDot(ev);
  for(let i=lastPlazaTags.length-1;i>=0;i--){
    const t=lastPlazaTags[i];
    if(dx>=t.x-8&&dx<t.x+8&&dy>=t.top&&dy<t.y) return t;
  }
  return null;
}
function plazaClick(ev){
  const t=plazaHit(ev);
  if(!t||t.text===lastPlazaMe) return;
  ev.stopPropagation();                       // 不然 document 的 click 會馬上把選單關掉
  const el=document.getElementById('ctx');
  el.innerHTML='';
  const hd=document.createElement('div'); hd.className='hd'; hd.textContent=t.text; el.append(hd);
  const b=document.createElement('button');
  b.textContent=t.battling ? '⚔ 對戰中…' : '⚔ 邀請對戰';
  b.disabled=!!t.battling;
  b.addEventListener('click',()=>{ closeCtx(); sendCmd('plazaInvite',{to:String(t.key).slice(2)}).then(()=>poll()); });
  el.append(b);
  el.style.display='block';
  el.style.left=Math.min(ev.clientX, innerWidth-el.offsetWidth-8)+'px';
  el.style.top =Math.min(ev.clientY, innerHeight-el.offsetHeight-8)+'px';
}
document.getElementById('pet').addEventListener('click',ev=>{ if(view==='plaza') plazaClick(ev); });
// 邀請列：別人邀我 → 接受／拒絕；我邀別人 → 等回覆。內容沒變就不重建（不然按鈕每 250ms 換一顆，點不到）
let inviteShown='';
function renderInvite(inv){
  const box=document.getElementById('plazainvite');
  const key=inv ? inv.kind+'|'+(inv.inviteId||'')+'|'+inv.name : '';
  if(!inv){ box.style.display='none'; inviteShown=''; return; }
  box.style.display='block';
  if(key!==inviteShown){
    inviteShown=key; box.textContent='';
    const msg=document.createElement('span'); msg.id='invitemsg'; box.append(msg);
    if(inv.kind==='in'){
      const yes=document.createElement('button'); yes.textContent='⚔ 接受';
      const no=document.createElement('button'); no.textContent='拒絕';
      yes.addEventListener('click',()=>sendCmd('plazaAnswer',{inviteId:inv.inviteId,accept:'1'}).then(()=>poll()));
      no.addEventListener('click',()=>sendCmd('plazaAnswer',{inviteId:inv.inviteId,accept:'0'}).then(()=>poll()));
      box.append(yes,no);
    }
  }
  document.getElementById('invitemsg').textContent = inv.kind==='in'
    ? inv.name+' 邀請你對戰（'+inv.secs+' 秒）'
    : '已邀請 '+inv.name+' 對戰，等待回覆…（'+inv.secs+' 秒）';
}
// 我的對戰演出：前線的戰鬥畫面，用前線的格子大小（8px）畫在疊層上，廣場在後面照常進行
function renderBattle(b){
  const box=document.getElementById('battlebox');
  if(!b||!b.lines){ box.style.display='none'; return; }
  box.style.display='flex';
  const cw=CW, ch=CH; CW=HOME_CW; CH=HOME_CH;
  try{ draw(b.lines, document.getElementById('battlecv')); } finally { CW=cw; CH=ch; }
}

// ── 聊天室 ──
// 只有最後一則變了才重畫（每 250ms 重建一次會把使用者正在選取的文字洗掉）。
// 原本就捲在最底下才跟著捲到底；往上翻舊訊息時不要被拉回去。
let chatShown=0;
function renderChat(list){
  list=list||[];
  const last=list.length ? list[list.length-1].seq : 0;
  if(last===chatShown) return;
  chatShown=last;
  const box=document.getElementById('chatlog');
  const atBottom = box.scrollTop+box.clientHeight >= box.scrollHeight-4;
  box.textContent='';
  for(const m of list){
    const row=document.createElement('div');
    const t=new Date(m.at), p2=n=>(n<10?'0':'')+n;
    const hhmm=p2(t.getHours())+':'+p2(t.getMinutes())+' ';
    if(m.sys){ row.className='sys'; row.textContent=hhmm+m.text; }
    else {
      row.append(document.createTextNode(hhmm));
      const who=document.createElement('span'); who.className='who';
      who.style.color=m.color||'${plaza.NAME_DEFAULT_COLOR}'; who.textContent=m.name;
      row.append(who, document.createTextNode('：'+m.text));   // textContent：別人打的字不能當 HTML
    }
    box.append(row);
  }
  if(atBottom) box.scrollTop=box.scrollHeight;
}
// 對話泡泡：說話的人頭上顯示前 BUBBLE_CHARS 個字，BUBBLE_MS 後消失（規格 §七）
const BUBBLE_MS=5000, BUBBLE_CHARS=12;
function drawBubbles(tags, list, now){
  if(!tags||!list||!list.length) return;
  const cv=document.getElementById('pet'), g=cv.getContext('2d');
  // 看板在畫布座標裡的範圍（兩者都在 #stage 裡，offset 直接相減）
  const hud=document.getElementById('hud');
  const hudRect = hud && hud.offsetWidth ? { x:hud.offsetLeft-cv.offsetLeft, y:hud.offsetTop-cv.offsetTop,
                                              w:hud.offsetWidth, h:hud.offsetHeight } : null;
  const DW=CW, DH=CH/2;
  g.save();
  g.font='12px "Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif';
  g.textAlign='center'; g.textBaseline='middle';
  for(const t of tags){
    const id=String(t.key||'').slice(2);   // key = 'p:' + 成員 id
    let msg=null;
    for(let i=list.length-1;i>=0;i--){ const m=list[i]; if(!m.sys&&m.from===id){ msg=m; break; } }
    if(!msg || now-msg.at>BUBBLE_MS) continue;
    const chars=[...msg.text];
    const txt=chars.length>BUBBLE_CHARS ? chars.slice(0,BUBBLE_CHARS).join('')+'…' : msg.text;
    const w=g.measureText(txt).width+12, h=18;
    const cx=Math.max(w/2+1, Math.min(cv.width-w/2-1, t.x*DW));
    let cy=Math.max(h/2+1, t.top*DH-h/2-6);
    // 右上角的日期／天氣看板（HTML 疊層）蓋在畫布上面：泡泡撞到它就改放到名牌下面
    if(hudRect && cx+w/2>hudRect.x && cx-w/2<hudRect.x+hudRect.w && cy-h/2<hudRect.y+hudRect.h && cy+h/2>hudRect.y)
      cy=Math.min(cv.height-h/2-1, t.y*DH+12+h/2+2);
    g.fillStyle='rgba(240,240,245,.95)'; g.strokeStyle='rgba(0,0,0,.6)'; g.lineWidth=1;
    g.beginPath(); g.roundRect(cx-w/2, cy-h/2, w, h, 6); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(cx-4,cy+h/2); g.lineTo(cx,cy+h/2+5); g.lineTo(cx+4,cy+h/2); g.fill();
    g.fillStyle='#1f2328'; g.fillText(txt,cx,cy+1);
  }
  g.restore();
}
function chatSubmit(){
  const ci=document.getElementById('chatin');
  const v=ci.value.trim(); if(!v) return;
  sendCmd('plazaChat',{text:v}).then(r=>{ if(r&&r.ok){ ci.value=''; poll(); } });
}
document.getElementById('chatsend').addEventListener('click',chatSubmit);
document.getElementById('chatin').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.isComposing) chatSubmit(); });

// 名牌：用正常字型畫在腳下置中（伺服器只給位置與顏色）。格子太小，塞進格子會變細長條。
// 深色描邊讓名字在任何天氣、任何角色顏色上都讀得到。
function drawNameTags(tags){
  if(!tags||!tags.length) return;
  const cv=document.getElementById('pet'), g=cv.getContext('2d');
  const DW=CW, DH=CH/2;
  g.save();
  g.font='bold 12px "Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif';
  g.textAlign='center'; g.textBaseline='top';
  g.lineJoin='round'; g.lineWidth=3; g.strokeStyle='rgba(0,0,0,.85)';
  for(const t of tags){
    const w=g.measureText(t.text).width;
    const x=Math.max(w/2+1, Math.min(cv.width-w/2-1, t.x*DW));
    const y=Math.min(cv.height-13, t.y*DH);
    g.strokeText(t.text,x,y);
    g.fillStyle=t.color; g.fillText(t.text,x,y);
    // 對戰中：頭上 ⚔（旁觀的人才知道那兩隻為什麼停住）
    if(t.battling){
      const bx=t.x*DW, by=Math.max(2,t.top*DH-16);
      g.strokeText('⚔',bx,by); g.fillStyle='#f0883e'; g.fillText('⚔',bx,by);
    }
    // 手動模式放太久睡著了：頭上冒 z（跟家裡睡覺的 Zzz 同一個意思）
    if(t.sleeping){
      const zx=t.x*DW+10, zy=Math.max(2,t.top*DH-12);
      g.strokeText('z',zx,zy+4); g.fillStyle='#c9d1d9'; g.fillText('z',zx,zy+4);
      g.font='bold 9px sans-serif'; g.strokeText('z',zx+9,zy-2); g.fillText('z',zx+9,zy-2);
      g.font='bold 12px "Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif';
    }
  }
  g.restore();
}

async function poll(){
  if(view==='plaza'){
    try{ await pollPlaza(); lastFetch=Date.now(); }
    catch(e){ document.getElementById('err').textContent='fetch fail: '+e.message; }
    return;
  }
  if(view==='yard'){
    try{ await pollYard(); lastFetch=Date.now(); }
    catch(e){ document.getElementById('err').textContent='fetch fail: '+e.message; }
    return;
  }
  try{
    const s=await (await fetch('/state',{cache:'no-store'})).json();
    lastState=s;
    // 廣場是 daemon 的狀態，不是分頁的：別的分頁按了進場，這個分頁也要跟著進去。
    if(s.plaza){
      plazaNoticeCheck(s.plaza.notice);
      if(s.plaza.active){ setView('plaza'); return; }
    }
    syncJogress(s.jogress);
    lastFetch=Date.now();
    document.getElementById('tick').textContent='#'+s.tick;
    document.getElementById('kind').textContent=s.kind;
    // cut-in 想吃滿整個畫面，上下那 1 dot 留白會透出底圖，看起來像沒對齊 → 塗黑當黑邊。
    // 戰鬥只在真正演 cut-in 的那幾拍套（打鬥過程不套，那時留白透出底圖是正常的）；
    // 卡片右半整片都是 CutIn 圖，所以整段顯示期間都套。
    document.getElementById('stage').classList.toggle('letterbox', !!s.cutIn || s.kind==='card');
    document.getElementById('char').textContent=s.character;
    document.getElementById('uptime').textContent=Math.round(s.uptimeSec)+'s';
    draw(s.petLines);
    const u=s.usage||{};
    document.getElementById('asess').textContent=(u.activeSession||'–').slice(0,8);
    document.getElementById('acost').textContent='$'+(u.activeCostUSD||0).toFixed(4);
    document.getElementById('tcost').textContent='$'+(u.totalCostUSD||0).toFixed(2);
    const bs=u.bySource||{};
    document.getElementById('bysrc').textContent=
      Object.keys(bs).length ? Object.entries(bs).map(([k,v])=>k+' $'+v.toFixed(2)).join('　') : '';
    document.getElementById('burn').textContent=(u.burn10mTokens||0).toLocaleString()+' tok / $'+(u.burn10mCostUSD||0).toFixed(4);
    document.getElementById('lastact').textContent=(u.lastActivityAgoSec==null?'?':u.lastActivityAgoSec+'s 前');
    document.getElementById('scan').textContent=(u.scannedFiles||0)+' 檔 / '+(u.uniqueMessages||0).toLocaleString()+' unique msg';
    document.getElementById('err').textContent=s.err?('⚠️ '+s.err):'';
  }catch(e){document.getElementById('err').textContent='fetch fail: '+e.message;}
}
// 提示字 3 秒後自動淡出（每次新訊息都重設計時，連續操作不會被前一則的倒數提前清掉）
let cmdMsgTimer=null;
function flashCmdMsg(text,color){
  const el=document.getElementById('cmdmsg');
  el.textContent=text; el.style.color=color; el.style.opacity='1';
  if(cmdMsgTimer)clearTimeout(cmdMsgTimer);
  cmdMsgTimer=setTimeout(()=>{ el.style.opacity='0'; },3000);
}
// 子行程的輸出是給終端機看的，帶 ANSI 色碼 → 網頁顯示前先剝掉
const stripAnsi = s => String(s).replace(/\[[0-9;]*[A-Za-z]/g,'');
function showOutput(text){
  const el=document.getElementById('cmdout');
  if(!text){ el.style.display='none'; return; }
  el.textContent=stripAnsi(text); el.style.display='block';
}
// 指令失敗時訊息列要顯示什麼。**把 CLI 講的理由直接放上去**，不要只說「失敗：keep」。
// 舊版就是只說動作名：走 CLI 的指令 r.error 是 undefined，於是永遠顯示「失敗：<動作>」，
// 而真正有用的那句（例如「營地已滿（5/5）。先 vpet release…」）被塞進畫布下方的輸出區
// —— 按了鈕只看到一句沒資訊的紅字，不會知道為什麼，也不會想到要往下看。
// 取第一行非空白：CLI 的第一行就是給人看的結論，後面常是細節或清單。
function failMsg(r,action){
  // ⚠️ 這一段活在前端的 template literal 裡，**反斜線會被吃掉一次**，
  //    所以這裡不能出現任何反斜線跳脫（連註解裡都不行 —— 那會變成真的換行，
  //    把 // 註解截斷、後半段變成語法錯誤，整頁的 JS 全死）。改用碼點取換行。
  const NL = String.fromCharCode(10);
  const why = r.error || String(r.output||'').split(NL).map(x=>x.trim()).find(Boolean);
  return why || ('失敗：'+action);
}

async function sendCmd(action,args){
  try{
    const r=await (await fetch('/cmd',{method:'POST',headers:{'Content-Type':'application/json'},
                                       body:JSON.stringify({action,args:args||{}})})).json();
    const MOOD={happy:'摸摸 ♥',wake:'把牠叫醒了',refuse:'牠生氣了！別一直戳',sulking:'鬧脾氣中…不理你',asleep:'牠睡死了，叫不動（vpet wake 才會醒）'};
    // 抓起／放下不報訊息：成功與否眼睛直接看得到（牠就在游標上），
    // 每拖一次洗一行「已送出：yardGrab」只是把訊息列變成雜訊。失敗還是要講。
    const quiet=(action==='yardGrab'||action==='yardDrop'||action==='plazaMove'||action==='plazaMode'||action==='plazaChat'||action==='plazaAnswer');
    if(!(quiet&&r.ok))
      flashCmdMsg(r.ok ? (MOOD[r.mood] || ('已送出：'+action)) : failMsg(r,action),
                  r.ok ? ((r.mood==='refuse'||r.mood==='sulking')?'#d29922':'#3fb950') : '#f85149');
    // 回傳帶網址的指令（走動範圍編輯器）：server 才剛 spawn，等一下再開分頁，
    // 不然會開到「連線被拒」的錯誤頁，使用者只好自己重整。
    if(r.ok && r.url) setTimeout(()=>window.open(r.url,'_blank'), 900);
    // 有回應文字的指令（doctor / stats / code / reset…）把 CLI 輸出原樣秀出來；
    // 失敗時也要顯示 —— 「找不到角色」那種訊息正是使用者需要看到的
    if(!quiet) showOutput(r.output || r.error || '');
    // 營地操作是「排入 force、下一拍才生效」，所以要等一拍再刷，否則看到的還是舊名單
    if(['keep','swap','release','jogress'].includes(action)) setTimeout(poll, 1300);
    // 摸摸馬上刷一次，不然要等下一次輪詢（最多 500ms）才看到牠跳起來，
    // 點下去到有反應之間那半秒會讓人以為沒點到。
    if(action==='yardPet') poll();
    return r;                        // 抓起來那次要拿回牠的點陣（見 startDrag）
  }catch(e){ flashCmdMsg('送出失敗：'+e.message,'#f85149'); return null; }
}
document.querySelectorAll('#controls button').forEach(b=>b.addEventListener('click',()=>{
  // 廣場：要連網路，回來成功才換畫面；失敗的理由（連不上、人滿、正在進化…）由 sendCmd 顯示
  // 能不能出門（進化中、戰鬥中、睡覺中）由伺服器端的 plazaBlocked 判，這裡不另寫一份。
  if(b.dataset.cmd==='plaza'){
    flashCmdMsg('連線到廣場…','#8b949e');
    sendCmd('plazaJoin').then(r=>{ if(r&&r.ok) setView('plaza'); });
    return;
  }
  if(b.dataset.cmd==='plazaLeave'){
    sendCmd('plazaLeave').then(()=>setView('home'));
    return;
  }
  // 院子只是換這個分頁在看哪裡，不是送指令給 daemon
  if(b.dataset.cmd==='yard'){
    if(view!=='yard'){
      const why=yardBlocked();
      if(why){ flashCmdMsg(why,'#d29922'); return; }
    }
    setView(view==='yard'?'home':'yard');
    return;
  }
  const cmd=b.dataset.cmd;
      // 滿了就直接說，不要先問「確定嗎？」再告訴使用者做不到。
      // 人數前端本來就有（/yard 的 kept/cap、或 /state 的 ranch），只是以前沒拿來用。
      // 這只是省一次無謂的確認 —— 真正的把關仍然在 CLI 那一道（見 --keep）。
      if(cmd==='keep'){
        const r=ranchFull();
        if(r && r.full){
          flashCmdMsg('營地已滿（'+r.kept+'/'+r.cap+'）。先放生一隻，或改用「換出營地」。','#d29922');
          return;
        }
      }
  if(cmd==='jogress'){
    const o=jgPicked();
    if(!o){ flashCmdMsg('現在沒有成立的合體組合。','#d29922'); return; }
    if(!confirm(jogressConfirmText(o))) return;
    sendCmd('jogress',{which:o.id});
    return;
  }
  const c=b.dataset.confirm;
  if(c && !confirm(c)) return;      // 破壞性操作（重抽）先問一次
  sendCmd(cmd);
}));
// 進階區：把該列的輸入框收成 {欄位:值} 一起送出。
// 一列可以有多顆鈕（開/關成對的開關）→ 動作優先取按鈕自己的 data-cmd，沒有才用整列的。
document.querySelectorAll('#adv .form').forEach(row=>{
  const collect=()=>{
    const args={};
    row.querySelectorAll('input').forEach(i=>{ if(i.value.trim()) args[i.dataset.f]=i.value.trim(); });
    return args;
  };
  row.querySelectorAll('button').forEach(b=>
    b.addEventListener('click',()=>{
      const cmd=b.dataset.cmd||row.dataset.cmd;
      // 滿了就直接說，不要先問「確定嗎？」再告訴使用者做不到。
      // 人數前端本來就有（/yard 的 kept/cap、或 /state 的 ranch），只是以前沒拿來用。
      // 這只是省一次無謂的確認 —— 真正的把關仍然在 CLI 那一道（見 --keep）。
      if(cmd==='keep'){
        const r=ranchFull();
        if(r && r.full){
          flashCmdMsg('營地已滿（'+r.kept+'/'+r.cap+'）。先放生一隻，或改用「換出營地」。','#d29922');
          return;
        }
      }
      const c=b.dataset.confirm;
      if(c && !confirm(c)) return;    // 破壞性操作（重抽）先問一次
      sendCmd(cmd,collect());
    }));
  row.querySelectorAll('input').forEach(i=>
    i.addEventListener('keydown',e=>{ if(e.key==='Enter')sendCmd(row.dataset.cmd,collect()); }));
});
// 廣場裡改名牌：存到跟「🏷 名牌」同一個地方，再同步到廣場（見 plazaRename）
function plazaRenameSubmit(){
  const ni=document.getElementById('plazaname');
  const v=ni.value.trim(); if(!v) return;
  ni.blur();
  sendCmd('plazaRename',{name:v}).then(r=>{ if(r&&r.ok) poll(); });
}
document.getElementById('plazarename').addEventListener('click',plazaRenameSubmit);
// 名牌顏色：放開選色器（change）才送，拖曳中的 input 事件不送，免得一拖送幾十次
document.getElementById('plazacolor').addEventListener('change',e=>{
  sendCmd('plazaColor',{color:e.target.value}).then(r=>{ if(r&&r.ok) poll(); });
});
document.getElementById('plazaname').addEventListener('keydown',e=>{ if(e.key==='Enter') plazaRenameSubmit(); });

// ── 廣場：自動／手動（WASD）──
// 只在「方向真的改變」時送一次（按下、放開、換方向），按住不放不重送 ——
// 位置是大家用同一個公式算的（見 plaza-walk 的 manualPos），伺服器只要知道方向何時改變。
let plazaMode='auto';
document.getElementById('plazamode').addEventListener('click',()=>{
  const to = plazaMode==='manual' ? 'auto' : 'manual';
  plazaKeys.clear(); plazaDir='0,0';
  sendCmd('plazaMode',{mode:to}).then(r=>{ if(r&&r.ok){ plazaMode=to; poll(); } });
});
const PLAZA_KEYS={w:[0,-1],a:[-1,0],s:[0,1],d:[1,0],
                  arrowup:[0,-1],arrowleft:[-1,0],arrowdown:[0,1],arrowright:[1,0]};
const plazaKeys=new Set();
let plazaDir='0,0';
function plazaSteer(){
  let vx=0, vy=0;
  for(const k of plazaKeys){ vx+=PLAZA_KEYS[k][0]; vy+=PLAZA_KEYS[k][1]; }
  vx=Math.sign(vx); vy=Math.sign(vy);
  const d=vx+','+vy;
  if(d===plazaDir) return;
  plazaDir=d;
  sendCmd('plazaMove',{vx:String(vx),vy:String(vy)}).then(()=>poll());
}
// 正在打字（名牌欄）時，WASD 是字，不是移動
const typing=()=>{ const a=document.activeElement; return a && (a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.tagName==='SELECT'); };
addEventListener('keydown',e=>{
  const k=e.key.toLowerCase();
  if(view!=='plaza'||plazaMode!=='manual'||!PLAZA_KEYS[k]||typing()) return;
  e.preventDefault();                       // 方向鍵不要捲動頁面
  if(!plazaKeys.has(k)){ plazaKeys.add(k); plazaSteer(); }
});
addEventListener('keyup',e=>{
  const k=e.key.toLowerCase();
  if(!plazaKeys.has(k)) return;
  plazaKeys.delete(k); plazaSteer();
});
// 切走視窗時 keyup 收不到 → 不清掉的話角色會一直走下去
addEventListener('blur',()=>{ if(plazaKeys.size){ plazaKeys.clear(); plazaSteer(); } });
// release 版沒有這顆下拉（dev 專屬），所以要防呆
for(const id of ['wxsel','wxcold','wxnight']){
  const e=document.getElementById(id);
  if(e) e.addEventListener('change',()=>{ if(view==='yard') poll(); });
}
// 點角色＝摸摸（連戳會生氣）。
// 營地那一下要先做命中判定：畫布上有好幾隻，而 pet 指令是作用在現役那隻的 ——
// 直接送出去會變成「摸了一隻、爽到另一隻」。所以營地走 yardPet + 內部 id。
// 而且營地的摸摸是**純表演，不動心情值** —— 冰箱裡的東西不會因為你戳牠而變好或變壞。
document.getElementById('pet').addEventListener('click',ev=>{
  // 營地改走 mousedown/mouseup（要分辨短按與長壓），這裡只剩家裡那條路
  if(view==='home') sendCmd('pet');   // 廣場裡點別人的 vpet 是第 3 期（邀請對戰）
});

// ── 長壓把 vpet 拿起來，放開丟下 ─────────────────────────────────────
// 拿在手上的那隻**不在伺服器合成的那張圖裡**（見 plaza.js 的 held），改由這裡
// 跟著游標畫在天氣那層疊加畫布上 —— 那層本來就有 60fps 的 rAF 迴圈，等於免費。
// 若改成讓伺服器每幀重畫，就得把 /yard 從 4fps 拉到 60fps（15KB x 60），完全不划算。
// 低於這個時間放開 = 摸摸，超過就把牠拎起來。
// 一路從 500 降到 200 再到 120：拎起來這個動作在手裡要「跟手」，等待感一旦被察覺，
// 讀起來就是介面在卡而不是我在長壓。
// ⚠️ 120 已經接近下限。有意識地點一下大約是 60–120ms，再往下砍就會開始把
//    「摸摸」判成「拎起來」—— 那是把一個正常操作弄壞，比反應慢更糟。
const LONGPRESS_MS=120;
const MOVE_TOL=1.5;       // dot。按著微微晃動不該被當成想拖曳
// 拎起／放下的上下位移。沒有它的話拿起來是「瞬間貼到游標」、放開是「瞬間出現在地上」，
// 讀起來像瞬移而不是被拿起來。
const LIFT_DOTS=2.5;      // 離地多高
const LIFT_MS=140;        // 抬起來（ease-out：一開始快，到頂變慢）
const FALL_MS=180;        // 落下（ease-in：像重力，越掉越快）
// phase：lift（拿著）→ fall（放手、落下中）→ landed（落地了，等伺服器的畫面把牠畫回去）
// wait：剛拿起來，伺服器的畫面裡牠還在地上 —— 這段期間手上那份先不畫（見 dragHandoff）
let drag=null;            // { id, frames, ox, oy, x, y, phase, t0, liftFrom, wait }
let press=null, pressTimer=null;

// 現在離地多少 dot（負值 = 往上）。時間走牆鐘，不跟 rAF 的時戳混用。
function liftNow(){
  if(!drag || drag.phase==='landed') return 0;
  const e=Date.now()-drag.t0;
  if(drag.phase==='fall'){ const p=Math.min(1,e/FALL_MS); return drag.liftFrom*(1-p*p); }
  const p=Math.min(1,e/LIFT_MS);
  return -LIFT_DOTS*(1-(1-p)*(1-p));
}

// 拎起／放下的交接。畫面上有兩份東西：伺服器合成的那張（拿著的那隻會被略過），
// 和前端手上畫的那份。兩份同時有牠 = 一瞬間兩隻；兩份都沒有 = 一瞬間消失 —— 回報的「閃爍」
// 就是這兩種。所以交接一律以**伺服器的畫面**為準，在收到新的一張時才換手：
//   拿起：伺服器那張已經沒有牠了 → 手上那份才開始畫（浮起動畫從這一刻起算）
//   放下：伺服器那張已經把牠畫回來了 → 才收掉手上那份
// 換手跟新畫面的 draw() 在同一個 task 裡，下一次重繪之前兩邊就都換好了。
function dragHandoff(y){
  if(!drag) return;
  const onField=((y&&y.pets)||[]).some(p=>p.id===drag.id);
  if(drag.wait && !onField){ drag.wait=false; drag.t0=Date.now(); }
  else if(drag.phase==='landed' && onField){ drag=null; }
}

function cancelPress(){ if(pressTimer){clearTimeout(pressTimer);pressTimer=null;} press=null; }

let grabbing=null;   // 已經送出 yardGrab、還沒回來的那隻
async function startDrag(hit, at){
  grabbing=hit.id;
  const r=await sendCmd('yardGrab',{which:hit.id});
  // ⚠️ 等待期間就放開了（長壓剛好卡在請求來回之間）。這時 mouseup 早就走完了，
  //    再設 drag 的話那隻會在**沒按著滑鼠**的狀態下黏在游標上，滑出畫布就消失，
  //    而且伺服器那邊一直是 held → 合成時被略過 → 看起來就是「被拎起來就不見了」。
  const aborted = grabbing!==hit.id;
  grabbing=null;
  if(!r||!r.ok||!r.frames){ cancelPress(); return; }
  if(aborted){ dropAt(hit.id, r.x, r.y); return; }   // 立刻放回原位
  // 抓取點相對身體的偏移要留著，不然拿起來的瞬間會跳成「以身體左上角對準游標」
  drag={ id:hit.id, frames:r.frames, ox:at.dx-r.x, oy:at.dy-r.y, x:r.x, y:r.y,
         phase:'lift', t0:Date.now(), liftFrom:0, wait:true };
  press=null; pressTimer=null;
  poll();   // 立刻刷一次，把伺服器那張裡的分身換掉（否則最多要等一次輪詢）
}

// 放下。座標夾在場地內 —— 伺服器也會夾一次，這裡夾是為了放開的當下畫面就不會超出去。
// /cmd 的白名單只收字串，座標要自己轉，不然會被整個濾掉（落點永遠變 0,0）。
function dropAt(id, x, y){
  const S=(lastYard&&lastYard.sprite)||16;
  const W=(lastYard&&lastYard.cols)||52, H=((lastYard&&lastYard.rows)||20)*2;
  const cx=Math.max(0,Math.min(W-S, Math.round(x)));
  const cy=Math.max(0,Math.min(H-S, Math.round(y)));
  return sendCmd('yardDrop',{which:id,x:String(cx),y:String(cy)}).then(r=>{
    // 手上那份對齊到伺服器實際落的那一格，交接時才不會挪一下
    if(r && r.ok && drag && drag.id===id && Number.isFinite(r.x)){ drag.x=r.x; drag.y=r.y; }
    poll();
  });
}

document.getElementById('pet').addEventListener('mousedown',ev=>{
  if(ev.button!==0||view!=='yard'||drag) return;   // 還在落下就別又抓一隻
  const hit=yardHit(ev); if(!hit) return;
  ev.preventDefault();                     // 避免拖出瀏覽器原生的「拖曳選取」
  const at=evDot(ev);
  press={ id:hit.id, at, moved:false };
  pressTimer=setTimeout(()=>{ if(press) startDrag(hit,at); }, LONGPRESS_MS);
});

window.addEventListener('mousemove',ev=>{
  if(drag){
    if(drag.phase!=='lift') return;                // 已經放手了，落點固定
    const d=evDot(ev); drag.x=d.dx-drag.ox; drag.y=d.dy-drag.oy; return;
  }
  if(!press) return;
  const d=evDot(ev);
  // 還沒到長壓時間就先移動 = 想拖但手快了；取消倒數，也不要當成摸摸
  if(Math.abs(d.dx-press.at.dx)>MOVE_TOL||Math.abs(d.dy-press.at.dy)>MOVE_TOL) cancelPress();
});

window.addEventListener('mouseup',ev=>{
  if(drag){
    if(drag.phase!=='lift') return;                // 已經在落下了，別重複觸發
    // 落下期間伺服器那邊仍然是 held（合成時被略過），所以畫面上只有這一份；
    // 落地之後才送 yardDrop 交回去 —— 中途交回去會看到牠瞬間出現在地上。
    drag.liftFrom=liftNow(); drag.phase='fall'; drag.t0=Date.now();
    const d=drag;
    setTimeout(()=>{
      if(drag!==d) return;
      // ⚠️ 落地了也**不能**馬上收掉手上這份：伺服器的畫面要等 yardDrop 和下一次 /yard
      //    兩趟來回才會把牠畫回去，中間那段兩邊都沒有牠 = 消失一下。停在地上繼續畫，
      //    由 dragHandoff 看到伺服器畫回來了才收。
      d.phase='landed';
      dropAt(d.id,d.x,d.y);
      // 保險：放下失敗（伺服器那邊早就不是拿著了）就永遠等不到畫回來 —— 不能一直掛在畫面上
      setTimeout(()=>{ if(drag===d) drag=null; }, 2000);
    }, FALL_MS);
    return;
  }
  // 長壓已經觸發、但 yardGrab 還沒回來 → 標記成取消（見 startDrag 的 aborted）。
  // 不當成摸摸：使用者確實按滿了長壓時間，那不是「點一下」。
  if(grabbing){ grabbing=null; cancelPress(); return; }
  if(press&&view==='yard'){ sendCmd('yardPet',{which:press.id}); }   // 短按 = 摸摸
  cancelPress();
});
setInterval(()=>{document.getElementById('fetchAge').textContent=Math.round((Date.now()-lastFetch)/1000)+'s';},250);
// 輪詢節奏依畫面而定：院子要 ${YT.POLL_MS}ms —— 摸摸的騰空只有那麼久，輪詢慢於它
// 就會整個被取樣漏掉（跳躍的節奏與這個數字綁在一起，見 yard-touch.js）。
// 家裡沒有這種需求，維持 500ms，不必為了沒人在看的畫面多打一倍的請求。
//
// 用自己排下一次而不是 setInterval：/yard 偶爾比間隔慢時，setInterval 會讓請求疊在
// 一起，畫面反而更頓。
const POLL_MS={home:500,yard:${YT.POLL_MS},plaza:250};   // 廣場：一拍 750ms，輪詢要比一拍密才不會跳格
(function pollLoop(){ poll().finally(()=>setTimeout(pollLoop, POLL_MS[view]||500)); })();
</script></body></html>`;

const server = http.createServer((req, res) => {
    // 舞台底圖：使用者自己放的圖（scripts/make-bg.js 產出）。沒放就 404，CSS 退回純色。
    // 刻意不內嵌進 js、也不隨 release 出貨 —— 底圖是個人化的東西，每個人的照片不一樣，
    // 塞進 repo 只會讓 daemon.js 或 release 無謂變肥。
    if (req.url === '/bg') {
        try {
            const buf = fs.readFileSync(BG_FILE);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
            res.end(buf);
        } catch (e) {
            res.writeHead(404); res.end();
        }
        return;
    }
    // 院子：營地成員 + 現役在同一個舞台散步（docs/ranch-spec.md 階段 2）。
    // 每次請求現算 —— 合成 20 隻約 0.3ms，沒必要放進主 tick 迴圈給不看院子的人付成本。
    // 名單直接讀 ranch.json，不經過 latest 快取：營地剛改完就要看得到。
    if (req.url === '/yard' || req.url.startsWith('/yard?')) {
        let body;
        try {
            const ranch = core.loadRanch();
            const st    = loadState(STATE_FILE);
            const step  = plazaStep();
            // ?w=rain / ?w=storm+cold → 預覽指定天氣（見 weatherFor）
            const wq    = new URL(req.url, 'http://x').searchParams.get('w');
            const wx    = weatherFor(wq);
            // ?zl=quadFull / ?zl=triangle → 預覽別的走動分區切法（dev 下拉用）。
            // 跟 ?w= 一樣是**這次請求**的覆寫，不寫進任何狀態。切法一換，每隻的
            // field 就換 → posAt 的 epoch 跟著變 → 舊快取自動作廢，不用另外清。
            const zoneLayout = new URL(req.url, 'http://x').searchParams.get('zl') || null;
            const alive = new Set((ranch.pets || []).map(p => p.id));
            const out   = plaza.composeYard(core, ranch, st, step,
                                            { caches: yardCaches, react: yardReactMap(alive),
                                              layout: zoneLayout });
            // 場地尺寸一定要回傳，**空營地時尤其重要**：沒有這個，前端拿不到尺寸只能
            // 沿用上一次畫過的畫布（家裡那個 52 欄的小舞台），空營地看起來就變成
            // 一個小方塊，像功能壞掉而不是「這裡還沒有東西」。
            const F = plaza.YARD_FIELD;
            // 帶座標與資料出去，讓前端能做右鍵選單：click 座標 -> 哪一隻。
            // 命中判定放前端而不是再開一個 /yard/hit 端點 —— 位置每拍都在動，
            // 多一次往返就會對到上一拍的位置，點了會抓錯人。
            const byId = Object.fromEntries((ranch.pets || []).map(p => [p.id, p]));
            const info = (id) => {
                const p = byId[id]; if (!p) return {};
                const st = p.state || {}, cid = st.characterId;
                let stage = '?', power = '?';
                try { stage = core.getCharacterStage(cid); } catch (e) {}
                try {
                    power = Math.min(core.getBasePower(st, cid) + (st.trainingBonus || 0),
                                     core.getTierCap(stage));
                } catch (e) {}
                const b = st.battleTotalCount || 0, w = st.battleWinCount || 0;
                return { stage, power, battles: b, wins: w,
                         winPct: b ? Math.floor(w / b * 100) : null, keptAt: p.keptAt,
                         // 在營地裡自己變掉的（大便獸彩蛋）：右鍵選單要顯示原本是誰
                         wasName: p.evolvedFrom ? core.getDisplayName(p.evolvedFrom) : null };
            };
            // 分區資訊：dev 的「走動範圍」開關要把框與定位點畫出來。
            // 一律回傳（不看 release）—— 它只是幾個數字，藏起來反而讓前端要多一條分支。
            // ⚠️ 一定要用 yardZonesFor（含編輯器存的覆寫檔），不是 plaza.yardZones（只有內建表）。
            //    合成走的是前者、payload 走後者的話，角色照新切法走、框卻畫舊的，
            //    看起來就像「存了沒生效」。踩過一次 —— 兩個來源就是會漂移。
            const zoneInfo = plaza.yardLayoutsFor(core, (ranch.pets || []).length);
            // 前端活在「細格」裡（營地畫小一號，見 plaza.js 的 YARD_RENDER）：
            // 尺寸、每隻的位置、範圍框一律換算成畫出來的座標再送。
            const D = plaza.yardToDraw, R = plaza.YARD_RENDER;
            const zones = plaza.yardZonesFor(core, (ranch.pets || []).length, zoneLayout).map(z => {
                const lo = D(z.minX, z.minY), hi = D(z.maxX, z.maxY), an = plaza.zoneAnchor(z), a = D(an.x, an.y);
                return { minX: lo.x, maxX: hi.x, minY: lo.y, maxY: hi.y, anchor: { x: a.x, y: a.y } };
            });
            body = { ok: true, step, cols: R.w, rows: R.h / 2, sprite: plaza.SPRITE, zones,
                     inPlaza: plazaClient.active(),   // 別的分頁進了廣場 → 這個分頁也要跟進去
                     weather: { ...wx, ...WX.describe(wx) },
                     cap: core.ranchCap(),
                     // dev 下拉要知道這個隻數有哪些切法可挑、現在是哪一個
                     layout: zoneLayout || zoneInfo.def,
                     layouts: zoneInfo.names,
                     kept: (ranch.pets || []).length,
                     lines: out ? out.lines : null,
                     // y 回傳**畫出來**的位置（含跳躍位移），不是地面的 y ——
                     // 前端拿這個做命中判定，用地面 y 的話跳到最高點時點身體會落空。
                     pets: out ? out.placed.map(p => ({
                         id: p.ranchId, name: p.name, char: p.char, zoneIdx: p.zoneIdx,
                         x: p.dx, y: p.dy, ...info(p.ranchId),
                     })) : [] };
        } catch (e) {
            body = { ok: false, error: e.message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
        return;
    }
    // 廣場畫面。跟院子一樣每次請求現算（20 人約 0.3ms）。
    // 不在廣場時回 active:false + 最近一次被帶回前線的原因，前端據此切回前線並顯示。
    if (req.url === '/plaza') {
        let body;
        try {
            if (!plazaClient.active()) {
                body = { ok: true, active: false, notice: plazaNotice };
            } else {
                const me = plazaClient.me();
                const list = plazaClient.roster();
                const occ = list.map(m => ({
                    key: 'p:' + m.id, code: m.name, color: m.color || null, char: m.char, walk: m.walk,
                    battle: !!m.battle,
                }));
                const step = plazaClient.step();
                // 場地與畫法比照營地（69x54 細格、角色 16 細格），原住民先不放。
                // 手動模式用毫秒算位置（每秒 4 格），要給校正過的伺服器時間
                const out = plaza.composePlazaLive(core, occ, step,
                    { caches: plazaCaches, me: me.name, nowMs: Date.now() + plazaClient.skew() });
                const mine = list.find(m => m.id === me.id);
                body = { ok: true, active: true, step, me: me.name, notice: plazaNotice,
                         mode: mine && mine.mode === 'manual' ? 'manual' : 'auto',
                         // 對戰邀請：別人邀我（要回覆）／我邀別人（等回覆）
                         invite: (() => {
                             const inc = plazaClient.incoming(), out = plazaClient.outgoing();
                             const left = (e) => Math.max(0, Math.round((e - (Date.now() + plazaClient.skew())) / 1000));
                             if (inc) return { kind: 'in', inviteId: inc.inviteId, name: inc.fromName, secs: left(inc.expiresAt) };
                             if (out) return { kind: 'out', name: out.toName, secs: left(out.expiresAt) };
                             return null;
                         })(),
                         // 我的對戰演出（前線的戰鬥畫面，頁面疊在廣場上）
                         battle: plazaBattle && latest.kind === 'battle'
                             ? { lines: latest.petLines, opp: plazaBattle.opp.name } : null,
                         cols: plaza.PLAZA_RENDER.w, rows: plaza.PLAZA_RENDER.h / 2,
                         myColor: me.color || null,
                         // 天氣比照營地：用這台 daemon 抓到的（內網大家在同一個城市，各抓各的一樣）
                         weather: (() => { const w = weatherFor(null); return { ...w, ...WX.describe(w) }; })(),
                         names: list.map(m => m.name), lines: out.lines, tags: out.tags,
                         // 聊天：最近 50 則；serverNow 給前端判斷對話泡泡還要不要顯示（5 秒）
                         chat: plazaClient.chat(), serverNow: Date.now() + plazaClient.skew() };
            }
        } catch (e) {
            body = { ok: false, error: e.message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
        return;
    }
    if (req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(Object.assign({}, latest, { uptimeSec: (Date.now() - startedAt) / 1000,
            plaza: { active: plazaClient.active(), notice: plazaNotice } })));
        return;
    }
    if (req.method === 'POST' && req.url === '/cmd') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
            let action = '', args = {};
            try {
                const j = JSON.parse(body);
                action = j.action;
                // 只收字串欄位，長度設限 —— /cmd 是公開端點，別讓瀏覽器塞奇怪東西進 argv
                if (j.args && typeof j.args === 'object') {
                    for (const k of Object.keys(j.args)) {
                        const v = j.args[k];
                        if (typeof v === 'string' && v.length <= 200) args[k] = v.trim();
                    }
                }
            } catch (e) {}
            // 大多數指令是同步的；廣場進場要等網路，回 Promise
            Promise.resolve()
                .then(() => applyCommand(action, args))
                .catch((e) => ({ ok: false, error: e.message }))
                .then((r) => {
                    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(r));
                });
        });
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
});
server.listen(PORT, () => {
    console.log(`🥚 agumon daemon 已啟動  [${AUTHORITATIVE ? '當家 authoritative' : '隔離 isolated'}]`
        + (DAEMON_ONLY ? '  (daemon-only 安裝 → 預設當家)' : ''));
    console.log(`   時鐘：每 ${STEP_MS}ms tick 一次（獨立於 Claude Code）`);
    if (AUTHORITATIVE) {
        console.log(`   ⚠️ 當家模式：寫真 ${STATE_FILE} + heartbeat，statusLine 會退唯讀`);
    } else {
        console.log(`   state：${STATE_FILE}（隔離，不碰正式 color-state.json，跑了不影響 statusLine）`);
    }
    console.log(`   開啟：http://localhost:${PORT}`);
});

// 關掉 daemon 時盡力送一次離場（規格 §六）。送不到也沒關係，伺服器 10 秒後自己清；
// 所以最多等 1 秒，不能讓 Ctrl+C 卡住。
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        if (!plazaClient.active()) process.exit(0);
        const bye = setTimeout(() => process.exit(0), 1000);
        plazaClient.leave().finally(() => { clearTimeout(bye); process.exit(0); });
    });
}
