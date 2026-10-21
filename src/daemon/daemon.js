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

// release 樹（根目錄有 RELEASE）：交給 supervisor —— 先檢查更新、再起子行程跑真正的 daemon
// （docs/update-spec.md）。開發樹沒有 RELEASE，照舊直接跑。VPET_SUPERVISE 給測試用。
const TREE_ROOT = path.resolve(__dirname, '..', '..');
const TREE_IS_RELEASE = fs.existsSync(path.join(TREE_ROOT, 'RELEASE'));
if (require.main === module && !process.env.VPET_CHILD && (TREE_IS_RELEASE || process.env.VPET_SUPERVISE)) {
    require('./supervisor.js').run();
    return;
}
// 我是 supervisor 起的子行程：外殼不在了（tray「結束」只殺得到外殼）就跟著收掉
if (process.env.VPET_PARENT_PID) require('./supervisor.js').watchParent(Number(process.env.VPET_PARENT_PID), () => process.exit(0));

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
const FEST  = require('../shared/festival.js');   // 特殊節日（docs/festival-spec.md）
const wxSrc = require('./weather-source.js');
const PlazaClient = require('./plaza-client');
const HELP  = require('./help-tips');      // 教學的說明表（docs/tutorial-spec.md）
const P2TALK = require('./page2-talk');    // 營地第二頁事件的台詞（docs/yard-page2-spec.md）
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
const DEV_ONLY   = new Set(['battle', 'evolve', 'stats', 'switch', 'pvp-server', 'zoneedit', 'page2Dev', 'duelDev', 'frontMini', 'miniBest']);   // frontMini／miniBest：前線小遊戲（先開發版限定，2026-10-21）
// 廣場管理（踢人、刪聊天）：只有 daemon 有（不是 CLI 指令，不跟上面那份對齊），release 一樣擋
const PLAZA_ADMIN_CMDS = new Set(['plazaKick', 'plazaChatDel', 'plazaChatClear']);

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
    ['card',   '🪪 卡片'],
    ['tree',   '🌳 進化樹'],
    // 拍照（docs/yard-photo-spec.md）：只在營地。不是送給 daemon 的指令，前端自己處理（photoTake）
    ['photo',  '📷 拍照', { scope: 'yard' }],
    ['album',  '📖 圖鑑', { scope: 'both' }],
    ['yard',   '⛺ 營地', { scope: 'both' }],
    // 合體進化：排在第二排的開頭（2026-10-21）。前面那個換行只在按鈕出現時才佔位（見 renderUiButton 的 'br'）
    ['br', '', { scope: 'home', when: 'jogress' }],
    ['jogress', '🧬 合體進化', { scope: 'home', when: 'jogress', accent: true }],
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
    // 換出／放生的兩列拿掉了：營地裡對那隻按右鍵就有（不用先查編號再打字）。
    // swap / release 指令本身留著 —— 右鍵選單送的就是它們，CLI 也照樣能打。
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
    // 前線在玩小遊戲（頁面每幾秒報一次）：vpet 正在玩，沒空打仗 → 自動戰鬥不觸發，也不排隊補打。
    // 這段期間武裝的那一回合直接當作「已經打過」，關掉小遊戲後不會一口氣冒出來
    if (!inPlaza && Date.now() < frontMiniUntil) {
        st._noAutoBattle = true;
        if (!(st.battleStartStep >= 0)) {
            st.battlePending = false;
            if (st.battleArmHookTs) st.battleFiredHookTs = st.battleArmHookTs;
        }
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
        let meArt          = tryLoadArt(artFile), meRightOffset = charDef.RIGHT_OFFSET;
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
        // 愚人節的廣場對戰：只換場上打架的本體，CutIn、子彈照原角色（百變怪本來就是學對方的招）
        const sw = inPlaza ? plazaBattleSwap() : null;
        const swArt = (id) => { try { const c = loadCharacter(id); const a = tryLoadArt(c.artFile); return a ? { a, off: c.charDef.RIGHT_OFFSET } : null; } catch (e) { return null; } };
        const swMe = sw && sw.me ? swArt(sw.me) : null, swOpp = sw && sw.opp ? swArt(sw.opp) : null;
        if (swMe)  { meArt = swMe.a; meRightOffset = swMe.off; }
        if (swOpp) { enemyArt = swOpp.a; enemyRightOffset = swOpp.off; }
        petLines = composeBattleScene({
            frame: result, meArt, enemyArt, meBulletArt, enemyBulletArt, meCutInArt, enemyCutInArt,
            shared: loadShared(), meRightOffset, enemyRightOffset,
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
    // phase：戰鬥演到哪一段（encounter/approach/attack/boom/result），廣場對戰看它決定要不要畫名字
    return { kind: result.kind, petLines, cutIn: !!(result.meCutIn || result.enemyCutIn), phase: result.phase || null };
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
// ── 自動更新（docs/update-spec.md）──
// 版本 = release 樹的 VERSION（發版時寫入）；開發樹沒有 → ''。
// 有沒有新版：問廣場伺服器的 /update/manifest（啟動後 5 秒、之後每 30 分鐘）。
// 只有 supervisor 起的 daemon 才給「有新版本」鈕 —— 按下去是靠外殼重開，沒有外殼就重開不了。
const UPDATER = require('./updater.js');
const MY_VERSION = UPDATER.localVersion(TREE_ROOT);
const UPDATE_CHECK_MS = 30 * 60 * 1000;
let updateAvail = null;     // { version }
async function checkUpdate() {
    if (!TREE_IS_RELEASE && !process.env.VPET_SUPERVISE) return;
    const m = await UPDATER.fetchManifest(UPDATER.baseUrl());
    updateAvail = m && m.version !== MY_VERSION ? { version: m.version } : null;
}
setTimeout(checkUpdate, 5000).unref();
setInterval(checkUpdate, UPDATE_CHECK_MS).unref();
// 上一次啟動前 updater 的結果（state/update.json）：10 分鐘內的才算「剛剛」，頁面顯示一次
function lastUpdateResult() {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'update.json'), 'utf8'));
        if (!j || Date.now() - j.at > 10 * 60 * 1000) return null;
        return { at: j.at, ok: !!j.ok,
                 text: j.ok ? '已更新到新版本（' + j.to + '）' : '自動更新失敗：' + j.error + '（目前仍是舊版）' };
    } catch (e) { return null; }
}

let plazaNotice = null;   // { text, at }：頁面顯示一次就好
const plazaCaches = new Map();
// 下樓梯（docs/plaza-stairs-spec.md）：遊戲中每 50ms 一拍，瀏覽器輪詢跟不上 →
// 開 /stairs/stream（SSE），廣場伺服器送來的遊戲事件原樣推過去。
const stairsStreams = new Set();
function stairsPush(kind, d) {
    const msg = 'event: ' + kind + '\ndata: ' + JSON.stringify(d || {}) + '\n\n';
    for (const res of stairsStreams) { try { res.write(msg); } catch (e) { stairsStreams.delete(res); } }
}
// ── 前線小遊戲（單機）：頁面開著小遊戲時每幾秒報一次 frontMini；超過 FRONT_MINI_TTL 沒報就當作關了（分頁關掉、當掉）
const FRONT_MINI_TTL = 12000;
let frontMiniUntil = 0;
// 單機的個人最佳（只記本機，不進廣場排行榜）：下樓梯記層數、小恐龍記分數
const MINI_BEST_FILE = path.join(STATE_DIR, 'minigame-best.json');
function miniBest(kind, val) {
    let j = {}; try { j = JSON.parse(fs.readFileSync(MINI_BEST_FILE, 'utf8')) || {}; } catch (e) {}
    let record = false;
    if ((kind === 'stairs' || kind === 'dino') && Number.isFinite(val) && val > 0 && val > (j[kind] || 0)) {
        j[kind] = Math.floor(val); record = true;
        try { fs.writeFileSync(MINI_BEST_FILE, JSON.stringify(j)); } catch (e) { console.log('   ⚠️ 小遊戲最佳紀錄存不了：' + e.message); }
    }
    return { stairs: j.stairs || 0, dino: j.dino || 0, record };
}
// art.json 第一幀（上下半格一組）→ 一點一格的 [r,g,b]／null。讀不到 = null
function artDots(file, frame = 0) {
    try {
        const art = JSON.parse(fs.readFileSync(file, 'utf8')), rows = [];
        for (const row of art.frames[frame]) {
            rows.push(row.map(c => (c && c[0] >= 0 ? [c[0], c[1], c[2]] : null)));
            rows.push(row.map(c => (c && c[3] >= 0 ? [c[3], c[4], c[5]] : null)));
        }
        return rows;
    } catch (e) { return null; }
}
// 手動戰鬥被打中的爆炸：一般戰鬥那顆（shared 的 boom，第 2、3 幀交替）
function duelBoom() { const f = path.join(core.ASSETS_DIR, 'shared', 'art.json'); return [artDots(f, 2), artDots(f, 3)]; }
// 房裡每個人的角色點陣（面右／面左 × 待機兩幀、受傷、難過）。開局抓一次，前端自己畫
function stairsSprites(chars) {
    const out = {};
    for (const c of chars || []) {
        if (!c || out[c] || !/^[A-Za-z0-9_-]{1,40}$/.test(c)) continue;
        try {
            // 0 待機一、1 待機二、2 受傷、3 難過、4 攻擊（打排球擊球）、5 開心（贏了）
            // 6 生氣（五子棋：被連成三）
            const f = (facing) => ['IDLE_1', 'IDLE_2', 'HURT', 'SAD', 'ATTACK', 'HAPPY', 'ANGRY'].map((fr, i) =>
                plaza.spriteDots(core, c, i === 1 ? 1 : 0, facing, i < 2 ? null : fr));
            const lc = core.loadCharacter(c);
            out[c] = { r: f('right'), l: f('left'), b: artDots(lc.bulletArtFile), c: artDots(lc.cutinArtFile) };   // 手動戰鬥：子彈、cutin
        } catch (e) {}
    }
    return out;
}
const plazaClient = PlazaClient.create({
    log: (m) => console.log('   🏛 ' + m),
    onLost: (reason) => { plazaNotice = { text: reason + '，已回到前線。', at: Date.now() }; plazaCaches.clear(); plazaBattle = null; },
    // 我是對戰的一方 → 下一拍在前線開演（見 renderTick 的「廣場對戰」）
    onBattle: (b) => { plazaBattle = { ...b, pending: true, seen: false, got: Date.now() }; },
    onInviteClose: (c) => {
        const why = { declined: '對方拒絕了對戰邀請', timeout: '對方沒有回應對戰邀請', left: '對方離開了廣場，邀請取消' }[c.reason];
        if (c.mine && why) plazaNotice = { text: why, at: Date.now() };
    },
    onStairs: (kind, d) => stairsPush(kind, d),
});
// 對戰演出給頁面的樣子。core 的戰鬥畫面最底下有一列名牌，是塞進 8px 格子的文字 ——
// 細長、而且只能對齊到整格，置中會偏（回報過）。這裡把那一列拿掉，改送「名字 + 該站在哪一欄的
// 中心」，前端用正常字型畫。我方固定在左邊 16 格、敵方在右邊 16 格（core 的 BATTLE_ME_LEFT_COL /
// BATTLE_ENEMY_RIGHT_COL）；結算階段 core 不畫名牌（我方移到中央），這裡也跟著不送。
// 爆炸那幾拍也不送：整個畫面是一團爆炸，底下還掛著兩個名字很突兀。
// 愚人節的廣場對戰：打架的兩隻換成**廣場上看到的那隻**百變怪（同一個 key → 同一個變色結果），
// CutIn 照原圖（一眼看得出是誰）。本人關掉節慶造型的那一方照原角色。回傳 { me, opp }，null = 不換。
function plazaBattleSwap() {
    if (!plazaBattle) return null;
    const f = festNow(Date.now() + plazaClient.skew());
    if (!f || !f.swap) return null;
    const me = plazaClient.me();
    const opp = plazaClient.roster().find(m => m.id === plazaBattle.opp.id);
    const pick = (m) => (m && m.costume !== false ? FEST.swapChar(f.swap, 'p:' + m.id) : null);
    return { me: pick(me), opp: pick(opp) };
}
function plazaBattleView(list, me) {
    const H = core.BATTLE_SCENE_HEIGHT || 8, Wd = core.BATTLE_SCENE_WIDTH || 52;
    const lines = latest.petLines || [];
    const opp = list.find(m => m.id === plazaBattle.opp.id);
    const named = lines.length > H && latest.phase !== 'boom';   // core 有加名牌列 = 不是結算階段
    return {
        lines: lines.slice(0, H), opp: plazaBattle.opp.name, phase: latest.phase,
        nameRow: true,   // 底下留一列放名字（營地第二頁的戰鬥沒有名字，不留）
        names: named ? [
            { text: me.name, color: me.color || plaza.NAME_DEFAULT_COLOR, col: 8 },
            { text: plazaBattle.opp.name, color: (opp && opp.color) || plaza.NAME_DEFAULT_COLOR, col: Wd - 8 },
        ] : null,
    };
}
// 廣場對戰（規格 §八）：{ opp:{id,name,char}, win, pending, seen, snap }
//   pending：還沒開演（下一拍 renderTick 會把它變成一場前線戰鬥）
//   seen   ：已經看到 kind === 'battle'（之後不是 battle 了 = 演完，收尾）
let plazaBattle = null;
const PLAZA_BATTLE_STALE_MS = 40000;   // 保險：卡住（例如正在進化而一直開不了打）就放棄
// 與 CLI 的 INSTALL_ROOT/state/pvp.json 是同一份（正式環境 STATE_DIR 就是那裡）；
// 用 STATE_DIR 是為了吃 AGUMON_STATE_DIR —— 測試不能讀寫使用者真正的名牌。
const PVP_FILE = path.join(STATE_DIR, 'pvp.json');
// 節日開關：bg = 營地的節日背景（廣場一律顯示，不吃這個）、costume = 節日造型
// （營地：自己的寵物穿不穿；廣場：要不要讓別人看到我穿）。預設都開。
const FEST_FILE = path.join(STATE_DIR, 'festival.json');
function readFest() {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(FEST_FILE, 'utf8')) || {}; } catch (e) {}
    // 一顆開關管全部：營地背景 + 造型（舊檔的 bg 欄位不再看）
    return { costume: j.costume !== false };
}
function writeFest(patch) {
    const next = { ...readFest(), ...patch };
    fs.mkdirSync(path.dirname(FEST_FILE), { recursive: true });
    fs.writeFileSync(FEST_FILE, JSON.stringify(next, null, 2));
    return next;
}
// 現在是哪個節日。VPET_FESTIVAL=halloween 可以在非節日期間預覽（營地另有 ?fest=）。
// release 不吃預覽：節日背景與造型開關只在活動期間出現
const festNow = (ms, q) => FEST.active(ms, IS_RELEASE ? null : (q || process.env.VPET_FESTIVAL || null));
// bg：這個節日有沒有背景（愚人節沒有 → 廣場照樣顯示自己選的常駐背景）
const festView = (f) => (f ? { id: f.id, name: f.name, acc: f.acc, bg: f.bg !== false } : null);
// 圍爐（春節前一週）：營地／廣場大家圍著圓桌坐。預覽／VPET_FESTIVAL 指定春節時不看日期
const festFeast = (f, ms, q) => FEST.feastOn(f, ms, !IS_RELEASE && !!(q || process.env.VPET_FESTIVAL));
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
    const prof = readProfile();
    const r = await plazaClient.join({ name, color: prof.color, costume: prof.costume, char, stage, pid: plazaPlayerId(),
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
    const costume = readFest().costume;
    try { const j = JSON.parse(fs.readFileSync(PVP_FILE, 'utf8')); return { code: j.code || null, color: j.color || null, costume }; }
    catch (e) { return { code: null, color: null, costume }; }
};
// 玩家代號（廣場排行榜用來認人，改名也是同一個人）：第一次進廣場時產生、存在自己的 state 資料夾，之後固定不變。
// 重灌或換電腦就是新的代號（跟用名牌認人的效果一樣）。讀寫失敗就不帶（伺服器退回用名字認人）。
const PLAYER_ID_FILE = path.join(STATE_DIR, 'plaza-player.json');
function plazaPlayerId() {
    try { const j = JSON.parse(fs.readFileSync(PLAYER_ID_FILE, 'utf8')); if (/^[0-9a-f]{16,32}$/.test(j.pid || '')) return j.pid; } catch (e) {}
    try {
        const pid = require('crypto').randomBytes(12).toString('hex');
        fs.writeFileSync(PLAYER_ID_FILE, JSON.stringify({ pid, at: Date.now() }));
        return pid;
    } catch (e) { console.log('   ⚠️ 存不了玩家代號：' + e.message); return undefined; }
}
let plazaRenameRejected = null;
let plazaRenaming = false;
async function plazaSyncName() {
    if (!plazaClient.active() || plazaRenaming) return null;
    const { code, color, costume } = readProfile();
    const me = plazaClient.me();
    const patch = {};
    if (code && code !== me.name) patch.name = code;
    if ((color || null) !== (me.color || null)) patch.color = color || null;
    if (costume !== (me.costume !== false)) patch.costume = costume;
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
    'switch', 'reset', 'keep', 'swap', 'release', 'jogress', 'pvp', 'drop', 'sleep',
    'page2Fight', 'page2GiveUp', 'page2Dev']);

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
            ranchInfo = { kept: (ranchNow.pets || []).length, cap: core.ranchCap(ranchNow),
                          // 營地第二頁第一階段：「牠逃到營地了」在前線跳一次（看過就記 seen）
                          page2Notice: !!(ranchNow.page2Quest && !ranchNow.page2Quest.seen) };
            jogress = jogressInfo(ranchNow, st);
        } catch (e) {}
        latest = {
            tick: ++tick,
            at: now,
            ranch: ranchInfo,
            jogress,
            kind: out.kind,
            cutIn: !!out.cutIn,                           // 正在演 cut-in 的拍 → 前端塗黑邊
            phase: out.phase,
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

// 圍爐中嗎（跟 /yard 同一套判斷；festQ = dev 的節日預覽）。圍爐不分頁，拎起來要用整份名單。
// 營地現在走哪一張場地（一頁／兩頁寬）、前端那一頁在兩頁寬畫布上的左緣。拎起來與放下都要跟
// /yard 合成時同一套，不然拎起來那一下位置對不上畫面（跳一下）、放下去落到別的地方。
function yardGeomNow(ranch, fest) {
    return plaza.yardWide(ranch, { feast: yardFeastNow(fest) }) ? plaza.YARD_GEOM_WIDE : plaza.YARD_GEOM;
}
function yardPageX0(ranch, fest, pg) {
    return plaza.yardWide(ranch, { feast: yardFeastNow(fest) }) ? plaza.yardPageX(Number(pg) || 0) : 0;
}
function yardFeastNow(festQ) {
    const fest = festNow(Date.now(), festQ || null);
    return !!(readFest().costume && festFeast(fest, Date.now(), festQ || null));
}

// ── 營地第二頁的事件（docs/yard-page2-spec.md「表演」）────────────────
// 進度全在 ranch.json（page2Quest → page2Fight → page2Result），前端只負責演：
//   page2Quest  打贏 Diablomon 後的待觸發（seen = 前線提示看過了）
//   page2Fight  挑好一隻、開打（勝負在開打那一刻就決定，跟一般戰鬥一樣）
//   page2Result 打完／放棄的結果，前端演完結果那段（對話、鏡頭、空降）再 page2Ack 清掉
let page2ForceWin = null;   // dev：下一場強制勝／敗（null = 照機率）

function page2StartFight(which) {
    const ranch = core.loadRanch();
    if (!ranch.page2Quest) return { ok: false, error: '現在沒有挑戰' };
    if (ranch.page2Fight) return { ok: false, error: '已經在打了' };
    const pet = (ranch.pets || []).find(p => p.id === which);
    const cid = pet && pet.state && pet.state.characterId;
    if (!cid) return { ok: false, error: '這隻不在營地裡' };
    const F = core.PAGE2_FINAL, seed = Date.now();
    // 營地裡的桌寵以收進去時的戰力（凍結的 state）算勝率，跟一般戰鬥同一條公式
    const win = page2ForceWin != null ? page2ForceWin
              : core.seedRand01(seed) < core.computeWinProb(cid, pet.state, F);
    page2ForceWin = null;
    ranch.page2Fight = { id: which, char: cid, win, version: core.pickBattleVersion(cid, F),
                         startStep: plazaStep() + 1 };
    ranch.page2Quest.seen = true;
    core.saveRanch(ranch);
    return { ok: true, action: 'page2Fight' };
}

// 打完了 → 結算。/yard 每次都先跑這個，所以關掉分頁、中途切回前線都照結果處理。
const PAGE2_EXIT_DOTS = 6;   // 退場：每拍往右幾細格（約 4 拍退出畫面）
function page2Settle(ranch, step) {
    const r = ranch.page2Result;
    // 敵人站在離右緣 SPRITE+4 細格的地方（composeYardStandoff），挪超過這段就整隻出畫面了
    if (r && !r.win && r.exitStep && (step - r.exitStep) * PAGE2_EXIT_DOTS >= plaza.SPRITE + 4) {
        delete ranch.page2Result;   // 退出畫面了 → 營地回到平常
        core.saveRanch(ranch);
        return true;
    }
    const f = ranch.page2Fight;
    if (!f || step - f.startStep < core.battleLength(f.version)) return false;
    delete ranch.page2Fight;
    let keramonId = null;
    if (f.win) keramonId = core.page2Grant(ranch);
    else delete ranch.page2Quest;          // 輸了：從打 Diablomon 重來
    ranch.page2Result = { win: !!f.win, keramonId, step, at: Date.now() };
    core.saveRanch(ranch);
    return true;
}

// 營地 Armagemon 戰的一拍（蓋在營地畫面上，跟廣場對戰同一個 battlebox）
function page2FightLines(f, step) {
    const elapsed = step - f.startStep;
    if (elapsed < 0) return null;
    let me, en;
    try { me = loadCharacter(f.char); en = loadCharacter(core.PAGE2_FINAL); } catch (e) { return null; }
    const frame = core.decideBattleFrame(elapsed, f.win, core.PAGE2_FINAL, me.charDef.F, f.version === 2);
    return composeBattleScene({
        frame, shared: loadShared(),
        meArt: tryLoadArt(me.artFile), enemyArt: tryLoadArt(en.artFile),
        meBulletArt: tryLoadArt(me.bulletArtFile), enemyBulletArt: tryLoadArt(en.bulletArtFile),
        meCutInArt: tryLoadArt(me.cutinArtFile), enemyCutInArt: tryLoadArt(en.cutinArtFile),
        meRightOffset: me.charDef.RIGHT_OFFSET, enemyRightOffset: en.charDef.RIGHT_OFFSET,
    });
}

// 這一刻營地該演什麼（null = 平常）。standoff = 要畫對峙畫面；enemyDx = 敵人退場位移
function page2Event(ranch, step) {
    const r = ranch.page2Result;
    if (r) {
        // 輸了／放棄：助手講完（page2Ack 記下 exitStep）Armagemon 才往右退場，我方繼續站著；
        // 贏了直接回平常的營地（前端帶去第二頁）
        return r.win ? { stage: 'result', win: true, keramonId: r.keramonId }
                     : { stage: 'result', win: false, gaveUp: !!r.gaveUp, standoff: true, exiting: !!r.exitStep,
                         enemyDx: r.exitStep ? Math.max(0, step - r.exitStep) * PAGE2_EXIT_DOTS : 0 };
    }
    const f = ranch.page2Fight;
    if (f) return { stage: 'fight', standoff: true, battle: { lines: page2FightLines(f, step) },
                    fighter: { id: f.id, name: core.getDisplayName(f.char) } };
    // 營地空了就沒人能出戰 → 先不觸發，等有桌寵再說
    if (ranch.page2Quest && (ranch.pets || []).length) return { stage: 'standoff', standoff: true };
    return null;
}

// dev：預覽用（release 由 DEV_ONLY 擋掉）。PAGE2_ENABLED 關著也能用 —— 這就是「做一版但不實裝」的入口
// 手動戰鬥的 dev 測試：我（前線那隻、廣場用的戰力）對上同階隨機一隻、戰力在那一階的範圍內隨機。
// 對手每回合隨機移動、隨機攻擊、隨機力度（頁面本地跑 duel-sim，不經伺服器）
function duelDev() {
    const st = loadState(STATE_FILE);
    const char = st.characterId || 'agumon';
    let stage = 'Child';
    try { stage = getCharacterStage(char) || stage; } catch (e) {}
    let str = 0;
    try { str = Math.min(core.getBasePower(st, char) + (st.trainingBonus || 0), core.getTierCap(stage)); } catch (e) {}
    let roster = [];
    try { const raw = JSON.parse(fs.readFileSync(path.join(core.ASSETS_DIR, 'roster.json'), 'utf8')); roster = Array.isArray(raw) ? raw : raw.roster; } catch (e) {}
    const same = roster.filter(c => c !== char && (() => { try { return getCharacterStage(c) === stage; } catch (e) { return false; } })());
    const opp = same.length ? same[Math.floor(Math.random() * same.length)] : char;
    const pw = same.map(c => core.getCharacterPower(c) || 0).filter(n => n > 0);
    const cap = core.getTierCap(stage), lo = pw.length ? Math.min(...pw) : 1, hi = Number.isFinite(cap) ? cap : Math.max(lo, ...pw);
    const oppStr = lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1));
    const nm = (c) => { try { return core.getDisplayName ? core.getDisplayName(c) : c; } catch (e) { return c; } };
    return { ok: true, action: 'duelDev', me: { char, str: Math.max(1, str), name: plazaName() || nm(char) },
             opp: { char: opp, str: Math.max(1, oppStr), name: nm(opp) + '（dev）' } };
}
function page2Dev(act) {
    const ranch = core.loadRanch();
    if (act === 'quest') {
        delete ranch.page2Fight; delete ranch.page2Result;
        ranch.page2Quest = { at: Date.now(), seen: false };
    } else if (act === 'unlock') {
        if (core.page2Unlocked(ranch)) return { ok: false, error: '已經解鎖了' };
        core.page2Grant(ranch);
    } else if (act === 'reset') {
        delete ranch.page2Quest; delete ranch.page2Fight; delete ranch.page2Result; delete ranch.page2At;
        // 反覆測試：解鎖送的那隻 Keramon 還在營地就一起收走（認 id，不認角色 ——
        // 牠可能已經進化了，玩家自己另外養的 Keramon 也不能被誤刪）
        if (ranch.page2RewardId) ranch.pets = (ranch.pets || []).filter(p => p.id !== ranch.page2RewardId);
        delete ranch.page2RewardId;
    } else if (act === 'win' || act === 'lose') {
        page2ForceWin = act === 'win';
        return { ok: true, action: 'page2Dev', output: '下一場 Armagemon 戰：強制' + (act === 'win' ? '勝' : '敗') };
    } else return { ok: false, error: '不認得的 dev 動作：' + act };
    core.saveRanch(ranch);
    return { ok: true, action: 'page2Dev', output: '營地第二頁：' + act };
}
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
    // 每次開都重起：舊的編輯器行程會一直跑著舊程式（daemon 重開過、或自己用 zone-editor.bat 起的
    // 都一樣），新 spawn 的那個 EADDRINUSE 靜靜死掉，開到的永遠是舊版 —— 2026-10-16 實測：
    // 10/13 開的編輯器一路跑到現在，5～8 隻的選項怎麼開都看不到。跟 vpet bg／album 同一招。
    // 照命令列找（zone-editor.bat 起的我們沒有 handle），砍掉確認死了再起新的。
    try {
        const doctor = require(path.join(__dirname, '..', 'runtime', 'doctor.js'));
        for (const pid of (doctor.scanNodesByScript('zone_editor_server.js') || [])) doctor.killConfirmed(pid);
    } catch (e) { console.log('   ⚠️ 收不掉舊的走動範圍編輯器：' + e.message); }
    zoneEditorProc = null;
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
    if (action === 'plazaLeave') {
        const room = plazaClient.stairsMine();
        if (room && room.state === 'play') return { ok: false, error: '小遊戲進行中，先玩完（或認輸／離開房間）再回前線' };
        return plazaClient.leave().then(() => ({ ok: true, action, output: '回到前線' }));
    }
    if (action === 'plazaRename') return plazaRename(args.name);
    if (action === 'plazaColor')  return plazaColor(args.color);
    // 自動／手動與 WASD。/cmd 只收字串，方向在這裡轉回 -1/0/1。
    // 節日開關（營地背景＋造型一起）。在廣場也能切，所以不在 PLAZA_BLOCKED_CMDS 裡
    if (action === 'festCostume') {
        const on = args.on !== 'false' && args.on !== false;
        try { writeFest({ costume: on }); }
        catch (e) { return { ok: false, error: '存不了節日設定：' + e.message }; }
        if (plazaClient.active()) {
            plazaRenameRejected = null;
            return plazaSyncName().then(r => (r && !r.ok ? { ok: false, error: r.error }
                : { ok: true, action, output: on ? '節日造型：開' : '節日造型：關' }));
        }
        return { ok: true, action, output: on ? '節日造型：開' : '節日造型：關' };
    }
    if (action === 'plazaMode') {
        if (args.mode !== 'auto' && args.mode !== 'manual') return { ok: false, error: '模式只有 auto / manual' };
        return plazaClient.move({ mode: args.mode }).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'plazaInvite') {
        if (!args.to) return { ok: false, error: '要指定邀請誰' };
        const kind = args.kind === 'duel' ? 'duel' : 'auto';
        return plazaClient.invite(args.to, kind).then(r => (r.ok ? { ok: true, action, output: kind === 'duel' ? '已送出手動戰鬥邀請' : '已送出對戰邀請' } : r));
    }
    if (action === 'plazaAnswer') {
        if (!args.inviteId) return { ok: false, error: '沒有邀請' };
        return plazaClient.answer(args.inviteId, args.accept === '1').then(r => (r.ok ? { ok: true, action } : r));
    }
    // 有新版本 → 結束碼 RESTART_CODE，外殼（supervisor）會跑 updater 再重開。在廣場的話先離場。
    if (action === 'selfUpdate') {
        if (!process.env.VPET_CHILD) return { ok: false, error: '這個 daemon 不是由更新外殼啟動的（開發版或舊的啟動方式），請手動重啟。' };
        const bye = () => process.exit(require('./supervisor.js').RESTART_CODE);
        setTimeout(() => {
            if (!plazaClient.active()) return bye();
            const t = setTimeout(bye, 1000);
            plazaClient.leave().finally(() => { clearTimeout(t); bye(); });
        }, 300);
        return { ok: true, action, output: '更新中，daemon 重開後頁面會自動重新整理…' };
    }
    // 下樓梯：開房（第一期只有無限制）／出發／方向（-1/0/1，只在改變時送）／離開房間
    if (action === 'stairsOpen')  return plazaClient.stairs('open', { mode: args.mode === 'survival' ? 'survival' : 'endless',
                                                                    kind: ['dino', 'volley', 'gomoku'].includes(args.kind) ? args.kind : 'stairs' })
                                         .then(r => (r.ok ? { ok: true, action } : r));
    // 小恐龍：回報自己跑到哪（約 10 次／秒）。/cmd 只收字串，這裡轉回數字
    if (action === 'dinoReport') {
        return plazaClient.stairs('report', { dist: Number(args.dist), y: Number(args.y), alive: args.alive !== '0' })
            .then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'stairsStart') return plazaClient.stairs('start').then(r => (r.ok ? { ok: true, action } : r));
    if (action === 'stairsJoin') {
        if (!args.room) return { ok: false, error: '要指定哪一間' };
        return plazaClient.stairs('join', { room: args.room }).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'stairsLeave') return plazaClient.stairs('leave').then(r => (r.ok ? { ok: true, action } : r));
    if (action === 'stairsInput') {
        const dir = Number(args.dir);
        if (![-1, 0, 1].includes(dir)) return { ok: false, error: '方向只能是 -1／0／1' };
        return plazaClient.stairs('input', { dir }).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'stairsBoard') return plazaClient.stairsBoard(args.kind).then(board => ({ ok: true, action, board }));
    // 打排球：每一格的按鍵（一秒 25 次）、比賽結果（兩邊算的一樣，誰先報都行）
    // 五子棋：下一手、認輸
    if (action === 'gomokuMove') {
        return plazaClient.stairs('gmove', { x: Number(args.x), y: Number(args.y) }).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'gomokuResign') return plazaClient.stairs('gresign').then(r => (r.ok ? { ok: true, action } : r));
    // 手動戰鬥：這回合的選擇（移動、攻擊位置、力度；沒選的不帶，伺服器用預設）、認輸
    if (action === 'duelPick') {
        const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
        return plazaClient.stairs('dpick', { mv: num(args.mv), aim: num(args.aim), p: num(args.p) }).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'duelResign') return plazaClient.stairs('dresign').then(r => (r.ok ? { ok: true, action } : r));
    if (action === 'duelDev') return duelDev();
    // 前線小遊戲：開著（每幾秒報一次）／關了；個人最佳（kind + val = 記一筆，沒給 val = 只讀）
    if (action === 'frontMini') { frontMiniUntil = args.on === '1' ? Date.now() + FRONT_MINI_TTL : 0; return { ok: true, action }; }
    if (action === 'miniBest') {
        const st = loadState(STATE_FILE);
        return { ok: true, action, char: st.characterId || 'agumon', ...miniBest(args.kind, Number(args.val)) };
    }
      if (action === 'volleyResign') return plazaClient.stairs('vresign').then(r => (r.ok ? { ok: true, action } : r));
    if (action === 'volleyInput') {
        return plazaClient.stairs('vin', { f: Number(args.f), k: Number(args.k) }).then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'volleyEnd') {
        return plazaClient.stairs('vend', { winner: args.winner, score: [Number(args.s0), Number(args.s1)] })
            .then(r => (r.ok ? { ok: true, action } : r));
    }
    // 偷看盤（docs/plaza-peek-spec.md）：躲起來／回座位、查台股（伺服器擋：每人 1 分鐘一次）
    if (action === 'plazaHide') return plazaClient.hide(args.on !== '0').then(r => (r.ok ? { ok: true, action } : r));
    if (action === 'stockQuery') {
        if (!args.code) return { ok: false, error: '要給股票代號' };
        return plazaClient.stockQuery(String(args.code)).then(r => (r.ok ? { ok: true, action, quote: r.quote, at: r.at, trading: r.trading } : r));
    }
    if (action === 'plazaHappy') {
        return plazaClient.emote().then(r => (r.ok ? { ok: true, action } : r));
    }
    if (action === 'plazaChat') {
        if (!args.text) return { ok: false, error: '沒有內容' };
        return plazaClient.say(args.text).then(r => (r.ok ? { ok: true, action } : r));
    }
    // 廣場管理（dev）：踢人、刪聊天。release 不給；伺服器那邊另外要管理金鑰（主機上的檔）才認
    if (PLAZA_ADMIN_CMDS.has(action)) {
        if (IS_RELEASE) return { ok: false, error: '此版本未提供此指令' };
        if (!plazaClient.active()) return { ok: false, error: '不在廣場' };
        const token = PlazaServer.loadAdminToken();
        if (!token) return { ok: false, error: '找不到管理金鑰（' + PlazaServer.ADMIN_KEY_FILE + '）：要在跑 plaza-host 的那台、或把那個檔複製過來' };
        if (action === 'plazaKick') {
            const m = plazaClient.roster().find(x => x.id === args.target);
            if (!m) return { ok: false, error: '對方已經不在廣場了' };
            if (m.id === plazaClient.me().id) return { ok: false, error: '不能踢自己' };
            return plazaClient.admin('kick', { token, target: m.id })
                .then(r => (r.ok ? { ok: true, action, output: '已把 ' + m.name + ' 移出廣場（' + PlazaServer.KICK_BAN_MS / 60000 + ' 分鐘內不能再進來）' } : r));
        }
        if (action === 'plazaChatDel') {
            const seq = Number(args.seq);
            if (!Number.isInteger(seq) || seq <= 0) return { ok: false, error: '要指定哪一則' };
            return plazaClient.admin('chat', { token, seq }).then(r => (r.ok ? { ok: true, action, output: '已刪除' } : r));
        }
        return plazaClient.admin('chat', { token, all: true }).then(r => (r.ok ? { ok: true, action, output: '聊天記錄已清空' } : r));
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
        // 跨頁（解鎖後 5～8 隻）：位置在兩頁寬的場地上算，再換成前端正在看的那一頁（args.pg）的座標
        const ranch = core.loadRanch(), G = yardGeomNow(ranch, args.fest), px0 = yardPageX0(ranch, args.fest, args.pg);
        const r = yardReactMap().get(args.which);
        const sp = plaza.yardSpriteFor(core, ranch, args.which, plazaStep(), {
            geom: G,
            joinStep: (r && r.anchor ? r.anchor.step : plaza.yardJoinStep())
                    + (r ? r.holdSteps || 0 : 0),
            origin: r && r.anchor ? r.anchor.origin : null,
            swap: (() => { const f = festNow(Date.now(), args.fest); return f && readFest().costume ? f.swap || null : null; })(),
            swapSalt: args.ds || null,
        });
        if (!sp) return { ok: false, error: '這隻不在營地裡' };
        if (!yardTouch.grab(args.which)) return { ok: false, error: '已經拿在手上了' };
        // 兩張待機幀交給前端輪替 —— 拿在手上也要繼續呼吸，不是定格
        // 前端在細格裡拖（營地畫小一號）—— 起點換成畫出來的位置
        const at = G.toDraw(sp.x, sp.y);
        return { ok: true, action: 'yardGrab', frames: sp.frames, x: at.x - px0, y: at.y, facing: sp.facing };
    }

    // 放開。落點成為新的起點，那隻從那裡開始走一條全新的鏈（見 plaza-walk 的 origin）。
    if (action === 'yardDrop') {
        if (!args.which) return { ok: false, error: '要指定是哪一隻' };
        const ranch = core.loadRanch(), G = yardGeomNow(ranch, args.fest), px0 = yardPageX0(ranch, args.fest, args.pg);
        const F = G.field;
        // ⚠️ /cmd 的白名單**只收字串**（刻意的：那些值會被送進 CLI 的 argv）。
        //    座標所以是以字串傳過來的，這裡才轉數字。第一版直接讀 args.x 拿到 undefined，
        //    落點永遠變成 (0,0) —— 而且 grab/drop 都回 ok:true，完全看不出哪裡錯。
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : NaN; };
        const x = num(args.x), y = num(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '落點座標不合法' };
        // 前端送來的是畫出來的位置（細格），走路在粗格上算 —— 換回來再夾
        const back = G.fromDraw(x + px0, y);   // 前端給的是那一頁的座標 → 換回兩頁寬畫布再換回走路格子
        const cx = PW.clamp(back.x, F.minX, F.maxX);
        const cy = PW.clamp(back.y, F.minY, F.maxY);
        if (!yardTouch.drop(args.which, cx, cy, args.facing)) {
            return { ok: false, error: '這隻沒有被拿著' };
        }
        // 回**畫出來**的位置（細格）：前端手上那份要先對齊到這一格，再交棒給伺服器的畫面，
        // 不然交接那一刻會看到牠往旁邊挪一格（細格不是每一格都對得到走路的格子）。
        const at = G.toDraw(cx, cy);
        return { ok: true, action: 'yardDrop', x: at.x - px0, y: at.y };
    }

    // ── 營地第二頁的事件（docs/yard-page2-spec.md）──
    if (action === 'page2Seen') {
        const ranch = core.loadRanch();
        if (ranch.page2Quest && !ranch.page2Quest.seen) { ranch.page2Quest.seen = true; core.saveRanch(ranch); }
        return { ok: true, action };
    }
    if (action === 'page2Fight') return page2StartFight(args.which);
    if (action === 'page2GiveUp') {
        const ranch = core.loadRanch();
        if (!ranch.page2Quest || ranch.page2Fight) return { ok: false, error: '現在沒有可以放棄的挑戰' };
        delete ranch.page2Quest;   // 放棄視同戰敗：從打 Diablomon 重來
        ranch.page2Result = { win: false, gaveUp: true, step: plazaStep(), at: Date.now() };
        core.saveRanch(ranch);
        return { ok: true, action };
    }
    // 結果演完了。贏：直接清掉。輸／放棄：助手講完才讓 Armagemon 退場（規格的順序），
    // 記下開始退場的那一拍，退出畫面後 page2Settle 自己清。
    if (action === 'page2Ack') {
        const ranch = core.loadRanch(), r = ranch.page2Result;
        if (r && !r.win && !r.exitStep) { r.exitStep = plazaStep(); core.saveRanch(ranch); }
        else if (r && r.win) { delete ranch.page2Result; core.saveRanch(ranch); }
        return { ok: true, action };
    }
    if (action === 'page2Dev') return page2Dev(args.act);

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
// 不在啟動時定死有沒有：底圖編輯器存檔／移除後，/state 帶的 bgV（檔案的 mtime，沒有 = 0）
// 會變，前端換掉 #stage 的 --bg（網址帶 ?v= 避開快取），不用重啟 daemon、也不用重整頁面。
const BG_FILE   = path.join(core.INSTALL_ROOT, 'bg.png');
function bgVersion() {
    try { return Math.round(fs.statSync(BG_FILE).mtimeMs); } catch (e) { return 0; }
}

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

// 小恐龍的模擬（src/shared/dino-sim.js）原樣內嵌進頁面：瀏覽器自己算位置（docs/plaza-dino-spec.md）。
// 頁面是 template literal → 那支不能有反引號、錢字號接大括號、反斜線；有的話就不內嵌（小恐龍停用），
// 不能讓整個頁面壞掉。test-dino 會先擋。
function loadSimSrc(file, what) {
    try {
        const src = fs.readFileSync(path.join(__dirname, '..', 'shared', file), 'utf8');
        if (/[`\\]|\$\{|<\/script/i.test(src)) { console.log('   ⚠️ ' + file + ' 有不能內嵌的字元，' + what + '停用'); return ''; }
        return src;
    } catch (e) { console.log('   ⚠️ 讀不到 ' + file + '，' + what + '停用：' + e.message); return ''; }
}
const DINO_SRC = loadSimSrc('dino-sim.js', '小恐龍');
const VOLLEY_SRC = loadSimSrc('volley-sim.js', '打排球');   // 打排球：兩邊各算同一套（輸入同步）
const GOMOKU_AI_SRC = loadSimSrc('gomoku-ai.js', '五子棋的電腦');   // 跟電腦下五子棋（盡可能強）
const STAIRS_SRC = loadSimSrc('stairs-sim.js', '前線的下樓梯（單機）');   // 下樓梯：廣場是伺服器算，前線單機在頁面算
const DUEL_SRC = loadSimSrc('duel-sim.js', '手動戰鬥的 dev 測試');   // 手動戰鬥：判定在伺服器，頁面只拿來跑 dev 測試對戰

// 教學助手（docs/tutorial-spec.md）：一般角色資料夾（characters/TerriermonAssistant，
// 沒進 roster，玩家遇不到），拿 IDLE_1／IDLE_2 兩幀交替當講話。
// 送成 16×16 的色碼（'' = 透明），前端畫進 16×16 的小畫布再放大，不走 dot 網格。
// 讀不到（素材沒裝）就送 null：說明照樣出，只是沒有助手。
const TUTOR_ID = 'terriermonassistant';
function tutorFrames() {
    try {
        const { config, artFile } = core.loadCharacter(TUTOR_ID);
        const art = JSON.parse(fs.readFileSync(artFile, 'utf8'));
        const hex = (c, o) => c && c[o] >= 0 ? '#' + [c[o], c[o + 1], c[o + 2]].map(v => v.toString(16).padStart(2, '0')).join('') : '';
        return ['IDLE_1', 'IDLE_2'].map(n => {
            const f = art.frames[config.frames[n]], px = [];
            for (const row of f) { px.push(row.map(c => hex(c, 0))); px.push(row.map(c => hex(c, 3))); }
            return px;
        });
    } catch (e) { console.log('   ⚠️ 教學助手的素材讀不到（說明照常，只是沒有助手）：' + e.message); return null; }
}

// 助手的 CutIn（營地第二頁事件的漫畫式對話框用）：32x16 的色碼，畫進小畫布再放大。
function tutorCutin() {
    try {
        const { cutinArtFile } = core.loadCharacter(TUTOR_ID);
        const art = JSON.parse(fs.readFileSync(cutinArtFile, 'utf8'));
        const hex = (c, o) => c && c[o] >= 0 ? '#' + [c[o], c[o + 1], c[o + 2]].map(v => v.toString(16).padStart(2, '0')).join('') : '';
        const px = [];
        for (const row of art.frames[0]) { px.push(row.map(c => hex(c, 0))); px.push(row.map(c => hex(c, 3))); }
        return px;
    } catch (e) { console.log('   ⚠️ 助手的 CutIn 讀不到（對話照常，只是沒有圖）：' + e.message); return null; }
}

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
         border-radius:4px;overflow:hidden}
  /* 灰白面板（比照原版）：底圖已在 make-bg.js 壓好亮度帶，這裡不再加濾鏡。
     要現場微調就在 devtools 加 filter，定案後回去改 make-bg.js 的 lo/hi 重烘。
     hasbg／--bg 由前端照 /state 的 bgV 切換（見 syncBg）；營地、廣場的 body.yard／body.plaza 規則比較具體，照樣蓋過。 */
  #stage.hasbg{background:#d2d2d2 var(--bg) center/cover}
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
  /* 節日背景：墊在角色畫布**下面**（角色畫布清空的地方是透明的）。只在營地／廣場。
     角色畫布要 position + z-index 才壓得過它；只對營地／廣場加，家裡的 letterbox 不受影響。 */
  #fest{position:absolute;display:none;pointer-events:none;z-index:0}
  /* 廣場的常駐背景（辦公室…）：同一層、DOM 排在節日背景前面 → 墊在節日背景底下 */
  #scene{position:absolute;display:none;pointer-events:none;z-index:0}
  body.scene.plaza #scene,body.scene.yard #scene{display:block}
  /* 節日前景：跟角色同一層、DOM 排在角色後面 → 疊在角色上面；天氣（z2）再蓋在它上面 */
  #festfront{position:absolute;display:none;pointer-events:none;z-index:1}
  body.yard #pet,body.plaza #pet{position:relative;z-index:1}
  body.fest.yard #fest,body.fest.plaza #fest,body.fest.yard #festfront,body.fest.plaza #festfront{display:block}
  body.yard #wx,body.plaza #wx{display:block}
  /* 右上角的日期／時間／天氣。用 HTML 疊層而不是畫點陣字：52 dot 寬塞一整行日期
     會佔掉整列又糊掉，而這裡本來就不是像素風的一部分，是「看板」。 */
  #hud{position:absolute;display:none;top:6px;right:8px;z-index:3;text-align:right;
       pointer-events:none;font-size:11px;line-height:1.4;color:#e6edf3;
       text-shadow:0 1px 3px #000, 0 0 6px #000, 0 0 2px #000}
  /* 壓黑：字後面一團往外淡掉的暗影（沒有框），彩旗／煙火從後面經過時字還讀得到 */
  #hud::before{content:'';position:absolute;inset:-8px -16px -8px -20px;z-index:-1;
       background:radial-gradient(closest-side,rgba(0,0,0,.85),rgba(0,0,0,.7) 55%,rgba(0,0,0,0))}
  body.yard #hud,body.plaza #hud{display:block}
  body.nohud #hud{display:none!important}   /* 「顯示天氣日期」取消勾選 */
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
  /* 換行：合體進化鈕出現時把它推到第二排的開頭（2026-10-21） */
  #controls .rowbr{flex-basis:100%;height:0;margin-bottom:-6px}   /* 自己佔一行，抵掉多出來的那一個行距 */
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
  /* dev 介面關掉：dev 限定的鈕／列／預覽全部藏起來，看到的就是 release 的樣子 */
  body.nodev .devonly{display:none!important}
  body.noinfo #info{display:none!important}   /* 進階指令「daemon 資訊」隱藏 */
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
  /* 管理（dev）：每則後面的刪除鈕，滑過那一列才出現 */
  #chatlog .del{display:none;margin-left:6px;padding:0 5px;border:1px solid #30363d;border-radius:4px;
                background:#21262d;color:#f85149;font-size:11px;cursor:pointer}
  #chatlog div:hover .del{display:inline}
  #plazaadmin select{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;
                     padding:3px 5px;font:inherit;font-size:12px;max-width:150px}
  /* 輸入框撐滿整列、送出鈕靠右（2026-10-21：原本固定寬度，送出右邊空一截） */
  #chatin{flex:1;min-width:0;width:auto !important}
  #chatrow{flex-wrap:nowrap}
  /* 表情符號面板：點 😀 開，點選插入到游標位置 */
  #emojipick{display:none;position:absolute;z-index:40;background:#161b22;border:1px solid #30363d;
             border-radius:8px;padding:6px;width:272px;box-shadow:0 6px 20px rgba(0,0,0,.5);
             grid-template-columns:repeat(8,1fr);gap:2px}
  #emojipick button{background:none !important;border:0 !important;font-size:18px;line-height:1;
                    padding:4px 0 !important;border-radius:4px;cursor:pointer}
  #emojipick button:hover{background:#30363d !important}
  #plazabar input[type=checkbox]{width:auto;padding:0;vertical-align:middle}   /* 不吃上面輸入框的 120px */
  #plazabar input[type=color]{width:34px;height:24px;padding:1px;vertical-align:middle;cursor:pointer}
  /* 廣場對戰：疊在廣場上的一層（壓暗 + 中間是前線的戰鬥畫面），不換畫面 */
  /* 下樓梯：蓋在廣場畫面上（同一個舞台、一樣大） */
  #stairsbox{position:absolute;inset:0;z-index:5;display:none}
  /* 偷看盤（docs/plaza-peek-spec.md）：廁所場景蓋在廣場上（本人才看得到），手機是 HTML（要打字） */
  #peekbtn{float:right;opacity:0;transition:opacity .25s;background:none;border:none;cursor:pointer;font-size:14px;padding:2px 6px;margin-right:6px}   /* 跟「室內／室外」隔開，同其他按鈕的 6px（2026-10-21：原本黏在一起） */
  #peekbtn:hover,#peekbtn:focus-visible{opacity:1}
  #peekbox{position:absolute;z-index:6;display:none;overflow:hidden}
  #peekcv{position:absolute;left:0;top:0;image-rendering:pixelated}
  #peekphone{position:absolute;left:4%;top:8%;width:92%;height:53%;box-sizing:border-box;background:#0d0d0f;border-radius:24px;padding:6px;
             box-shadow:0 4px 0 rgba(0,0,0,.35);font-family:system-ui,'Microsoft JhengHei',sans-serif}
  #peekphone .island{position:absolute;left:13px;top:50%;width:9px;height:30px;margin-top:-15px;background:#000;border-radius:6px;border:1px solid #222}
  #peekphone .scr{position:absolute;inset:6px;background:#0b0e14;border-radius:18px;padding:6px 10px 6px 30px;color:#e6edf3;display:flex;flex-direction:column;gap:3px;overflow:hidden}
  #peekphone .r1{display:flex;gap:6px;align-items:center;font-size:12px}
  #peekphone input{width:92px;font-size:12px;padding:2px 6px;border:1px solid #30363d;border-radius:6px;color:#e6edf3;background:#161b22}
  #peekphone button{font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#e6edf3;cursor:pointer}
  #peekphone #peekmsg{color:#ff7b72;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #peekphone .main{display:flex;gap:10px;flex:1;min-height:0}
  #peekphone .lf{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
  #pkname{font-size:12px;color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #pkprice{font-size:24px;font-weight:700;line-height:1.1}
  #pkchg{font-size:12px;font-weight:600}
  #pkinfo{font-size:10px;color:#8b949e;line-height:1.35}
  #pkbook{font-size:10px;border-collapse:collapse;align-self:center}
  #pkbook td{padding:0 5px;text-align:right}
  #pkbook th{font-weight:400;color:#6e7681;padding:0 5px}
  #peekphone .ft{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#6e7681}
  .pk-up{color:#ff5c5c} .pk-dn{color:#3fd47a}   /* 黑底的漲紅跌綠要亮一點 */
  #peekfade{position:absolute;inset:0;z-index:7;background:#000;opacity:0;pointer-events:none;transition:opacity .3s}
  body.peeking #plazahappy,body.peeking #minibtn,body.peeking #plazamode{display:none!important}
  #stairscv{position:absolute;image-rendering:pixelated;max-width:none}
  /* 前線玩小遊戲：畫布貼齊舞台左上（前線的 #pet 有留白），舞台撐到畫布那麼大（見 miniFrontFit） */
  body.minifront #stairscv{left:0!important;top:0!important}
  #gmresign{position:absolute;right:8px;bottom:8px;z-index:2;font-size:11px;padding:2px 8px}
  #stout{position:absolute;right:8px;bottom:8px;z-index:2;font-size:12px;padding:3px 10px}
  /* 小遊戲選單（廣場的「🎮 小遊戲」）：跟等待面板同一個樣式，蓋在舞台中間 */
  /* 遊戲變多之後選單比舞台高：限制高度、裡面捲動（不然上下被裁掉，看不到第一個遊戲） */
  #minipick{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;display:none;width:300px;max-width:92%;max-height:calc(100% - 12px);overflow-y:auto;box-sizing:border-box;
            background:rgba(13,17,23,.95);border:1px solid #444c56;border-radius:8px;padding:10px 12px;
            color:#c9d1d9;font:12px/1.6 "Microsoft JhengHei","PingFang TC",sans-serif;text-align:center}
  #minipick .mp-h{font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:6px}
  #minipick .mp-game{border:1px solid #30363d;border-radius:6px;padding:6px 8px;margin-top:6px;text-align:left}
  #minipick .mp-game b{color:#e6edf3;font-size:13px}
  #minipick .mp-desc{color:#8b949e;font-size:11px}
  #minipick .mp-modes{margin-top:4px;display:flex;gap:6px}
  #minipick .mp-best{align-self:center;font-size:11px;color:#d29922}
  #minipick .mp-soon{color:#7f868e;font-size:11px;margin-top:6px}
  #minipick button.pri{background:#238636;border-color:#238636;color:#fff}
  #minipick .st-board{margin:6px auto 0;max-width:220px;text-align:left;font-size:11px}
  #minipick .st-bh{color:#8b949e;text-align:center}
  #minipick .st-row{display:flex;gap:6px} #minipick .st-row span:nth-child(2){flex:1}
  #minipick .st-row.me{color:#f7c631}
  #minipick .mp-room{display:flex;align-items:center;gap:6px;margin-top:4px;padding-top:4px;border-top:1px dashed #30363d;font-size:11px}
  #minipick .mp-room span{flex:1;color:#c9d1d9}
  #chatlog button.stjoin{margin-left:6px;padding:0 6px;font-size:11px;line-height:16px}
  #stairspanel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:340px;max-width:94%;
               background:rgba(13,17,23,.94);border:1px solid #444c56;border-radius:8px;padding:10px 12px;
               color:#c9d1d9;font:12px/1.6 "Microsoft JhengHei","PingFang TC",sans-serif;text-align:center}
  #stairspanel .st-h{font-size:14px;font-weight:700;color:#e6edf3}
  #stairspanel .st-mode{font-size:11px;color:#d29922;font-weight:400}
  #stairspanel .st-res{margin-top:4px;font-size:13px} #stairspanel .st-res b{color:#58a6ff;font-size:16px}
  #stairspanel .st-rec{color:#f7c631;font-weight:700}
  #stairspanel .st-board{margin:6px auto 0;max-width:200px;text-align:left;font-size:11px}
  #stairspanel .st-bh{color:#8b949e;text-align:center}
  #stairspanel .st-row{display:flex;gap:6px} #stairspanel .st-row span:nth-child(2){flex:1}
  #stairspanel .st-row.me{color:#f7c631}
  /* 房裡每個人：自己的 vpet（待機動畫）＋名牌，房主名牌前加皇冠 */
  #stairspanel .st-mem{margin-top:8px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap}
  #stairspanel .st-pl{width:72px;display:flex;flex-direction:column;align-items:center}
  #stairspanel .st-pl canvas{width:64px;height:64px;image-rendering:pixelated;background:#161b22;border:1px solid #30363d;border-radius:6px}
  #stairspanel .st-pl span{margin-top:2px;color:#e6edf3;font-size:11px;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #stairspanel .st-pl.host span::before{content:'👑'}
  #stairspanel .st-pl.empty canvas{border-style:dashed;background:transparent}
  #stairspanel .st-pl.empty span{color:#7f868e}
  #stairspanel .st-hint{margin-top:4px;font-size:11px;color:#8b949e}
  #stairspanel .st-btns{margin-top:8px;display:flex;gap:8px;justify-content:center}
  #stairspanel button.pri{background:#238636;border-color:#238636;color:#fff}
  #stairspanel .st-wait{color:#8b949e}
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
  /* 圖示固定寬度：⚔ 是窄字、🎮 是寬的 emoji，直接接字的話後面的字對不齊（2026-10-21 回報） */
  #ctx button .ci{display:inline-block;width:1.6em;text-align:center}
  #ctx button.danger{color:#f85149}
  /* 教學（docs/tutorial-spec.md）：? 鈕 → 問號模式（滑過的地方亮框）→ 點了壓黑＋助手講解 */
  #helpbtn{width:24px;height:24px;padding:0;border-radius:50%;font-weight:700}
  #helpbtn.on{background:#3b1f6b;border-color:#a371f7;color:#e9dcff}
  body.helpmode, body.helpmode *{cursor:help !important}
  .helphover{outline:2px dashed #a371f7 !important;outline-offset:2px}
  #helptoast{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9001;display:none;
             background:#3b1f6b;border:1px solid #a371f7;color:#e9dcff;border-radius:16px;padding:4px 14px;font-size:12px;pointer-events:none}
  #helpdim{position:fixed;inset:0;z-index:9000;display:none}
  #helphole{position:fixed;border-radius:8px;outline:2px solid #a371f7;box-shadow:0 0 0 200vmax rgba(1,4,9,.74);pointer-events:none}
  #helpbox{position:fixed;display:flex;gap:12px;align-items:flex-start;width:420px;box-sizing:border-box;
           background:#161b22;border:1px solid #a371f7;border-radius:10px;padding:10px 12px;color:#c9d1d9;font-size:13px;line-height:1.6}
  #helpcv{width:80px;height:80px;flex:none;image-rendering:pixelated;cursor:inherit}
  #helpbox .who{font-size:11px;color:#a371f7}
  #helpbox .hd{font-weight:700;color:#e6edf3;margin-bottom:2px}
  #helpbox .ft{font-size:11px;color:#8b949e;margin-top:6px}
  /* 營地第二頁事件：助手的 CutIn + 漫畫式對話框。dim = 壓黑擋住其他操作；
     選一隻出戰時不壓黑（要能點到營地裡的桌寵），只留對話框。 */
  #story{position:fixed;inset:0;z-index:9100;display:none;pointer-events:none}
  #story.dim{background:rgba(1,4,9,.62);pointer-events:auto}
  /* 助手在上、對話框在下（上下擺放） */
  #storypanel{position:fixed;display:flex;flex-direction:column;align-items:center;gap:0;pointer-events:auto;cursor:pointer}
  /* CutIn 擺正，外框是點陣的黑框＋四角綠色 L 形：storyfx 比 CutIn 大一圈 2 點、蓋在上面，只畫最外一圈
     （中間那圈留空，框和 CutIn 之間留一點縫）。1 點 = 6px，跟 CutIn 的放大倍率一樣（32×16 → 192×96），像素才對得齊。 */
  #storycut{position:relative;flex:none;width:192px;height:96px}
  /* max-width:none 一定要：全域的 canvas{max-width:100%} 會把比 #storycut（192px）寬的外框縮成 192px，
     框就歪向一邊（2026-10-16 vpet 小視窗實測回報）。 */
  #storycv{display:block;width:192px;height:96px;max-width:none;image-rendering:pixelated;background:#fff}
  #storyfx{position:absolute;left:-12px;top:-12px;width:216px;height:120px;max-width:none;image-rendering:pixelated;pointer-events:none}
  #storybubble{position:relative;margin-top:32px;background:#fff;color:#111;border:3px solid #111;border-radius:18px;
               box-sizing:border-box;padding:10px 14px;min-width:220px;max-width:360px;box-shadow:4px 4px 0 #111;
               font:700 14px/1.6 "Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif}
  /* 漫畫對話框的尾巴：往上指向助手 */
  #storybubble::before{content:'';position:absolute;top:-20px;left:50%;margin-left:-11px;
                       border:11px solid transparent;border-bottom:18px solid #111;border-top:0}
  #storybubble::after{content:'';position:absolute;top:-13px;left:50%;margin-left:-7px;
                      border:7px solid transparent;border-bottom:12px solid #fff;border-top:0}
  #storybubble .nm{font-size:11px;color:#8250df;margin-bottom:2px}
  #storybubble .btns{display:flex;gap:8px;margin-top:8px}
  #storybubble .btns:empty{display:none}
  #storybubble .btns button{font:700 13px/1 inherit;padding:6px 14px;border:2px solid #111;border-radius:8px;
                            background:#ffd84a;color:#111;cursor:pointer;box-shadow:2px 2px 0 #111}
  #storybubble .btns button.alt{background:#eee}
  #storybubble .btns button.danger{background:#ff8a8a}
  #storybubble .hint{font-size:11px;color:#777;margin-top:4px}
  /* 選一隻出戰：滑過去的那隻亮框 */
  #p2hl{position:absolute;display:none;z-index:3;pointer-events:none;outline:2px dashed #ffd84a;outline-offset:1px;border-radius:3px}
  body.p2pick #pet{cursor:pointer}
  /* 營地翻頁：舞台左下／右下角的箭頭（只在那個方向還有頁時出現）＋底部正中的頁碼點點，三個排在同一條線上。
     疊在畫面上而不是放進文字列 —— 翻頁是「看隔壁」，箭頭就該長在畫面邊上；放角落不擋到中間走動的桌寵。 */
  .pgarrow{position:absolute;bottom:6px;z-index:4;display:none;width:24px;height:24px;padding:0;
           border-radius:50%;border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.45);color:#fff;
           font:700 18px/20px ui-monospace,Consolas,monospace;text-align:center;cursor:pointer;opacity:.7;
           transition:opacity .15s,background .15s}
  .pgarrow:hover{opacity:1;background:rgba(0,0,0,.7)}
  #pgprev{left:6px} #pgnext{right:6px}
  /* 拍照：快門閃光＋照片預覽（按鈕在圖鑑左邊，見 UI_BUTTONS） */
  #photoflash{position:absolute;inset:0;z-index:6;background:#fff;opacity:0;pointer-events:none}
  #photoflash.on{animation:photoflash .45s ease-out}
  @keyframes photoflash{0%{opacity:.95}100%{opacity:0}}
  #photobox{position:fixed;inset:0;z-index:9200;display:none;align-items:center;justify-content:center;background:rgba(1,4,9,.7)}
  #photobox.on{display:flex}
  #photocard{background:#f4f1ea;padding:12px 12px 10px;border-radius:4px;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:calc(100vw - 32px);
             text-align:center;color:#222;font:13px/1.5 "Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif}
  #photoimg{display:block;max-width:100%;image-rendering:pixelated;border:1px solid #ccc}
  #photocard .btns{margin-top:10px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
  #photocard button{padding:4px 12px;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer;font:inherit}
  #photocard button.pri{background:#238636;border-color:#238636;color:#fff}
  #photomsg{margin-top:6px;min-height:1.5em;font-size:12px;color:#555;word-break:break-all}
  #pgdots{position:absolute;left:0;right:0;bottom:15px;z-index:4;display:none;text-align:center;pointer-events:none;line-height:0}
  #pgdots i{display:inline-block;width:7px;height:7px;margin:0 3px;border-radius:50%;background:rgba(255,255,255,.35);
            box-shadow:0 0 2px rgba(0,0,0,.8)}
  #pgdots i.on{background:#fff}
</style></head><body>
<div id="ctx"></div>
<div id="helptoast">❓ 點想問的地方　（Esc 或右鍵離開）</div>
<div id="helpdim"><div id="helphole"></div><div id="helpbox"><canvas id="helpcv" width="16" height="16"></canvas>
  <div style="flex:1;min-width:0"><div class="who">🎓 Terriermon 助手</div><div class="hd"></div><div class="bd"></div><div class="ft">點任何地方關閉</div></div></div></div>
<div id="photobox"><div id="photocard"><img id="photoimg" alt="營地照片"><div id="photomsg"></div>
  <div class="btns"><button id="photosave" class="pri">💾 儲存</button><button id="photoagain">🔄 再拍一張</button><button id="photoclose">關閉</button></div></div></div>
<div id="story"><div id="storypanel"><div id="storycut"><canvas id="storycv" width="32" height="16"></canvas><canvas id="storyfx" width="36" height="20"></canvas></div>
  <div id="storybubble"><div class="nm">🎓 Terriermon 助手</div><div class="bd"></div><div class="btns"></div><div class="hint">點一下繼續</div></div></div></div>
<h1>🥚 Vpet daemon</h1>
<div id="wrap">
  <div id="petbox"><div id="stage" data-help="stage"><canvas id="scene"></canvas><canvas id="fest"></canvas><canvas id="pet" width="480" height="200"></canvas><canvas id="festfront"></canvas><canvas id="wx"></canvas><div id="battlebox"><canvas id="battlecv"></canvas></div><div id="peekbox"><canvas id="peekcv"></canvas><div id="peekphone"><div class="island"></div><div class="scr"><div class="r1"><input id="peekcode" maxlength="7" placeholder="代號 例：2330" autocomplete="off"><button id="peekgo">查詢</button><span id="peekmsg"></span></div><div class="main"><div class="lf"><div id="pkname">輸入台股代號查詢</div><div id="pkprice">—</div><div id="pkchg"></div><div id="pkinfo"></div></div><table id="pkbook"></table></div><div class="ft"><span id="pktime">資料有延遲，僅供參考</span><button id="peekback" title="回到廣場">🚽 沖水回座位</button></div></div></div></div><div id="peekfade"></div><div id="stairsbox"><canvas id="stairscv"></canvas><div id="stairspanel"></div><button id="gmresign" style="display:none">🏳 認輸</button><button id="stout" style="display:none">🚪 先離開（回廣場）</button></div><div id="minipick"></div><div id="p2hl"></div><button id="pgprev" class="pgarrow" data-help="yardpage" title="上一頁">‹</button><button id="pgnext" class="pgarrow" data-help="yardpage" title="下一頁">›</button><div id="pgdots"></div><div id="photoflash"></div><div id="hud" data-help="hud"><div id="hudTime">–</div><div class="wx" id="hudWx">–</div></div></div>
    <div id="controls">
      ${UI_BUTTONS.filter(([c, , o]) => !(IS_RELEASE && ((o && o.dev) || DEV_ONLY.has(c))))
                  .map(([c, label, o]) => c === 'br' ? `<span class="rowbr" data-scope="home" data-when="${o.when}"></span>` : `<button data-cmd="${c}" data-help="${c}" data-scope="${(o && o.scope) || 'home'}"${o && o.when ? ` data-when="${o.when}"` : ''}${o && o.accent ? ' class="accent"' : o && o.dev ? ' class="devonly"' : ''}${o && o.confirm ? ` data-confirm="${o.confirm}"` : ''}${o && (o.scope === 'plaza' || o.scope === 'yard') ? ' style="display:none"' : ''}>${label}${o && o.dev ? ' <span class="devtag">dev</span>' : ''}</button>`)
                  // 好幾組能合體時的下拉，緊跟在合體鈕後面
                  .map((h) => (h.includes('data-cmd="jogress"') ? h + '<select id="jgsel" data-help="jogress" data-scope="home" data-when="jogressMulti" title="營地裡有好幾隻能合體，選一隻"></select>' : h))
                  .join('\n      ')}
      ${IS_RELEASE ? '' : '<button id="minifront" data-help="minifront" data-scope="home" class="devonly" title="自己玩小遊戲（單機，開發版限定）">🎮 小遊戲 <span class="devtag">dev</span></button>'}
      <span id="ctlright" style="margin-left:auto;display:flex;align-items:center;gap:10px">
      <button id="selfupdate" data-help="selfupdate" class="accent" style="display:none" title="下載新版並重開 daemon（幾秒鐘）">🆕 有新版本</button>
      <label class="k" id="festplaza" data-help="festplaza" style="display:none;margin-left:auto;align-items:center;gap:4px;font-size:12px"
             title="關掉的話，大家看到的你就是平常的樣子"><input type="checkbox" id="festcos2">顯示節慶造型</label>
      <label class="k" id="hudshow" data-help="hudshow" style="display:none;align-items:center;gap:4px;font-size:12px"
             title="右上角的日期／時間／天氣"><input type="checkbox" id="hudcb" checked>顯示天氣日期</label>
      <button id="helpbtn" title="教學：按了之後，點想問的地方">?</button>
      </span>
    </div>
    <div id="yardbar" style="display:none;margin-top:6px;font-size:12px;color:#8b949e">
      <span id="yardinfo" data-help="yardinfo">–</span>
      <span class="k">（點一下摸摸、按右鍵開選單）</span>
${IS_RELEASE ? '' : `<span class="devonly" data-help="yarddev">
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
      <label class="k">節日預覽 <span class="devtag">dev</span><select id="festsel">
        <option value="">自動（依日期）</option>
${FEST.FESTIVALS.map(f => `        <option value="${f.id}">${f.name}</option>`).join('\n')}
      </select></label>
      <label class="k"><input type="checkbox" id="zonebox"> 走動範圍 <span class="devtag">dev</span></label>
      <label class="k">第二頁 <span class="devtag">dev</span><select id="p2dev">
        <option value="">—</option>
        <option value="quest">進第二階段</option>
        <option value="win">下一場必勝</option>
        <option value="lose">下一場必敗</option>
        <option value="unlock">直接解鎖</option>
        <option value="reset">重置</option>
      </select></label>
      <label class="k">切法 <select id="zonelayout"><option value="">預設</option></select></label></span>`}
    </div>
    <div id="plazabar" style="display:none;margin-top:6px;font-size:12px;color:#8b949e">
      <button id="plazamode" data-help="plazamode" title="自動：隨機散步／手動：WASD 或方向鍵移動">🚶 自動</button>
      <button id="plazahappy" data-help="plazahappy" title="跳一下，大家都看得到">😄 開心</button>
      <button id="minibtn" data-help="minigame" title="跟廣場上的人一起玩小遊戲">🎮 小遊戲</button>
      <button id="plazaio" data-help="plazaio" style="float:right" title="辦公室的室內／室外（只影響你自己的畫面）">🏢 室內</button>
      <button id="peekbtn" data-help="peekbtn" title="上班請專心">🤫</button>
      <div id="plazainvite" data-help="plazainvite"></div>
      <div class="form" data-help="plazaname" style="margin-top:4px">
        <span class="lbl">🏷 名牌</span><input id="plazaname" placeholder="新名牌"><button id="plazarename">改名</button>
        <label class="k" title="名牌顏色">顏色 <input type="color" id="plazacolor" value="${plaza.NAME_DEFAULT_COLOR}"></label>
      </div>
      <div id="chatlog" data-help="chatlog"></div>
      <div class="form" id="chatrow" data-help="chat" style="margin-top:4px;position:relative">
        <button id="chatemoji" title="表情符號">😀</button><input id="chatin" maxlength="${PlazaServer.CHAT_MAX}" placeholder="說點什麼…（Enter 送出）"><button id="chatsend">送出</button>
        <div id="emojipick"></div>
      </div>
${IS_RELEASE ? '' : `      <div class="form" id="plazadevrow" data-help="plazadev" style="margin-top:4px">
        <label class="k" title="跟進階指令的「🛠 dev介面」是同一個開關"><input type="checkbox" id="plazadev"> dev 介面 <span class="devtag">dev</span></label>
        <label class="k devonly" title="只影響你自己的畫面">節日預覽 <span class="devtag">dev</span><select id="plazafestsel">
          <option value="">自動（依日期）</option>
${FEST.FESTIVALS.map(f => `          <option value="${f.id}">${f.name}</option>`).join('\n')}
        </select></label>
      </div>
`}${IS_RELEASE ? '' : `      <div class="form devonly" id="plazaadmin" data-help="plazaadmin" style="margin-top:4px">
        <span class="lbl">🛡 管理 <span class="devtag">dev</span></span><select id="admwho"></select><button id="admkick">踢出</button>
        <button id="admclear">清空聊天</button>
      </div>`}
    </div>
    <div id="cmdmsg"></div>
    <details id="adv" data-help="adv"><summary>⚙ 進階指令</summary>
      ${UI_FORMS.filter(f => !(IS_RELEASE && (f.dev || DEV_ONLY.has(f.action))))
                .map(f => `<div class="form${f.dev ? ' devonly' : ''}" data-help="${f.action || f.buttons[0][0]}" data-scope="${f.scope || 'home'}"${f.action ? ` data-cmd="${f.action}"` : ''}>
        <span class="lbl">${f.label}${f.dev ? ' <span class="devtag">dev</span>' : ''}</span>
        ${(f.fields || []).map(([k, ph]) => `<input data-f="${k}" placeholder="${ph}">`).join('')}
        ${f.buttons ? f.buttons.map(([a, t]) => `<button data-cmd="${a}">${t}</button>`).join('')
                    : `<button${f.confirm ? ` data-confirm="${f.confirm}"` : ''}>執行</button>`}
      </div>`).join('\n      ')}
      <div class="form" id="infoui" data-help="infoui"><span class="lbl">📊 daemon 資訊</span>
        <button data-on="1">顯示</button><button data-on="0">隱藏</button></div>
${IS_RELEASE ? '' : `      <div class="form" id="devui" data-help="devui"><span class="lbl">🛠 dev介面 <span class="devtag">dev</span></span>
        <button data-on="1">on</button><button data-on="0">off</button></div>`}
    </details>
    <div id="cmdout"></div></div>
  <div class="panel" id="info" data-help="info">
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
const DN=${DINO_SRC ? '(function(){const module={exports:{}};' + DINO_SRC + ';return module.exports;})()' : 'null'};   // 小恐龍的模擬（dino-sim.js）
const STS=${STAIRS_SRC ? '(function(){const module={exports:{}};' + STAIRS_SRC + ';return module.exports;})()' : 'null'};   // 下樓梯的模擬（stairs-sim.js）：前線單機用
const DS=${DUEL_SRC ? '(function(){const module={exports:{}};' + DUEL_SRC + ';return module.exports;})()' : 'null'};   // 手動戰鬥的判定（duel-sim.js）：dev 測試對戰在頁面跑
const MB_BOOM=${JSON.stringify(duelBoom())};   // 手動戰鬥被打中的爆炸（一般戰鬥那顆）
const VB=${VOLLEY_SRC ? '(function(){const module={exports:{}};' + VOLLEY_SRC + ';return module.exports;})()' : 'null'};   // 打排球的模擬（volley-sim.js）
const GMAI=${GOMOKU_AI_SRC ? '(function(){const module={exports:{}};' + GOMOKU_AI_SRC + ';return module.exports;})()' : 'null'};   // 五子棋的電腦（gomoku-ai.js）
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
// 圍爐圖層（composePlaza 的 layer）：原圖照縮放倍率畫在 dot 格上，縮小不丟像素。
// 一個原圖像素 = k 個 dot（k = 角色大小/16）→ 10/12/14 號是 5/6/7 px 見方。
function drawLayer(layer){
  if(!layer||!layer.length) return;
  const g=document.getElementById('pet').getContext('2d'), DW=CW, DH=CH/2;
  for(const it of layer){
    const sw=it.k*DW, sh=it.k*DH, x0=it.x*DW, y0=it.y*DH;
    for(let i=0;i<it.px.length;i++){
      const c=it.px.charCodeAt(i); if(c===46) continue;
      const cx=i%it.w, cy=(i-cx)/it.w;
      g.fillStyle=it.pal[c-48];
      g.fillRect(Math.round(x0+cx*sw), Math.round(y0+cy*sh), Math.ceil(sw), Math.ceil(sh));
    }
  }
}
function draw(petLines, target){
  const cv=target||document.getElementById('pet'),ctx=cv.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,cv.width,cv.height);
  if(!petLines){return;}
  const rows=petLines.map(parseAnsi);
  const maxW=Math.max(0,...rows.map(r=>r.length));
  // 前線（卡片、進化樹的字都在這）：內部解析度乘上 devicePixelRatio（2026-10-21 玩家回報）。
  // 瀏覽器縮放低於 100% 時，畫布原本是先畫成 100% 再被 pixelated 縮小 → 丟列，字缺筆畫。
  // 改成直接畫在實際的裝置像素上，CSS 尺寸不變（只設寬，高靠 height:auto 跟著比例）。
  // 只做前線：營地、廣場的拍照合成、圍爐圖層、天氣層都直接拿這張畫布的寬高對位，不去動它們。
  const dpr=(!target&&view==='home')?(window.devicePixelRatio||1):1;
  const cssW=Math.max(1,maxW*CW), cssH=Math.max(1,rows.length*CH);
  cv.width=Math.max(1,Math.round(cssW*dpr)); cv.height=Math.max(1,Math.round(cssH*dpr));
  cv.style.width=dpr!==1?cssW+'px':''; cv._dpr=dpr;
  ctx.textBaseline='top'; ctx.font='13px ui-monospace, Consolas, monospace';
  // 半格像素：直接畫在裝置像素上、邊界取整數（倍率不是整數時，小數座標會在格子之間留下細縫）
  const P=(v)=>Math.round(v*dpr);
  for(let r=0;r<rows.length;r++){
    for(let c=0;c<rows[r].length;c++){
      const cell=rows[r][c]; if(!cell||cell.ch!==undefined)continue;
      const x0=P(c*CW), x1=P((c+1)*CW), y0=P(r*CH), ym=P(r*CH+CH/2), y1=P((r+1)*CH);
      if(cell.top){ctx.fillStyle='rgb('+cell.top.join(',')+')';ctx.fillRect(x0,y0,x1-x0,ym-y0);}
      if(cell.bot){ctx.fillStyle='rgb('+cell.bot.join(',')+')';ctx.fillRect(x0,ym,x1-x0,y1-ym);}
    }
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);   // 文字照原本的 CSS 座標畫，交給 transform 換成裝置像素
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
// 營地第二頁（見下方「營地第二頁」那段）：目前看第幾頁、事件演到哪、空降中的那隻、對話框
let photoSeed=null, photoBusy=false, photoShot=null;   // 拍照中：seed（/yard?photo=）、合成好的照片
let yardPage=0, sliding=false, slideOv=null, slideMask=null;   // 翻頁滑行中：蓋在上面的快照／兩頁的角色層並排（天氣遮罩用）
let p2Phase=null, p2WaitAt=0, p2NoticeShown=false, p2Drop=null;
let story=null;   // { lines, i, done, typing, text }
// 這個元素在目前的畫面要不要出現。廣場是例外：進去之後**只剩**廣場自己的東西
// （規格 §六：在廣場不能切畫面、不能做會改變角色的事），'both' 的鈕也一律藏起來。
// 廣場不是「這個分頁在看哪裡」而是 daemon 的狀態 —— 每個分頁都會被帶進去（見 poll）。
function inScope(sc){
  if(view==='plaza') return sc==='plaza';
  return !sc || sc==='both' || sc===view;
}
// 每次切進營地換一個亂數，跟著 /yard 送出去：愚人節的變色版「進出一次抽一次」（見 festival.js swapChar）
let yardSalt=Math.random().toString(36).slice(2,8);
function setView(v){
  if(v!=='plaza'&&typeof peekShow==='function') peekShow(false,true);   // 離開廣場：廁所場景直接收掉
  if(comState&&v!==view) comStop();   // 單機小遊戲玩到一半切畫面 → 收掉（不然畫布會留在新畫面上）
  if(v==='yard' && view!=='yard') yardSalt=Math.random().toString(36).slice(2,8);
  if(v!=='yard' && view==='yard'){ p2Reset(); if(v!=='plaza') renderBattle(null); }
  if(v!=='yard'){ for(const id of ['pgprev','pgnext','pgdots']) document.getElementById(id).style.display='none'; }
  if(v==='yard' && view!=='yard') yardPage=0;
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
  document.getElementById('hudshow').style.display = (v==='yard'||v==='plaza') ? 'flex' : 'none';
  // 節慶勾選框要等 /yard、/plaza 回來才知道有沒有節日（applyFestival）；回前線先藏起來
  if(v!=='yard'&&v!=='plaza') document.getElementById('festplaza').style.display='none';
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
const WX_SHAFT_END_HOUR=17;   // 晴天光柱只到這個整點（本機時間）
let wxParts=null, wxLast=0, wxSeed=1;
function wxRand(){ wxSeed=(Math.imul(wxSeed,1664525)+1013904223)>>>0; return wxSeed/4294967296; }

// 天氣畫布要精準疊在角色畫布上。角色畫布每次 draw() 都會依內容重建尺寸，
// 所以每次畫完都要重新對位一次。
function syncWx(){
  const pet=document.getElementById('pet'), wx=document.getElementById('wx');
  const w=pet.offsetWidth, h=pet.offsetHeight;
  wx.style.left=pet.offsetLeft+'px'; wx.style.top=pet.offsetTop+'px';
  if(wx.width!==w||wx.height!==h){ wx.width=w; wx.height=h; }
  for(const id of ['scene','fest','festfront']){
    const fe=document.getElementById(id);
    fe.style.left=pet.offsetLeft+'px'; fe.style.top=pet.offsetTop+'px';
    if(fe.width!==w||fe.height!==h){ fe.width=w; fe.height=h; }
  }
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
  sceneDraw(ts);  // 廣場的常駐背景
  festDraw(ts);   // 節日背景：同一個幀迴圈
  const cv=document.getElementById('wx');
  if((view!=='yard'&&view!=='plaza')||!cv.width||!cv.height){ wxLast=ts; return; }
  // 室內（辦公室）：天氣只在落地窗外（sceneWeather），整片的天氣層清掉
  if(sceneIndoor()){ cv.getContext('2d').clearRect(0,0,cv.width,cv.height); wxLast=ts; return; }
  const dt=Math.min(0.1,(ts-wxLast)/1000)||0; wxLast=ts;
  const w=cv.width, h=cv.height, g=cv.getContext('2d');
  if(!wxParts||wxParts.w!==w||wxParts.h!==h) wxParts=wxBuild(w,h);
  const P=wxParts, sky=wxState.sky;
  const hwSky=sky==='clear'&&festShown()&&festState.id==='halloween';   // 萬聖節：晴天當陰天
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
  //    17:00 之後也關：夏天天黑得晚，傍晚還掛著正午那種光柱不對（看本機時鐘）。
  //    萬聖節背景顯示中也關，改飄陰天的雲（見下面）：鬼節配陽光不對。
  if(sky==='clear'&&!wxState.night&&new Date().getHours()<WX_SHAFT_END_HOUR&&!hwSky){
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
  // 萬聖節背景顯示中的晴天也飄（跟陰天一樣）。
  if(sky!=='clear'||hwSky){
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
    // 翻頁滑行中：底下的角色畫布已經是新的一頁（而且藏起來了），拿它當遮罩的話，陽光會照出
    // 新頁角色的輪廓（2026-10-19 回報，跟天空透出新頁同一類）。改用滑行用的「只有角色」那張
    // 兩頁並排圖（slideMask，不含地板 —— 含地板的話整片地面都會被當成角色加亮），
    // 照快照目前平移到的位置對齊。
    if(slideOv&&slideMask){
      const m=new DOMMatrixReadOnly(getComputedStyle(slideOv).transform), k=w/pet.offsetWidth;
      mg.drawImage(slideMask, m.m41*k, 0, slideOv.offsetWidth*k, h);
    } else mg.drawImage(pet,0,0,w,h);
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
  drawDrop(g, ts);
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

// ── 特殊節日（docs/festival-spec.md）──────────────────────────────────
// 背景：墊在角色下面的一張畫布，畫幾樣點陣小東西，**只放在邊緣**（上緣一條、下緣兩角），
// 中間是角色走路的地方，不放東西 —— 背景搶戲的話角色就看不清楚了。
// 一個 dot = CW x CH/2，跟角色同一套格子，所以裝飾跟角色一樣是方塊像素。
// 每一幀由 wxDraw 順手呼叫（蝙蝠拍翅、煙火要動），不另開一條 requestAnimationFrame 迴圈。
// 開關：廣場一律顯示；營地看「節日背景」勾選框（daemon 存的，換分頁也記得）。
const festState={id:null, bg:true, hasBg:false};
// 廣場的地平線：辦公室的牆腳、節日地板的上緣都在這裡（角色走到最上面時腳剛好踩在這）
const PLAZA_HORIZON=${PW.PLAZA_HORIZON};
// 蝙蝠不能用深色：營地底色是 rgb(24,24,24)，深紫疊上去幾乎看不見（截圖確認過）
const FEST_PAL={K:'#8a68b4',O:'#f0922a',Y:'#ffd84a',G:'#4f8a3a',R:'#de2028',W:'#ffffff',
  D:'#f2c94c',N:'#2f7d3e',P:'#8b5a2b',B:'#4a8cff',Q:'#5a6472',H:'#f0508c',A:'#3d7fd6',a:'#7fb8ff',
  M:'#fff1b8',m:'#e8cf7a',s:'#9aa3ad'};
const FEST_ART={
  pumpkin:['...G...','.OOOOO.','OYOOOYO','OOOOOOO','OYYYYYO','.OOOOO.'],
  bat1:['K.....K','KK.K.KK','..KKK..'],
  bat2:['..KKK..','.KK.KK.','K.....K'],
  tree:['....D....','....N....','...NNN...','..NNNNN..','...NNN...','..NNNNN..','.NNNNNNN.','NNNNNNNNN','....P....','....P....'],
  gift:['.D.D.','RRDRR','RRDRR','RRDRR'],
  redlantern:['..D..','.RRR.','RRDRR','RRRRR','.RRR.','..D..','..D..'],
  skylantern:['.OOO.','OYYYO','OYYYO','.OOO.','..Y..'],
  heart:['H.H','HHH','.H.'],
  balloon:['.XX.','XXXX','XXXX','.XX.','..s.','.s..','..s.'],
  boat:['..............NN','..O..O..O..O..NN','RRRRRRRRRRRRRRRN','.RDRDRDRDRDRDRR.','..RRRRRRRRRRRR..'],
};
// 一樣的圖換顏色用（氣球）：map 把某個字換成指定顏色
function festPix(g,art,x,y,alpha,map){
  g.globalAlpha=alpha==null?1:alpha;
  for(let r=0;r<art.length;r++) for(let c=0;c<art[r].length;c++){
    const ch=art[r][c]; if(ch==='.') continue;
    g.fillStyle=(map&&map[ch])||FEST_PAL[ch];
    g.fillRect(Math.round(x+c)*CW, Math.round(y+r)*(CH/2), CW, CH/2);
  }
  g.globalAlpha=1;
}
function festDot(g,x,y,color,alpha){
  g.globalAlpha=alpha; g.fillStyle=color;
  g.fillRect(Math.round(x)*CW, Math.round(y)*(CH/2), CW, CH/2); g.globalAlpha=1;
}
let festBursts=[], festNextBurst=0;
// 0～1 的固定亂數（同一個 i 每一幀都一樣）：雪花、星星、天燈的位置用它，不用另外存狀態
const festRnd=(i)=>{ const x=Math.sin(i*127.1+311.7)*43758.5453; return x-Math.floor(x); };
// 煙火：遠方的天空 → 只在畫面最上緣（跟萬聖節蝙蝠同高）、炸得小，畫在角色後面那張畫布
//（雙十晚上、跨年整天）。以前炸在上面三成的地方，看起來像在角色旁邊炸（回報過）
function festFireworks(g,ts,W,H,colors,gap){
  if(ts>festNextBurst){
    festNextBurst=ts+gap*(0.6+Math.random()*0.8);
    festBursts.push({x:4+Math.random()*(W-8), y:2.5+Math.random()*3, t0:ts,
                     c:colors[Math.floor(Math.random()*colors.length)]});
  }
  festBursts=festBursts.filter(b=>ts-b.t0<1100);
  for(const b of festBursts){
    const k=(ts-b.t0)/1100, r=0.6+k*3.4;
    for(let i=0;i<10;i++){
      const a=i/10*Math.PI*2;
      festDot(g,b.x+Math.cos(a)*r, b.y+Math.sin(a)*r*0.6, b.c, 0.9*(1-k));
    }
  }
}
// 跨年的遠景：上緣一排城市天際線，101 最高。
// 為什麼是遠景、不是右側一整根：101 從畫面底部長上來，等於立在營地地板上，跟角色一樣近，
// 看起來像營地裡的一根柱子（回報過）。遠方的東西要「只在上方、淡、底部起霧」，
// 跟下面的營地地面分開。顏色接近底色，窗燈稀疏、慢慢閃；煙火在它後面的天空炸開。
function festSkyline(g,ts,W,H){
  const base=Math.round(H*0.27);            // 天際線的「地面」：再下面就是營地
  const col='#2b3342', lit='#ffd84a';
  // 底部起霧：離 base 越近越淡 → 大樓沒有「站」在任何東西上
  const fade=(y)=>Math.max(0,Math.min(1,(base-y)/3));
  const dot=(x,y,c,a)=>{ const f=fade(y); if(f>0) festDot(g,x,y,c,a*f); };
  // 矮樓：寬 2～4、高 4～8，左右排滿（101 的位置留給它）
  const tx=Math.round(W*0.5);              // 正中間：右上是時間天氣看板，放右邊頂端會被蓋住
  for(let x=0,i=0;x<W;i++){
    const w=2+Math.floor(festRnd(i+300)*3), h=4+Math.floor(festRnd(i+400)*5);
    if(x+w>=tx-2 && x<=tx+2){ x=tx+3; continue; }
    for(let dx=0;dx<w;dx++) for(let y=base-h;y<=base;y++) dot(x+dx,y,col,0.9);
    if(festRnd(i+500)<0.6){
      const wy=base-h+1+Math.floor(festRnd(i+600)*(h-2));
      dot(x+Math.floor(w/2),wy,lit,0.25+0.35*(0.5+0.5*Math.sin(ts/900+i)));
    }
    x+=w;
  }
  // 101：天線 → 頂冠 → 八節（每節兩列，上列寬一點＝竹節外擴）→ 底座，一路到 base
  let y=1;
  for(;y<4;y++) dot(tx,y,col,0.95);
  dot(tx,y,col,0.95); y++;
  for(let k=0;k<8&&y<base-1;k++){
    for(let dx=-1;dx<=1;dx++) dot(tx+dx,y,col,0.95);
    dot(tx-1,y+1,col,0.95); dot(tx,y+1,col,0.95); dot(tx+1,y+1,col,0.95);
    dot(tx,y+1,lit,0.2+0.3*(0.5+0.5*Math.sin(ts/800+k)));
    y+=2;
  }
  for(;y<=base;y++) for(let dx=-2;dx<=2;dx++) dot(tx+dx,y,col,0.95);
}
// 由下往上飄的東西（天燈、愛心、氣球）：n 個，各自速度、左右晃，飄出上緣再從下面出來
function festRise(g,ts,W,H,n,art,h,alpha,mapOf){
  for(let i=0;i<n;i++){
    const sp=1.2+festRnd(i)*1.4, x=festRnd(i+50)*(W-6)+Math.sin(ts/1300+i*2)*1.5;
    const y=H+1-((ts/1000*sp+festRnd(i+90)*(H+h))%(H+h+2));
    festPix(g,art,x,y,alpha*(y<H*0.25?Math.max(0,y/(H*0.25)):1),mapOf&&mapOf(i));
  }
}
// ── 常駐背景（跟節日無關，一直都在）──────────────────────────────────
// 墊在節日背景下面的另一張畫布。
//   廣場：辦公室，常駐、不能關（角色的走動範圍照它的地平線限制，見 plaza-walk 的
//         PLAZA_HORIZON）。分室內／室外，每個人自己選（存在這台瀏覽器）：
//         室內 = 整面落地窗，天氣只出現在窗外（整片的天氣層關掉 —— 室內下雨很怪，回報過）；
//         室外 = 公司門口，天氣層照舊。節日有背景時換成節日的（互斥，節日優先）。
//   營地：一片草地，上面是天空和遠方的樹林。節日（有開節慶造型）換成節日的地板。
let plazaOutdoor=false;
try{ plazaOutdoor=localStorage.getItem('vpet.plazaOutdoor')==='1'; }catch(e){}
function sceneRect(g,x,y,w,h,c,a){
  g.globalAlpha=a==null?1:a; g.fillStyle=c;
  g.fillRect(Math.round(x)*CW, Math.round(y)*(CH/2), w*CW, h*(CH/2)); g.globalAlpha=1;
}
// 現在要畫哪一種：'office' / 'outdoor' / 'yard' / ''（不畫）
function sceneKind(){
  // 營地：節日背景顯示中就換成節日的（地板一起換，互斥），否則是草地
  if(view==='yard') return festShown() && festState.hasBg ? '' : 'yard';
  if(view==='plaza' && !(festState.hasBg && festState.bg)) return plazaOutdoor ? 'outdoor' : 'office';
  return '';
}
// 室內：天氣只在窗外，整片的天氣層不畫
function sceneIndoor(){ return sceneKind()==='office'; }
// 背景只要 10fps：上面的動畫都很慢（植物搖、程式碼捲、雲飄、窗外的雨），每幀重畫
// 只是讓 GPU 多合成一張整面的畫布。換場景、畫布尺寸變了（變尺寸會清空）就立刻重畫。
const SCENE_MS=100;
let sceneAt=-1e9, sceneKey='';
function sceneDraw(ts){
  const cv=document.getElementById('scene');
  const kind=sceneKind();
  document.body.classList.toggle('scene', !!kind);
  if(!kind||!cv.width||!cv.height){ sceneKey=''; return; }
  const key=kind+'|'+cv.width+'x'+cv.height;
  if(key===sceneKey && ts-sceneAt<SCENE_MS && ts>=sceneAt) return;
  sceneAt=ts; sceneKey=key;
  const g=cv.getContext('2d'), W=Math.floor(cv.width/CW), H=Math.floor(cv.height/(CH/2));
  g.clearRect(0,0,cv.width,cv.height);
  if(kind==='office') sceneOffice(g,ts,W,H);
  else if(kind==='outdoor') sceneOutdoor(g,ts,W,H);
  else sceneYard(g,ts,W,H);
}
// 錯縫鋪磚（y0 以下）：w×h 一塊，奇數排錯開半塊，最上一列和最左一行是縫
function sceneBricks(g,W,H,y0,w,h,cols,seam){
  for(let y=y0,r=0;y<H;y+=h,r++){
    const off=r%2?Math.floor(w/2):0;
    for(let x=-off,k=0;x<W;x+=w,k++){
      sceneRect(g,x,y,w,h,cols[Math.floor(festRnd(r*31+k)*cols.length)]);
      sceneRect(g,x,y,1,h,seam); sceneRect(g,x,y,w,1,seam);
    }
  }
}
// 草地（y0 以下）：底色＋一撮一撮的草（固定位置，微微搖）
function sceneGrass(g,ts,W,H,y0,base,tuft,n){
  sceneRect(g,0,y0,W,H-y0,base);
  for(let i=0;i<n;i++){
    const x=Math.floor(festRnd(i+400)*W), y=y0+1+Math.floor(festRnd(i+500)*(H-y0-1));
    sceneRect(g,x+(Math.sin(ts/1400+i)>0.6?1:0),y,1,1,tuft); sceneRect(g,x+1,y,1,1,tuft,0.6);
  }
}
function sceneMix(a,b,t){
  const p=(h,i)=>parseInt(h.substr(1+i*2,2),16);
  let o='#';
  for(let i=0;i<3;i++) o+=Math.round(p(a,i)+(p(b,i)-p(a,i))*t).toString(16).padStart(2,'0');
  return o;
}
// 天空（y0～y1）：跟著天氣、日夜換顏色，上深下淺
function sceneSky(g,W,y0,y1){
  const sky=wxState.sky, night=wxState.night;
  const c = night ? ['#0d1322','#1a2440'] : sky==='clear' ? ['#3c6fa6','#76a6d4']
          : sky==='cloudy' ? ['#535e6b','#717c89'] : sky==='rain' ? ['#404a56','#55606b'] : ['#2c343e','#404853'];
  for(let y=y0;y<=y1;y++) sceneRect(g,0,y,W,1,sceneMix(c[0],c[1],(y-y0)/Math.max(1,y1-y0)));
}
// 遠方的大樓（x0～x1，底在 base）：白天被霧氣染淡，晚上剩剪影和亮著的窗
function sceneCity(g,ts,x0,x1,base){
  const sky=wxState.sky, night=wxState.night;
  const col = night ? '#1b2232' : sky==='clear' ? '#4b5d74' : '#4c545f';
  for(let x=x0,i=0;x<x1;i++){
    const w=3+Math.floor(festRnd(i+600)*4), h=3+Math.floor(festRnd(i+700)*7);
    sceneRect(g,x,base-h+1,Math.min(w,x1-x),h,col);
    // 晚上：窗戶排成格子（隔一格一扇），亮不亮各自決定，偶爾有人關燈／開燈
    if(night) for(let ly=base-h+2;ly<base;ly+=2) for(let lx=x+1;lx<x+w-1&&lx<x1;lx+=2){
      if(festRnd(lx*31+ly*7+Math.floor(ts/9000+lx))<0.35) sceneRect(g,lx,ly,1,1,'#ffd84a',0.5);
    }
    x+=w+(festRnd(i+800)<0.3?1:0);
  }
}
// 窗外的天氣（y0～y1 這一段）：雲、雨、閃電、寒風。室內版的天氣全在這裡
function sceneWeather(g,ts,W,y0,y1){
  const sky=wxState.sky, night=wxState.night, hh=y1-y0+1;
  if(night && sky==='clear'){
    for(let i=0;i<10;i++) sceneRect(g,Math.floor(festRnd(i+900)*W),y0+Math.floor(festRnd(i+950)*(hh*0.5)),1,1,'#ffffff',0.3+0.4*(0.5+0.5*Math.sin(ts/700+i)));
  }
  // 雲：晴天兩朵白的慢慢飄，壞天氣多幾朵灰的、飄得快
  const nC = sky==='clear' ? 2 : 5, cc = sky==='clear' ? '#e6eef7' : (night ? '#3a4352' : '#9aa3ad');
  const sp = sky==='storm'||sky==='thunder' ? 2.5 : sky==='rain' ? 1.6 : 0.8;
  for(let i=0;i<nC;i++){
    const w=5+Math.floor(festRnd(i+30)*4), x=((ts/1000*sp*(0.6+festRnd(i)*0.6)+festRnd(i+40)*W)%(W+w+4))-w-2, y=y0+1+Math.floor(festRnd(i+50)*(hh*0.35));
    sceneRect(g,x,y,w,1,cc,0.6); sceneRect(g,x+1,y-1,w-3,1,cc,0.5);
  }
  if(sky==='rain'||sky==='storm'||sky==='thunder'){
    const n = sky==='rain' ? 26 : 44;
    for(let i=0;i<n;i++){
      const v=9+festRnd(i+60)*5, y=y0+((ts/1000*v+festRnd(i+70)*hh)%hh), x=festRnd(i+80)*W-(y-y0)*0.3;
      sceneRect(g,x,y,1,1,'#a9c4d8',0.45); sceneRect(g,x-0.3,y+1<=y1?y+1:y,1,1,'#a9c4d8',0.3);
    }
  }
  if(sky==='thunder'){
    const e=ts%5600;
    if(e<90||(e>160&&e<240)){
      sceneRect(g,0,y0,W,hh,'#e4eeff',e<90?0.35:0.18);
      const bx=Math.floor(festRnd(Math.floor(ts/5600))*(W-8))+4;
      for(let y=y0,x=bx;y<y0+hh*0.7;y++){ sceneRect(g,x,y,1,1,'#ffffff',0.9); x+=(festRnd(y+bx)<0.5?-1:1); }
    }
  }
  if(wxState.cold){
    for(let i=0;i<4;i++){
      const x=((ts/1000*(14+i*3)+festRnd(i+90)*W)%(W+10))-5, y=y0+2+Math.floor(festRnd(i+95)*(hh-4));
      sceneRect(g,x,y,3,1,'#dfefff',0.35); sceneRect(g,x+3,y,2,1,'#dfefff',0.15);
    }
  }
}
// 辦公室（室內）：上面 18 dot 是一整面落地窗（角色走到最上面時腳剛好踩在窗腳），
// 窗外是天空和遠方的大樓，天氣都在窗外。下面是地毯。
// 顏色刻意壓暗、低彩度 —— 角色是 16x16 的小圖，背景一搶眼就分不出誰是誰。
// 右上角是時間／天氣看板，那裡只放矮的東西（飲水機、盆栽）。
function sceneOffice(g,ts,W,H){
  const WALL=PLAZA_HORIZON, R=(x,y,w,h,c,a)=>sceneRect(g,x,y,w,h,c,a);
  const sky=wxState.sky, night=wxState.night;
  // 窗外：天空 → 大樓 → 天氣，再整片壓暗一點（室內看出去，也不讓窗外搶戲）
  sceneSky(g,W,1,WALL-2);
  sceneCity(g,ts,0,W,WALL-2);
  sceneWeather(g,ts,W,1,WALL-2);
  R(0,1,W,WALL-2,'#0d1117',0.22);
  // 窗框：上樑、窗腳、四根直框；玻璃上幾道斜斜的反光
  R(0,0,W,1,'#3a3f48'); R(0,WALL-1,W,1,'#4a3f33');
  for(const x of [0,17,34,51,68]) R(x,1,1,WALL-2,'#454b55');
  for(const x0 of [3,21,38,55]) for(let k=0;k<5;k++) R(x0+k,WALL-3-k,1,1,'#ffffff',0.06);
  // 地毯拼塊：兩個很接近的顏色交錯
  for(let y=WALL;y<H;y+=4) for(let x=0;x<W;x+=6)
    R(x,y,6,4,((x/6+(y-WALL)/4)%2)?'#1f2227':'#23272d');
  R(0,WALL,W,1,'#16181c',0.8);   // 窗腳的陰影
  // 晴天白天：陽光從落地窗斜斜灑在地毯上
  if(sky==='clear'&&!night&&new Date().getHours()<WX_SHAFT_END_HOUR){
    for(const [a,b] of [[1,16],[18,33],[35,50],[52,67]])
      for(let y=WALL;y<WALL+12;y++) R(a+(y-WALL)*0.8,y,b-a,1,'#ffeeb4',0.07*(1-(y-WALL)/12));
  }
  // 白板（有腳的那種，站在窗前）：藍色字、紅色圈、一條長條圖
  R(2,4,14,8,'#8b949e'); R(3,5,12,6,'#d5d9df');
  R(4,6,6,1,'#4a8cff'); R(4,8,4,1,'#4a8cff'); R(9,8,2,1,'#4a8cff');
  R(11,6,3,1,'#de2028'); R(11,7,1,1,'#de2028'); R(13,7,1,1,'#de2028'); R(11,8,3,1,'#de2028');
  for(const [x,h] of [[4,1],[6,2],[8,3]]) R(x,11-h,1,h,'#3fb950');
  R(3,12,12,1,'#59606b'); R(3,13,1,4,'#59606b'); R(14,13,1,4,'#59606b');
  // 掛鐘（掛在中間那根窗框上）：分針照真的時間轉
  const now=new Date(), mA=(now.getMinutes()/60)*Math.PI*2, hA=((now.getHours()%12)/12+now.getMinutes()/720)*Math.PI*2;
  R(33,3,3,5,'#c9d1d9'); R(32,4,5,3,'#c9d1d9'); R(33,4,3,3,'#eef0f3');
  R(34,5,1,1,'#30363d');
  R(34+Math.round(Math.sin(mA)),5-Math.round(Math.cos(mA)),1,1,'#30363d');
  R(34+Math.round(Math.sin(hA)*0.6),5-Math.round(Math.cos(hA)*0.6),1,1,'#de2028');
  // 窗前兩張辦公桌：螢幕上的程式碼一行一行往上捲，旁邊一杯咖啡
  for(const dx0 of [18,37]){
    R(dx0,14,14,1,'#7a6248'); R(dx0,15,14,1,'#5a4733');
    R(dx0+1,16,1,1,'#3d3022'); R(dx0+12,16,1,1,'#3d3022');
    R(dx0+4,9,7,5,'#1b1f24'); R(dx0+5,10,5,3,'#14283a');
    for(let r=0;r<3;r++){
      const k=Math.floor(ts/600)+r+dx0, len=1+Math.floor(festRnd(k)*4);
      R(dx0+5+(festRnd(k+5)<0.4?1:0),10+r,Math.min(len,5),1, festRnd(k+3)<0.5?'#5fe08a':'#79c0ff',0.8);
    }
    R(dx0+7,13,1,1,'#30363d');
    R(dx0+5,14,4,1,'#8b949e');   // 鍵盤
    R(dx0+12,13,1,1,'#e6e6e6');   // 咖啡杯
  }
  // 盆栽
  R(53,14,4,3,'#8b5a2b'); R(53,14,4,1,'#a06a34');
  for(const [x,y,c] of [[54,10,'#3f8f3c'],[55,9,'#5fb04a'],[53,11,'#5fb04a'],[56,11,'#3f8f3c'],[54,12,'#5fb04a'],[55,12,'#3f8f3c'],[55,11,'#5fb04a'],[54,11,'#3f8f3c'],[56,10,'#5fb04a'],[53,12,'#3f8f3c'],[56,12,'#5fb04a']])
    R(x+Math.round(Math.sin(ts/1800+x)*0.4),y,1,1,c);
  // 飲水機：水桶偶爾冒一個泡泡上去
  R(61,8,4,4,'#79c0ff',0.55); R(61,8,4,1,'#9fd3ff',0.6);
  R(60,12,6,5,'#c9d1d9'); R(60,12,6,1,'#e6eaef');
  R(61,14,1,1,'#de2028'); R(64,14,1,1,'#4a8cff'); R(61,16,4,1,'#8b949e');
  const bub=(ts%4000)/4000; if(bub<0.6) R(62+(bub>0.3?1:0),11-Math.floor(bub/0.6*4),1,1,'#e6f3ff',0.9);
}
// 公司門口（室外）：左邊是公司大樓的玻璃門，後面一排樹籬和行道樹、遠方大樓，
// 右邊一盞路燈（晚上會亮），地上是紅磚人行道。天氣交給整片的天氣層。
function sceneOutdoor(g,ts,W,H){
  const HZ=PLAZA_HORIZON, R=(x,y,w,h,c,a)=>sceneRect(g,x,y,w,h,c,a), night=wxState.night;
  sceneSky(g,W,0,HZ-1);
  sceneCity(g,ts,20,W,HZ-3);
  R(0,0,W,HZ,'#0d1117',0.3);   // 室外也壓暗一點：天氣層的雲、光還會再疊上來
  // 公司大樓：外牆、一格一格的窗（晚上有幾格還亮著）、玻璃自動門
  R(0,0,20,HZ,'#353a43'); R(19,0,1,HZ,'#2b2f37');
  for(let y=1;y<10;y+=3) for(let x=1;x<19;x+=3){
    const lit=night ? festRnd(x*7+y)<0.4 : false;
    R(x,y,2,2, lit ? '#ffd84a' : '#4b5d74', lit ? 0.7 : 0.8);
  }
  R(5,10,10,1,'#59606b');   // 雨遮
  R(6,11,8,HZ-11,'#5d7a99',0.55); R(10,11,1,HZ-11,'#454b55'); R(6,11,8,1,'#454b55');
  R(7,12,1,3,'#ffffff',0.12); R(11,12,1,3,'#ffffff',0.12);
  // 樹籬＋兩棵行道樹（樹冠微微擺）
  R(20,HZ-3,W-20,3,'#22392a'); for(let x=20;x<W;x+=2) R(x+(x%4?0:1),HZ-3,1,1,'#2d4a33');
  for(const tx of [28,47]){
    R(tx,HZ-8,1,5,'#4a3424');
    const sw=Math.round(Math.sin(ts/1600+tx)*0.5);
    R(tx-3+sw,HZ-12,7,4,'#2a4a30'); R(tx-2+sw,HZ-13,5,1,'#2a4a30'); R(tx-2+sw,HZ-11,2,1,'#3a6a40');
  }
  // 長椅（樹籬前）
  R(34,HZ-3,9,1,'#7a6248'); R(34,HZ-2,9,1,'#5a4733'); R(35,HZ-1,1,1,'#3d3022'); R(41,HZ-1,1,1,'#3d3022');
  // 紅磚人行道
  sceneBricks(g,W,H,HZ,6,3,['#3a2a26','#3d2c28','#36281f'],'#2c201c');
  R(0,HZ,W,1,'#16181c',0.7);
  // 路燈：晚上亮，地上一圈暖光
  R(62,3,1,HZ-3,'#59606b'); R(60,3,4,1,'#59606b');
  R(60,4,2,1, night ? '#ffd84a' : '#8b949e');
  if(night){ R(58,HZ,8,3,'#ffd84a',0.08); R(59,HZ+3,6,2,'#ffd84a',0.05); }
}
// 營地：地平線以上是天空、遠山和一排樹林，下面是草地，零星幾朵小花和石頭。
// 天氣交給整片的天氣層（營地在戶外）。
function sceneYard(g,ts,W,H){
  const HZ=PLAZA_HORIZON, night=wxState.night;
  sceneSky(g,W,0,HZ-1);
  for(let x=0;x<W;x++){   // 遠山：兩層起伏
    const h1=4+Math.round(2.5*Math.sin(x/7)+1.5*Math.sin(x/3.1+1));
    sceneRect(g,x,HZ-h1,1,h1, night?'#151c26':'#3a4a52');
  }
  for(let x=0;x<W;x+=3){  // 樹林：一排圓圓的樹冠，微微擺
    const h=3+Math.floor(festRnd(x+1800)*3), sw=Math.round(Math.sin(ts/1700+x)*0.4);
    sceneRect(g,x+sw,HZ-h,3,h, night?'#121a15':'#22382a');
    sceneRect(g,x+1+sw,HZ-h-1,1,1, night?'#121a15':'#22382a');
  }
  sceneRect(g,0,0,W,HZ,'#0d1117',0.3);   // 壓暗一點，天氣層的雲、光還會疊上來
  sceneGrass(g,ts,W,H,HZ,'#1d281e','#273526',60);
  for(let i=0;i<10;i++){
    const x=Math.floor(festRnd(i+1600)*W), y=HZ+1+Math.floor(festRnd(i+1700)*(H-HZ-1));
    sceneRect(g,x,y,1,1, i%3===0 ? '#d8d2b0' : i%3===1 ? '#c9b85a' : '#4a4f55', i%3===2 ? 0.8 : 0.55);
  }
}
// 廣場的地板：每個節日一種，跟背景同一個氣氛。地平線跟辦公室的牆腳同高（PLAZA_HORIZON），
// 上面留給天空的東西（煙火、月亮、星星）。顏色一律壓暗、低彩度 —— 角色站在上面要看得清楚。
// 營地、廣場都鋪（營地的節日背景要開「顯示節慶造型」才會出現）。
function festFloor(g,ts,W,H,id){
  const HZ=PLAZA_HORIZON, R=(x,y,w,h,c,a)=>sceneRect(g,x,y,w,h,c,a);
  const bricks=(w,h,cols,seam)=>sceneBricks(g,W,H,HZ,w,h,cols,seam);
  const grass=(base,tuft,n)=>sceneGrass(g,ts,W,H,HZ,base,tuft,n);
  const sprinkle=(n,seed,c,a)=>{ for(let i=0;i<n;i++) R(Math.floor(festRnd(i+seed)*W),HZ+1+Math.floor(festRnd(i+seed+97)*(H-HZ-1)),1,1,c,a); };
  if(id==='doubleten'){
    // 總統府前的石板廣場：大塊灰石板
    bricks(10,5,['#2c2e33','#2f3136','#2a2c31'],'#25272b');
  } else if(id==='halloween'){
    // 紫灰色的石子路＋幾片橘色落葉
    R(0,HZ,W,H-HZ,'#211c26');
    for(let y=HZ+1,r=0;y<H;y+=3,r++) for(let x=(r%2)*2,k=0;x<W;x+=4,k++)
      R(x,y,3,2,festRnd(r*17+k)<0.5?'#29232f':'#2d2633');
    sprinkle(10,700,'#a05a1e',0.7);
  } else if(id==='christmas'){
    // 積雪的地面：一條條起伏的雪堆，偶爾閃一下
    R(0,HZ,W,H-HZ,'#2a3039');
    for(let y=HZ+2;y<H;y+=5) for(let x=0;x<W;x++){
      const t=Math.sin(x/4+y)*1.2; R(x,y+Math.round(t),1,2,'#353c47');
    }
    for(let i=0;i<8;i++){ const a=Math.max(0,Math.sin(ts/500+i*2.3)); if(a>0.7) R(Math.floor(festRnd(i+800)*W),HZ+2+Math.floor(festRnd(i+900)*(H-HZ-3)),1,1,'#ffffff',a*0.6); }
  } else if(id==='newyear'){
    // 跨年晚會的廣場：深藍地磚，映著一點煙火的顏色
    for(let y=HZ;y<H;y+=4) for(let x=0;x<W;x+=6) R(x,y,6,4,((x/6+(y-HZ)/4)%2)?'#1b2030':'#1f2536');
    const cs=['#de2028','#5b8cff','#ffd84a','#f0508c'];
    for(let i=0;i<6;i++){ const a=Math.max(0,Math.sin(ts/900+i*1.7)); R(Math.floor(festRnd(i+1000)*W),HZ+2+Math.floor(festRnd(i+1100)*(H-HZ-3)),2,1,cs[i%cs.length],a*0.25); }
  } else if(id==='lunarny'){
    // 三合院的青磚地＋滿地鞭炮紅紙屑
    bricks(6,3,['#2a2d33','#2d3037','#282b30'],'#232529');
    sprinkle(18,1200,'#b0151c',0.75);
  } else if(id==='lantern'){
    // 廟埕的大石板，地上映著燈籠的暖光（慢慢明暗）
    bricks(12,6,['#2b2925','#2e2b27','#292723'],'#242220');
    for(let i=0;i<3;i++){
      const cx=Math.round(W*(0.2+0.3*i)), cy=HZ+8+i*7, a=0.07+0.03*Math.sin(ts/400+i);
      R(cx-5,cy-1,10,3,'#ffb347',a); R(cx-3,cy-2,6,5,'#ffb347',a);
    }
  } else if(id==='valentine'){
    // 木地板（帶一點玫瑰色）＋幾片花瓣
    for(let y=HZ,r=0;y<H;y+=2,r++){
      R(0,y,W,2,r%2?'#30262a':'#33292d'); R(0,y,W,1,'#2a2125',0.5);
      for(let x=Math.floor(festRnd(r)*9);x<W;x+=9+Math.floor(festRnd(r+x)*6)) R(x,y,1,2,'#261e21');
    }
    sprinkle(8,1300,'#d86a95',0.55);
  } else if(id==='qingming'){
    // 濕濕的草地，中間一條石板小徑
    grass('#1e2820','#27352a',40);
    for(let y=HZ,k=0;y<H;y+=3,k++){
      const x=Math.round(W/2-5+Math.sin(k*0.8)*4);
      R(x,y,7,2,'#2c302f'); R(x+1,y,5,1,'#353a39',0.8);
    }
  } else if(id==='children'){
    // 遊樂場的安全地墊：四色拼塊（都壓暗）
    const cs=['#262c40','#283628','#3a2828','#36321f'];
    for(let y=HZ,r=0;y<H;y+=4,r++) for(let x=0,k=0;x<W;x+=6,k++){ R(x,y,6,4,cs[(r+k)%4]); R(x,y,6,1,'#1c1e24',0.5); }
  } else if(id==='dragonboat'){
    // 河邊的木棧道（下緣的水面另外畫）
    for(let y=HZ,r=0;y<H;y+=3,r++){
      R(0,y,W,3,r%2?'#352a1f':'#3a2e22'); R(0,y,W,1,'#2a2118');
      for(let x=(r*5)%11;x<W;x+=11) R(x,y+1,1,1,'#55452f');   // 釘子
    }
  } else if(id==='qixi'){
    // 夜裡的草原，螢火蟲慢慢飄
    grass('#172128','#1f2c33',36);
    for(let i=0;i<7;i++){
      const x=festRnd(i+1400)*W+Math.sin(ts/1300+i)*3, y=HZ+3+festRnd(i+1500)*(H-HZ-6)+Math.cos(ts/1700+i*2)*2;
      R(x,y,1,1,'#d8ff7a',0.25+0.55*Math.max(0,Math.sin(ts/600+i*1.9)));
    }
  } else if(id==='midautumn'){
    // 中秋烤肉的草皮，左下鋪一塊野餐墊
    grass('#1f2a1f','#283728',36);
    for(let y=0;y<4;y++) for(let x=0;x<12;x++) R(3+x,H-7+y,1,1,((x>>1)+(y>>1))%2?'#5a2a2a':'#8a8478',0.75);
  }
}
// 節日背景現在有沒有在畫（廣場一律、營地看開關）
// 廣場、營地都看同一顆「顯示節慶造型」：關掉 = 自己看到的畫面不過節（2026-10-21：廣場原本只拿掉自己的帽子）
function festShown(){ return !!festState.id && (view==='plaza' || view==='yard') && festState.bg; }
function festDraw(ts){
  const cv=document.getElementById('fest');
  const on = festShown();
  document.body.classList.toggle('fest', on);
  if(!on||!cv.width||!cv.height) return;
  const g=cv.getContext('2d'), W=Math.floor(cv.width/CW), H=Math.floor(cv.height/(CH/2));
  g.clearRect(0,0,cv.width,cv.height);
  festFloor(g,ts,W,H,festState.id);   // 地板先鋪，其他東西疊在上面（營地、廣場都鋪）
  // 前景（疊在角色上面）：雙十彩旗、春節燈籠 —— 掛在鏡頭前的東西
  const fcv=document.getElementById('festfront'), gf=fcv.getContext('2d');
  gf.clearRect(0,0,fcv.width,fcv.height);
  if(festState.id==='doubleten'){
    // 上緣一條彩旗：紅白藍三角旗掛在微微下垂的繩子上，掛在**鏡頭前**（前景畫布）
    // 繩子兩端在畫面外（y=-1），中間垂到 y=1：太低會跟右上角的時間／天氣看板疊在一起
    const sag=2;
    for(let x=0;x<W;x++){
      const t=2*x/(W-1)-1, y=sag*(1-t*t)-1;
      festDot(gf,x,y,'#8b949e',0.6);
      if(x%5===2){
        const c=['#de2028','#ffffff','#0038a8'][Math.floor(x/5)%3];
        for(let dx=-1;dx<=1;dx++) festDot(gf,x+dx,y+1,c,0.85);
        festDot(gf,x,y+2,c,0.85);
      }
    }
    // 晚上加煙火
    if(wxState.night) festFireworks(g,ts,W,H,['#de2028','#ffffff','#5b8cff','#ffd84a'],2500);
  } else if(festState.id==='halloween'){
    // 蜘蛛網試過拿掉了：一格 dot 太大，九格的網看起來是一塊灰色棋盤，不像網
    // 上緣三隻蝙蝠慢慢飛過，翅膀兩幀
    for(let i=0;i<3;i++){
      const sp=2.2+i*0.7, x=((ts/1000*sp+i*W/3)%(W+14))-7;
      const y=3+i*2+Math.sin(ts/600+i)*1.2;
      festPix(g,(Math.floor(ts/250)+i)%2?FEST_ART.bat1:FEST_ART.bat2,x,y,0.9);
    }
    // 下緣兩角的南瓜燈，眼睛會閃（蓋一層忽明忽暗的黑）
    const glow=0.75+0.25*Math.sin(ts/300);
    for(const px of [1,W-8]){
      festPix(g,FEST_ART.pumpkin,px,H-7,1);
      g.globalAlpha=1-glow; g.fillStyle='#000';
      for(const [c,r] of [[1,2],[5,2],[1,4],[2,4],[3,4],[4,4],[5,4]])
        g.fillRect((px+c)*CW,(H-7+r)*(CH/2),CW,CH/2);
      g.globalAlpha=1;
    }
  } else if(festState.id==='christmas'){
    // 飄雪（整面，很淡）＋右下聖誕樹（燈會閃）＋左下禮物
    for(let i=0;i<40;i++){
      const sp=1+festRnd(i)*1.2, x=festRnd(i+7)*W+Math.sin(ts/1500+i)*1.5;
      const y=((ts/1000*sp)+festRnd(i+30)*(H+2))%(H+2)-1;
      festDot(g,x,y,'#ffffff',0.35+festRnd(i+60)*0.35);
    }
    festPix(g,FEST_ART.tree,W-11,H-10,1);
    const lights=[[4,3],[3,5],[5,5],[2,6],[6,6],[4,7],[1,7],[7,7]];
    lights.forEach(([c,r],i)=>festDot(g,W-11+c,H-10+r,['#de2028','#ffd84a','#4a8cff'][(Math.floor(ts/450)+i)%3],1));
    festPix(g,FEST_ART.gift,2,H-4,1);
  } else if(festState.id==='newyear'){
    // 整天都放煙火（晚上放得比較密）＋上緣城市天際線（101 最高）
    // 先放煙火、再蓋天際線：煙火在大樓後面的天空炸開
    festFireworks(g,ts,W,H,['#de2028','#ffffff','#5b8cff','#ffd84a','#f0508c','#5fe08a'],wxState.night?1300:2600);
    festSkyline(g,ts,W,H);
  } else if(festState.id==='lunarny'){
    // 上緣一整排紅燈籠微微晃，掛在**鏡頭前**（前景畫布，角色走過去會被擋住）；
    // 下緣兩角掛鞭炮，底下一直冒火花
    const nL=Math.max(3,Math.floor(W/11));
    for(let i=0;i<nL;i++){
      festPix(gf,FEST_ART.redlantern,Math.round((i+0.5)*W/nL)-2+Math.sin(ts/900+i)*0.6,0,1);
    }
    for(const px of [3,W-4]){
      // 中間一條引信，兩側交錯一節一節的紅炮
      for(let r=0;r<9;r++){
        festDot(g,px,H-12+r,'#8b5a2b',1);
        festDot(g,px+(r%2?1:-1),H-12+r,'#de2028',1);
        if(r%2===0) festDot(g,px+(r%4?2:-2),H-12+r,'#b0151c',1);
      }
      for(let k=0;k<4;k++){
        const t=Math.floor(ts/120)+k*7+px;
        festDot(g,px-2+festRnd(t)*4,H-3+festRnd(t+1)*2,festRnd(t+2)<0.5?'#ffd84a':'#ffffff',0.9);
      }
    }
  } else if(festState.id==='lantern'){
    // 天燈從下面慢慢飄上去，火光一閃一閃
    // 上升的東西都壓暗（半透明）：滿畫面在飄，太亮會搶過角色
    festRise(g,ts,W,H,6,FEST_ART.skylantern,5,0.45*(0.85+0.15*Math.sin(ts/200)));
  } else if(festState.id==='valentine'){
    festRise(g,ts,W,H,9,FEST_ART.heart,3,0.4);
  } else if(festState.id==='qingming'){
    // 清明：低調。斜斜的毛毛雨（很淡）＋左上垂下幾條柳枝隨風擺，偶爾飄一片柳葉
    for(let i=0;i<34;i++){
      const sp=6+festRnd(i)*3, x0=festRnd(i+11)*(W+8);
      const t=(ts/1000*sp+festRnd(i+23)*(H+4))%(H+4)-2;
      for(let k=0;k<2;k++) festDot(g,x0-(t+k)*0.35,t+k,'#a9c4d8',0.18+0.08*k);
    }
    // 一根橫枝從左上角伸出來，底下垂幾條長短不一的柳條；柳條細細一條、兩側交錯長葉子，
    // 越往下擺越大（實心直條試過，看起來像柵欄）
    for(let x=0;x<16;x++) festDot(g,x,x<8?0:1,'#6b4a2b',0.9);
    [7,11,5,9,6,10].forEach((len,b)=>{
      const bx=1+b*2.6, sway=Math.sin(ts/1500+b*0.9)*1.6;
      for(let r=0;r<len;r++){
        const k=(r/len)*(r/len), x=bx+sway*k, y=(bx<8?1:2)+r;
        festDot(g,x,y,'#4f8f3c',0.8);
        if(r%2===1) festDot(g,x+((r>>1)%2?1:-1),y,'#8fcf6a',0.75);
      }
    });
    for(let i=0;i<3;i++){
      const sp=1+festRnd(i+70)*0.6, t=(ts/1000*sp+i*7)%(H+4);
      festDot(g,4+i*3+t*0.8+Math.sin(ts/500+i)*1.5,6+t,'#8fcf6a',0.7);
    }
  } else if(festState.id==='children'){
    const cols=['#de2028','#4a8cff','#ffd84a','#5fe08a','#f0508c'];
    festRise(g,ts,W,H,6,FEST_ART.balloon,5,0.45,(i)=>({X:cols[i%cols.length]}));
  } else if(festState.id==='dragonboat'){
    // 下緣水面＋一艘龍舟慢慢划過去（槳手一上一下）
    const sp=ts/1000*3, bx=(sp%(W+16))-14;
    festPix(g,FEST_ART.boat,bx,H-6,1);
    // 槳：一拍往前一拍往後
    for(let k=0;k<4;k++) festDot(g,bx+2+k*3+(Math.floor(ts/300)%2?1:-1),H-3,'#8b5a2b',1);
    for(let x=0;x<W;x++){
      const crest=Math.sin(x/3+ts/500)>0.3;
      festDot(g,x,H-2,'#3d7fd6',0.75);
      festDot(g,x,H-1,'#2a5fa8',0.85);
      if(crest) festDot(g,x,H-3,'#7fb8ff',0.6);
    }
  } else if(festState.id==='qixi'){
    // 上半部星空：星星一閃一閃，兩顆十字亮星是牛郎、織女（銀河試過，一格 dot 太粗，看起來像灰塵）
    for(let i=0;i<22;i++){
      const x=festRnd(i+100)*W, y=festRnd(i+200)*(view==='plaza'?PLAZA_HORIZON-1:H*0.45);   // 廣場：只在地平線上
      festDot(g,x,y,'#ffffff',0.25+0.45*(0.5+0.5*Math.sin(ts/(500+festRnd(i)*600)+i)));
    }
    const tw=0.75+0.25*Math.sin(ts/400);
    for(const [sx,sy,c] of [[Math.round(W*0.12),Math.round(H*0.18),'#bfe0ff'],[Math.round(W*0.55),Math.round(H*0.1),'#ffc0dd']]){
      festDot(g,sx,sy,c,1);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) festDot(g,sx+dx,sy+dy,c,tw*0.6);
    }
  } else if(festState.id==='midautumn'){
    // 左上一顆大月亮（右上是時間看板），月面有兔子影子；兩條雲慢慢飄過
    const mx=6, my=5, R=4;
    for(let y=-R;y<=R;y++) for(let x=-R-1;x<=R+1;x++){
      if((x*x)/((R+1)*(R+1))+(y*y)/(R*R)>1) continue;
      festDot(g,mx+x,my+y,'#fff1b8',0.95);
    }
    for(const [x,y] of [[0,-2],[1,-2],[0,-1],[0,0],[1,0],[-1,1],[0,1],[1,1],[2,1],[-1,2]]) festDot(g,mx+x,my+y,'#e8cf7a',0.9);
    for(let i=0;i<2;i++){
      const cx=((ts/1000*(0.8+i*0.4)+i*W*0.5)%(W+20))-10, cy=3+i*5;
      for(let x=0;x<9;x++) festDot(g,cx+x,cy,'#9aa3ad',0.35);
      for(let x=2;x<6;x++) festDot(g,cx+x,cy-1,'#9aa3ad',0.3);
    }
  }
}
// 伺服器給的節日狀態 → 背景與勾選框。勾選框只在有節日時出現。
function applyFestival(f, opts){
  festState.id = f ? f.id : null;
  festState.hasBg = !!(f && f.bg !== false);
  if(opts && opts.costume!=null) festState.bg = !!opts.costume;   // 營地、廣場：背景跟造型同一顆開關
  const io=document.getElementById('plazaio'); if(io) io.style.display = festState.hasBg && festState.bg ? 'none' : '';
  document.querySelectorAll('.festname').forEach(el=>{ el.textContent = f ? f.name : ''; });
  // 營地、廣場同一顆，排在控制列最右（跟「顯示天氣日期」並排）
  document.getElementById('festplaza').style.display = (f && (view==='yard'||view==='plaza')) ? 'flex' : 'none';
  const set=(id,v)=>{ const el=document.getElementById(id); if(el && v!=null && document.activeElement!==el) el.checked=!!v; };
  if(opts) set('festcos2',opts.costume);
}

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
  const fsel=document.getElementById('festsel');
  if(fsel&&fsel.value) qs.push('fest='+encodeURIComponent(fsel.value));
  qs.push('ds='+yardSalt);
  if(yardPage) qs.push('pg='+yardPage);
  if(p2Drop&&!p2Drop.release) qs.push('drop='+encodeURIComponent(p2Drop.id));
  if(photoSeed!=null) qs.push('photo='+photoSeed);
  const y = await (await fetch('/yard'+(qs.length?'?'+qs.join('&'):''),
                               {cache:'no-store'})).json();
  if(!y.ok){ document.getElementById('err').textContent='⚠️ '+y.error; return; }
  if(y.inPlaza){ setView('plaza'); return; }
  lastYard=y;
  if(y.page!=null) yardPage=y.page;   // 伺服器夾過的頁碼（例如放生後只剩一頁）
  // 空降落地、伺服器那張已經畫上牠了 → 收掉前端自己畫的那份
  if(p2Drop&&p2Drop.release&&!y.drop) p2Drop=null;
  p2Sync(y);
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
  pageNav(y.pages||1);
  photoNav(y);
  document.getElementById('kind').textContent='yard';
  document.getElementById('tick').textContent='#'+y.step;
  applyWeather(y.weather);
  applyFestival(y.festival, {costume:y.festCostume});
  if(y.lines){ draw(y.lines); drawLayer(y.layer); }
  else {
    // 空營地：仍然把畫布撐成完整的場地大小再清空。
    // 只 clearRect 不改尺寸的話，畫布會停在上一次畫過的家裡舞台（52 欄），
    // 空營地就變成一個小方塊，看起來像壞掉而不是「這裡還沒有東西」。
    const cv=document.getElementById('pet');
    cv.width=y.cols*CW; cv.height=y.rows*CH;
    cv.getContext('2d').clearRect(0,0,cv.width,cv.height);
  }
  // 舞台大小畫了才定（從前線切進來那一下還是前線的大小）→ 對話框每次畫完重新定位。
  // ⚠️ 這行不能插在上面的 if/else 中間：插過一次，else 變成接在它後面，營地每次畫完就被清空。
  if(story) storyPlace();
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
  // 前線畫布的內部解析度乘過 devicePixelRatio（見 draw）→ 先除回 CSS 像素
  const k=cv._dpr||1;
  return { dx:(ev.clientX-r.left)*(cv.width/k/r.width)/CW,
           dy:(ev.clientY-r.top )*(cv.height/k/r.height)/(CH/2) };
}
function yardHit(ev){
  if(view!=='yard'||!lastYard||!lastYard.pets||!lastYard.pets.length) return null;
  const {dx,dy}=evDot(ev);
  const S=lastYard.sprite||16;
  // 由後往前找 = 從畫在最上層的那隻開始，跟眼睛看到的一致
  for(let i=lastYard.pets.length-1;i>=0;i--){
    const p=lastYard.pets[i], s=p.size||S;   // 圍爐會縮小
    if(dx>=p.x&&dx<p.x+s&&dy>=p.y&&dy<p.y+s) return p;
  }
  return null;
}

// dev「走動範圍」開關。切換後直接用上一次的畫面重畫 —— 等輪詢的話最多要 250ms
// 才看得到反應，會讓人以為勾了沒用。
{
  const zb=document.getElementById('zonebox');
  if(zb) zb.addEventListener('change',()=>{
    showZones=zb.checked;
    if(view==='yard'&&lastYard&&lastYard.lines){ draw(lastYard.lines); drawLayer(lastYard.layer); }
  });
}

document.getElementById('pet').addEventListener('contextmenu',ev=>{
  if(view==='yard'&&p2Phase){ ev.preventDefault(); return; }   // 營地事件中：右鍵選單不開
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
               hit.stage+'　戰力 '+hit.power+'　'+wr+'<br>獲得於 '+
               (hit.gotAt?new Date(hit.gotAt).toLocaleString():'—')+'</span></div>';
  const add=(txt,fn,cls)=>{const b=document.createElement('button');b.textContent=txt;
    if(cls)b.className=cls;b.onclick=e=>{e.stopPropagation();closeCtx();fn();};el.appendChild(b);};
  add('🔄 換出來（與現役交換）',()=>sendCmd('swap',{which:hit.id}));
  add('🗑 放生（永久刪除）',()=>{ if(confirm('放生「'+hit.name+'」？永久刪除，救不回來。'))
      sendCmd('release',{which:hit.id}); },'danger');
  el.style.display='block';
  el.style.left=Math.min(ev.clientX, innerWidth-el.offsetWidth-8)+'px';
  el.style.top =Math.min(ev.clientY, innerHeight-el.offsetHeight-8)+'px';
});

// ── 自動更新（docs/update-spec.md）──
// 每分鐘問一次 daemon 有沒有新版；有就亮「🆕 有新版本」。按下去 daemon 會重開，
// 這段期間 fetch 會失敗，等版本號變了就重新整理頁面（新版的頁面也要重載）。
let myVersion=null, updating=false;
async function pollUpdate(){
  let u=null;
  try{ u=await (await fetch('/update',{cache:'no-store'})).json(); }catch(e){ return null; }
  if(myVersion===null) myVersion=u.version;
  if(updating && u.version!==myVersion){ location.reload(); return u; }
  const b=document.getElementById('selfupdate');
  b.style.display = (u.available && !updating) ? '' : 'none';
  if(u.available) b.title='新版本 '+u.available.version+'：下載並重開 daemon（幾秒鐘）';
  // 上一次重開時的更新結果：同一筆只講一次（重新整理後不要再跳）
  if(u.last){
    let seen=0; try{ seen=Number(localStorage.getItem('vpet.updseen'))||0; }catch(e){}
    if(u.last.at>seen){
      try{ localStorage.setItem('vpet.updseen',String(u.last.at)); }catch(e){}
      flashCmdMsg(u.last.text, u.last.ok?'#3fb950':'#d29922');
    }
  }
  return u;
}
document.getElementById('selfupdate').addEventListener('click',()=>{
  if(!confirm('更新到新版本？daemon 會重開幾秒鐘，在廣場的話會先離場。')) return;
  sendCmd('selfUpdate',{}).then(r=>{
    if(!r||!r.ok) return;
    updating=true;
    document.getElementById('selfupdate').style.display='none';
    const t0=Date.now();
    const iv=setInterval(()=>{
      if(Date.now()-t0>180000){ clearInterval(iv); updating=false; flashCmdMsg('更新等太久了，請手動重開 daemon','#d29922'); return; }
      pollUpdate();
    },1500);
  });
});
setInterval(pollUpdate,60000);
pollUpdate();

// ── 廣場 ──
// 「被帶回前線」的原因只顯示一次：記住看過的最後一則（at），之後的輪詢不再重複跳。
// 起始值是開頁的時間 —— 開頁之前發生的事不用補講。
let plazaNoticeSeen=Date.now();
function plazaNoticeCheck(n){
  if(n && n.at>plazaNoticeSeen){ plazaNoticeSeen=n.at; flashCmdMsg(n.text,'#d29922'); }
}
async function pollPlaza(){
  const pfs=document.getElementById('plazafestsel');   // dev 節日預覽
  const p=await (await fetch('/plaza'+(pfs&&pfs.value?'?fest='+encodeURIComponent(pfs.value):''),{cache:'no-store'})).json();
  if(!p.ok){ document.getElementById('err').textContent='⚠️ '+p.error; return; }
  plazaNoticeCheck(p.notice);
  if(!p.active){ setView('home'); return; }
  plazaMode=p.mode||'auto'; plazaFeast=!!p.feast;
  document.getElementById('plazamode').textContent = plazaMode==='manual' ? '🎮 手動（WASD）' : '🚶 自動';
  document.getElementById('plazamode').style.display = plazaFeast ? 'none' : '';   // 圍爐：大家坐著，沒有走路模式
  // 名牌輸入框：沒在打字時才跟著伺服器的名字走，不然會把正在輸入的字蓋掉
  const ni=document.getElementById('plazaname');
  if(ni && document.activeElement!==ni && ni.dataset.cur!==p.me){ ni.value=p.me; ni.dataset.cur=p.me; }
  const ci=document.getElementById('plazacolor');
  // 選色器顯示的就是別人看到的顏色（沒選過 = 預設色）
  const mine=p.myColor||'${plaza.NAME_DEFAULT_COLOR}';
  if(ci && document.activeElement!==ci && ci.value!==mine) ci.value=mine;
  applyWeather(p.weather);
  applyFestival(p.festival, {costume:p.festCostume});
  document.getElementById('kind').textContent='plaza';
  document.getElementById('tick').textContent='#'+p.step;
  document.getElementById('err').textContent='';
  draw(p.lines); drawLayer(p.layer);
  lastPlazaTags=p.tags||[]; lastPlazaMe=p.me;
  drawNameTags(p.tags, p.owner);
  drawBubbles(p.tags, p.chat, p.serverNow);
  renderChat(p.chat);
  renderAdmin(p.members);
  renderInvite(p.invite);
  renderBattle(p.battle);
  stMyChar=p.myChar||stMyChar;
  stairsSync(p.stairs, p.serverNow);
  peekSync(p);
  document.querySelectorAll('#controls button[data-cmd="plazaLeave"]').forEach(b=>{ b.disabled=miniBusy(); b.title=miniBusy()?'小遊戲進行中，不能回前線':''; });
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
  b.innerHTML='<span class="ci">⚔️</span>'+(t.battling ? '對戰中…' : '邀請對戰');
  b.disabled=!!t.battling;
  b.addEventListener('click',()=>{ closeCtx(); sendCmd('plazaInvite',{to:String(t.key).slice(2)}).then(()=>poll()); });
  el.append(b);
  // 手動戰鬥（docs/plaza-duel-spec.md）：九宮格回合制，自己選移動、攻擊位置、力度
  const bd=document.createElement('button');
  bd.innerHTML='<span class="ci">🎮</span>'+(t.battling ? '對戰中…' : '邀請手動戰鬥');
  bd.disabled=!!t.battling;
  bd.addEventListener('click',()=>{ closeCtx(); sendCmd('plazaInvite',{to:String(t.key).slice(2),kind:'duel'}).then(r=>{ if(r&&!r.ok) flashCmdMsg(r.error||'邀請失敗','#f85149'); poll(); }); });
  el.append(bd);
  if(PLAZA_ADMIN){
    const k=document.createElement('button'); k.className='danger devonly'; k.innerHTML='<span class="ci">🚫</span>踢出廣場（dev）';
    k.addEventListener('click',()=>{ closeCtx(); adminKick(String(t.key).slice(2), t.text); });
    el.append(k);
  }
  el.style.display='block';
  el.style.left=Math.min(ev.clientX, innerWidth-el.offsetWidth-8)+'px';
  el.style.top =Math.min(ev.clientY, innerHeight-el.offsetHeight-8)+'px';
}
document.getElementById('pet').addEventListener('click',ev=>{ if(view==='plaza') plazaClick(ev); });
// 邀請列：別人邀我 → 接受／拒絕；我邀別人 → 等回覆。內容沒變就不重建（不然按鈕每 250ms 換一顆，點不到）
let inviteShown='';
function renderInvite(inv){
  const box=document.getElementById('plazainvite');
  const key=inv ? inv.kind+'|'+(inv.inviteId||'')+'|'+inv.name+'|'+(inv.duel?1:0) : '';
  if(!inv){ box.style.display='none'; inviteShown=''; return; }
  box.style.display='block';
  if(key!==inviteShown){
    inviteShown=key; box.textContent='';
    const msg=document.createElement('span'); msg.id='invitemsg'; box.append(msg);
    if(inv.kind==='in'){
      const yes=document.createElement('button'); yes.textContent='⚔ 接受';
      const no=document.createElement('button'); no.textContent='拒絕';
      yes.addEventListener('click',()=>{ if(comState){ flashCmdMsg('小遊戲玩到一半，先玩完再接受','#d29922'); return; }
        sendCmd('plazaAnswer',{inviteId:inv.inviteId,accept:'1'}).then(()=>poll()); });
      no.addEventListener('click',()=>sendCmd('plazaAnswer',{inviteId:inv.inviteId,accept:'0'}).then(()=>poll()));
      box.append(yes,no);
    }
  }
  const what=inv.duel?'手動戰鬥':'對戰';
  document.getElementById('invitemsg').textContent = inv.kind==='in'
    ? inv.name+' 邀請你'+what+'（'+inv.secs+' 秒）'
    : '已邀請 '+inv.name+' '+what+'，等待回覆…（'+inv.secs+' 秒）';
}
// 我的對戰演出：前線的戰鬥畫面，用前線的格子大小（8px）畫在疊層上，廣場在後面照常進行
function renderBattle(b){
  const box=document.getElementById('battlebox');
  if(!b||!b.lines){ box.style.display='none'; return; }
  box.style.display='flex';
  const cv=document.getElementById('battlecv');
  const cw=CW, ch=CH; CW=HOME_CW; CH=HOME_CH;
  // 廣場對戰多畫一列空白，留給底下的名字（結算階段沒有名字也照留，畫面高度才不會跳）。
  // 營地第二頁的戰鬥沒有名字 → 不留，不然底下多一條空白（2026-10-16 實測回報）
  try{ draw(b.nameRow ? b.lines.concat(['']) : b.lines, cv); } finally { CW=cw; CH=ch; }
  if(b.names){
    const g=cv.getContext('2d');
    for(const n of b.names) drawTagText(g, n.text, n.col*HOME_CW, b.lines.length*HOME_CH+1, n.color, cv.width);
  }
}

// ── 聊天室 ──
// 內容變了才重畫（每 250ms 重建一次會把使用者正在選取的文字洗掉）。
// 比整串 seq 而不是只比最後一則：管理員刪掉中間一則，最後一則沒變但要重畫。
// 原本就捲在最底下才跟著捲到底；往上翻舊訊息時不要被拉回去。
const PLAZA_ADMIN=${IS_RELEASE ? 'false' : 'true'};   // 開發版才有管理（踢人、刪聊天）
let chatShown='';
function renderChat(list){
  list=list||[];
  stJoinButtons();   // 房間狀態會變（滿了、開始了、解散了）：「加入」鈕每次輪詢都要更新
  const sig=list.map(m=>m.seq).join(',');
  if(sig===chatShown) return;
  chatShown=sig;
  const box=document.getElementById('chatlog');
  const atBottom = box.scrollTop+box.clientHeight >= box.scrollHeight-4;
  box.textContent='';
  for(const m of list){
    const row=document.createElement('div');
    const t=new Date(m.at), p2=n=>(n<10?'0':'')+n;
    const hhmm=p2(t.getHours())+':'+p2(t.getMinutes())+' ';
    if(m.sys){ row.className='sys'; row.textContent=hhmm+m.text;
      if(m.stairsRoom){ const jb=document.createElement('button'); jb.className='stjoin'; jb.dataset.room=m.stairsRoom; jb.textContent='加入';
        jb.addEventListener('click',()=>stJoin(m.stairsRoom)); row.append(jb); } }
    else {
      row.append(document.createTextNode(hhmm));
      const who=document.createElement('span'); who.className='who';
      who.style.color=m.color||'${plaza.NAME_DEFAULT_COLOR}'; who.textContent=m.name;
      row.append(who, document.createTextNode('：'+m.text));   // textContent：別人打的字不能當 HTML
    }
    if(PLAZA_ADMIN){
      const del=document.createElement('button'); del.className='del devonly'; del.textContent='刪除'; del.title='刪除這則（dev）';
      del.addEventListener('click',()=>sendCmd('plazaChatDel',{seq:String(m.seq)}).then(()=>poll()));
      row.append(del);
    }
    box.append(row);
  }
  stJoinButtons();
  if(atBottom) box.scrollTop=box.scrollHeight;
}
// 管理列（dev）：踢人的下拉。名單沒變就不重建（不然正在選的會被洗掉）
let adminShown=null;
function renderAdmin(list){
  const sel=document.getElementById('admwho');
  if(!sel||!list) return;
  const sig=list.map(m=>m.id+':'+m.name).join(',');
  if(sig===adminShown) return;
  adminShown=sig;
  const keep=sel.value;
  sel.textContent='';
  const none=document.createElement('option'); none.value=''; none.textContent=list.length?'（選一個人）':'（沒有別人）'; sel.append(none);
  for(const m of list){ const o=document.createElement('option'); o.value=m.id; o.textContent=m.name; sel.append(o); }
  if(list.some(m=>m.id===keep)) sel.value=keep;
}
function adminKick(id,name){
  if(!id||!confirm('把 '+name+' 移出廣場？（5 分鐘內不能再進來）')) return;
  sendCmd('plazaKick',{target:id}).then(()=>poll());
}
if(document.getElementById('plazaadmin')){
  document.getElementById('admkick').addEventListener('click',()=>{
    const sel=document.getElementById('admwho');
    adminKick(sel.value, sel.selectedIndex>=0 ? sel.options[sel.selectedIndex].textContent : '');
  });
  document.getElementById('admclear').addEventListener('click',()=>{
    if(confirm('清空所有人的聊天記錄？')) sendCmd('plazaChatClear',{}).then(()=>poll());
  });
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
// 表情符號：插到輸入框游標的位置（不是一律接在最後），插完游標停在表情後面、焦點回到輸入框
const EMOJIS=['😀','😂','🤣','😊','😍','😎','🤔','😴','😭','😡','😱','🥳','👍','👎','👏','🙏',
              '💪','👋','🙌','🤝','🎉','❤️','💔','🔥','✨','⭐','☀️','🌧️','⚡','❄️','🍜','🍺',
              '☕','🎮','⚔️','🏆','💤','❓','❗','🐾'];
(function(){
  const pick=document.getElementById('emojipick'), btn=document.getElementById('chatemoji'), ci=document.getElementById('chatin');
  for(const e of EMOJIS){
    const b=document.createElement('button'); b.textContent=e; b.type='button';
    b.addEventListener('click',ev=>{
      ev.stopPropagation();
      const a=ci.selectionStart??ci.value.length, z=ci.selectionEnd??ci.value.length;
      const next=ci.value.slice(0,a)+e+ci.value.slice(z);
      if([...next].length>ci.maxLength) return;      // 超過字數上限就不插
      ci.value=next; ci.focus(); ci.setSelectionRange(a+e.length, a+e.length);
    });
    pick.append(b);
  }
  btn.addEventListener('click',ev=>{
    ev.stopPropagation();
    const open=pick.style.display==='grid';
    pick.style.display=open?'none':'grid';
    if(!open){ pick.style.left=btn.offsetLeft+'px'; pick.style.top=(btn.offsetTop-pick.offsetHeight-6)+'px'; }
  });
  document.addEventListener('click',ev=>{ if(!pick.contains(ev.target)) pick.style.display='none'; });
})();
document.getElementById('chatin').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.isComposing) chatSubmit(); });

// 名牌：用正常字型畫在腳下置中（伺服器只給位置與顏色）。格子太小，塞進格子會變細長條。
// 深色描邊讓名字在任何天氣、任何角色顏色上都讀得到。
// 一個名字（粗體、深色描邊），x 為中心。廣場的名牌與對戰演出的名字共用。
const TAG_FONT='bold 13px "Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif';
function drawTagText(g, text, cx, y, color, maxW){
  g.save();
  g.font=TAG_FONT; g.textAlign='center'; g.textBaseline='top';
  g.lineJoin='round'; g.lineWidth=3; g.strokeStyle='rgba(0,0,0,.85)';
  const w=g.measureText(text).width;
  const x=Math.max(w/2+2, Math.min(maxW-w/2-2, cx));
  g.strokeText(text,x,y);
  g.fillStyle=color; g.fillText(text,x,y);
  g.restore();
}
let tagScratch=null;
function drawNameTags(tags, owner){
  if(!tags||!tags.length) return;
  const cv=document.getElementById('pet'), g=cv.getContext('2d');
  const DW=CW, DH=CH/2;
  // 後排先畫：名牌之間的前後也跟角色一致
  tags=tags.slice().sort((a,b)=>(a.z||0)-(b.z||0));
  if(!tagScratch) tagScratch=document.createElement('canvas');
  for(const t of tags){
    const y=Math.min(cv.height-15, t.y*DH);
    // 先畫在暫存畫布上，再把「站得比我前面（z 較大）的角色畫到的 dot」挖掉，最後貼回去。
    // 名牌畫在角色圖層之上，不挖的話後排的名字會浮在前排的身上（回報過）。
    const sc=tagScratch; sc.width=cv.width; sc.height=cv.height;
    const sg=sc.getContext('2d');
    drawTagText(sg, t.text, t.x*DW, y, t.color, cv.width);
    if(owner && t.z!=null){
      const y0=Math.max(0,Math.floor(y/DH)), y1=Math.min(owner.length-1,Math.ceil((y+15)/DH));
      for(let dy=y0;dy<=y1;dy++){
        const row=owner[dy]; if(!row) continue;
        for(let dx=0;dx<row.length;dx++){
          const c=row.charCodeAt(dx);
          if(c!==46 && c-48>t.z) sg.clearRect(dx*DW, dy*DH, DW, DH);
        }
      }
    }
    g.drawImage(sc,0,0);
  }
  // 頭上的記號（⚔、z）不分前後，一律畫在最上面
  g.save();
  g.font=TAG_FONT; g.textAlign='center'; g.textBaseline='top';
  g.lineJoin='round'; g.lineWidth=3; g.strokeStyle='rgba(0,0,0,.85)';
  for(const t of tags){
    // 對戰中：頭上 ⚔（旁觀的人才知道那兩隻為什麼停住）
    if(t.battling){
      const bx=t.x*DW, by=Math.max(2,t.top*DH-16);
      g.strokeText('⚔',bx,by); g.fillStyle='#f0883e'; g.fillText('⚔',bx,by);
    }
    // 在小遊戲的房間裡（等人或玩到一半）：頭上 🦖／🪜，看得出誰在玩、誰在等人
    const rk=stRoomKindOf(String(t.key||'').slice(2));
    if(rk&&!t.battling){
      const bx=t.x*DW, by=Math.max(2,t.top*DH-16);
      g.fillText(rk==='dino'?'🦖':rk==='volley'?'🏐':rk==='gomoku'?'⚫':'🪜',bx,by);
    }
    // 手動模式放太久睡著了：頭上冒 z（跟家裡睡覺的 Zzz 同一個意思）
    if(t.sleeping){
      const zx=t.x*DW+10, zy=Math.max(2,t.top*DH-12);
      g.strokeText('z',zx,zy+4); g.fillStyle='#c9d1d9'; g.fillText('z',zx,zy+4);
      g.font='bold 9px sans-serif'; g.strokeText('z',zx+9,zy-2); g.fillText('z',zx+9,zy-2);
      g.font=TAG_FONT;
    }
  }
  g.restore();
}

// 底圖編輯器存檔後不用重啟：bgV（bg.png 的 mtime）一變就換網址，瀏覽器會重抓；0 = 移除了，回純色
let bgShown=-1;
function syncBg(v){
  v=v||0;
  if(v===bgShown) return;
  const st=document.getElementById('stage');
  bgShown=v;
  st.classList.toggle('hasbg',!!v);
  if(v) st.style.setProperty('--bg','url(/bg?v='+v+')'); else st.style.removeProperty('--bg');
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
    syncBg(s.bgV);
    // 營地第二頁第一階段：打贏 Diablomon 之後，下次在前線看到畫面時跳一次
    // 提示收掉（伺服器記成看過）就解除「已跳過」—— 不然第二階段輸了、重打 Diablomon 又贏，
    // 同一個分頁不會再跳（2026-10-16 實測回報）。
    if(s.ranch&&!s.ranch.page2Notice&&!storyOn()) p2NoticeShown=false;
    if(view==='home'&&s.ranch&&s.ranch.page2Notice&&!storyOn()&&!p2NoticeShown){
      p2NoticeShown=true;
      storyOpen([{text:P2TALK.notice}], ()=>sendCmd('page2Seen'), {dim:true});
    }
    lastFetch=Date.now();
    document.getElementById('tick').textContent='#'+s.tick;
    document.getElementById('kind').textContent=s.kind;
    frontKind=s.kind;
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
    const quiet=(action==='yardGrab'||action==='yardDrop'||action==='plazaMove'||action==='plazaMode'||action==='plazaChat'||action==='plazaAnswer'
                 ||action==='plazaHappy'||action==='festCostume'
                 ||action==='page2Seen'||action==='page2Fight'||action==='page2GiveUp'||action==='page2Ack'
                 // 小遊戲：方向／位置一秒送好幾次，開房、出發、看排行榜畫面上直接看得到
                 ||action==='stairsInput'||action==='dinoReport'||action==='stairsOpen'||action==='stairsStart'||action==='stairsLeave'||action==='stairsBoard'||action==='stairsJoin'||action==='volleyInput'||action==='volleyEnd'||action==='gomokuMove'||action==='gomokuResign'||action==='duelPick'||action==='duelResign'||action==='duelDev'||action==='frontMini'||action==='miniBest'||action==='volleyResign'||action==='plazaHide'||action==='stockQuery');   // 勾選框／開心鈕／事件：畫面直接看得到
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
// 只綁有 data-cmd 的：? 鈕、🆕 有新版本也在 #controls 裡，綁到了會多送一個空指令（action 是 undefined）
document.querySelectorAll('#controls button[data-cmd]').forEach(b=>b.addEventListener('click',()=>{
  // 廣場：要連網路，回來成功才換畫面；失敗的理由（連不上、人滿、正在進化…）由 sendCmd 顯示
  // 能不能出門（進化中、戰鬥中、睡覺中）由伺服器端的 plazaBlocked 判，這裡不另寫一份。
  if(b.dataset.cmd==='plaza'){
    flashCmdMsg('連線到廣場…','#8b949e');
    sendCmd('plazaJoin').then(r=>{ if(r&&r.ok) setView('plaza'); });
    return;
  }
  if(b.dataset.cmd==='plazaLeave'){
    if(miniBusy()){ flashCmdMsg('小遊戲進行中，先玩完（或認輸／離開房間）再回前線','#d29922'); return; }
    sendCmd('plazaLeave').then(()=>setView('home'));
    return;
  }
  if(b.dataset.cmd==='photo'){ photoTake(); return; }
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
// dev 介面 on/off：只在 dev 版有。純前端（記在這個瀏覽器），關掉＝看 release 長怎樣。
// 關的時候順便把預覽歸回自動，不然藏起來的預覽還在生效，畫面會對不上。
function setDevUi(on){
  document.body.classList.toggle('nodev', !on);
  try{ localStorage.setItem('vpet.devui', on ? '1' : '0'); }catch(e){}
  document.querySelectorAll('#devui button').forEach(b=>{ b.style.borderColor = (b.dataset.on==='1')===on ? '#58a6ff' : ''; });
  const pd=document.getElementById('plazadev'); if(pd) pd.checked=on;   // 廣場那顆勾選框（同一個開關）
  if(on) return;
  for(const [id,k] of [['wxsel','value'],['festsel','value'],['plazafestsel','value'],['wxcold','checked'],['wxnight','checked'],['zonebox','checked']]){
    const el=document.getElementById(id);
    if(!el || !el[k]) continue;
    el[k] = k==='value' ? '' : false;
    el.dispatchEvent(new Event('change'));
  }
}
if(document.getElementById('devui')){
  document.querySelectorAll('#devui button').forEach(b=>b.addEventListener('click',()=>setDevUi(b.dataset.on==='1')));
  document.getElementById('plazadev').addEventListener('change',e=>setDevUi(e.target.checked));
  let v=null; try{ v=localStorage.getItem('vpet.devui'); }catch(e){}
  setDevUi(v!=='0');
}
// 進階區：把該列的輸入框收成 {欄位:值} 一起送出。
// 一列可以有多顆鈕（開/關成對的開關）→ 動作優先取按鈕自己的 data-cmd，沒有才用整列的。
// daemon 資訊（tick 以下那一塊）顯示／隱藏：純前端、記在這個瀏覽器，release 也有；預設隱藏（沒按過顯示就藏）
function setInfo(on){
  document.body.classList.toggle('noinfo', !on);
  try{ localStorage.setItem('vpet.info', on ? '1' : '0'); }catch(e){}
  document.querySelectorAll('#infoui button').forEach(b=>{ b.style.borderColor = (b.dataset.on==='1')===on ? '#58a6ff' : ''; });
}
document.querySelectorAll('#infoui button').forEach(b=>b.addEventListener('click',()=>setInfo(b.dataset.on==='1')));
{ let v=null; try{ v=localStorage.getItem('vpet.info'); }catch(e){} setInfo(v==='1'); }
document.querySelectorAll('#adv .form:not(#devui):not(#infoui)').forEach(row=>{
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
// 顯示／不顯示右上的天氣日期：純前端、記在這個瀏覽器（營地與廣場共用）
function setHud(on){
  document.body.classList.toggle('nohud', !on);
  document.getElementById('hudcb').checked = on;
  try{ localStorage.setItem('vpet.hud', on ? '1' : '0'); }catch(e){}
}
document.getElementById('hudcb').addEventListener('change',e=>setHud(e.target.checked));
{ let v=null; try{ v=localStorage.getItem('vpet.hud'); }catch(e){} setHud(v!=='0'); }
// 節日開關：存在 daemon（state/festival.json），所以換分頁、重開都記得
for(const [id,act] of [['festcos2','festCostume']]){
  document.getElementById(id).addEventListener('change',e=>{
    sendCmd(act,{on:String(e.target.checked)}).then(()=>poll());
  });
}

// ── 廣場：自動／手動（WASD）──
// 只在「方向真的改變」時送一次（按下、放開、換方向），按住不放不重送 ——
// 位置是大家用同一個公式算的（見 plaza-walk 的 manualPos），伺服器只要知道方向何時改變。
let plazaMode='auto', plazaFeast=false;
// 演完（${PlazaServer.EMOTE_MS}ms）才能再按：伺服器也會擋，但連按只會換來一排「還在開心中」
{
  // 室內／室外：只換自己看到的背景（存在這台瀏覽器）。節日有背景時藏起來（用不到）
  const io=document.getElementById('plazaio');
  const show=()=>{ io.textContent = plazaOutdoor ? '🌳 室外' : '🏢 室內'; };
  show();
  io.addEventListener('click',()=>{
    plazaOutdoor=!plazaOutdoor; show();
    try{ localStorage.setItem('vpet.plazaOutdoor', plazaOutdoor ? '1' : '0'); }catch(e){}
  });
}
document.getElementById('plazahappy').addEventListener('click',e=>{
  const b=e.currentTarget; b.disabled=true;
  setTimeout(()=>{ b.disabled=false; }, ${PlazaServer.EMOTE_MS});
  sendCmd('plazaHappy',{}).then(()=>poll());
});
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
  if(view!=='plaza'||plazaMode!=='manual'||plazaFeast||!PLAZA_KEYS[k]||typing()) return;
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
  // 節日預覽（dev 下拉）也帶過去：愚人節預覽時，拿起來的那隻才會是百變怪
  const fsel=document.getElementById('festsel');
  const ga={which:hit.id,ds:yardSalt,pg:String(yardPage)}; if(fsel&&fsel.value) ga.fest=fsel.value;   // pg：跨頁時伺服器要換成這一頁的座標
  const r=await sendCmd('yardGrab',ga);
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
  const fsel=document.getElementById('festsel');
  const da={which:id,x:String(cx),y:String(cy),pg:String(yardPage)}; if(fsel&&fsel.value) da.fest=fsel.value;
  return sendCmd('yardDrop',da).then(r=>{
    // 手上那份對齊到伺服器實際落的那一格，交接時才不會挪一下
    if(r && r.ok && drag && drag.id===id && Number.isFinite(r.x)){ drag.x=r.x; drag.y=r.y; }
    poll();
  });
}

document.getElementById('pet').addEventListener('mousedown',ev=>{
  if(ev.button!==0||view!=='yard'||drag) return;   // 還在落下就別又抓一隻
  if(p2Phase) return;                                // 營地事件中：點擊是「選一隻出戰」，不摸也不拎
  if(lastYard&&lastYard.feast) return;               // 圍爐：大家坐在位子上，不能拎走（點一下摸摸照舊）
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
// ── 教學（docs/tutorial-spec.md）────────────────────────────────────
// ? 鈕 → 問號模式（helpMode 1）：滑鼠變問號、滑過有說明的地方亮虛線框，點了 →
// 講解（helpMode 2）：其餘壓黑、只留那一塊，Terriermon 助手逐字講。點任何地方關閉、回到平常。
// 問號模式下的點擊**一律在捕獲階段攔下來**（preventDefault + stopImmediatePropagation）：
// 想問「重抽」是什麼，不能真的重抽下去。mousedown 也要攔 —— 長壓拎起、下拉選單都從 mousedown 開始。
// 說明文字在 help-tips.js（release 不帶 dev 條目），元素只標 data-help 代號。
// ── 營地第二頁（docs/yard-page2-spec.md）────────────────────────────────
// 進度在伺服器（ranch.json），這裡只負責演：/yard 的 event 告訴我們現在是哪一段。
//   standoff 對峙 → 助手兩句 → 選一隻（亮框、確認）或放棄
//   fight    戰鬥蓋在營地上（battlebox，跟廣場對戰同一個）
//   result   贏：助手 → 鏡頭滑到第二頁 → Keramon 空降 → 助手；輸／放棄：助手 → Armagemon 退場
const P2TALK=${JSON.stringify(P2TALK)};
const TUTOR_CUT=${JSON.stringify(tutorCutin())};
const STORY_TYPE_MS=28, SLIDE_MS=700, DROP_MS=650, DROP_BOUNCE_MS=220, REVEAL_DELAY_MS=500;
// 狀態變數（yardPage / p2Phase / story…）宣告在 view 旁邊：setView、pollYard 會比這段更早被叫到
function storyOn(){ return !!story; }
function storyDrawCut(){
  const cv=document.getElementById('storycv'), g=cv.getContext('2d');
  g.clearRect(0,0,cv.width,cv.height);
  if(!TUTOR_CUT) return;
  cv.height=TUTOR_CUT.length; cv.width=TUTOR_CUT[0].length;
  for(let y=0;y<TUTOR_CUT.length;y++) for(let x=0;x<TUTOR_CUT[y].length;x++){
    const c=TUTOR_CUT[y][x]; if(!c) continue; g.fillStyle=c; g.fillRect(x,y,1,1);
  }
}
// 外框（2026-10-16 選定 D 款）：storyfx 36×20 點，只畫最外一圈 —— 黑框、四個角綠色 L 形（像瞄準框）。靜態，畫一次就好。
function storyFxDraw(){
  const cv=document.getElementById('storyfx'), g=cv.getContext('2d'), W=cv.width, H=cv.height;
  g.clearRect(0,0,W,H);
  const px=(x,y)=>{ g.fillStyle=((x<4||x>=W-4)&&(y<3||y>=H-3))?'#2fd158':'#111'; g.fillRect(x,y,1,1); };
  for(let x=0;x<W;x++){ px(x,0); px(x,H-1); }
  for(let y=1;y<H-1;y++){ px(0,y); px(W-1,y); }
}
// 對話框放在舞台下方（放不下就蓋在舞台上），左右夾在視窗內
function storyPlace(){
  const p=document.getElementById('storypanel'), st=document.getElementById('stage').getBoundingClientRect();
  const W=document.documentElement.clientWidth, H=document.documentElement.clientHeight;
  const pw=p.offsetWidth, ph=p.offsetHeight;
  const left=Math.max(12, Math.min(W-pw-12, st.left+(st.width-pw)/2));
  let top=st.bottom+10; if(top+ph>H-8) top=Math.max(8, st.bottom-ph-8);
  p.style.left=left+'px'; p.style.top=top+'px';
}
function storyLine(){
  const L=story.lines[story.i], bd=document.querySelector('#storybubble .bd'), bt=document.querySelector('#storybubble .btns');
  bt.innerHTML='';
  for(const b of (L.buttons||[])){
    const el=document.createElement('button'); el.textContent=b.label; if(b.cls) el.className=b.cls;
    el.addEventListener('click',ev=>{ ev.stopPropagation(); b.fn(); });
    bt.appendChild(el);
  }
  document.querySelector('#storybubble .hint').style.display=(L.buttons&&L.buttons.length)?'none':'';
  // 先放整段量好大小、把框鎖在那個大小，再定位。不鎖的話逐字打時框從 220 一路長到 360px，
  // 整塊置中 → 上面的 CutIn 跟著字一直往旁邊跑（2026-10-16 實測回報）；pollYard 每次也會重新定位。
  const bb=document.getElementById('storybubble');
  bb.style.width=''; bb.style.minHeight='';
  bd.textContent=L.text;
  bb.style.width=bb.offsetWidth+'px'; bb.style.minHeight=bb.offsetHeight+'px';
  storyPlace();
  story.text=L.text; let n=0; bd.textContent='';
  clearInterval(story.typing);
  story.typing=setInterval(()=>{ n++; bd.textContent=story.text.slice(0,n); if(n>=story.text.length){ clearInterval(story.typing); story.typing=null; storyShown(); } }, STORY_TYPE_MS);
}
// 這句字打完了（自己打完、或被點一下直接顯示完）→ 通知 opts.onShown（每句一次）
function storyShown(){
  if(!story||story.shownI===story.i) return;
  story.shownI=story.i;
  if(story.onShown) story.onShown(story.i);
}
function storyOpen(lines, done, opts){
  storyClose();
  story={ lines, i:0, done, typing:null, text:'', onShown:opts&&opts.onShown, shownI:-1 };
  const o=document.getElementById('story');
  o.classList.toggle('dim', !(opts&&opts.dim===false));
  o.style.display='block';
  storyDrawCut(); storyFxDraw(); storyLine();
}
function storyClose(){
  if(story) clearInterval(story.typing);
  story=null; document.getElementById('story').style.display='none';
}
// 點一下：還在打字 → 一次顯示完；打完 → 下一句；最後一句 → 關掉再呼叫 done。有按鈕的那句只能按按鈕
function storyAdvance(){
  if(!story) return;
  if(story.typing){ clearInterval(story.typing); story.typing=null; document.querySelector('#storybubble .bd').textContent=story.text; storyShown(); return; }
  const L=story.lines[story.i]; if(L.buttons&&L.buttons.length) return;
  if(story.i<story.lines.length-1){ story.i++; storyLine(); return; }
  const done=story.done; storyClose(); if(done) done();
}
document.getElementById('story').addEventListener('click',ev=>{ ev.preventDefault(); storyAdvance(); });
// 壓黑的時候其他地方一律點不到（捕獲階段攔下，跟教學的問號模式同一招）
for(const t of ['mousedown','mouseup','click','dblclick','contextmenu','pointerdown']){
  window.addEventListener(t, ev=>{
    if(!story||!document.getElementById('story').classList.contains('dim')) return;
    if(ev.target.closest&&ev.target.closest('#story')) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
  }, true);
}
window.addEventListener('resize',()=>{ if(story) storyPlace(); });

function p2Reset(){ p2Phase=null; storyClose(); p2Hl(null); document.body.classList.remove('p2pick'); }
function p2Hl(p){
  const el=document.getElementById('p2hl'), pet=document.getElementById('pet');
  if(!p){ el.style.display='none'; return; }
  const S=p.size||16;
  el.style.left=(pet.offsetLeft+p.x*CW)+'px'; el.style.top=(pet.offsetTop+p.y*(CH/2))+'px';
  el.style.width=(S*CW)+'px'; el.style.height=(S*(CH/2))+'px'; el.style.display='block';
}
// 選一隻：不壓黑，只留對話框（附「放棄」）
function p2Pick(){
  p2Phase='pick'; document.body.classList.add('p2pick');
  storyOpen([{ text:P2TALK.pick, buttons:[{ label:'放棄', cls:'alt', fn:p2GiveUpAsk }] }], null, {dim:false});
}
function p2Confirm(p){
  p2Phase='confirm'; p2Hl(null); document.body.classList.remove('p2pick');
  storyOpen([{ text:P2TALK.confirm.replace('{name}', p.name||'牠'), buttons:[
    { label:'出戰', fn:()=>{ p2Phase='wait'; p2WaitAt=Date.now(); storyClose(); sendCmd('page2Fight',{which:p.id}); } },
    { label:'再想想', cls:'alt', fn:p2Pick } ] }], null);
}
function p2GiveUpAsk(){
  p2Phase='confirm'; p2Hl(null); document.body.classList.remove('p2pick');
  storyOpen([{ text:P2TALK.giveUp, buttons:[
    { label:'放棄', cls:'danger', fn:()=>{ p2Phase='wait'; p2WaitAt=Date.now(); storyClose(); sendCmd('page2GiveUp'); } },
    { label:'再想想', cls:'alt', fn:p2Pick } ] }], null);
}
document.getElementById('pet').addEventListener('mousemove',ev=>{
  if(view!=='yard'||p2Phase!=='pick') return;
  p2Hl(yardHit(ev));
});
document.getElementById('pet').addEventListener('mouseleave',()=>{ if(p2Phase==='pick') p2Hl(null); });
document.getElementById('pet').addEventListener('click',ev=>{
  if(view!=='yard'||p2Phase!=='pick') return;
  const h=yardHit(ev); if(h) p2Confirm(h);
});
// 每次 /yard 回來：照伺服器的事件階段推進表演
function p2Sync(y){
  const ev=y.event, stg=ev&&ev.stage;
  renderBattle(stg==='fight' ? ev.battle : null);
  if(!ev){ if(p2Phase&&p2Phase!=='reveal') p2Reset(); return; }
  if(stg==='standoff'){
    // 還沒開始（或上一輪的結果還在收尾就又觸發了）→ 從助手那兩句開始
    if(!p2Phase||p2Phase==='exit'||p2Phase==='result'||p2Phase==='fight'){
      p2Reset(); p2Phase='intro'; sendCmd('page2Seen'); storyOpen(P2TALK.standoff.map(t=>({text:t})), p2Pick); }
    // 出戰／放棄送出後，伺服器還沒轉到下一段的那一兩次輪詢不算；等太久（指令失敗）才回到選擇
    else if(p2Phase==='wait'&&Date.now()-p2WaitAt>3000) p2Pick();
    return;
  }
  if(stg==='fight'){ if(p2Phase!=='fight'){ storyClose(); p2Hl(null); document.body.classList.remove('p2pick'); p2Phase='fight'; } return; }
  // 退場中 / 重新整理後接到「已經在退場」：等伺服器把結果清掉（event 變 null）就回平常
  if(stg==='result'&&!ev.win&&ev.exiting){ if(p2Phase!=='exit'){ storyClose(); p2Phase='exit'; } return; }
  if(stg==='result'&&p2Phase!=='result'&&p2Phase!=='reveal'){
    storyClose(); p2Hl(null); document.body.classList.remove('p2pick'); p2Phase='result';
    // Keramon 一打贏就已經在營地名單裡了 —— 從這一刻起就當成「空降中」（?drop=，伺服器不畫牠），
    // 不然跨頁走動時牠可能就走在第一頁，滑過去之前就先露面（2026-10-16 回報）。
    // t0 還沒設 → drawDrop 不畫 → 整段藏著，等說明打完字 REVEAL_DELAY_MS 才掉下來。
    if(ev.win&&ev.keramonId) p2Drop={ id:ev.keramonId, t0:0, release:false };
    if(ev.win) storyOpen([{text:P2TALK.win}], async ()=>{
      p2Phase='reveal';
      await sendCmd('page2Ack');
      await slideToPage(ev.keramonPage||1, ev.keramonId);
      storyOpen([{text:P2TALK.unlocked}], ()=>{ p2Phase=null; }, { dim:false, onShown:()=>{
        setTimeout(()=>{ if(p2Drop&&!p2Drop.t0) p2Drop.t0=performance.now(); }, REVEAL_DELAY_MS);
      } });
    });
    else storyOpen([{text:P2TALK.lose}], ()=>{ p2Phase='exit'; sendCmd('page2Ack'); });
  }
}
// 換頁：拿目前這頁的畫面跟新的一頁並排，整片往左（右）滑。底下的畫布已經是新的一頁，
// 滑完把這張拿掉就無縫接上。天氣層（z2）蓋在上面，滑的時候雨照樣下。
// 翻頁快照拍的圖層 = 滑行時要藏起來的即時圖層（兩邊用同一份，加圖層不會漏一邊）
const SLIDE_LIVE=['scene','fest','pet','festfront'];
function snapStage(){
  const pet=document.getElementById('pet'), c=document.createElement('canvas');
  c.width=pet.width; c.height=pet.height;
  const g=c.getContext('2d');
  for(const id of SLIDE_LIVE){
    const e=document.getElementById(id);
    if(e.width&&getComputedStyle(e).display!=='none') g.drawImage(e,0,0,c.width,c.height);
  }
  return c;
}
async function slideToPage(to, dropId){
  if(sliding||view!=='yard') return;
  sliding=true;
  const from=yardPage, A=snapStage(), pet=document.getElementById('pet'), W=A.width, dir=to>from?1:-1;
  // 先蓋上「舊頁」的快照，再把底下的即時圖層藏起來，然後才換頁重畫。
  // 快照裡地板以外（天空）是透明的 —— 不藏的話，底下已經換成新頁的桌寵（連節慶帽子）
  // 會從天空那塊透出來，看起來像新頁提前畫好了（2026-10-16 實測回報，節慶背景最明顯）。
  // 天氣層（wx）不藏：兩頁的天氣本來就一樣，照常在最上面動。
  const ov=document.createElement('canvas'); ov.width=W*2; ov.height=A.height;
  const g=ov.getContext('2d');
  g.drawImage(A, dir>0?0:W, 0);
  ov.style.cssText='position:absolute;z-index:1;pointer-events:none;image-rendering:pixelated;max-width:none;'
    +'left:'+pet.offsetLeft+'px;top:'+pet.offsetTop+'px;width:'+(W*2)+'px;height:'+A.height+'px;'
    +'transition:transform '+SLIDE_MS+'ms ease-in-out;transform:translateX('+(dir>0?0:-W)+'px)';
  document.getElementById('stage').appendChild(ov); slideOv=ov;
  const mk=document.createElement('canvas'); mk.width=W*2; mk.height=A.height;
  mk.getContext('2d').drawImage(pet, dir>0?0:W, 0); slideMask=mk;
  const live=SLIDE_LIVE.map(id=>document.getElementById(id)).filter(Boolean);
  live.forEach(e=>{ e.style.visibility='hidden'; });
  try{
    yardPage=to;
    if(dropId) p2Drop={ id:dropId, t0:0, release:false };
    try{ await pollYard(); }catch(e){}
    sceneDraw(performance.now()+1e6);
    g.drawImage(snapStage(), dir>0?W:0, 0);   // 藏起來（visibility）照樣讀得到畫布內容
    mk.getContext('2d').drawImage(pet, dir>0?W:0, 0);
    ov.getBoundingClientRect();
    ov.style.transform='translateX('+(dir>0?-W:0)+'px)';
    await new Promise(r=>setTimeout(r,SLIDE_MS+40));
  } finally {
    live.forEach(e=>{ e.style.visibility=''; });
    ov.remove(); slideOv=null; slideMask=null; sliding=false;
  }
}
// ── 下樓梯（docs/plaza-stairs-spec.md）───────────────────────────────────
// 廣場伺服器算位置、每 50ms 推一拍；這裡只負責畫（60fps，在兩拍之間補間）和送方向。
// 房間清單、等待、結果跟著 /plaza 輪詢走；遊戲中的每一拍走 /stairs/stream（SSE）。
const ST_GHOST_MS=2500, ST_GHOST_RISE=30;   // 出局的虛影：幾毫秒飄完、往上飄幾點
const stDead=new Map();                     // 出局的人：第一次看到出局的時間與位置（虛影從那裡往上飄）
const ST_W=69, ST_H=54, ST_S=12, ST_TICK=50, ST_CEIL=4, ST_HP=3;   // ST_HP = 幾顆心（同 stairs-sim 的 HP_MAX）
const ST_COL={ normal:'#8b7d6b', spike:'#c94f4f', convL:'#5b7fbf', convR:'#5b7fbf', spring:'#4caf6a', flip:'#d6b24a' };
let stairs=null;            // /plaza 的 stairs：{ rooms, mine, end, meId }
let stES=null, stPrev=null, stCur=null, stCurAt=0, stRaf=0, stSprites={}, stSpriteKey='', stDir=0, stKeys=new Set();
function stMine(){ return stairs&&stairs.mine; }
// 小遊戲進行中（連線的房間正在玩、或正在跟電腦玩）：不能離開廣場回前線（2026-10-20）
function miniBusy(){ const m=stMine(); return !!(comState||(m&&m.state==='play')); }
let stEndSeen=0;   // 看過（按了回到廣場）的那一局結果的時間戳
function stPlaying(){ const m=stMine(); return !!(m&&m.state==='play'); }
function stairsSync(s, serverNow){
  stairs=s||null;
  if(typeof serverNow==='number') stSkew=serverNow-Date.now();
  if(comState){ document.getElementById('minibtn').style.display='none'; return; }   // 跟電腦玩中：畫面由本地管
  const m=stMine(), box=document.getElementById('stairsbox');
  document.getElementById('minibtn').style.display=(view==='plaza'&&!m)?'':'none';
  if(m) miniClose();
  if(!m){
    stStream(false); stStop(); dnStop(); vbStop(); gmStop(); mbStop();
    // 一局結束房間就解散了（伺服器）：結果面板蓋在廣場上，按「回到廣場」收掉
    const end=stairs&&stairs.end;
    if(end&&end.result&&end.at!==stEndSeen){ box.style.display='block'; stEndPanel(end); }
    else box.style.display='none';
    return;
  }
  box.style.display='block';
  stStream(true);
  stLoadSprites(m);
  if(m.kind==='duel'){   // 手動戰鬥：邀請接受就直接開打，沒有等待畫面
    stStop(); dnStop(); vbStop(); gmStop();
    if(m.state==='play'&&m.duel){ document.getElementById('stairspanel').style.display='none'; mbStart(); }
    else mbStop();
    return;
  }
  mbStop(); mbUnstyle();
  if(m.kind==='gomoku'){
    stStop(); dnStop(); vbStop();
    if(m.state==='play'&&m.gomoku){ document.getElementById('stairspanel').style.display='none'; gmStart(); }
    else { gmStop(); stPanel(m); }
    return;
  }
  gmStop();
  if(m.kind==='volley'){
    stStop(); dnStop();
    if(m.state==='play'&&m.volley){ document.getElementById('stairspanel').style.display='none'; vbBegin(m.volley); }
    else { vbStop(); stPanel(m); }
    return;
  }
  vbStop();
  if(m.kind==='dino'){
    stStop();
    if(m.state==='play'&&m.dino){ document.getElementById('stairspanel').style.display='none'; dnBegin(m.dino); }
    else { dnStop(); stPanel(m); }
    return;
  }
  dnStop();
  if(m.state==='play'){ document.getElementById('stairspanel').style.display='none'; stStart(); }
  else { stStop(); stPanel(m); }
}
function stStream(on){
  if(on&&!stES){
    stES=new EventSource('/stairs/stream');
    stES.addEventListener('tick',e=>{ let d; try{ d=JSON.parse(e.data); }catch(x){ return; }
      if(!d||!d.s) return; stPrev=stCur; stCur=d.s; stCurAt=performance.now();
      if(d.ev) for(const v of d.ev) stEvent(v); });
    stES.addEventListener('start',()=>{ stPrev=stCur=null; poll(); });
    stES.addEventListener('end',()=>{ poll(); });
    stES.addEventListener('lobby',()=>{ poll(); });
    stES.addEventListener('ghost',e=>{ try{ dnGhost(JSON.parse(e.data)); }catch(x){} });
    stES.addEventListener('vin',e=>{ try{ vbIn(JSON.parse(e.data)); }catch(x){} });
    stES.addEventListener('gmove',()=>{ poll(); });
    stES.addEventListener('duel',()=>{ poll(); });   // 手動戰鬥：一回合結算了 → 馬上重抓（頁面看到新的 last 就開演）
  } else if(!on&&stES){ stES.close(); stES=null; stPrev=stCur=null; }
}
// 角色點陣：開局（或房裡有人換）時抓一次
function stLoadSprites(m){
  const key=(m.chars||[]).join(',');
  if(key===stSpriteKey) return;
  stSpriteKey=key;
  fetch('/stairs/sprites?c='+encodeURIComponent(key),{cache:'no-store'}).then(r=>r.json()).then(j=>{
    stSprites={};
    for(const c in j){ stSprites[c]={ r:j[c].r.map(stBake), l:j[c].l.map(stBake) }; }
    stPanelPets();
  }).catch(()=>{});
}
// 16x16 點陣 → 一張小畫布（1 點 = 4px），畫的時候整張貼上，比每拍逐點畫快
function stBake(dots){
  if(!dots) return null;
  const c=document.createElement('canvas'); c.width=dots[0].length*4; c.height=dots.length*4;
  const g=c.getContext('2d');
  for(let y=0;y<dots.length;y++) for(let x=0;x<dots[y].length;x++){ const d=dots[y][x]; if(!d) continue;
    g.fillStyle='rgb('+d[0]+','+d[1]+','+d[2]+')'; g.fillRect(x*4,y*4,4,4); }
  return c;
}
let stFx=[];   // 受傷／回血的小特效：{ id, type, at }
function stEvent(v){ if(v&&v.id) stFx.push({ id:v.id, type:v.type, at:performance.now() }); }
function stStart(){ if(!stRaf) stRaf=requestAnimationFrame(stFrame); }
function stStop(){ if(stRaf){ cancelAnimationFrame(stRaf); stRaf=0; } stKeys.clear(); stDir=0; }
function stFrame(){
  stRaf=requestAnimationFrame(stFrame);
  stDraw();
}
// 畫：延後一拍、在前一拍跟這一拍之間補間（網路抖一下也不會卡）
function stDraw(){
  const cv=document.getElementById('stairscv'), pet=document.getElementById('pet');
  const DW=CW, DH=CH/2, Wpx=ST_W*DW, Hpx=ST_H*DH;
  if(cv.width!==Wpx||cv.height!==Hpx){ cv.width=Wpx; cv.height=Hpx; }
  cv.style.left=pet.offsetLeft+'px'; cv.style.top=pet.offsetTop+'px';
  const g=cv.getContext('2d'); g.imageSmoothingEnabled=false;
  const bg=g.createLinearGradient(0,0,0,Hpx); bg.addColorStop(0,'#141a24'); bg.addColorStop(1,'#0b0e14');
  g.fillStyle=bg; g.fillRect(0,0,Wpx,Hpx);
  if(!stCur){ g.fillStyle='#8b949e'; g.font='14px sans-serif'; g.textAlign='center'; g.fillText('準備中…',Wpx/2,Hpx/2); return; }
  const a=stPrev?Math.max(0,Math.min(1,(performance.now()-stCurAt)/ST_TICK)):1;
  const lerp=(p,c)=>p+(c-p)*a;
  const prevPl=new Map((stPrev?stPrev.pl:[]).map(q=>[q[0],q]));
  const t=performance.now()/1000;
  // 階梯
  for(const q of stCur.pl){
    const p0=prevPl.get(q[0]); const x=q[1], y=p0?lerp(p0[2],q[2]):q[2], w=q[3], type=q[4];
    if(q[5]) continue;   // 翻掉了
    const X=x*DW, Y=y*DH, Wd=w*DW;
    // 翻板快翻了：一邊閃爍、一邊變透明（伺服器給進度 0～1，從第一次被踩開始）
    const fade=q[6]||0;
    if(type==='flip'&&fade>0) g.globalAlpha=Math.max(0.15,1-fade*0.85)*(Math.floor(performance.now()/90)%2?0.45:1);
    if(type==='spike'){
      // 尖刺地板：刺長在地板的厚度裡（不凸出上緣，2026-10-20 回報），底下一條深色底座
      g.fillStyle='#7a2f2f'; g.fillRect(X,Y+DH*1.4,Wd,DH*0.6);
      // 寬度是奇數時最後一根刺會超出右緣 1 格 → 刺數取 floor(w/2) 置中，再裁在地板框裡保險（2026-10-20 二次回報）
      g.save(); g.beginPath(); g.rect(X,Y,Wd,2*DH); g.clip();
      const sn=Math.floor(w/2), so=X+(w-sn*2)/2*DW;
      g.fillStyle='#e8e8e8';
      for(let k=0;k<sn;k++){ const sx=so+k*2*DW; g.beginPath(); g.moveTo(sx,Y+DH*1.4); g.lineTo(sx+DW,Y); g.lineTo(sx+2*DW,Y+DH*1.4); g.fill(); }
      g.fillStyle='#c94f4f'; for(let k=0;k<sn;k++) g.fillRect(so+(k*2+1)*DW-1,Y,2,2);
      g.restore();
    } else {
      g.fillStyle=ST_COL[type]||'#8b7d6b'; g.fillRect(X,Y,Wd,2*DH);
      g.fillStyle='rgba(255,255,255,.18)'; g.fillRect(X,Y,Wd,2);
    }
    if(type==='convL'||type==='convR'){ g.fillStyle='rgba(255,255,255,.35)';
      const off=((t*14*(type==='convR'?1:-1))%4+4)%4;
      for(let i=-4;i<w+4;i+=4){ const sx=X+(i+off)*DW; if(sx>=X&&sx<X+Wd-DW) g.fillRect(sx,Y+DH*0.6,DW,DH*0.8); } }
    if(type==='spring'){ g.strokeStyle='#bdf0c8'; g.lineWidth=2; g.beginPath();
      for(let i=0;i<w;i+=2){ g.moveTo(X+i*DW,Y+DH*1.8); g.lineTo(X+(i+1)*DW,Y+DH*0.3); } g.stroke(); }
    if(type==='flip'){ g.fillStyle='rgba(0,0,0,.35)'; for(let i=0;i<w;i+=3) g.fillRect(X+i*DW,Y,DW,2*DH); }
    g.globalAlpha=1;
  }
  // 天花板尖刺
  g.fillStyle='#3a3f4a'; g.fillRect(0,0,Wpx,DH*1.2);
  g.fillStyle='#d9d9d9';
  for(let x=0;x<ST_W;x+=2){ g.beginPath(); g.moveTo(x*DW,DH*1.2); g.lineTo((x+1)*DW,ST_CEIL*DH); g.lineTo((x+2)*DW,DH*1.2); g.fill(); }
  // 玩家
  const prevP=new Map((stPrev?stPrev.p:[]).map(q=>[q[0],q]));
  const me=stMeId(), names=stInfoMap();   // 單機（前線）時是 comState 那組
  const nowMs=performance.now(), SS=stCur.s||ST_S, PK=64*SS/ST_S;   // 這一局的角色大小（人多就小）
  for(const q of stCur.p){
    const p0=prevP.get(q[0]); let x=p0?lerp(p0[1],q[1]):q[1], y=p0?lerp(p0[2],q[2]):q[2];
    const alive=q[4], dir=q[5], hurt=q[7];
    // 出局：被刺死的虛影從出局的地方往上飄、慢慢淡掉；掉出底部的直接消失（2026-10-21）
    let ghostA=0.45;
    if(!alive){
      let d=stDead.get(q[0]); if(!d){ d={ t:nowMs, y, fell:y>ST_H-1 }; stDead.set(q[0],d); }
      const k=(nowMs-d.t)/ST_GHOST_MS; if(d.fell||k>=1) continue;
      y=d.y-k*ST_GHOST_RISE; ghostA=0.45*(1-k);
    } else stDead.delete(q[0]);
    const info=names.get(q[0])||{}, sp=stSprites[info.char];
    const facing=dir<0?'l':dir>0?'r':(q[0]===me?(stLastFace||'r'):'r');
    if(q[0]===me&&dir) stLastFace=facing;
    const fr=!alive?3:hurt?2:(Math.floor(nowMs/400)%2);
    const X=x*DW, Y=y*DH, box=SS*DW;
    g.globalAlpha=!alive?ghostA:(hurt&&Math.floor(nowMs/80)%2?0.4:1);
    const img=sp&&(sp[facing][fr]||sp[facing][0]);
    if(img) g.drawImage(img, X+(box-PK)/2, Y+(SS*DH-PK), PK, PK);
    else { g.fillStyle=q[0]===me?'#58a6ff':'#d29922'; g.fillRect(X+DW*2,Y,box-DW*4,SS*DH); }
    g.globalAlpha=1;
    if(names.size>1){ g.fillStyle=q[0]===me?'#f7c631':'#e6edf3'; g.font='11px sans-serif'; g.textAlign='center';
      g.fillText(info.name||'?', X+box/2, Y-3); }
  }
  // 特效：回血 +1、受傷 -3（往上飄）
  stFx=stFx.filter(f=>nowMs-f.at<700);
  for(const f of stFx){
    const q=stCur.p.find(z=>z[0]===f.id); if(!q) continue;
    const k=(nowMs-f.at)/700, txt=f.type==='heal'?'+♥':(f.type==='hurt'||f.type==='ceil')?'-♥':f.type==='spring'?'↑':'';
    if(!txt) continue;
    g.globalAlpha=1-k; g.fillStyle=f.type==='heal'?'#7ee787':'#ff7b72'; g.font='bold 13px sans-serif'; g.textAlign='center';
    g.fillText(txt, (q[1]+SS/2)*DW, q[2]*DH-6-k*14); g.globalAlpha=1;
  }
  // 我的血量、層數
  const mine=stCur.p.find(z=>z[0]===me);
  if(mine){
    for(let i=0;i<ST_HP;i++) stHeart(g, 6+i*24, ST_CEIL*DH+6, 3, i<mine[3]);
    g.fillStyle='#e6edf3'; g.font='bold 13px ui-monospace,Consolas,monospace'; g.textAlign='right';
    g.fillText('B'+mine[6], Wpx-8, ST_CEIL*DH+20);
    if(!mine[4]){ g.fillStyle='rgba(0,0,0,.5)'; g.fillRect(0,Hpx/2-18,Wpx,36);
      g.fillStyle='#ff7b72'; g.font='bold 16px sans-serif'; g.textAlign='center'; g.fillText('出局！B'+mine[6], Wpx/2, Hpx/2+6); }
  }
  // 開局倒數（伺服器給的秒數；這段時間階梯不捲）
  if(stCur.cd>0){ g.fillStyle='rgba(0,0,0,.35)'; g.fillRect(0,0,Wpx,Hpx);
    g.fillStyle='#f7c631'; g.font='bold 48px ui-monospace,Consolas,monospace'; g.textAlign='center'; g.fillText(String(stCur.cd), Wpx/2, Hpx/2+16); }
}
// 三顆點陣心（7×6，1 = 心、2 = 亮點）。滿的紅、空的暗灰
const ST_HEART=['0110110','1211111','1111111','0111110','0011100','0001000'];
function stHeart(g, x, y, px, full){
  for(let r=0;r<ST_HEART.length;r++) for(let c=0;c<7;c++){
    const v=ST_HEART[r][c]; if(v==='0') continue;
    g.fillStyle=full?(v==='2'?'#ffd1cc':'#ff5a4f'):'#3a3f4a'; g.fillRect(x+c*px, y+r*px, px, px);
  }
}
let stLastFace='r';
// 等待面板裡每個人的 vpet：待機兩幀輪流（跟營地、廣場一樣的節奏）
function stPanelPets(){
  const fr=Math.floor(performance.now()/600)%2;
  document.querySelectorAll('#stairspanel canvas[data-c]').forEach(cv=>{
    const sp=stSprites[cv.dataset.c]; const g=cv.getContext('2d'); g.clearRect(0,0,64,64);
    const img=sp&&(sp.r[fr]||sp.r[0]); if(img){ g.imageSmoothingEnabled=false; g.drawImage(img,0,0,64,64); }
  });
}
setInterval(()=>{ if(stMine()&&!stPlaying()) stPanelPets(); }, 300);
// 小遊戲選單：挑一個遊戲就開房。之後有新遊戲就往 MINI_GAMES 加一筆
// 下樓梯先不分模式（2026-10-20 定）：一律無限制，生存制之後再說
const MINI_GAMES=[
  { id:'stairs', name:'🪜 下樓梯', desc:'左右移動踩階梯往下走，越深越快。三顆心，尖刺和天花板會扣血。層數記排行榜。' },
  { id:'dino', name:'🦖 小恐龍', desc:'空白鍵或 ↑ 跳過仙人掌、閃過飛鳥，越跑越快。大家跑同一條賽道，別人是影子。分數記排行榜。' },
  { id:'gomoku', name:'⚫ 五子棋', desc:'1 對 1，輪流在棋盤上下子，先連成五顆就贏（黑子先下）。兩邊的 vpet 會隨著棋局做表情。也可以跟電腦玩。', noBoard:true, com:true },
  { id:'volley', name:'🏐 打排球', desc:'1 對 1。← → 移動、↑ 跳，碰到球時按空白鍵或點畫面用力打（空中是殺球）。先拿 7 分贏。也可以跟電腦玩。', noBoard:true, com:true },
];
function miniOpen(){
  const el=document.getElementById('minipick');
  el.innerHTML='<div class="mp-h">🎮 小遊戲</div>'+MINI_GAMES.map(gm=>
    '<div class="mp-game"><b>'+gm.name+'</b><div class="mp-desc">'+gm.desc+'</div><div class="mp-modes">'
    +'<button class="pri" data-g="'+gm.id+'">開房</button>'+(gm.noBoard?'':'<button data-b="'+gm.id+'">🏆 排行榜</button>')+(gm.com?'<button data-c="'+gm.id+'">🤖 跟電腦玩</button>':'')+'</div>'
    +((stairs&&stairs.rooms)||[]).filter(r=>(r.kind||'stairs')===gm.id).map(r=>'<div class="mp-room"><span>'+stEsc(r.hostName)+' 的房間　'+r.n+'/'+(r.cap||4)
      +(r.state!=='lobby'?'　進行中':'')+'</span><button data-j="'+stEsc(r.id)+'"'+(stJoinable(r.id)?'':' disabled')+'>加入</button></div>').join('')
    +'</div>').join('')
    +(PLAZA_ADMIN&&DS?'<div class="mp-game devonly"><b>⚔ 手動戰鬥（dev 測試）</b><div class="mp-desc">本地跑，不經伺服器：同階隨機對手、隨機戰力，對手每回合隨機移動、攻擊、力度。</div><div class="mp-modes"><button class="pri" id="duelDev">開打</button></div></div>':'')
    +'<div class="mp-soon">更多小遊戲陸續加入…</div><div class="mp-modes" style="justify-content:center;margin-top:8px"><button id="miniclose">關閉</button></div>';
  el.querySelectorAll('button[data-b]').forEach(b=>b.addEventListener('click',()=>miniBoard(b.dataset.b)));
  el.querySelectorAll('button[data-j]').forEach(b=>b.addEventListener('click',()=>stJoin(b.dataset.j)));
  el.querySelectorAll('button[data-c]').forEach(b=>b.addEventListener('click',()=>comStart(b.dataset.c)));
  el.querySelectorAll('button[data-g]').forEach(b=>b.addEventListener('click',()=>{
    sendCmd('stairsOpen',{mode:'endless',kind:b.dataset.g}).then(()=>{ miniClose(); poll(); });
  }));
  document.getElementById('miniclose').addEventListener('click',miniClose);
  const dv=document.getElementById('duelDev'); if(dv) dv.addEventListener('click',mbDevStart);
  el.style.display='block';
}
function miniClose(){ document.getElementById('minipick').style.display='none';
  if(view!=='plaza'&&!comState){ const st=document.getElementById('stage'); st.style.minWidth=''; st.style.minHeight=''; }   // 前線：選單撐開的舞台收回去
}
// 小遊戲選單裡看排行榜（前 20 名）：跟廣場主機要，「返回」回到遊戲列表
function miniBoard(kind){
  const el=document.getElementById('minipick'), gm=MINI_GAMES.find(x=>x.id===kind)||{};
  el.innerHTML='<div class="mp-h">🏆 '+(gm.name||'')+' 排行榜</div><div class="st-bh">讀取中…</div>';
  sendCmd('stairsBoard',{kind}).then(r=>{
    if(el.style.display!=='block') return;
    const me=lastPlazaMe;
    el.innerHTML='<div class="mp-h">🏆 '+(gm.name||'')+' 排行榜</div>'+stBoardHtml(kind,(r&&r.board)||[],me,20)
      +'<div class="mp-modes" style="justify-content:center;margin-top:8px"><button id="miniback">返回</button><button id="miniclose">關閉</button></div>';
    document.getElementById('miniback').addEventListener('click',miniOpen);
    document.getElementById('miniclose').addEventListener('click',miniClose);
  });
}
// 等待畫面／結果：房間成員、出發（只有房主）、離開；結束後顯示層數、紀錄、排行榜前 10
// 加入別人的房間（聊天室的「加入」、小遊戲選單的「加入」）
function stJoin(room){ sendCmd('stairsJoin',{room}).then(r=>{ if(r&&!r.ok) flashCmdMsg(r.error||'加入失敗','#f85149'); miniClose(); poll(); }); }
// 自己出局（下樓梯）／撞到（小恐龍）了：右下角出現「先離開」，按了回廣場（成績照記，不用等別人玩完）
function stOutSync(){
  const m=stMine(), el=document.getElementById('stout');
  let show=false;
  if(m&&m.state==='play'&&!comState){
    if(m.kind==='dino') show=!!dnGame&&(!dnGame.alive||dnSpectate);
    else if((m.kind||'stairs')==='stairs'&&stCur){ const q=stCur.p.find(z=>z[0]===stairs.meId); show=!!q&&!q[4]; }
  }
  el.style.display=show?'':'none';
}
setInterval(stOutSync,300);
document.getElementById('stout').addEventListener('click',()=>{
  const m=stMine(); let txt='';
  if(m&&m.kind==='dino'&&dnGame) txt='這一局 '+DN.score(dnGame.dist)+' 分';
  else if(stCur){ const q=stCur.p.find(z=>z[0]===stairs.meId); if(q) txt='這一局 B'+q[6]; }
  sendCmd('stairsLeave').then(()=>{ document.getElementById('stout').style.display='none'; if(txt) flashCmdMsg(txt+'，已回到廣場','#3fb950'); poll(); });
});
function stJoinable(room){
  const r=stairs&&(stairs.rooms||[]).find(x=>x.id===room);
  return !!(r&&r.state==='lobby'&&r.n<(r.cap||4)&&!stMine()&&!comState);   // 玩到一半（含跟電腦玩）不能跑去別的房
}
function stJoinButtons(){
  document.querySelectorAll('#chatlog button.stjoin').forEach(b=>{
    const r=stairs&&(stairs.rooms||[]).find(x=>x.id===b.dataset.room);
    const ok=stJoinable(b.dataset.room);
    b.disabled=!ok;
    b.textContent=!r?'已解散':r.state!=='lobby'?'進行中':r.n>=(r.cap||4)?'已滿':stMine()?'加入':'加入（'+r.n+'/'+(r.cap||4)+'）';
  });
}
function stRoomKindOf(id){
  const r=id&&stairs&&(stairs.rooms||[]).find(x=>x.ids&&x.ids.includes(id));
  return r?(r.kind||'stairs'):null;
}
const stEsc=(s)=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// 排行榜列表（結果面板、小遊戲選單共用）：kind 決定顯示層數（B12）還是分數
function stBoardHtml(kind, board, meName, n){
  const val=(b)=>kind==='dino'?String(b.score):'B'+b.floor;
  if(!board||!board.length) return '<div class="st-board"><div class="st-bh">排行榜</div><div class="st-bh">還沒有紀錄</div></div>';
  return '<div class="st-board"><div class="st-bh">排行榜</div>'+board.slice(0,n||10).map((b,i)=>
    '<div class="st-row'+(meName&&b.name===meName?' me':'')+'"><span>'+(i+1)+'.</span><span>'+stEsc(b.name)+'</span><span>'+val(b)+'</span></div>').join('')+'</div>';
}
// 一局結束：成績、紀錄、排行榜前 10，「回到廣場」收掉（房間已經解散了）
function stEndPanel(end){
  const el=document.getElementById('stairspanel'); el.style.display='block';
  document.getElementById('stairscv').style.display='';
  const dino=end.kind==='dino', volley=end.kind==='volley', gomoku=end.kind==='gomoku', duel=end.kind==='duel', me=end.result.find(r=>r.id===stairs.meId);
  let h='<div class="st-h">'+(duel?'⚔ 手動戰鬥':gomoku?'⚫ 五子棋':volley?'🏐 打排球':dino?'🦖 小恐龍':'🪜 下樓梯')+'　結束</div>';
  if(duel&&me){
    const op=end.result.find(r=>r.id!==me.id);
    h+='<div class="st-res"><b>'+(me.draw?'平手':me.rank===1?'你贏了！':'你輸了')+'</b>'+(op?'　vs '+stEsc(op.name):'')+'　共 '+me.rounds+' 回合'
      +(op&&op.why==='resign'?'（對手認輸）':me.why==='resign'?'（認輸）':op&&op.why==='left'?'（對手離開了）':op&&op.why==='lost'?'（對手斷線）':'')+'</div>';
  }
  if(gomoku&&me){
    const op=end.result.find(r=>r.id!==me.id);
    h+='<div class="st-res"><b>'+(me.draw?'平手':me.rank===1?'你贏了！':'你輸了')+'</b>　共 '+me.moves+' 手'
      +(op&&op.why==='resign'?'（對手認輸）':me.why==='resign'?'（認輸）':op&&op.why==='left'?'（對手離開了）':op&&op.why==='lost'?'（對手斷線）':'')+'</div>';
  }
  if(volley&&me){
    const op=end.result.find(r=>r.id!==me.id);
    h+='<div class="st-res"><b>'+(me.rank===1?'你贏了！':'你輸了')+'</b>'+(me.score!=null&&op&&op.score!=null?'　'+me.score+' : '+op.score:'')
      +(op&&op.why==='resign'?'（對手認輸）':me.why==='resign'?'（認輸）':op&&op.why==='left'?'（對手離開了）':op&&op.why==='lost'?'（對手斷線）':'')+'</div>';
  }
  else if(me&&!gomoku&&!duel) h+='<div class="st-res">這一局：<b>'+(dino?String(me.score):'B'+me.floor)+'</b>'+(end.result.length>1?'　第 '+me.rank+' 名':'')+'</div>';
  const rec=(end.records||[]).find(r=>r.id===stairs.meId);
  if(rec) h+='<div class="st-rec">'+(rec.top1?'🏆 全服第一！':'🎉 刷新個人紀錄！')+'</div>';
  if(!volley&&!gomoku&&!duel) h+=stBoardHtml(end.kind, end.board, me&&me.name, 10);
  h+='<div class="st-btns"><button id="stback" class="pri">回到廣場</button></div>';
  if(el.dataset.h!==h){ el.dataset.h=h; el.innerHTML=h;
    document.getElementById('stback').addEventListener('click',()=>{ stEndSeen=end.at; stairsSync(stairs); });
  }
}
function stPanel(m){
  const el=document.getElementById('stairspanel'); el.style.display='block';
  // 等待畫面：畫布上不該留著上一局（任何小遊戲）的最後一幕
  { const cv=document.getElementById('stairscv'); if(cv.width) cv.getContext('2d').clearRect(0,0,cv.width,cv.height); }
  const host=stairs.meId===m.host, end=stairs.end;
  const esc=(s)=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const dino=m.kind==='dino', volley=m.kind==='volley', gomoku=m.kind==='gomoku';
  void end;
  let h='<div class="st-h">'+(gomoku?'⚫ 五子棋':volley?'🏐 打排球':dino?'🦖 小恐龍':'🪜 下樓梯')+'</div>';
  // 房裡每個人的 vpet（待機動畫，stPanelPets 畫）＋名牌；沒人的位置畫虛線框，看得出還能來幾個
  h+='<div class="st-mem">'+m.names.map((n,i)=>'<div class="st-pl'+(m.ids[i]===m.host?' host':'')+'"><canvas width="64" height="64" data-c="'+esc(m.chars[i]||'')+'"></canvas><span>'+esc(n)+'</span></div>').join('')
    +Array.from({length:Math.max(0,(m.cap||4)-m.names.length)},()=>'<div class="st-pl empty"><canvas width="64" height="64"></canvas><span>空位</span></div>').join('')+'</div>';
  h+='<div class="st-hint">'+(gomoku?'1 對 1。房主執黑先下，輪流點棋盤下子，橫、直、斜任一方向先連成五顆就贏。下完一手兩邊的 vpet 會做表情。':volley?'1 對 1。← → 或 A D 移動、↑ 或 W 跳。碰到球就會彈回去；碰到的那一刻按空白鍵或點畫面＝用力打（球快很多，在空中是往下殺球）。球落在誰那邊，另一邊得分；先拿 7 分贏。'
     :dino?'空白鍵、↑ 或點畫面跳（按住跳高一點），跳過仙人掌、閃過飛鳥；高的鳥站著就會從頭上飛過。撞到就結束，跑越遠分數越高。'
     :'← → 或 A D 移動。三顆心：尖刺、天花板各扣一顆，踩三次普通階梯回一顆；心沒了或掉出畫面就出局。')+'</div>';
  const need2=(volley||gomoku)&&m.names.length<2;   // 打排球、五子棋要剛好 2 個人
  h+='<div class="st-btns">'+(host?'<button id="stgo" class="pri"'+(need2?' disabled title="等對手加入"':'')+'>'+(need2?'等對手加入…':'出發')+'</button>':'<span class="st-wait">等房主出發…</span>')
    +'<button id="stleave">離開</button></div>';
  if(el.dataset.h!==h){ el.dataset.h=h; el.innerHTML=h; stPanelPets();
    const go=document.getElementById('stgo');
    if(go) go.addEventListener('click',()=>{ go.disabled=true; sendCmd('stairsStart').then(()=>poll()); });
    document.getElementById('stleave').addEventListener('click',()=>sendCmd('stairsLeave').then(()=>poll()));
  }
}
document.getElementById('minibtn').addEventListener('click',()=>{
  const el=document.getElementById('minipick'); if(el.style.display==='block') miniClose(); else miniOpen();
});
// 方向鍵：遊戲中攔在最前面（捕獲階段），廣場手動走路那組 WASD 不會一起動
const ST_KEYS={ arrowleft:-1, a:-1, arrowright:1, d:1 };
function stSteer(){
  let d=0; for(const k of stKeys) d+=ST_KEYS[k]; d=Math.sign(d);
  if(d===stDir) return;
  stDir=d;
  if(comState) return;   // 單機：本地的迴圈每拍自己讀 stDir
  sendCmd('stairsInput',{dir:String(d)});
}
window.addEventListener('keydown',e=>{
  const k=e.key.toLowerCase();
  // 只在下樓梯攔：原本「任何小遊戲進行中」都攔，連線打排球的 ← → 被這裡吃掉（2026-10-21 回報）
  const sm=stMine(), stOn=(stPlaying()&&(sm.kind||'stairs')==='stairs')||(comState&&comState.kind==='stairs');
  if(!stOn||!(k in ST_KEYS)||typing()) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if(!stKeys.has(k)){ stKeys.add(k); stSteer(); }
},true);
window.addEventListener('keyup',e=>{
  const k=e.key.toLowerCase();
  if(!stKeys.has(k)) return;
  e.stopImmediatePropagation();
  stKeys.delete(k); stSteer();
},true);
window.addEventListener('blur',()=>{ if(stKeys.size){ stKeys.clear(); stSteer(); } });
// ── 小恐龍（docs/plaza-dino-spec.md）────────────────────────────────────
// 跟下樓梯相反：位置**自己算**（dino-sim.js 原樣內嵌在 DN），按跳當下就起跳。
// 伺服器只發 seed 與起跑時間（伺服器時間），大家跑同一條賽道；每 100ms 回報一次位置，
// 別人的位置從 /stairs/stream 的 ghost 收，畫成半透明的影子。
let dnGame=null, dnStartAt=0, dnRaf=0, dnLastTs=0, dnAcc=0, dnSent=0, dnSpectate=false, dnHeld=false, dnGhosts={}, stSkew=0;
const DN_REPORT_MS=100;
function dnBegin(info){
  if(!DN||!info) return;
  if(dnGame&&dnGame.seed===(info.seed>>>0)&&dnStartAt===info.startAt){ if(!dnRaf) dnRaf=requestAnimationFrame(dnFrame); return; }
  dnGame=DN.createGame(info.seed); dnStartAt=info.startAt; dnAcc=0; dnSent=0; dnLastTs=0; dnGhosts={}; dnHeld=false;
  // 重新整理頁面時已經跑了一陣子：按鍵記錄不在了，重算不出來 → 這一局只能看（伺服器等不到回報會當作撞到）
  dnSpectate=(Date.now()+stSkew)-info.startAt>1500;
  if(!dnRaf) dnRaf=requestAnimationFrame(dnFrame);
}
function dnStop(){ if(dnRaf){ cancelAnimationFrame(dnRaf); dnRaf=0; } dnGame=null; dnHeld=false; }
function dnPlaying(){ if(comState) return comState.kind==='dino'&&!!dnGame&&dnGame.alive; const m=stMine(); return !!(m&&m.kind==='dino'&&m.state==='play'&&dnGame&&dnGame.alive&&!dnSpectate); }
function dnGhost(d){ if(d&&d.id&&d.id!==(stairs&&stairs.meId)) dnGhosts[d.id]={ dist:d.dist, y:d.y, alive:d.alive, at:performance.now() }; }
function dnReport(force){
  const g=dnGame; if(!g||dnSpectate) return;
  const t=performance.now(); if(!force&&t-dnSent<DN_REPORT_MS) return;
  dnSent=t;
  sendCmd('dinoReport',{ dist:String(Math.round(g.dist*10)/10), y:String(Math.round(g.y*10)/10), alive:g.alive?'1':'0' });
}
function dnFrame(ts){
  dnRaf=requestAnimationFrame(dnFrame);
  const g=dnGame; if(!g) return;
  const now=Date.now()+stSkew;
  if(now>=dnStartAt&&g.alive&&!dnSpectate){
    if(!dnLastTs) dnLastTs=ts;
    dnAcc+=Math.min(0.1,(ts-dnLastTs)/1000); dnLastTs=ts;
    while(dnAcc>=DN.DT&&g.alive){ dnAcc-=DN.DT; if(DN.step(g)==='dead'){ if(comState) miniSoloOver('dino',DN.score(g.dist)); else { dnReport(true); dnSaveBest(); } } }
    if(g.alive&&!comState) dnReport(false);
  } else dnLastTs=ts;
  dnDraw(now);
}
let dnBest=0; try{ dnBest=Number(localStorage.getItem('vpet.dino.best'))||0; }catch(e){}
function dnSaveBest(){ const s=DN.score(dnGame.dist); if(s>dnBest){ dnBest=s; try{ localStorage.setItem('vpet.dino.best',String(s)); }catch(e){} } }
// 仙人掌（一株：寬 cw、高 ch，中間樹幹、兩邊各一隻手）與飛鳥（兩幀拍翅）
function dnCactus(g,X,Y,cw,ch,DW,DH){
  const px=(x,y,w,h)=>g.fillRect(X+x*DW,Y+y*DH,w*DW,h*DH);
  const tx=Math.floor(cw/2)-1;
  px(tx,0,2,ch); px(0,Math.floor(ch*0.3),1,Math.floor(ch*0.35)); px(0,Math.floor(ch*0.6),tx,1);
  px(cw-1,Math.floor(ch*0.2),1,Math.floor(ch*0.35)); px(tx+2,Math.floor(ch*0.5),cw-tx-2,1);
}
function dnBird(g,X,Y,w,h,DW,DH,up){
  const px=(x,y,ww,hh)=>g.fillRect(X+x*DW,Y+y*DH,ww*DW,hh*DH);
  px(0,2,2,1); px(1,2,6,2); px(7,3,2,1);            // 嘴、身體、尾巴
  if(up) px(3,0,2,2); else px(3,4,2,2);              // 翅膀上／下
}
function dnDraw(now){
  const cv=document.getElementById('stairscv'), pet=document.getElementById('pet');
  const DW=CW, DH=CH/2, Wpx=DN.W*DW, Hpx=DN.H*DH, g0=dnGame;
  if(cv.width!==Wpx||cv.height!==Hpx){ cv.width=Wpx; cv.height=Hpx; }
  cv.style.left=pet.offsetLeft+'px'; cv.style.top=pet.offsetTop+'px';
  const g=cv.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#f4f4f2'; g.fillRect(0,0,Wpx,Hpx);
  const gy=DN.GROUND*DH;
  // 地面：一條線＋往左捲的小碎石
  g.fillStyle='#535353'; g.fillRect(0,gy,Wpx,2);
  for(let i=0;i<24;i++){ const wx=((i*37-(g0.dist*DW))%Wpx+Wpx)%Wpx; g.fillRect(wx,gy+4+(i%3)*5,DW*(1+i%2),2); }
  // 障礙物（畫面上的 x = 世界 x - 我跑到哪）
  g.fillStyle='#535353';
  for(const o of g0.obstacles){
    const X=(o.x-g0.dist)*DW; if(X>Wpx||X+o.w*DW<0) continue;
    const Y=gy-(o.y+o.h)*DH;
    if(o.kind==='birdLow'||o.kind==='birdHigh') dnBird(g,X,Y,o.w,o.h,DW,DH,Math.floor(g0.t*6)%2===0);
    else { const [cw,ch]=o.kind==='cactusBig'?DN.CACTUS.big:DN.CACTUS.small; for(let k=0;k<o.n;k++) dnCactus(g,X+k*(cw+1)*DW,Y,cw,ch,DW,DH); }
  }
  // 角色：自己的 vpet；別人是半透明影子（x 跟我的距離差，活著的往前推估一點，畫面比較順）
  const me=stMeId(), info=stInfoMap();   // 單機（前線）時是 comState 那組
  const drawPet=(id,dist,y,alive,alpha)=>{
    const X=(DN.RX+dist-g0.dist)*DW; if(X>Wpx||X+DN.S*DW<0) return;
    const sp=stSprites[(info.get(id)||{}).char];
    const fr=!alive?3:(y>0?5:Math.floor(dist/6)%2);   // 跑：待機兩幀交替；跳：開心（HAPPY）；撞到：難過（SAD）
    const img=sp&&(sp.r[fr]||sp.r[0]);
    const Y=gy-(y+DN.S)*DH;
    g.globalAlpha=alpha;
    if(img) g.drawImage(img, X+(DN.S*DW-64)/2, Y+(DN.S*DH-64), 64, 64);
    else { g.fillStyle='#58a6ff'; g.fillRect(X+DW*2,Y,(DN.S-4)*DW,DN.S*DH); }
    if(id!==me&&info.size>1){ g.fillStyle='#57606a'; g.font='11px sans-serif'; g.textAlign='center'; g.fillText((info.get(id)||{}).name||'?', X+DN.S*DW/2, Y-3); }
    g.globalAlpha=1;
  };
  const tNow=performance.now();
  for(const id in dnGhosts){
    const q=dnGhosts[id], d=q.dist+(q.alive?DN.speedAt(q.dist)*Math.min(0.3,(tNow-q.at)/1000):0);
    drawPet(id,d,q.y,q.alive,0.45);
  }
  if(!dnSpectate) drawPet(me,g0.dist,g0.y,g0.alive,1);
  // 分數（像原版：HI 最高分＋這一局，5 位數）
  const pad=(n)=>('00000'+n).slice(-5);
  g.fillStyle='#535353'; g.font='bold 13px ui-monospace,Consolas,monospace'; g.textAlign='right';
  const hi=comState?miniBestCache.dino:dnBest;
  g.fillText((hi?'HI '+pad(hi)+'  ':'')+pad(DN.score(g0.dist)), Wpx-8, 18);
  g.textAlign='center';
  if(now<dnStartAt){ g.fillStyle='#d29922'; g.font='bold 44px ui-monospace,Consolas,monospace'; g.fillText(String(Math.ceil((dnStartAt-now)/1000)), Wpx/2, Hpx/2); g.font='12px sans-serif'; g.fillStyle='#57606a'; g.fillText('空白鍵、↑ 或點畫面跳（按住跳高一點）', Wpx/2, Hpx/2+22); }
  else if(dnSpectate){ g.fillStyle='#57606a'; g.font='bold 14px sans-serif'; g.fillText('這一局開始了，觀戰中…', Wpx/2, 40); }
  else if(!g0.alive){ g.fillStyle='#535353'; g.font='bold 18px ui-monospace,Consolas,monospace'; g.fillText('G A M E   O V E R', Wpx/2, Hpx/2-20);
    const others=Object.values(dnGhosts).some(q=>q.alive);
    if(others){ g.font='12px sans-serif'; g.fillText('等其他人跑完…', Wpx/2, Hpx/2+2); } }
}
// 跳：空白鍵、↑（捕獲階段攔下來，頁面不會捲動、廣場也不會一起動）
window.addEventListener('keydown',e=>{
  const k=e.key;
  if(!(k===' '||k==='ArrowUp')||!dnPlaying()||typing()) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if(!dnHeld){ dnHeld=true; DN.press(dnGame,true); }
},true);
window.addEventListener('keyup',e=>{
  if(!(e.key===' '||e.key==='ArrowUp')||!dnHeld) return;
  e.stopImmediatePropagation(); dnHeld=false; if(dnGame) DN.press(dnGame,false);
},true);
// 點畫面也能跳（2026-10-20）：按下去起跳、按住跳高一點、放開（或滑出畫面）就提早下墜，同鍵盤
(function(){
  const cv=document.getElementById('stairscv');
  const up=()=>{ if(dnHeld){ dnHeld=false; if(dnGame) DN.press(dnGame,false); } };
  cv.addEventListener('pointerdown',e=>{
    if(!dnPlaying()) return;
    e.preventDefault(); e.stopPropagation();
    if(!dnHeld){ dnHeld=true; DN.press(dnGame,true); }
  });
  for(const t of ['pointerup','pointercancel','pointerleave']) cv.addEventListener(t,up);
})();
// ── 跟電腦玩（打排球、五子棋）─────────────────────────────────────────────
// 不開房、不連伺服器：整局在這個頁面裡跑。電腦用 Terriermon 助手（教學助手那隻），難度先只有「普通」。
// 結束後可以再來一局或回廣場（不用等別人，所以保留再來一局）。
const COM_ID='com', COM_CHAR='${TUTOR_ID}', COM_NAME='Terriermon 助手';
let comState=null;   // { kind:'volley'|'gomoku', gm?, startAt, done }
function stMeId(){ return comState?'me':(stairs&&stairs.meId); }
// 名字／角色：跟電腦玩時是「我＋助手」，平常是房間名單
function stInfoMap(){
  if(comState) return new Map([['me',{ name:lastPlazaMe||'我', char:stMyChar }],[COM_ID,{ name:COM_NAME, char:COM_CHAR }]]);
  const m=stMine();
  return new Map(((m&&m.ids)||[]).map((id,i)=>[id,{ name:m.names[i], char:m.chars[i] }]));
}
let stMyChar=null;
// ── 前線小遊戲（單機）─────────────────────────────────────────────────
// 只有單機：下樓梯、小恐龍自己玩，五子棋、打排球跟電腦玩（手動戰鬥還在調，先不放）。
// 前線的格子比較大，玩的時候換成廣場那組小格（畫面大小跟廣場一樣），玩完換回來。
// 開著的時候每幾秒跟 daemon 報一次 frontMini：vpet 在玩，沒空打仗 → 自動戰鬥不觸發。
let frontKind='', miniBestCache={ stairs:0, dino:0 }, miniFrontTimer=0;
function miniFrontOn(){
  if(view==='plaza') return;
  document.body.classList.add('minifront');
  CW=YARD_CW; CH=YARD_CH;
  sendCmd('frontMini',{on:'1'});
  clearInterval(miniFrontTimer);
  miniFrontTimer=setInterval(()=>{ if(comState&&view!=='plaza') sendCmd('frontMini',{on:'1'}); miniFrontFit(); }, 200);
}
function miniFrontOff(){
  if(!document.body.classList.contains('minifront')) return;
  document.body.classList.remove('minifront');
  clearInterval(miniFrontTimer); miniFrontTimer=0;
  if(view!=='yard'&&view!=='plaza'){ CW=HOME_CW; CH=HOME_CH; }
  const st=document.getElementById('stage'); st.style.minWidth=''; st.style.minHeight='';
  sendCmd('frontMini',{on:'0'});
}
// 舞台撐到小遊戲畫布那麼大（前線的舞台本來只有走路那條的高度）
function miniFrontFit(){
  if(!document.body.classList.contains('minifront')) return;
  const st=document.getElementById('stage'), cv=document.getElementById('stairscv');
  st.style.minWidth=cv.width+'px'; st.style.minHeight=cv.height+'px';
}
// 一局結束（單機）：記個人最佳 → 結果面板
function miniSoloOver(kind, val){
  if(!comState||comState.done) return;
  comState.done=true;
  sendCmd('miniBest',{kind, val:String(val)}).then(r=>{
    if(r&&r.ok) miniBestCache={ stairs:r.stairs, dino:r.dino };
    const show=kind==='stairs'?'B'+val:String(val), best=r&&r.ok?(kind==='stairs'?'B'+r.stairs:String(r.dino)):'';
    setTimeout(()=>{ if(comState&&comState.kind===kind)
      comEndPanel(null,'這一局：<b>'+show+'</b>'+(r&&r.record?'　🎉 刷新個人最佳！':best?'　個人最佳 '+best:'')); }, 1200);
  });
}
// 前線的小遊戲選單：每個遊戲一顆「開始」（自己玩／跟電腦玩），旁邊是個人最佳
const FRONT_GAMES=[
  { id:'stairs', name:'🪜 下樓梯', desc:'← → 或 A D 左右移動，踩階梯往下走，越深越快。三顆心，尖刺和天花板會扣血。' },
  { id:'dino', name:'🦖 小恐龍', desc:'空白鍵、↑ 或點畫面跳，跳過仙人掌、閃過飛鳥，越跑越快。' },
  { id:'gomoku', name:'⚫ 五子棋', desc:'跟 Terriermon 助手下，先連成五顆就贏（你執黑先下）。' },
  { id:'volley', name:'🏐 打排球', desc:'跟 Terriermon 助手打。← → 移動、↑ 跳，碰到球時按空白鍵或點畫面用力打。先拿 7 分贏。' },
];
function miniFrontOpen(){
  const el=document.getElementById('minipick');
  if(frontKind==='battle'||frontKind==='evolve'){ flashCmdMsg('正在戰鬥／進化，等演完再玩','#d29922'); return; }
  const draw=()=>{
    el.innerHTML='<div class="mp-h">🎮 小遊戲（單機）</div>'+FRONT_GAMES.map(gm=>{
      const b=gm.id==='stairs'?miniBestCache.stairs:gm.id==='dino'?miniBestCache.dino:0;
      return '<div class="mp-game"><b>'+gm.name+'</b><div class="mp-desc">'+gm.desc+'</div><div class="mp-modes">'
        +'<button class="pri" data-s="'+gm.id+'">開始</button>'+(b?'<span class="mp-best">個人最佳 '+(gm.id==='stairs'?'B'+b:b)+'</span>':'')+'</div></div>';
    }).join('')+'<div class="mp-soon">玩的時候前線不會自動戰鬥。</div><div class="mp-modes" style="justify-content:center;margin-top:8px"><button id="miniclose">關閉</button></div>';
    el.querySelectorAll('button[data-s]').forEach(b=>b.addEventListener('click',()=>{
      if(b.dataset.s==='stairs'&&!STS){ flashCmdMsg('下樓梯的模擬沒載入','#f85149'); return; }
      if(b.dataset.s==='dino'&&!DN){ flashCmdMsg('小恐龍的模擬沒載入','#f85149'); return; }
      comStart(b.dataset.s);
    }));
    document.getElementById('miniclose').addEventListener('click',miniClose);
  };
  // 前線的舞台只有走路那條高：選單開著時先撐到小遊戲那麼大（跟廣場一樣）
  const st=document.getElementById('stage'); st.style.minWidth=(69*YARD_CW)+'px'; st.style.minHeight=(54*(YARD_CH/2))+'px';
  draw(); el.style.display='block';
  sendCmd('miniBest',{}).then(r=>{ if(!r||!r.ok) return; miniBestCache={ stairs:r.stairs, dino:r.dino }; stMyChar=r.char||stMyChar; if(el.style.display==='block') draw(); });
}
// 前線小遊戲先開發版限定：release 沒有這顆鈕
if(document.getElementById('minifront')) document.getElementById('minifront').addEventListener('click',()=>{
  const el=document.getElementById('minipick'); if(el.style.display==='block') miniClose(); else miniFrontOpen();
});
function comStart(kind){
  miniClose();
  stEndSeen=(stairs&&stairs.end&&stairs.end.at)||stEndSeen;   // 上一局（連線）的結果不要蓋過來
  comState={ kind, startAt:Date.now()+stSkew+1500, done:false };
  mbStop(); mbUnstyle();
  miniFrontOn();
  stLoadSprites({ chars:[stMyChar, COM_CHAR] });
  const box=document.getElementById('stairsbox'); box.style.display='block';
  document.getElementById('stairspanel').style.display='none';
  stStream(false); stStop(); dnStop(); vbStop(); gmStop();
  if(kind==='volley'){ vbBegin({ startAt:comState.startAt, sides:['me',COM_ID] }); }
  else if(kind==='dino'){ dnStop(); dnBegin({ seed:(Math.random()*4294967296)>>>0, startAt:Date.now()+stSkew+2000 }); }
  else if(kind==='stairs'){
    // 下樓梯（單機）：伺服器那套模擬（stairs-sim）搬到頁面跑，同一個 50ms 一拍；畫面照舊吃 stCur／stPrev
    const sg=STS.createGame({ seed:(Math.random()*4294967296)>>>0, mode:'endless', players:[{ id:'me' }] });
    comState.st=sg; stPrev=null; stCur=STS.snapshot(sg); stCurAt=performance.now(); stDir=0; stKeys.clear(); stFx=[];
    comState.timer=setInterval(()=>{
      if(!comState||comState.st!==sg) return;
      STS.setInput(sg,'me',stDir);
      const ev=STS.step(sg);
      stPrev=stCur; stCur=STS.snapshot(sg); stCurAt=performance.now();
      for(const v of ev) stEvent(v);
      if(sg.over){ clearInterval(comState.timer); miniSoloOver('stairs',sg.players[0].floor); }
    }, STS.TICK_MS);
    stStart();
  }
  else {
    comState.gm={ board:'0'.repeat(225).split(''), turn:0, sides:['me',COM_ID], last:null, expr:['IDLE','IDLE'], exprAt:0, winner:null, n:15, moves:0 };
    gmStart();
  }
}
function comStop(){ if(comState&&comState.timer) clearInterval(comState.timer); comState=null; vbStop(); gmStop(); mbStop(); dnStop(); stStop(); stPrev=stCur=null; miniFrontOff(); document.getElementById('stairsbox').style.display='none'; poll(); }
// 結束面板（本地）：勝負、比分／手數，再來一局或回廣場
function comEndPanel(won, text){
  const el=document.getElementById('stairspanel'); el.style.display='block';
  const k0=comState.kind, solo=k0==='stairs'||k0==='dino';
  const title={ volley:'🏐 打排球', duel:'⚔ 手動戰鬥（dev 測試）', stairs:'🪜 下樓梯', dino:'🦖 小恐龍' }[k0]||'⚫ 五子棋';
  // 單機（下樓梯、小恐龍）沒有勝負：won 不用，text 是成績那一行
  el.dataset.h=''; el.innerHTML='<div class="st-h">'+title+(k0==='duel'||solo?'':'　vs 🤖 '+COM_NAME)+'</div><div class="st-res">'+(solo?'':'<b>'+(won==null?'平手':won?'你贏了！':'你輸了')+'</b>　')+text+'</div>'
    +'<div class="st-btns"><button id="comagain" class="pri">再來一局</button><button id="comback">'+(view==='plaza'?'回到廣場':'回到前線')+'</button></div>';
  document.getElementById('comagain').addEventListener('click',()=>{ const k=comState.kind; if(k==='duel') mbDevStart(); else comStart(k); });
  document.getElementById('comback').addEventListener('click',comStop);
}
// 排球的電腦（普通）：跑到球底下、球低了就跳、空中有時殺球；只在球在自己這邊時動
function comVolleyKeys(g){
  const i=1, p=g.players[i], b=g.ball, c=p.x+VB.S/2;
  if(b.x<VB.NET_X) return (Math.abs(c-(VB.NET_X+(VB.W-VB.NET_X)/2))>VB.S)?(c<VB.NET_X+(VB.W-VB.NET_X)/2?VB.K_RIGHT:VB.K_LEFT):0;   // 回中間待命
  let k=0;
  const aim=b.x+VB.S/4;   // 站在球稍微後面一點，才會往對面彈
  if(aim<c-12) k|=VB.K_LEFT; else if(aim>c+12) k|=VB.K_RIGHT;
  if(b.y>VB.GROUND-VB.S*3&&Math.abs(b.x-c)<VB.S&&b.vy>0) k|=VB.K_JUMP;
  if(p.y<VB.GROUND-VB.S&&g.f%3!==0) k|=VB.K_SPIKE;
  return k;
}
// 五子棋的電腦：gomoku-ai.js（GMAI）—— 連五、擋五、活四、連續衝四找殺、擋對方的殺、往下看幾步。
// 讀不到（頁面沒內嵌成功）才退回下面這個只看一層的簡單版
function comLineScore(b, n, x, y, c){
  let total=0;
  for(const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]){
    let cnt=1, open=0;
    for(const s of [1,-1]){
      let i=x+dx*s, j=y+dy*s;
      while(i>=0&&j>=0&&i<n&&j<n&&b[j*n+i]===c){ cnt++; i+=dx*s; j+=dy*s; }
      if(i>=0&&j>=0&&i<n&&j<n&&b[j*n+i]==='0') open++;
    }
    total+= cnt>=5?100000 : cnt===4?(open===2?10000:open===1?1200:0) : cnt===3?(open===2?1000:open===1?120:0) : cnt===2?(open===2?100:open===1?12:0) : (open===2?6:1);
  }
  return total;
}
function comGomokuMove(gm){
  if(GMAI) return GMAI.choose(gm.board, 2, { timeMs:1200 });
  const n=gm.n, b=gm.board; let best=-1, cands=[];
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){
    if(b[y*n+x]!=='0') continue;
    // 只看已有棋子旁邊兩格內（空棋盤就下天元）
    let near=false;
    for(let j=Math.max(0,y-2);j<=Math.min(n-1,y+2)&&!near;j++) for(let i=Math.max(0,x-2);i<=Math.min(n-1,x+2);i++) if(b[j*n+i]!=='0'){ near=true; break; }
    if(!near) continue;
    const s=comLineScore(b,n,x,y,'2')*1.1+comLineScore(b,n,x,y,'1');
    if(s>best){ best=s; cands=[[x,y]]; } else if(s===best) cands.push([x,y]);
  }
  if(!cands.length) return [7,7];
  return cands[Math.floor(Math.random()*cands.length)];
}
function gmLineLocal(b,n,x,y){
  const c=b[y*n+x]; let best=1;
  for(const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]){ let k=1;
    for(const s of [1,-1]){ let i=x+dx*s, j=y+dy*s; while(i>=0&&j>=0&&i<n&&j<n&&b[j*n+i]===c){ k++; i+=dx*s; j+=dy*s; } }
    best=Math.max(best,k); }
  return best;
}
// 下一手（我或電腦）：跟伺服器同一套規則與表情
function comPlace(x,y){
  const gm=comState.gm, me=gm.turn;
  gm.board[y*gm.n+x]=String(me+1); gm.moves++; gm.last={ x, y, c:me };
  const len=gmLineLocal(gm.board,gm.n,x,y);
  const ex=len>=5?['HAPPY','SAD']:len===4?['ATTACK','HURT']:len===3?['HAPPY','ANGRY']:['IDLE','IDLE'];
  gm.expr=me===0?ex:[ex[1],ex[0]]; gm.exprAt=Date.now()+stSkew;
  if(len>=5) gm.winner=me; else if(gm.moves>=gm.n*gm.n) gm.winner=-1; else gm.turn=1-me;
  if(gm.winner!=null){ setTimeout(()=>{ if(comState&&comState.gm===gm) comEndPanel(gm.winner<0?null:gm.winner===0, '共 '+gm.moves+' 手'); }, 1800); return; }
  if(gm.turn===1){
    gm.thinking=true;   // 畫面顯示「助手思考中…」；先讓這一幀畫出來再算（算的時候畫面會停約一秒）
    setTimeout(()=>{ if(comState&&comState.gm===gm&&gm.turn===1){ const [cx,cy]=comGomokuMove(gm); gm.thinking=false; comPlace(cx,cy); } }, 450);
  }
}
// ── 五子棋（docs/plaza-gomoku-spec.md）────────────────────────────────────
// 輪流下、伺服器判定：棋盤跟著 /plaza 的房間資料走（有人下了一手會推 gmove，頁面馬上重抓）。
// 中間是棋盤，兩邊的 vpet 站在左右（左＝黑子、右＝白子），下完一手兩邊做表情（伺服器決定，大家看到一樣）。
const GM_EXPR={ IDLE:-1, HURT:2, SAD:3, ATTACK:4, HAPPY:5, ANGRY:6 };   // 表情 → 角色點陣的第幾幀（-1 = 待機兩幀交替）
const GM_EXPR_MS=2200;   // 表情維持多久（結束後的勝負表情一直維持）
let gmRaf=0, gmHover=null;
function gmData(){ if(comState) return comState.kind==='gomoku'?comState.gm:null; const m=stMine(); return m&&m.kind==='gomoku'&&m.gomoku?m.gomoku:null; }
function gmStart(){ if(!gmRaf) gmRaf=requestAnimationFrame(gmFrame); document.getElementById('gmresign').style.display='none'; }   // 認輸改成畫面裡的長按白旗（rsDraw）
function gmResign(){
  if(comState&&comState.gm){ comState.gm.winner=1; comState.gm.expr=['SAD','HAPPY']; comState.gm.exprAt=Date.now()+stSkew; comEndPanel(false,'（認輸）'); return; }
  sendCmd('gomokuResign').then(()=>poll());
}
function gmStop(){ if(gmRaf){ cancelAnimationFrame(gmRaf); gmRaf=0; } document.getElementById('gmresign').style.display='none'; }
function gmFrame(){ gmRaf=requestAnimationFrame(gmFrame); gmDraw(); }
// 棋盤在畫布上的位置：正中間的正方形（留邊給兩邊的 vpet）
// 兩邊各留 vpet（64）＋左右空白（GM_SIDE_GAP）＋棋盤外框，vpet 不要貼著棋盤（2026-10-20）
const GM_SIDE_GAP=26;
function gmGeom(Wpx,Hpx,n){ const size=Math.min(Hpx-24, Wpx-2*(8+64+GM_SIDE_GAP)-12); const x0=(Wpx-size)/2, y0=(Hpx-size)/2+6; return { x0, y0, size, cell:size/(n-1) }; }
function gmDraw(){
  const gm=gmData(); if(!gm) return;
  const cv=document.getElementById('stairscv'), pet=document.getElementById('pet');
  const Wpx=69*CW, Hpx=54*(CH/2);
  if(cv.width!==Wpx||cv.height!==Hpx){ cv.width=Wpx; cv.height=Hpx; }
  cv.style.left=pet.offsetLeft+'px'; cv.style.top=pet.offsetTop+'px';
  const g=cv.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#2b2118'; g.fillRect(0,0,Wpx,Hpx);
  const n=gm.n||15, G=gmGeom(Wpx,Hpx,n);
  // 棋盤：木頭色、格線、星位
  g.fillStyle='#dcb35c'; g.fillRect(G.x0-G.cell*0.6,G.y0-G.cell*0.6,G.size+G.cell*1.2,G.size+G.cell*1.2);
  g.strokeStyle='#5a4320'; g.lineWidth=1;
  for(let i=0;i<n;i++){ const p=Math.round(G.x0+i*G.cell)+0.5, q=Math.round(G.y0+i*G.cell)+0.5;
    g.beginPath(); g.moveTo(p,G.y0); g.lineTo(p,G.y0+G.size); g.stroke();
    g.beginPath(); g.moveTo(G.x0,q); g.lineTo(G.x0+G.size,q); g.stroke(); }
  g.fillStyle='#5a4320';
  for(const [a,b] of [[3,3],[3,11],[11,3],[11,11],[7,7]]){ g.beginPath(); g.arc(G.x0+a*G.cell,G.y0+b*G.cell,2.5,0,6.2832); g.fill(); }
  // 棋子
  const r=G.cell*0.44;
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){
    const c=gm.board[y*n+x]; if(c==='0') continue;
    const cx=G.x0+x*G.cell, cy=G.y0+y*G.cell;
    g.fillStyle=c==='1'?'#111':'#f4f4f4'; g.beginPath(); g.arc(cx,cy,r,0,6.2832); g.fill();
    g.strokeStyle=c==='1'?'#000':'#999'; g.lineWidth=1; g.stroke();
  }
  if(gm.last){ g.fillStyle='#e5534b'; g.beginPath(); g.arc(G.x0+gm.last.x*G.cell,G.y0+gm.last.y*G.cell,r*0.35,0,6.2832); g.fill(); }
  // 輪到我：滑鼠停的位置顯示半透明的預覽子
  const me=stMeId(), myTurn=gm.winner==null&&gm.sides[gm.turn]===me;
  if(myTurn&&gmHover&&gm.board[gmHover.y*n+gmHover.x]==='0'){
    g.globalAlpha=0.45; g.fillStyle=gm.turn===0?'#111':'#f4f4f4';
    g.beginPath(); g.arc(G.x0+gmHover.x*G.cell,G.y0+gmHover.y*G.cell,r,0,6.2832); g.fill(); g.globalAlpha=1;
  }
  // 兩邊的 vpet：左黑右白，面向棋盤；表情由伺服器給（下完一手 GM_EXPR_MS 內；跟電腦玩時本地給）
  const info=stInfoMap();
  const t=performance.now(), fresh=gm.winner!=null||(Date.now()+stSkew)-gm.exprAt<GM_EXPR_MS;
  gm.sides.forEach((id,i)=>{
    const sp=stSprites[(info.get(id)||{}).char], face=i===0?'r':'l';
    const ex=fresh?GM_EXPR[gm.expr[i]]:-1;
    const fr=ex==null||ex<0?Math.floor(t/600)%2:ex;
    const img=sp&&(sp[face][fr]||sp[face][0]);
    const px=i===0?8:Wpx-72, py=Hpx/2-10;
    // 輪到誰：腳下亮一圈
    if(gm.winner==null&&gm.turn===i){ g.fillStyle='rgba(247,198,49,.35)'; g.beginPath(); g.ellipse(px+32,py+66,30,7,0,0,6.2832); g.fill(); }
    if(img) g.drawImage(img,px,py,64,64);
    g.fillStyle=i===0?'#111':'#f4f4f4'; g.beginPath(); g.arc(px+32,py-12,7,0,6.2832); g.fill(); g.strokeStyle='#888'; g.stroke();
    g.fillStyle=id===me?'#f7c631':'#e6edf3'; g.font='11px sans-serif'; g.textAlign='center';
    // 名字放在 vpet 底下（2026-10-20）：頭上留給代表自己的那顆棋子。
    // 太長就截斷加「…」，寬度不超過 vpet 那一欄（64＋左右空白），完整名字在等待面板看得到
    g.textBaseline='top';
    g.fillText(gmFit(g,(info.get(id)||{}).name||'?',64+GM_SIDE_GAP), px+32, py+76);
    g.textBaseline='alphabetic';
  });
  g.fillStyle='#e6edf3'; g.font='bold 12px sans-serif'; g.textAlign='center';
  const msg=gm.winner!=null?(gm.winner<0?'平手！':(gm.sides[gm.winner]===me?'你贏了！':'你輸了…')):(myTurn?'輪到你（'+(gm.turn===0?'黑':'白')+'）':gm.thinking?'助手思考中…':'等對手下…');
  // 連線對局：每手倒數（伺服器時間；超時由電腦代下一手），剩 5 秒變紅
  const left=!comState&&gm.winner==null&&gm.turnAt&&gm.turnMs?Math.max(0,Math.ceil((gm.turnAt+gm.turnMs-(Date.now()+stSkew))/1000)):null;
  if(left!=null&&left<=5) g.fillStyle='#ff7b72';
  g.fillText(msg+(left!=null?'　'+left+' 秒':''), Wpx/2, 14);
  if(gm.winner==null) rsDraw(g,Wpx-46,Hpx-46,36,gmResign);
}
function gmFit(g,t,w){ if(g.measureText(t).width<=w) return t; while(t.length>1&&g.measureText(t+'…').width>w) t=t.slice(0,-1); return t+'…'; }
// 點棋盤：換算成最近的交叉點，輪到我、那裡沒子就下
function gmCell(e){
  const gm=gmData(); if(!gm) return null;
  const cv=document.getElementById('stairscv'), rc=cv.getBoundingClientRect();
  const sx=(e.clientX-rc.left)*cv.width/rc.width, sy=(e.clientY-rc.top)*cv.height/rc.height;
  const n=gm.n||15, G=gmGeom(cv.width,cv.height,n);
  const x=Math.round((sx-G.x0)/G.cell), y=Math.round((sy-G.y0)/G.cell);
  return x>=0&&y>=0&&x<n&&y<n?{ x, y }:null;
}
(function(){
  const cv=document.getElementById('stairscv');
  cv.addEventListener('mousemove',e=>{ gmHover=gmData()?gmCell(e):null; });
  cv.addEventListener('mouseleave',()=>{ gmHover=null; });
  cv.addEventListener('click',e=>{
    const gm=gmData(); if(!gm||gm.winner!=null||gm.sides[gm.turn]!==stMeId()||rsAt(e)) return;
    const c=gmCell(e); if(!c||gm.board[c.y*(gm.n||15)+c.x]!=='0') return;
    if(comState){ comPlace(c.x,c.y); return; }   // 跟電腦玩：本地下
    sendCmd('gomokuMove',{ x:String(c.x), y:String(c.y) }).then(r=>{ if(r&&!r.ok) flashCmdMsg(r.error||'下不了','#f85149'); poll(); });
  });
  document.getElementById('gmresign').addEventListener('click',()=>{
    if(!confirm('確定要認輸嗎？')) return;
    const dd=mbData();
    if(dd){   // 手動戰鬥
      if(comState){ dd.winner=1; dd.endAt=0; return; }
      sendCmd('duelResign').then(()=>poll()); return;
    }
    if(comState&&comState.gm){ comState.gm.winner=1; comState.gm.expr=['SAD','HAPPY']; comState.gm.exprAt=Date.now()+stSkew; comEndPanel(false,'（認輸）'); return; }
    sendCmd('gomokuResign').then(()=>poll());
  });
})();
// ── 偷看盤（docs/plaza-peek-spec.md）─────────────────────────────────────
// 廣場下方右邊一顆隱形的 🤫（滑鼠移過去才浮出來，提示「上班請專心」）。按下去：伺服器把我標成躲起來
//（大家的廣場上我消失、聊天室「XXX 不知道躲去哪了...」），我自己這邊轉場進廁所，滑手機看台股。
// 廁所是程式畫的點陣圖（1/3 解析度再放大），手機是 HTML（要打字）。vpet 從左下角斜斜探進來看手機。
let peekOn=false, peekArt=null, peekArtChar='', peekRaf=0, peekBusy=false;
const PEEK_L=3;   // 背景畫在 1/3 解析度再放大 → 點陣感
// 背景第 2 版（2026-10-21）：鏡頭貼近馬桶，左右隔板斜斜收向後牆 → 像躲在一間裡面。
// 第 1 版（peekBgV1，遠景、整間廁所）先留著，PEEK_BG 改回 1 就能換回去
const PEEK_BG=2;
function peekBg(W,H){ return PEEK_BG===1?peekBgV1(W,H):peekBgV2(W,H); }
function peekBgV2(W,H){
  const lw=Math.ceil(W/PEEK_L), lh=Math.ceil(H/PEEK_L), c=document.createElement('canvas'); c.width=lw; c.height=lh;
  const g=c.getContext('2d'), R=(col,x,y,w,h)=>{ g.fillStyle=col; g.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h)); };
  const poly=(col,pts)=>{ g.fillStyle=col; g.beginPath(); g.moveTo(pts[0][0],pts[0][1]); for(const p of pts.slice(1)) g.lineTo(p[0],p[1]); g.closePath(); g.fill(); };
  const ell=(x,y,rx,ry,col)=>{ g.fillStyle=col; g.beginPath(); g.ellipse(x,y,rx,ry,0,0,6.2832); g.fill(); };
  // 後牆（隔間裡面那一面）：上半淺灰、下半深灰磁磚
  const bx0=lw*0.17, bx1=lw*0.83, by0=lh*0.06, by1=lh*0.72, mid=lh*0.4;
  R('#d9d9d6',0,0,lw,lh); R('#3e4045',bx0,mid,bx1-bx0,by1-mid);
  for(let x=bx0;x<bx1;x+=(bx1-bx0)/6){ R('#c6c6c2',x,by0,1,mid-by0); R('#34363b',x,mid,1,by1-mid); }
  R('#34363b',bx0,(mid+by1)/2,bx1-bx0,1);
  // 地板（往鏡頭這邊張開的梯形）
  poly('#2c2e32',[[bx0,by1],[bx1,by1],[lw,lh],[0,lh]]);
  g.strokeStyle='#383a3f'; for(let i=0;i<=6;i++){ const u=i/6; g.beginPath(); g.moveTo(bx0+(bx1-bx0)*u,by1); g.lineTo(lw*u,lh); g.stroke(); }
  // 左右隔板：從畫面邊緣斜斜收向後牆
  poly('#e2e2df',[[0,0],[bx0,by0],[bx0,by1],[0,lh*1.02]]); poly('#d7d7d3',[[lw,0],[bx1,by0],[bx1,by1],[lw,lh*1.02]]);
  g.strokeStyle='#b4b4af'; g.beginPath(); g.moveTo(bx0,by0); g.lineTo(bx0,by1); g.moveTo(bx1,by0); g.lineTo(bx1,by1); g.stroke();
  // 左隔板上的捲筒衛生紙盒（大的銀色圓，跟著隔板斜一點）
  ell(lw*0.085,lh*0.55,lw*0.07,lh*0.11,'#9aa0a6'); ell(lw*0.085,lh*0.55,lw*0.055,lh*0.09,'#c8cbcf'); R('#eef0f2',lw*0.06,lh*0.48,2,lh*0.1);
  // 右隔板上的掛勾
  R('#9aa0a6',lw*0.9,lh*0.3,3,2); R('#9aa0a6',lw*0.92,lh*0.3,1,4);
  // 垃圾桶（後牆左下角）
  const tx=lw*0.22, ty=by1-lh*0.13;
  R('#8d9298',tx-1,ty-1,lw*0.08+2,3); R('#b8bcc1',tx,ty+1,lw*0.08,lh*0.13); R('#d6d9dc',tx+2,ty+2,2,lh*0.11); R('#222',tx+2,ty-1,lw*0.08-4,1);
  // 馬桶（近景、大）：掀起的蓋子靠在後牆、馬桶圈、底座出畫面
  const cx=lw*0.53;
  ell(cx,by1-lh*0.1,lw*0.13,lh*0.11,'#c9c9c6'); ell(cx,by1-lh*0.1,lw*0.115,lh*0.095,'#f4f4f2');            // 蓋子
  R('#c9c9c6',cx-lw*0.1,by1-lh*0.02,lw*0.2,lh*0.05); R('#f4f4f2',cx-lw*0.095,by1-lh*0.02,lw*0.19,lh*0.045);   // 鉸鏈那條
  R('#c9c9c6',cx-lw*0.1,lh*0.86,lw*0.2,lh*0.2); R('#f0f0ee',cx-lw*0.09,lh*0.86,lw*0.18,lh*0.2);             // 底座（出畫面）
  ell(cx,lh*0.84,lw*0.17,lh*0.1,'#c9c9c6'); ell(cx,lh*0.84,lw*0.155,lh*0.085,'#f4f4f2');                     // 馬桶圈
  ell(cx,lh*0.845,lw*0.1,lh*0.05,'#b9bdc0'); ell(cx,lh*0.85,lw*0.07,lh*0.032,'#a7c4d4');                    // 裡面、水
  return c;
}
function peekBgV1(W,H){
  const lw=Math.ceil(W/PEEK_L), lh=Math.ceil(H/PEEK_L), c=document.createElement('canvas'); c.width=lw; c.height=lh;
  const g=c.getContext('2d'), R=(col,x,y,w,h)=>{ g.fillStyle=col; g.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h)); };
  const wall=lh*0.52, panel=lh*0.76, sideL=lw*0.2, sideR=lw*0.84;
  R('#d9d9d6',0,0,lw,wall);                                                      // 上半牆：淺灰大磁磚
  for(let x=0;x<lw;x+=lw/6) R('#c6c6c2',x,0,1,wall); R('#c6c6c2',0,wall*0.45,lw,1);
  R('#3e4045',0,wall,lw,panel-wall);                                             // 馬桶後面：深灰磁磚
  for(let x=0;x<lw;x+=lw/8) R('#34363b',x,wall,1,panel-wall); R('#34363b',0,(wall+panel)/2,lw,1);
  R('#2c2e32',0,panel,lw,lh-panel);                                              // 地板：深色磁磚
  for(let x=-lw;x<lw*2;x+=lw/5) { g.strokeStyle='#383a3f'; g.beginPath(); g.moveTo(lw/2+(x-lw/2)*0.6,panel); g.lineTo(x,lh); g.stroke(); }
  R('#383a3f',0,panel+(lh-panel)*0.45,lw,1);
  R('#e4e4e1',0,0,sideL,lh*0.9); R('#bdbdb8',sideL,0,1,lh*0.9); R('#cfcfcb',0,lh*0.9-2,sideL,2);   // 左右隔板
  R('#dededb',sideR,0,lw-sideR,lh*0.9); R('#bdbdb8',sideR,0,1,lh*0.9);
  // 左牆的捲筒衛生紙盒（大的銀色圓）
  g.fillStyle='#9aa0a6'; g.beginPath(); g.arc(sideL*0.5,wall*0.95,sideL*0.42,0,6.2832); g.fill();
  g.fillStyle='#c8cbcf'; g.beginPath(); g.arc(sideL*0.5,wall*0.95,sideL*0.34,0,6.2832); g.fill();
  R('#eef0f2',sideL*0.3,wall*0.95-sideL*0.25,2,sideL*0.3);
  // 垃圾桶（銀色）
  const tx=lw*0.27, ty=panel-lh*0.12;
  R('#8d9298',tx-1,ty-1,lw*0.1+2,3); R('#b8bcc1',tx,ty+1,lw*0.1,lh*0.14); R('#d6d9dc',tx+2,ty+2,2,lh*0.12); R('#222',tx+2,ty-1,lw*0.1-4,1);
  // 馬桶（坐墊掀起來）：水箱藏在後面，看得到掀起的蓋子、馬桶圈、底座
  const cx=lw*0.53, ell=(x,y,rx,ry,col)=>{ g.fillStyle=col; g.beginPath(); g.ellipse(x,y,rx,ry,0,0,6.2832); g.fill(); };
  ell(cx,panel-lh*0.13,lw*0.085,lh*0.06,'#c9c9c6'); ell(cx,panel-lh*0.13,lw*0.075,lh*0.05,'#f4f4f2');   // 掀起的蓋子
  R('#c9c9c6',cx-lw*0.07,panel-lh*0.08,lw*0.14,lh*0.04); R('#f4f4f2',cx-lw*0.065,panel-lh*0.08,lw*0.13,lh*0.035);
  ell(cx,panel+lh*0.01,lw*0.1,lh*0.055,'#c9c9c6'); ell(cx,panel+lh*0.01,lw*0.09,lh*0.045,'#f4f4f2');      // 馬桶圈
  ell(cx,panel+lh*0.012,lw*0.06,lh*0.028,'#b9bdc0');
  R('#c9c9c6',cx-lw*0.045,panel+lh*0.05,lw*0.09,lh*0.16); R('#f0f0ee',cx-lw*0.04,panel+lh*0.05,lw*0.08,lh*0.16);   // 底座
  return c;
}
function peekLoadArt(ch){
  if(!ch||ch===peekArtChar) return; peekArtChar=ch;
  fetch('/stairs/sprites?c='+encodeURIComponent(ch),{cache:'no-store'}).then(r=>r.json()).then(j=>{
    const a=j[ch]; if(!a) return;
    const bake=(dots)=>{ const s=9, c=document.createElement('canvas'); c.width=dots[0].length*s; c.height=dots.length*s; const g=c.getContext('2d');
      for(let y=0;y<dots.length;y++) for(let x=0;x<dots[y].length;x++){ const d=dots[y][x]; if(!d) continue; g.fillStyle='rgb('+d[0]+','+d[1]+','+d[2]+')'; g.fillRect(x*s,y*s,s,s); } return c; };
    peekArt=[bake(a.r[0]),bake(a.r[1])];
  }).catch(()=>{ peekArtChar=''; });
}
let peekBgCache=null;
function peekFrame(){
  peekRaf=requestAnimationFrame(peekFrame);
  const box=document.getElementById('peekbox'), pet=document.getElementById('pet'), cv=document.getElementById('peekcv');
  const W=69*CW, H=54*(CH/2);
  box.style.left=pet.offsetLeft+'px'; box.style.top=pet.offsetTop+'px'; box.style.width=W+'px'; box.style.height=H+'px';
  if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; peekBgCache=null; }
  if(!peekBgCache) peekBgCache=peekBg(W,H);
  const g=cv.getContext('2d'); g.imageSmoothingEnabled=false;
  g.drawImage(peekBgCache,0,0,peekBgCache.width*PEEK_L,peekBgCache.height*PEEK_L);
  // vpet：從左下角斜斜探進來，抬頭看手機（一半在畫面外）；兩幀待機慢慢換
  const img=peekArt&&peekArt[Math.floor(performance.now()/700)%2];
  if(img){ g.save(); g.translate(W*0.17,H*0.86); g.rotate(-0.45); g.drawImage(img,-img.width/2,-img.height/2); g.restore(); }
}
// 開／關（轉場：黑幕淡入 → 換場景 → 淡出）。instant = 直接關（離開廣場、切畫面）
function peekShow(on,instant){
  if(on===peekOn) return;
  peekOn=on;
  const box=document.getElementById('peekbox'), fade=document.getElementById('peekfade');
  const swap=()=>{
    box.style.display=on?'block':'none';
    document.body.classList.toggle('peeking',on);
    if(on){ peekLoadArt(stMyChar); if(!peekRaf) peekRaf=requestAnimationFrame(peekFrame); setTimeout(()=>document.getElementById('peekcode').focus(),50); }
    else if(peekRaf){ cancelAnimationFrame(peekRaf); peekRaf=0; }
  };
  if(instant){ swap(); fade.style.opacity=0; return; }
  fade.style.opacity=1;
  setTimeout(()=>{ swap(); fade.style.opacity=0; },320);
}
// 輪詢帶回來的狀態：我躲起來了沒（重新整理頁面也會回到廁所）、最近一筆報價（盤中伺服器每 30 秒推）
function peekSync(p){
  if(!peekBusy) peekShow(!!p.hidden);
  if(p.hidden&&p.stock) peekRender(p.stock);
}
const pkFmt=(n)=>n==null?'—':(Math.round(n*100)/100).toLocaleString(undefined,{maximumFractionDigits:2});
function peekRender(s){
  const q=s&&s.quote; if(!q) return;
  const up=q.change>0, dn=q.change<0, cls=up?'pk-up':dn?'pk-dn':'';
  document.getElementById('pkname').textContent=q.name+'　'+q.code+(q.market==='otc'?'（櫃）':'');
  const pr=document.getElementById('pkprice'); pr.textContent=pkFmt(q.price); pr.className=cls;
  const ch=document.getElementById('pkchg'); ch.className=cls;
  ch.textContent=q.change==null?'':(up?'▲ ':dn?'▼ ':'')+pkFmt(Math.abs(q.change))+'（'+(q.pct>0?'+':'')+(q.pct==null?'—':q.pct)+'%）';
  document.getElementById('pkinfo').innerHTML='開 '+pkFmt(q.open)+'　高 '+pkFmt(q.high)+'<br>低 '+pkFmt(q.low)+'　昨收 '+pkFmt(q.prev)+'<br>量 '+(q.volume==null?'—':q.volume.toLocaleString())+' 張';
  let h='<tr><th>買價</th><th>賣價</th></tr>';
  for(let i=0;i<5;i++) h+='<tr><td class="pk-up">'+(q.bids[i]!=null?pkFmt(q.bids[i]):'')+'</td><td class="pk-dn">'+(q.asks[i]!=null?pkFmt(q.asks[i]):'')+'</td></tr>';
  document.getElementById('pkbook').innerHTML=h;
  document.getElementById('pktime').textContent=(q.time?q.time+'　':'')+(s.trading?'盤中・每 30 秒更新':'已收盤')+'　僅供參考';
}
function peekMsg(t){ const m=document.getElementById('peekmsg'); m.textContent=t||''; }
function peekQuery(){
  const code=document.getElementById('peekcode').value.trim().toUpperCase();
  if(!code){ peekMsg('輸入代號'); return; }
  peekMsg('查詢中…');
  sendCmd('stockQuery',{code}).then(r=>{
    if(!r||!r.ok){ peekMsg((r&&r.error)||'查不到'); return; }
    peekMsg(''); peekRender({ quote:r.quote, at:r.at, trading:r.trading });
  });
}
document.getElementById('peekbtn').addEventListener('click',()=>{
  peekBusy=true;
  sendCmd('plazaHide',{on:'1'}).then(r=>{ peekBusy=false; if(r&&r.ok) peekShow(true); else flashCmdMsg((r&&r.error)||'躲不了','#f85149'); });
});
document.getElementById('peekback').addEventListener('click',()=>{
  peekBusy=true;
  sendCmd('plazaHide',{on:'0'}).then(r=>{ peekBusy=false; if(r&&r.ok) peekShow(false); else peekMsg((r&&r.error)||'回不去'); });
});
document.getElementById('peekgo').addEventListener('click',peekQuery);
document.getElementById('peekcode').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.isComposing){ e.preventDefault(); peekQuery(); } });
// ── 手動戰鬥（docs/plaza-duel-spec.md）────────────────────────────────────
// 九宮格回合制：A 欄自己（畫面左邊永遠是自己）、B 欄中間、C 欄對手。判定在伺服器（duel-sim.js），
// 頁面照每回合的結果（last）演出：移動 → 發射 → 對波／打中 → 爆炸。
// dev 測試對戰（comState.kind==='duel'）：同一套 duel-sim 在頁面本地跑，對手每回合隨機選。
const MB={ W:552, H:432, GX:30, GW:164, GY:100, GH:90, PS:6, BS:8, CS:6, BOOM:8, PANEL:56, BAR_MS:1400, BAR_MIN_MS:900, BAR_MAX_MS:1600 };   // 力度條一趟（來回）幾毫秒：每回合在 MIN～MAX 之間隨機   // vpet 6 倍、子彈 8 倍（2026-10-20 再放大）
let mbRaf=0, mbArt={}, mbArtKey='', mbBoom=null, mbSel=null, mbAnim=null, mbBtns=[], mbBgCache={};
function mbData(){
  if(comState) return comState.kind==='duel'?comState.duel:null;
  const m=stMine(); if(!m||m.kind!=='duel'||!m.duel) return null;
  const d=m.duel, at=(i)=>m.ids.indexOf(d.sides[i]);
  return Object.assign({}, d, { names:[0,1].map(i=>m.names[at(i)]||'?'), chars:[0,1].map(i=>m.chars[at(i)]||null) });
}
function mbMe(d){ return comState?0:Math.max(0,d.sides.indexOf(stMeId())); }
function mbNow(){ return Date.now()+stSkew; }
// 認輸改成畫在畫面裡的白旗（長按，見 mbResignBtn）：網頁原生那顆不用
function mbStart(){ if(!mbRaf) mbRaf=requestAnimationFrame(mbFrame); document.getElementById('gmresign').style.display='none'; }
// 停的時候畫布維持縮放（結束面板後面還看得到最後一幕）；換別的小遊戲時才拿掉（mbUnstyle）
function mbStop(){ if(mbRaf){ cancelAnimationFrame(mbRaf); mbRaf=0; } mbSel=null; mbAnim=null; }
// 換別的小遊戲（或進別的房的等待畫面）：拿掉縮放、清掉最後一幕 —— 不清的話等待畫面後面會留著擂台（2026-10-21 回報）
function mbUnstyle(){ const cv=document.getElementById('stairscv'); if(!cv.style.width) return;
  cv.style.width=''; cv.style.height=''; cv.getContext('2d').clearRect(0,0,cv.width,cv.height); }
function mbPlaying(){ return !!mbRaf&&!!mbData(); }
// 點陣 → 小畫布（s 倍、可左右翻）。cx/cy/hw：內容外框的中心與半寬（子彈圖的內容不在正中間）
function mbBake(dots,s,flip){
  if(!dots) return null;
  const w=dots[0].length, c=document.createElement('canvas'); c.width=w*s; c.height=dots.length*s;
  const g=c.getContext('2d'); let x0=99,x1=-1,y0=99,y1=-1;
  for(let y=0;y<dots.length;y++) for(let x=0;x<w;x++){ const d=dots[y][flip?w-1-x:x]; if(!d) continue;
    g.fillStyle='rgb('+d[0]+','+d[1]+','+d[2]+')'; g.fillRect(x*s,y*s,s,s);
    x0=Math.min(x0,x); x1=Math.max(x1,x); y0=Math.min(y0,y); y1=Math.max(y1,y); }
  return { img:c, cx:(x0+x1+1)/2*s, cy:(y0+y1+1)/2*s, hw:(x1-x0+1)/2*s };
}
function mbLoadArt(chars){
  const key=chars.join(',');
  if(key===mbArtKey) return; mbArtKey=key;
  if(!mbBoom&&MB_BOOM) mbBoom=MB_BOOM.map(f=>mbBake(f,MB.BOOM,false));
  fetch('/stairs/sprites?c='+encodeURIComponent(key),{cache:'no-store'}).then(r=>r.json()).then(j=>{
    mbArt={};
    for(const c in j){ const a=j[c];
      // 子彈原圖面左：左邊（往右打）的不翻、右邊的翻（2026-10-20 試做圖定）；cutin 是左邊的翻、右邊的不翻（雙方面向中間）
      mbArt[c]={ r:a.r.map(f=>mbBake(f,MB.PS,false)), l:a.l.map(f=>mbBake(f,MB.PS,false)),
                 bulL:mbBake(a.b,MB.BS,false), bulR:mbBake(a.b,MB.BS,true),
                 cutL:mbBake(a.c,MB.CS,true), cutR:mbBake(a.c,MB.CS,false) }; }
  }).catch(()=>{ mbArtKey=''; });
}
const mbCell=(col,row)=>[MB.GX+MB.GW*col+MB.GW/2, MB.GY+MB.GH*row+MB.GH/2];
const mbEase=(u)=>1-(1-u)*(1-u);

// ── 三張背景（點陣風、程式畫）：畫一次存起來 ──
function mbBg(name,W,H){
  const key=name+W+'x'+H; if(mbBgCache[key]) return mbBgCache[key];
  const c=document.createElement('canvas'); c.width=W; c.height=H; const g=c.getContext('2d');
  const R=(col,x,y,w,h)=>{ g.fillStyle=col; g.fillRect(x,y,w,h); };
  const HZ=MB.GY-8;
  if(name==='ring'){
    R('#14142a',0,0,W,H);
    for(let i=0;i<300;i++) R(i%2?'#24244a':'#30305c',(i*61)%W,(i*37)%H,8,8);
    g.globalAlpha=.10; g.fillStyle='#fff8d0';
    for(const cx of [W*0.25,W*0.75]){ g.beginPath(); g.moveTo(cx-12,0); g.lineTo(cx+12,0); g.lineTo(cx+120,H); g.lineTo(cx-120,H); g.fill(); }
    g.globalAlpha=1;
    const x0=18, y0=HZ, x1=W-18, y1=MB.GY+MB.GH*3+10;
    R('#222',x0-10,y0-6,x1-x0+20,y1-y0+18); R('#3d5a80',x0,y0,x1-x0,y1-y0);
    for(let y=y0+24;y<y1;y+=30) R('#43628a',x0,y,x1-x0,2);
    MB_ROPE.forEach((col,k)=>{ R(col,x0,y0-18+k*6,x1-x0,3); R(col,x0-3+k*3,y0-18+k*6,3,y1-y0+18); R(col,x1-k*3,y0-18+k*6,3,y1-y0+18); });
    for(const x of [x0-8,x1-5]) R('#bbb',x,y0-26,13,28);
  } else if(name==='studio'){
    R('#e8dcc8',0,0,W,HZ);
    for(let x=16;x<W;x+=106){ R('#9fb7c8',x,10,90,HZ-24); R('#c4d8e6',x+5,15,80,HZ-34); R('#e4f0f7',x+13,15,13,HZ-34); }
    R('#7a5230',0,HZ-38,W,5); for(let x=40;x<W;x+=132) R('#5e3e22',x,HZ-33,5,33);
    R('#8a5a30',0,HZ-5,W,5); R('#b07a45',0,HZ,W,H-HZ);
    for(let y=HZ;y<H;y+=24){ R('#9a6837',0,y,W,2); for(let x=((y-HZ)/24%2)*80;x<W;x+=160) R('#9a6837',x,y,2,24); }
  } else {
    R('#8fc9f0',0,0,W,38); R('#a9d6f5',0,0,W,14);
    R('#c9a66b',0,38,W,HZ-38);
    for(let x=0;x<W;x+=10) R('#b8955a',x,38,5,5);
    for(let x=12;x<W;x+=48){ R('#6b4e2e',x,56,26,HZ-56); R('#6b4e2e',x+5,51,16,5); R('#4e3820',x+5,66,16,HZ-66); }
    R('#8a6a40',0,HZ-5,W,5); R('#d9b779',0,HZ,W,H-HZ);
    for(let i=0;i<340;i++) R(i%3?'#cfa868':'#e6c993',(i*97)%W,HZ+((i*53)%(H-HZ)),5,5);
  }
  return mbBgCache[key]=c;
}
const MB_ROPE=['#c0392b','#ecf0f1','#2e5ea8'];
// 擂台前面那排繩子畫在角色前面（看得到四面圍繩）
function mbRingFront(g,W){
  const x0=18, x1=W-18, y1=MB.GY+MB.GH*3+10;
  MB_ROPE.forEach((col,k)=>{ g.fillStyle=col; g.fillRect(x0,y1-14+k*6,x1-x0,3); });
  g.fillStyle='#bbb'; for(const x of [x0-8,x1-5]) g.fillRect(x,y1-22,13,30);
}

// ── 一回合的演出時間軸（毫秒，從收到結果開始）──
const MBT={ MOVE:400, FLY:900, HOLD:800, FADE:300, WIN:450, BOOM:600 };
function mbTimeline(L, T, mi){
  const col=(s)=>s===mi?0:2;
  const rows=[0,1].map(s=>T<MBT.MOVE?L.from[s]+(L.to[s]-L.from[s])*mbEase(T/MBT.MOVE):L.to[s]);
  const P=[0,1].map(s=>mbCell(col(s),L.to[s])), Tg=[0,1].map(s=>mbCell(col(1-s),L.aim[s]));
  const at=(s,u)=>[P[s][0]+(Tg[s][0]-P[s][0])*u, P[s][1]+(Tg[s][1]-P[s][1])*u];
  const meet=MBT.MOVE+MBT.FLY*0.5, holdEnd=meet+MBT.HOLD, hitT=L.clash?holdEnd+MBT.WIN:MBT.MOVE+MBT.FLY;
  const bullets=[];
  for(const s of [0,1]){
    if(T<MBT.MOVE) continue;
    if(L.clash){
      if(T<holdEnd||s!==L.cw){
        const u=Math.min(0.5,(T-MBT.MOVE)/MBT.FLY);
        let a=1; if(T>=holdEnd) a=Math.max(0,1-(T-holdEnd)/MBT.FADE);   // 輸的（或一樣強的兩顆）淡出
        if(a<=0) continue;
        const p=at(s,u), j=T>=meet&&T<holdEnd?((Math.floor(T/70)+s)%2?-3:3):0;   // 頂住時上下錯開抖動
        bullets.push({ s, x:p[0], y:p[1]+j, a, lock:true });
      } else if(T<hitT){
        const p=at(s,0.5+0.5*(T-holdEnd)/MBT.WIN); bullets.push({ s, x:p[0], y:p[1], a:1 });
      }
    } else {
      const u=(T-MBT.MOVE)/MBT.FLY;
      if(L.hit[1-s]&&u>=1) continue;                 // 打中：子彈消失、換爆炸
      if(u>1.35) continue;                            // 沒打中：飛過頭、淡掉
      const p=at(s,u); bullets.push({ s, x:p[0], y:p[1], a:u>1?Math.max(0,1-(u-1)/0.35):1 });
    }
  }
  const booms=[0,1].filter(s=>L.hit[s]&&T>=hitT&&T<hitT+MBT.BOOM).map(s=>({ s, x:mbCell(col(s),L.to[s])[0], y:mbCell(col(s),L.to[s])[1], f:Math.floor((T-hitT)/120)%2 }));
  const frame=[0,1].map(s=>(L.hit[s]&&T>=hitT&&T<hitT+800)?2:(T>=MBT.MOVE&&T<MBT.MOVE+600)?4:-1);
  return { rows, bullets, booms, frame, hp:T<hitT?L.hpBefore:L.hp, done:T>=DS.ANIM_MS };
}

// ── 選擇（每回合依序：移動 → 攻擊位置 → 力度）──
function mbPhase(d,now){
  if(now<d.startAt) return 'open';
  if(mbAnim&&!mbAnim.done) return 'anim';
  if(d.winner!=null) return 'over';
  if(now<d.deadline-DS.PICK_MS||now>=d.deadline) return 'anim';
  return 'pick';
}
function mbSelFor(d){
  if(!mbSel||mbSel.round!==d.round) mbSel={ round:d.round, step:0, cur:0, mv:null, aim:null, barT0:0, sent:false };
  return mbSel;
}
// 力度條：每回合（每次進到這一步）速度、起點、方向都隨機（2026-10-21：固定 1.4 秒一趟、每次從 0 往上，節奏背起來就一直 ×2）。
// barPh = 起始相位 0～1：前半是往上、後半是往下，所以起點和方向一起決定
function mbBarVal(){ const ms=mbSel.barMs||MB.BAR_MS, ph=(((performance.now()-mbSel.barT0)/ms+(mbSel.barPh||0))%1+1)%1; return ph<0.5?ph*2:2-ph*2; }
// 一次只能走一格（上／不動／下）而且不能出界。原本只檢查出界 → 隔兩格的位置也會出現虛影、點了被伺服器退回（2026-10-21）
function mbMoveOk(d,mi,mv){ const r=d.row[mi]+mv; return (mv===-1||mv===0||mv===1)&&r>=0&&r<3; }
function mbChooseMove(d,mi,mv){ if(!mbMoveOk(d,mi,mv)) return; mbSel.mv=mv; mbSel.step=1; mbSel.cur=d.row[mi]+mv; }
function mbChooseAim(a){ mbSel.aim=a; mbSel.step=2; mbSel.barT0=performance.now();
  mbSel.barMs=MB.BAR_MIN_MS+Math.random()*(MB.BAR_MAX_MS-MB.BAR_MIN_MS); mbSel.barPh=Math.random(); }
function mbBack(){ if(mbSel.step===2){ mbSel.step=1; mbSel.cur=mbSel.aim; } else if(mbSel.step===1){ mbSel.step=0; mbSel.cur=mbSel.mv; } }
function mbSend(p){
  const d=mbData(); if(!d||mbSel.sent) return;
  mbSel.sent=true;
  const pk={}; if(mbSel.mv!=null) pk.mv=mbSel.mv; if(mbSel.step>=2&&mbSel.aim!=null) pk.aim=mbSel.aim; if(p!=null) pk.p=p;
  if(comState){ d.picks[0]=pk; d.picked[0]=true; return; }
  const args={}; for(const k in pk) args[k]=String(pk[k]);
  sendCmd('duelPick',args).then(r=>{ if(r&&!r.ok){ flashCmdMsg(r.error||'送不出去','#f85149'); } poll(); });
}
function mbKey(k){
  const d=mbData(); if(!d) return false;
  if(mbPhase(d,mbNow())!=='pick') return false;
  const s=mbSelFor(d), mi=mbMe(d); if(s.sent) return false;
  const up=k==='arrowup'||k==='w', dn=k==='arrowdown'||k==='s', ok=k==='enter'||k===' ', back=k==='escape'||k==='backspace';
  if(back){ mbBack(); return true; }
  if(s.step===0){ if(up&&mbMoveOk(d,mi,s.cur-1)) s.cur--; else if(dn&&mbMoveOk(d,mi,s.cur+1)) s.cur++; else if(ok) mbChooseMove(d,mi,s.cur); return up||dn||ok; }
  if(s.step===1){ if(up&&s.cur>0) s.cur--; else if(dn&&s.cur<2) s.cur++; else if(ok) mbChooseAim(s.cur); return up||dn||ok; }
  if(ok){ mbSend(mbBarVal()); return true; }
  return false;
}
function mbCanvasXY(e){ const cv=document.getElementById('stairscv'), rc=cv.getBoundingClientRect(); return [(e.clientX-rc.left)*cv.width/rc.width,(e.clientY-rc.top)*cv.height/rc.height]; }
function mbCellAt(x,y){ const c=Math.floor((x-MB.GX)/MB.GW), r=Math.floor((y-MB.GY)/MB.GH); return c>=0&&c<3&&r>=0&&r<3?[c,r]:null; }
// ── 認輸：右下角的白旗小方塊（長按，共用的 rsDraw）──
const MB_RF={ w:40 };
const mbResignRect=()=>({ x:MB.W-MB.GX-MB_RF.w+6, y:MB.H-MB.PANEL+8, w:MB_RF.w, h:MB_RF.w });
function mbResignActive(d,now){ return d.winner==null&&now>=d.startAt; }
function mbResignBtn(g,d,now){ if(!mbResignActive(d,now)) return; const r=mbResignRect(); rsDraw(g,r.x,r.y,r.w,()=>mbResign(d)); }
// ── 長按認輸（白旗小方塊）：手動戰鬥、五子棋、打排球共用（2026-10-21 定 A3 版）──
// 按住 RS_MS 才算：外框從左上角順時針慢慢變紅、白旗擺動，放開或滑出去就取消；點一下沒作用。
// 位置由各遊戲每一幀畫的時候給（rsDraw）；按的判定看最近一幀畫在哪（停畫超過 300ms 就不算）
const RS_MS=1000;
const RS_FLAG=[['P.......','PWWWWW..','PWWWWWW.','PWWWWWW.','PWWWWW..','P.......','P.......','P.......'],
               ['P.......','PWWWW...','PWWWWWW.','PWWWWWWW','PWWWW...','P.......','P.......','P.......']];
let rsHold=0, rsBox=null;
function rsDraw(g,x,y,w,onResign){
  const t=performance.now(), p=rsHold?Math.min(1,(t-rsHold)/RS_MS):0;
  rsBox={ x, y, w, at:t };
  g.fillStyle='#000'; g.fillRect(x-2,y-2,w+4,w+4);
  g.fillStyle='#5a2a2a'; g.fillRect(x,y,w,w); g.fillStyle='#3a1a1a'; g.fillRect(x,y+w-3,w,3);
  const f=RS_FLAG[rsHold?Math.floor(t/120)%2:0], s=Math.max(2,Math.floor(w*0.6/8)), fx=x+(w-8*s)/2+2, fy=y+(w-8*s)/2;
  for(let j=0;j<8;j++) for(let i=0;i<8;i++){ const c=f[j][i]; if(c==='.') continue;
    g.fillStyle=c==='P'?'#8a6a40':(i>4?'#d8d8d8':'#fafafa'); g.fillRect(fx+i*s,fy+j*s,s,s); }
  if(p>0){
    const e=[[x,y,1,0],[x+w,y,0,1],[x+w,y+w,-1,0],[x,y+w,0,-1]];
    g.save(); g.strokeStyle='#ff6b6b'; g.lineWidth=4; g.beginPath(); g.moveTo(x,y);
    let left=4*w*p; for(const [ex,ey,dx,dy] of e){ const seg=Math.min(w,left); g.lineTo(ex+dx*seg,ey+dy*seg); left-=seg; if(left<=0) break; }
    g.stroke(); g.restore();
  }
  // 提示字：放在方塊上面；方塊貼著上緣（打排球放右上角）就放下面
  const ly=y<30?y+w+12:y-10, label=rsHold?'放開取消':'按住認輸';
  g.save(); g.font='bold 12px sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.lineWidth=3; g.strokeStyle='#000';
  g.strokeText(label,x+w/2,ly); g.fillStyle='#ffb3b3'; g.fillText(label,x+w/2,ly); g.restore();
  if(p>=1){ rsHold=0; rsBox=null; onResign(); }
}
function rsAt(e){
  if(!rsBox||performance.now()-rsBox.at>300) return false;
  const [x,y]=mbCanvasXY(e); return x>=rsBox.x&&x<rsBox.x+rsBox.w&&y>=rsBox.y&&y<rsBox.y+rsBox.w;
}
function mbResign(d){
  if(comState){ d.winner=1; d.endAt=0; return; }   // dev 測試：本地直接判輸
  sendCmd('duelResign').then(()=>poll());
}
function mbClick(e){
  const d=mbData(); if(!d||mbPhase(d,mbNow())!=='pick') return;
  const s=mbSelFor(d), mi=mbMe(d); if(s.sent) return;
  const [x,y]=mbCanvasXY(e);
  if(rsAt(e)) return;   // 認輸那塊是長按，點一下不算任何選擇
  const b=mbBtns.find(b=>x>=b.x&&x<b.x+b.w&&y>=b.y&&y<b.y+b.h);
  if(b){ if(!b.off) b.act(); return; }
  if(s.step===2){ mbSend(mbBarVal()); return; }
  const c=mbCellAt(x,y); if(!c) return;
  if(s.step===0&&c[0]===0) mbChooseMove(d,mi,c[1]-d.row[mi]);
  else if(s.step===1&&c[0]===2) mbChooseAim(c[1]);
}
function mbHoverAt(e){
  const d=mbData(); if(!d||!mbSel||mbSel.sent||mbPhase(d,mbNow())!=='pick') return;
  const [x,y]=mbCanvasXY(e), c=mbCellAt(x,y), mi=mbMe(d); if(!c) return;
  if(mbSel.step===0&&c[0]===0&&mbMoveOk(d,mi,c[1]-d.row[mi])) mbSel.cur=c[1]-d.row[mi];
  else if(mbSel.step===1&&c[0]===2) mbSel.cur=c[1];
}

// ── dev 測試對戰：本地跑 duel-sim，對手每回合隨機 ──
function mbDevStart(){
  if(!DS){ flashCmdMsg('手動戰鬥的判定沒載入','#f85149'); return; }
  sendCmd('duelDev').then(r=>{
    if(!r||!r.ok){ flashCmdMsg((r&&r.error)||'開不了','#f85149'); return; }
    miniClose();
    stEndSeen=(stairs&&stairs.end&&stairs.end.at)||stEndSeen;
    const now=mbNow(), startAt=now+DS.OPEN_MS;
    const d=Object.assign(DS.createDuel([r.me.str,r.opp.str], DS.BGS[Math.floor(Math.random()*DS.BGS.length)]),
      { sides:['me','dev'], names:[r.me.name,r.opp.name], chars:[r.me.char,r.opp.char], startAt, deadline:startAt+DS.PICK_MS,
        picks:[null,null], picked:[false,false], endAt:0 });
    comState={ kind:'duel', duel:d, startAt, done:false };
    const box=document.getElementById('stairsbox'); box.style.display='block';
    document.getElementById('stairspanel').style.display='none';
    stStream(false); stStop(); dnStop(); vbStop(); gmStop();
    mbSel=null; mbAnim=null; mbStart();
  });
}
function mbLocalTick(d,now){
  if(d.winner!=null){
    if(!comState.done&&now>=d.endAt){ comState.done=true;
      comEndPanel(d.winner<0?null:d.winner===0, '共 '+(d.round-1)+' 回合　'+d.names[1]+'（戰力 '+d.str[1]+'）'); }
    return;
  }
  if(now<d.startAt) return;
  if(!d.picks[1]&&now>=d.deadline-DS.PICK_MS){ d.picks[1]=DS.randomPick(d,1); d.picked[1]=true; }
  if((d.picks[0]&&d.picks[1])||now>=d.deadline){
    DS.resolve(d,[0,1].map(i=>DS.normPick(d,i,d.picks[i])));
    d.picks=[null,null]; d.picked=[false,false];
    if(d.winner!=null) d.endAt=now+DS.ANIM_MS+DS.END_MS; else d.deadline=now+DS.ANIM_MS+DS.PICK_MS;
  }
}

function mbFrame(){
  mbRaf=requestAnimationFrame(mbFrame);
  const d=mbData(); if(!d) return;
  const now=mbNow();
  if(comState) mbLocalTick(d,now);
  mbLoadArt(d.chars.map(c=>c||'agumon'));
  if(d.last&&(!mbAnim||d.last.round>mbAnim.round)) mbAnim={ round:d.last.round, last:d.last, t0:performance.now(), done:false };
  // 時限快到還沒送出：有選多少送多少（沒選的伺服器用預設）
  if(mbPhase(d,now)==='pick'){ const s=mbSelFor(d); if(!s.sent&&d.deadline-now<400) mbSend(null); }
  mbDraw(d,now);
}
function mbDraw(d,now){
  const cv=document.getElementById('stairscv'), pet=document.getElementById('pet');
  // 畫在固定的 552×432（版面照這個排），顯示大小跟其他小遊戲一樣（69×54 格，格子大小會變）
  const W=MB.W, H=MB.H;
  if(cv.width!==W||cv.height!==H){ cv.width=W; cv.height=H; }
  cv.style.width=(69*CW)+'px'; cv.style.height=(54*(CH/2))+'px';
  cv.style.left=pet.offsetLeft+'px'; cv.style.top=pet.offsetTop+'px';
  const g=cv.getContext('2d'); g.imageSmoothingEnabled=false;
  const mi=mbMe(d), oi=1-mi, side=[0,1].map(s=>s===mi?0:2);
  g.drawImage(mbBg(d.bg,W,H),0,0);
  // 演出中用這回合的時間軸；其他時候站在現在的位置
  let tl=null;
  if(mbAnim){ const T=performance.now()-mbAnim.t0; tl=mbTimeline(mbAnim.last,T,mi); if(tl.done){ mbAnim.done=true; tl=null; } }
  const rows=tl?tl.rows:d.row, hp=tl?tl.hp:d.hp, phase=mbPhase(d,now), t=performance.now();
  const sel=phase==='pick'?mbSelFor(d):null;
  // 選擇中：可以去的格子、要打的格子
  const box=(col,row,color,dash)=>{ g.save(); g.strokeStyle=color; g.lineWidth=3; if(dash) g.setLineDash([6,5]);
    g.strokeRect(MB.GX+MB.GW*col+5,MB.GY+MB.GH*row+5,MB.GW-10,MB.GH-10); g.restore(); };
  if(sel&&!sel.sent){
    if(sel.step===0){ box(0,d.row[mi],'#ffd84a'); box(0,d.row[mi]+sel.cur,'rgba(255,255,255,.85)',true); }
    else { box(0,d.row[mi]+sel.mv,'#8f8',true); for(let r=0;r<3;r++) box(2,r,'rgba(255,90,90,.6)',true); }
  }
  // 兩隻 vpet（左邊是自己，面右；右邊是對手，面左）
  const over=d.winner!=null&&!tl;
  for(const s of [0,1]){
    const a=mbArt[d.chars[s]||'agumon']; if(!a) continue;
    const [x,y]=mbCell(side[s],rows[s]);
    let fr=tl&&tl.frame[s]>=0?tl.frame[s]:Math.floor(t/600)%2;
    if(over) fr=d.winner<0?0:(d.winner===s?5:3);
    const sp=(s===mi?a.r:a.l)[fr]||(s===mi?a.r:a.l)[0]; if(!sp) continue;
    g.fillStyle='rgba(0,0,0,.25)'; g.beginPath(); g.ellipse(x,y+40,36,8,0,0,6.2832); g.fill();
    g.drawImage(sp.img,Math.round(x-sp.img.width/2),Math.round(y-sp.img.height/2-6));
    // 選好的移動：半透明的預覽
    if(s===mi&&sel&&!sel.sent){ const mv=sel.step===0?sel.cur:sel.mv; if(mv){ const [gx,gy]=mbCell(0,d.row[mi]+mv);
      g.globalAlpha=.4; g.drawImage(sp.img,Math.round(gx-sp.img.width/2),Math.round(gy-sp.img.height/2-6)); g.globalAlpha=1; } }
  }
  if(d.bg==='ring') mbRingFront(g,W);
  // 準星
  if(sel&&!sel.sent&&sel.step>=1){ const [x,y]=mbCell(2,sel.step===1?sel.cur:sel.aim); g.save(); g.strokeStyle='#ff4040'; g.lineWidth=3;
    g.beginPath(); g.arc(x,y,30,0,6.2832); g.stroke();
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ g.beginPath(); g.moveTo(x+dx*20,y+dy*20); g.lineTo(x+dx*40,y+dy*40); g.stroke(); } g.restore(); }
  // 子彈、爆炸
  if(tl){
    for(const b of tl.bullets){ const a=mbArt[d.chars[b.s]||'agumon']; const im=a&&(b.s===mi?a.bulL:a.bulR); if(!im) continue;
      let x=b.x; if(b.lock) x=b.s===mi?Math.min(x,W/2-im.hw):Math.max(x,W/2+im.hw);   // 對波：兩顆在正中間邊緣相連，不交疊
      g.globalAlpha=b.a; g.drawImage(im.img,Math.round(x-im.cx),Math.round(b.y-im.cy)); g.globalAlpha=1; }
    for(const b of tl.booms){ const im=mbBoom&&mbBoom[b.f]; if(im) g.drawImage(im.img,Math.round(b.x-im.img.width/2),Math.round(b.y-im.img.height/2-6)); }
  }
  // 上方：名字＋血條（不顯示數字）、第幾回合、倒數
  g.fillStyle='rgba(0,0,0,.45)'; g.fillRect(0,0,W,48);
  const bar=(x,s,right)=>{ const ratio=Math.max(0,hp[s]/d.max[s]), w=Math.round(200*ratio);
    g.font='bold 15px sans-serif'; g.textBaseline='middle'; g.textAlign=right?'right':'left'; g.fillStyle=s===mi?'#f7c631':'#fff';
    g.fillText(gmFit(g,d.names[s]||'?',190),right?x+200:x,12);
    g.fillStyle='#000'; g.fillRect(x-2,24,204,16); g.fillStyle='#444'; g.fillRect(x,26,200,12);
    g.fillStyle=ratio>.5?'#3ad15a':ratio>.25?'#f1c40f':'#e74c3c'; g.fillRect(right?x+200-w:x,26,w,12);
    g.fillStyle='rgba(255,255,255,.35)'; g.fillRect(right?x+200-w:x,26,w,4); };
  bar(12,mi,false); bar(W-212,oi,true);
  if(phase==='pick'&&d.picked&&d.picked[oi]){ g.font='bold 12px sans-serif'; g.textAlign='right'; g.lineWidth=3; g.strokeStyle='#000'; g.strokeText('對手已選好 ✓',W-12,56); g.fillStyle='#7ee787'; g.fillText('對手已選好 ✓',W-12,56); }
  g.textAlign='center'; g.font='bold 12px sans-serif'; g.fillStyle='#ddd';
  g.font='bold 14px sans-serif'; g.fillText('第 '+Math.min(tl?mbAnim.last.round:d.round,DS.MAX_ROUNDS)+' 回合',W/2,12);   // 演出中還是這一回合
  if(phase==='pick'){ const sec=Math.max(0,Math.ceil((d.deadline-now)/1000)); g.font='bold 22px sans-serif';
    g.lineWidth=3; g.strokeStyle='#000'; g.strokeText(String(sec),W/2,32); g.fillStyle=sec<=3?'#ff6b6b':'#fff'; g.fillText(String(sec),W/2,32); }
  g.textBaseline='alphabetic';
  mbBtns=[];
  if(phase==='pick') mbPanel(g,d,mi,W,H,sel);
  if(over){ g.fillStyle='rgba(0,0,0,.4)'; g.fillRect(0,H/2-26,W,52); g.fillStyle='#fff'; g.font='bold 22px sans-serif'; g.textAlign='center'; g.textBaseline='middle';
    g.fillText(d.winner<0?'平手！':d.winner===mi?'你贏了！':'你輸了…',W/2,H/2); g.textBaseline='alphabetic'; }
  mbResignBtn(g,d,now);
  if(phase==='open') mbCutin(g,d,mi,W,H,now);
}
// 下方的選擇面板：步驟、按鈕、力度條（按鈕位置記在 mbBtns 給點擊用）
function mbPanel(g,d,mi,W,H,sel){
  const y0=H-MB.PANEL;
  g.fillStyle='rgba(10,10,20,.8)'; g.fillRect(0,y0,W,MB.PANEL); g.fillStyle='#555'; g.fillRect(0,y0,W,2);
  g.textBaseline='middle'; g.textAlign='left'; g.font='bold 14px sans-serif';
  ['① 移動','② 攻擊','③ 力度'].forEach((t,i)=>{ g.fillStyle=sel.sent?'#8f8':i===sel.step?'#ffd84a':i<sel.step?'#8f8':'#777'; g.fillText(t,12+i*62,y0+16); });
  const btn=(x,w,label,state,act)=>{ const y=y0+22, h=26;   // state: 0 一般 1 選中 2 停用
    g.fillStyle=state===2?'#333':state===1?'#ffd84a':'#3b4a6b'; g.fillRect(x,y,w,h);
    g.fillStyle=state===2?'#222':state===1?'#b8901a':'#25304a'; g.fillRect(x,y+h-3,w,3);
    g.fillStyle=state===2?'#666':state===1?'#222':'#fff'; g.font='bold 15px sans-serif'; g.textAlign='center'; g.fillText(label,x+w/2,y+h/2);
    g.textAlign='left'; mbBtns.push({ x, y, w, h, act, off:state===2 }); };
  g.font='13px sans-serif'; g.fillStyle='#aaa';
  if(sel.sent){ g.fillText(d.picked&&d.picked[1-mi]?'雙方都選好了…':'已選好，等對手…',12,y0+40); g.textBaseline='alphabetic'; return; }
  g.fillText(sel.step===2?'點擊或空白鍵停住':'點格子或 ↑↓ / Enter',12,y0+42);
  const bx=204, BACK=404;   // 右下角留給「認輸」鈕
  if(sel.step===0){
    btn(bx,74,'▲ 上',mbMoveOk(d,mi,-1)?(sel.cur===-1?1:0):2,()=>mbChooseMove(d,mi,-1));
    btn(bx+80,90,'● 不動',sel.cur===0?1:0,()=>mbChooseMove(d,mi,0));
    btn(bx+176,74,'▼ 下',mbMoveOk(d,mi,1)?(sel.cur===1?1:0):2,()=>mbChooseMove(d,mi,1));
  } else if(sel.step===1){
    ['上','中','下'].forEach((t,i)=>btn(bx+i*64,58,t,sel.cur===i?1:0,()=>mbChooseAim(i)));
    btn(BACK,62,'↩ 返回',0,mbBack);
  } else {
    const x=bx, y=y0+22, w=186, h=26, v=mbBarVal();
    g.fillStyle='#000'; g.fillRect(x-2,y-2,w+4,h+4);
    g.fillStyle='#4a6a4a'; g.fillRect(x,y,w*DS.ZONE_15,h); g.fillStyle='#e67e22'; g.fillRect(x+w*DS.ZONE_15,y,w*(DS.ZONE_2-DS.ZONE_15),h);
    g.fillStyle='#e74c3c'; g.fillRect(x+w*DS.ZONE_2,y,w*(1-DS.ZONE_2),h);
    g.font='bold 12px sans-serif'; g.textAlign='center'; g.fillStyle='#cfe8cf'; g.fillText('×1',x+w*DS.ZONE_15/2,y0+10);   // 三個倍率都寫在條的上方
    g.fillStyle='#ffb366'; g.fillText('×1.5',x+w*(DS.ZONE_15+DS.ZONE_2)/2,y0+10); g.fillStyle='#ff8080'; g.fillText('×2',x+w*(1+DS.ZONE_2)/2+2,y0+10);
    g.fillStyle='#fff'; g.fillRect(x+w*v-2,y-5,4,h+10); g.fillStyle='#000'; g.fillRect(x+w*v-1,y-5,2,h+10);
    g.textAlign='left';
    btn(BACK,62,'↩ 返回',0,mbBack);
  }
  g.textBaseline='alphabetic';
}
// 開場：雙方 cutin 從畫面外滑入（自己左下、對手右上，都面向中間），中間 VS
function mbCutin(g,d,mi,W,H,now){
  const e=now-(d.startAt-DS.OPEN_MS), out=DS.OPEN_MS-350;
  const k=e<450?mbEase(Math.max(0,e)/450):e>out?1-Math.min(1,(e-out)/350):1;
  g.fillStyle='rgba(0,0,0,'+(0.55*k)+')'; g.fillRect(0,0,W,H);
  const cut=(s,left)=>{ const a=mbArt[d.chars[s]||'agumon'], im=a&&(left?a.cutL:a.cutR); if(!im) return;
    const w=im.img.width, h=im.img.height, tx=left?24:W-24-w, ty=left?H-h-44:60, sx=left?-w-40:W+40;
    const x=Math.round(sx+(tx-sx)*k);
    g.fillStyle='#000'; g.fillRect(x-7,ty-7,w+14,h+14); g.fillStyle=left?'#3b82f6':'#e74c3c'; g.fillRect(x-5,ty-5,w+10,h+10);
    g.fillStyle='#111'; g.fillRect(x,ty,w,h); g.drawImage(im.img,x,ty); };
  cut(1-mi,false); cut(mi,true);
  if(e>250&&e<out+200){ const p=Math.min(1,(e-250)/250), sc=p<1?0.4+p*0.8:1.2-Math.min(0.2,(e-500)/1000);
    g.save(); g.globalAlpha=Math.min(1,k*1.5); g.translate(W/2,H/2); g.rotate(-0.12); g.scale(sc,sc);
    g.font='bold italic 72px sans-serif'; g.textAlign='center'; g.textBaseline='middle';
    g.lineWidth=12; g.strokeStyle='#000'; g.lineJoin='round'; g.strokeText('VS',0,0); g.fillStyle='#ff2a2a'; g.fillText('VS',0,0); g.restore(); }
}
(function(){
  const cv=document.getElementById('stairscv');
  cv.addEventListener('click',e=>{ if(mbPlaying()) mbClick(e); });
  // 長按認輸：比打排球的「點畫面殺球」先註冊，按在白旗上就攔下來（不會順便殺球）
  cv.addEventListener('pointerdown',e=>{ if(!rsAt(e)) return; e.preventDefault(); e.stopImmediatePropagation(); rsHold=performance.now(); });
  for(const t of ['pointerup','pointercancel','pointerleave']) cv.addEventListener(t,()=>{ rsHold=0; });
  cv.addEventListener('pointermove',e=>{ if(rsHold&&!rsAt(e)) rsHold=0; });
  cv.addEventListener('mousemove',e=>{ if(mbPlaying()) mbHoverAt(e); });
})();
window.addEventListener('keydown',e=>{
  if(!mbPlaying()||typing()) return;
  const k=e.key.toLowerCase();
  // 對戰中方向鍵、WASD 一律攔下（不然廣場那邊會拿去走路）
  if(['arrowup','arrowdown','arrowleft','arrowright','w','a','s','d','enter',' ','escape','backspace'].includes(k)){ mbKey(k); e.preventDefault(); e.stopImmediatePropagation(); }
},true);
// ── 打排球（docs/plaza-volley-spec.md）────────────────────────────────────
// 1 對 1、輸入同步（鎖步）：兩邊各算同一套模擬（volley-sim.js 原樣內嵌在 VB），只交換每一格的按鍵。
// 我的按鍵延後 VB_DELAY 格才生效：處理第 f 格時，送出第 f+VB_DELAY 格的按鍵；
// 第 f 格要等「我的、對手的」按鍵都到了才算 —— 網路卡一下畫面會停一下，但兩邊永遠一樣。
const VB_DELAY=3;
// 殺球殘影：球橫向夠快（殺球、地上用力打；一般碰到的橫速最多 22）就記下這幾格的位置，慢下來就清掉
const VB_TRAIL_N=6, VB_TRAIL_FAST=24;
let vbTrail=[];
function vbTrailPush(g){
  const b=g.ball;
  if(b&&Math.abs(b.vx)>=VB_TRAIL_FAST){ vbTrail.push({ x:b.x, y:b.y }); if(vbTrail.length>VB_TRAIL_N) vbTrail.shift(); }
  else vbTrail.length=0;
}
let vbGame=null, vbPrev=null, vbStartAt=0, vbSides=[], vbMe=0, vbMine=new Map(), vbTheirs=new Map(), vbRaf=0, vbKeys=new Set(), vbStallAt=0, vbEndSent=false, vbStepAt=0;
function vbBegin(info){
  if(!VB||!info) return;
  if(vbGame&&vbStartAt===info.startAt){ if(!vbRaf) vbRaf=requestAnimationFrame(vbFrame); return; }
  vbGame=VB.createGame(); vbPrev=null; vbStartAt=info.startAt; vbSides=info.sides||[];
  vbMe=Math.max(0,vbSides.indexOf(stMeId())); vbMine=new Map(); vbTheirs=new Map(); vbEndSent=false; vbStallAt=0;
  if(!vbRaf) vbRaf=requestAnimationFrame(vbFrame);
}
function vbStop(){ if(vbRaf){ cancelAnimationFrame(vbRaf); vbRaf=0; } vbGame=null; vbKeys.clear(); }
function vbPlaying(){ if(comState) return comState.kind==='volley'&&!!vbGame&&!vbGame.over; const m=stMine(); return !!(m&&m.kind==='volley'&&m.state==='play'&&vbGame&&!vbGame.over); }
function vbIn(d){ if(d&&d.id!==(stairs&&stairs.meId)&&Number.isInteger(d.f)) vbTheirs.set(d.f,d.k|0); }
function vbKeyBits(){
  let k=0;
  for(const c of vbKeys){ if(c==='arrowleft'||c==='a') k|=VB.K_LEFT; else if(c==='arrowright'||c==='d') k|=VB.K_RIGHT;
    else if(c==='arrowup'||c==='w') k|=VB.K_JUMP; else if(c===' '||c==='enter'||c==='tap') k|=VB.K_SPIKE; }
  return k;
}
function vbFrame(){
  vbRaf=requestAnimationFrame(vbFrame);
  const g=vbGame; if(!g) return;
  const now=Date.now()+stSkew;
  const due=Math.floor((now-vbStartAt)/VB.FRAME_MS);
  let stalled=false;
  if(comState){   // 跟電腦玩：不用等網路，我的按鍵當場生效，電腦的當場算
    while(g.f<due&&!g.over){
      vbPrev={ b:{ x:g.ball.x, y:g.ball.y }, p:g.players.map(p=>({ x:p.x, y:p.y })) };
      VB.step(g,[vbKeyBits(),comVolleyKeys(g)]); vbStepAt=performance.now(); vbTrailPush(g);
    }
    if(g.over&&!comState.done){ comState.done=true; setTimeout(()=>{ if(comState&&vbGame===g) comEndPanel(g.winner===0, g.score[0]+' : '+g.score[1]); }, 1500); }
    vbDraw(now); return;
  }
  while(g.f<due&&!g.over){
    // 送出 VB_DELAY 格之後要用的按鍵（每格只送一次）
    const fs=g.f+VB_DELAY;
    if(!vbMine.has(fs)){ const k=vbKeyBits(); vbMine.set(fs,k); sendCmd('volleyInput',{ f:String(fs), k:String(k) }); }
    const mk=g.f<VB_DELAY?0:vbMine.get(g.f), tk=g.f<VB_DELAY?0:vbTheirs.get(g.f);
    if(mk===undefined||tk===undefined){ stalled=true; break; }   // 對手這一格的按鍵還沒到：等
    vbPrev={ b:{ x:g.ball.x, y:g.ball.y }, p:g.players.map(p=>({ x:p.x, y:p.y })) };
    const keys=vbMe===0?[mk,tk]:[tk,mk];
    VB.step(g,keys); vbStepAt=performance.now(); vbTrailPush(g);
    vbMine.delete(g.f-1); vbTheirs.delete(g.f-1);
  }
  vbStallAt=stalled?(vbStallAt||performance.now()):0;
  if(g.over&&!vbEndSent){
    vbEndSent=true;   // 兩邊算的一樣：誰先報都可以，伺服器收第一個
    sendCmd('volleyEnd',{ winner:vbSides[g.winner]||'', s0:String(g.score[0]), s1:String(g.score[1]) });
  }
  vbDraw(now);
}
// 開場倒數時的操作說明：置中的小卡片，按鍵畫成鍵帽（原本一整行字會超出畫面兩邊，2026-10-20）
function vbHelpCard(g, cx, top){
  const rows=[
    [['k','←'],['k','→'],['t','移動'],['g'],['k','↑'],['t','跳']],
    [['k','空白鍵'],['t','或點畫面'],['g'],['t','碰到球時用力打']],
    [['t','在空中用力打＝殺球'],['g'],['t','先拿 '+VB.WIN+' 分贏']],
  ];
  const KF='bold 11px ui-monospace,Consolas,monospace', TF='12px sans-serif', RH=22, PAD=12;
  const wOf=(it)=>{ if(it[0]==='g') return 14; g.font=it[0]==='k'?KF:TF; return it[0]==='k'?Math.max(20,g.measureText(it[1]).width+10):g.measureText(it[1]).width; };
  const rowW=(r)=>r.reduce((s,it)=>s+wOf(it)+4,-4);
  const cw=Math.max(...rows.map(rowW))+PAD*2, ch=rows.length*RH+PAD*2-6;
  const rr=(x,y,w,h,r)=>{ g.beginPath(); g.moveTo(x+r,y); g.arcTo(x+w,y,x+w,y+h,r); g.arcTo(x+w,y+h,x,y+h,r); g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath(); };
  g.fillStyle='rgba(255,255,255,.9)'; rr(cx-cw/2,top,cw,ch,8); g.fill();
  g.strokeStyle='#d0d7de'; g.lineWidth=1; g.stroke();
  g.textBaseline='middle'; g.textAlign='left';
  rows.forEach((r,j)=>{
    let x=cx-rowW(r)/2; const y=top+PAD+j*RH+5;
    for(const it of r){
      const w=wOf(it);
      if(it[0]==='k'){ g.fillStyle='#d0d7de'; rr(x,y-9,w,19,4); g.fill(); g.fillStyle='#fff'; rr(x,y-9,w,17,4); g.fill();
        g.strokeStyle='#8c959f'; rr(x,y-9,w,19,4); g.stroke();
        g.font=KF; g.fillStyle='#1f2328'; g.textAlign='center'; g.fillText(it[1],x+w/2,y); g.textAlign='left'; }
      else if(it[0]==='t'){ g.font=TF; g.fillStyle='#1f2328'; g.fillText(it[1],x,y+1); }
      x+=w+4;
    }
  });
  g.textBaseline='alphabetic';
}
function vbDraw(now){
  const cv=document.getElementById('stairscv'), pet=document.getElementById('pet');
  const DW=CW, DH=CH/2, U=VB.SUB, Wpx=VB.W/U*DW, Hpx=VB.H/U*DH, g0=vbGame;
  if(cv.width!==Wpx||cv.height!==Hpx){ cv.width=Wpx; cv.height=Hpx; }
  cv.style.left=pet.offsetLeft+'px'; cv.style.top=pet.offsetTop+'px';
  const g=cv.getContext('2d'); g.imageSmoothingEnabled=false;
  const X=(v)=>v/U*DW, Y=(v)=>v/U*DH;
  const sky=g.createLinearGradient(0,0,0,Y(VB.GROUND)); sky.addColorStop(0,'#7cc4f4'); sky.addColorStop(1,'#cfeefc');
  g.fillStyle=sky; g.fillRect(0,0,Wpx,Y(VB.GROUND));
  g.fillStyle='#e8cf8e'; g.fillRect(0,Y(VB.GROUND),Wpx,Hpx-Y(VB.GROUND));
  g.fillStyle='#d4b670'; for(let i=0;i<30;i++) g.fillRect(((i*53)%Wpx), Y(VB.GROUND)+6+(i%4)*7, DW, DH/2);
  // 網子
  g.fillStyle='#f5f5f5'; g.fillRect(X(VB.NET_X),Y(VB.NET_TOP),X(VB.NET_W),Y(VB.GROUND-VB.NET_TOP));
  g.fillStyle='#9aa4ad'; for(let y=VB.NET_TOP;y<VB.GROUND;y+=2*U) g.fillRect(X(VB.NET_X),Y(y),X(VB.NET_W),2);
  // 補間：在上一格跟這一格之間（25 格／秒，不補會一頓一頓）
  const a=vbPrev?Math.max(0,Math.min(1,(performance.now()-vbStepAt)/VB.FRAME_MS)):1;
  const L=(p,c)=>p+(c-p)*a;
  const info=stInfoMap();
  g0.players.forEach((p,i)=>{
    const id=vbSides[i], sp=stSprites[(info.get(id)||{}).char];
    const px=vbPrev?L(vbPrev.p[i].x,p.x):p.x, py=vbPrev?L(vbPrev.p[i].y,p.y):p.y;
    const face=i===0?'r':'l';
    const air=p.y<VB.GROUND-VB.S;
    // 擊球：攻擊幀（ATTACK）；結束：贏的開心、輸的難過；空中：待機一；平常：待機兩幀交替
    const fr=g0.over?(g0.winner===i?5:3):p.atk>0?4:air?0:(Math.floor(g0.f/6)%2);
    const img=sp&&(sp[face][fr]||sp[face][0]);
    if(img) g.drawImage(img, X(px)+(X(VB.S)-64)/2, Y(py)+(Y(VB.S)-64), 64, 64);
    else { g.fillStyle=i===0?'#d29922':'#58a6ff'; g.fillRect(X(px),Y(py),X(VB.S),Y(VB.S)); }
    g.fillStyle=id===stMeId()?'#9a6700':'#1f2328'; g.font='11px sans-serif'; g.textAlign='center';
    g.fillText((info.get(id)||{}).name||'?', X(px+VB.S/2), Y(py)-3);
  });
  // 球：白底紅線的點陣小球＋地上的影子
  // 得分後停的那一秒、比賽結束：球留在落地的位置（不要消失，看得出落在哪一邊）
  {
    const bx=vbPrev?L(vbPrev.b.x,g0.ball.x):g0.ball.x, by=vbPrev?L(vbPrev.b.y,g0.ball.y):g0.ball.y, r=X(VB.BALL_R);
    // 殺球／用力打的快球：後面拖幾顆越來越淡、越來越小的殘影
    vbTrail.forEach((t,i)=>{ const k=(i+1)/(vbTrail.length+1);
      g.globalAlpha=0.08+0.32*k; g.fillStyle='#ffd0c8'; g.beginPath(); g.arc(X(t.x),Y(t.y),r*(0.55+0.4*k),0,6.2832); g.fill(); });
    g.globalAlpha=1;
    g.fillStyle='rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(X(bx),Y(VB.GROUND)+2,r,r/3,0,0,6.2832); g.fill();
    g.fillStyle='#ffffff'; g.beginPath(); g.arc(X(bx),Y(by),r,0,6.2832); g.fill();
    g.strokeStyle='#e5534b'; g.lineWidth=2; g.beginPath(); g.arc(X(bx),Y(by),r*0.6,0.4,2.6); g.stroke();
    g.strokeStyle='#57606a'; g.lineWidth=1; g.beginPath(); g.arc(X(bx),Y(by),r,0,6.2832); g.stroke();
  }
  // 比分
  g.fillStyle='#1f2328'; g.font='bold 18px ui-monospace,Consolas,monospace'; g.textAlign='center';
  g.fillText(g0.score[0]+' : '+g0.score[1], Wpx/2, 22);
  g.font='12px sans-serif';
  if(now<vbStartAt){ g.fillStyle='#9a6700'; g.font='bold 40px ui-monospace,Consolas,monospace'; g.fillText(String(Math.ceil((vbStartAt-now)/1000)), Wpx/2, Hpx/2-10);
    vbHelpCard(g, Wpx/2, 34); g.textAlign='center'; }
  else if(g0.pause&&!g0.over){ g.fillText('得分！', Wpx/2, 40); }
  if(vbStallAt&&performance.now()-vbStallAt>400){ g.fillStyle='rgba(0,0,0,.45)'; g.fillRect(0,Hpx/2-16,Wpx,32);
    g.fillStyle='#fff'; g.font='bold 13px sans-serif'; g.fillText('等待對手連線…', Wpx/2, Hpx/2+5); }
  if(g0.over){ g.fillStyle='rgba(0,0,0,.4)'; g.fillRect(0,Hpx/2-20,Wpx,40);
    g.fillStyle='#fff'; g.font='bold 18px sans-serif'; g.fillText(g0.winner===vbMe?'你贏了！':'你輸了…', Wpx/2, Hpx/2+6); }
  if(!g0.over&&now>=vbStartAt) rsDraw(g,Wpx-44,8,34,vbResign);   // 右上角（下面是場地）
}
function vbResign(){
  if(comState){ if(vbGame){ vbGame.over=true; vbGame.winner=1-vbMe; } comState.done=true; comEndPanel(false,'（認輸）'); return; }
  sendCmd('volleyResign').then(()=>poll());
}
// 按鍵：← → / A D 移動、↑ / W 跳、空白鍵 / Enter 殺球（捕獲階段攔下，廣場不會一起動）
const VB_KEYS=['arrowleft','arrowright','arrowup','a','d','w',' ','enter'];
window.addEventListener('keydown',e=>{
  const k=e.key.toLowerCase();
  if(!VB_KEYS.includes(k)||!vbPlaying()||typing()) return;
  e.preventDefault(); e.stopImmediatePropagation(); vbKeys.add(k);
},true);
window.addEventListener('keyup',e=>{
  const k=e.key.toLowerCase();
  if(!vbKeys.has(k)) return;
  e.stopImmediatePropagation(); vbKeys.delete(k);
},true);
window.addEventListener('blur',()=>vbKeys.clear());
// 點畫面 = 殺球鍵（按住期間碰到球就用力打），同空白鍵
(function(){
  const cv=document.getElementById('stairscv');
  cv.addEventListener('pointerdown',e=>{ if(!vbPlaying()) return; e.preventDefault(); e.stopPropagation(); vbKeys.add('tap'); });
  for(const t of ['pointerup','pointercancel','pointerleave']) cv.addEventListener(t,()=>vbKeys.delete('tap'));
})();
// ── 拍照 ─────────────────────────────────────────────────────────────
// 按下去：換一個 seed 跟伺服器要「大家排好、擺姿勢」的那一張（/yard?photo=），畫到舞台上，
// 再把舞台各層（背景、節日、角色、天氣）疊成一張，前線那隻從左邊斜 45 度探頭進來，閃光、跳出預覽。
// 預覽開著的時候舞台維持拍照的樣子；關掉才放大家回去走。
// 按鈕顯示與否歸 data-scope 管（只在營地）；這裡只管能不能按：空營地、事件進行中不能拍
function photoNav(y){
  const b=document.querySelector('#controls button[data-cmd="photo"]');
  if(b) b.disabled=!(y&&y.kept&&!p2Phase&&!y.event);
}
async function photoTake(){
  if(photoBusy||sliding||p2Phase||view!=='yard'||!lastYard||!lastYard.kept) return;
  photoBusy=true;
  try{
    photoSeed=Math.floor(Math.random()*4294967296);
    await pollYard();
    if(!lastYard||!lastYard.photo){ photoSeed=null; return; }   // 伺服器不給拍（事件剛開始之類）
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));   // 背景、天氣先畫上這一幀
    photoShot=photoCompose(lastYard.photo.front, lastYard.photo.peek);
    const fl=document.getElementById('photoflash');
    fl.classList.remove('on'); fl.getBoundingClientRect(); fl.classList.add('on');
    document.getElementById('photoimg').src=photoShot;
    document.getElementById('photomsg').textContent='';
    document.getElementById('photobox').classList.add('on');
  } finally { photoBusy=false; }
}
// 舞台各層 → 一張圖。天氣層（wx）是 CSS 像素大小，縮放到同一張
function photoCompose(front, peek){
  // 先鋪舞台的底色：有些背景（像聖誕夜空）天空那塊是透明的，靠 #stage 的底色撐著 —— 不鋪的話照片上那塊是透明的
  const s=snapStage(), c=document.createElement('canvas'); c.width=s.width; c.height=s.height;
  const g=c.getContext('2d');
  g.fillStyle=getComputedStyle(document.getElementById('stage')).backgroundColor||'#181818';
  g.fillRect(0,0,c.width,c.height); g.drawImage(s,0,0);
  const wx=document.getElementById('wx');
  if(wx.width) g.drawImage(wx,0,0,c.width,c.height);
  if(front&&front.dots) photoPeek(g, front.dots, peek||{x:3,y:42});
  return c.toDataURL('image/png');
}
// 前線探頭：先畫成原本大小（1 點 = CW × CH/2），再整張轉 45 度（最近點取樣，保持像素風）。
// 中心 = 伺服器給的 peek（細格，左下角）→ 只露出上半身，像從畫面外斜斜探進來。
// 位置跟伺服器排站位時避開的那塊是同一份（plaza.PHOTO_PEEK），兩邊不會對不上
function photoPeek(g, dots, peek){
  const DW=CW, DH=CH/2, o=document.createElement('canvas');
  o.width=dots[0].length*DW; o.height=dots.length*DH;
  const og=o.getContext('2d');
  for(let y=0;y<dots.length;y++) for(let x=0;x<dots[y].length;x++){
    const c=dots[y][x]; if(!c) continue;
    og.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')'; og.fillRect(x*DW,y*DH,DW,DH);
  }
  g.save(); g.imageSmoothingEnabled=false;
  g.translate(peek.x*DW, peek.y*DH); g.rotate(Math.PI/4);
  g.drawImage(o,-o.width/2,-o.height/2);
  g.restore();
}
function photoClose(){
  document.getElementById('photobox').classList.remove('on');
  photoSeed=null; photoShot=null;
}
document.getElementById('photoclose').addEventListener('click',photoClose);
document.getElementById('photoagain').addEventListener('click',()=>{
  document.getElementById('photobox').classList.remove('on'); photoTake();
});
document.getElementById('photosave').addEventListener('click',async()=>{
  const msg=document.getElementById('photomsg');
  if(!photoShot) return;
  msg.textContent='儲存中…';
  try{
    const r=await (await fetch('/photo',{method:'POST',body:JSON.stringify({png:photoShot})})).json();
    if(!r.ok) throw new Error(r.error||'存不了');
    msg.innerHTML='';
    msg.appendChild(document.createTextNode('已存到 '+r.path+'　'));
    const a=document.createElement('button'); a.textContent='📂 開啟資料夾';
    a.addEventListener('click',()=>fetch('/photoOpen',{method:'POST',body:JSON.stringify({path:r.path})}));
    msg.appendChild(a);
  }catch(e){ msg.textContent='⚠️ '+e.message; }
});
// 翻頁的箭頭與點點。事件進行中、滑行中都不給翻
function pageNav(pages){
  const show=view==='yard'&&pages>1&&!p2Phase;
  document.getElementById('pgprev').style.display=(show&&yardPage>0)?'block':'none';
  document.getElementById('pgnext').style.display=(show&&yardPage<pages-1)?'block':'none';
  const d=document.getElementById('pgdots');
  d.style.display=show?'block':'none';
  const want=pages+':'+yardPage;
  if(show&&d.dataset.k!==want){ d.dataset.k=want; d.innerHTML=Array.from({length:pages},(_,i)=>'<i'+(i===yardPage?' class="on"':'')+'></i>').join(''); }
}
document.getElementById('pgprev').addEventListener('click',()=>{ if(!p2Phase&&yardPage>0) slideToPage(yardPage-1); });
document.getElementById('pgnext').addEventListener('click',()=>{ if(!p2Phase&&lastYard&&yardPage<(lastYard.pages||1)-1) slideToPage(yardPage+1); });
// Keramon 空降：從畫面上方掉到牠的位置，落地彈一下、揚一點灰。伺服器在這段期間不畫牠（?drop=）
function drawDrop(g, ts){
  if(!p2Drop||!p2Drop.t0||!lastYard||!lastYard.drop) return;
  const d=lastYard.drop, t=ts-p2Drop.t0;
  let y;
  if(t<DROP_MS){ const k=t/DROP_MS; y=-18+(d.y+18)*k*k; }
  else if(t<DROP_MS+DROP_BOUNCE_MS){ const k=(t-DROP_MS)/DROP_BOUNCE_MS; y=d.y-Math.sin(k*Math.PI)*2.5; }
  else { y=d.y; if(!p2Drop.release) p2Drop.release=true; }
  const dots=d.frames[(lastYard.step||0)%2]||d.frames[0];
  const px=Math.round(d.x*CW), py=Math.round(y*(CH/2));
  if(t>=DROP_MS&&t<DROP_MS+DROP_BOUNCE_MS*2){   // 落地的灰
    const k=Math.min(1,(t-DROP_MS)/(DROP_BOUNCE_MS*2));
    g.save(); g.globalAlpha=0.45*(1-k); g.fillStyle='#d8cdb4';
    g.beginPath(); g.ellipse(px+8*CW, (d.y+16)*(CH/2), (6+8*k)*CW, (1.5+1.5*k)*(CH/2), 0, 0, Math.PI*2); g.fill(); g.restore();
  }
  for(let yy=0;yy<dots.length;yy++){ const row=dots[yy];
    for(let x=0;x<row.length;x++){ const c=row[x]; if(!c) continue;
      g.fillStyle='rgb('+c[0]+','+c[1]+','+c[2]+')'; g.fillRect(px+x*CW, py+yy*(CH/2), CW, CH/2); } }
}
{
  const sel=document.getElementById('p2dev');
  if(sel) sel.addEventListener('change',()=>{ const a=sel.value; sel.value=''; if(a){ p2NoticeShown=false; sendCmd('page2Dev',{act:a}); } });
}

const HELP=${JSON.stringify(HELP.tipsFor(IS_RELEASE))};
const TUTOR=${JSON.stringify(tutorFrames())};
const HELP_TYPE_MS=28, HELP_ANIM_MS=375, HELP_BOX_W=420;   // 逐字速度、助手兩幀交替的間隔（半拍）
let helpMode=0, helpHover=null, helpAnim=null, helpType=null, helpText='';
function helpTarget(t){ const el=t&&t.closest&&t.closest('[data-help]'); return el&&HELP[el.dataset.help] ? el : null; }
// 同一個元素在不同畫面意思不一樣（舞台）：by 依畫面挑
function helpTip(el){ const t=HELP[el.dataset.help]; return t.by ? (t.by[view]||t.by.home) : t; }
function helpHoverSet(el){
  if(helpHover) helpHover.classList.remove('helphover');
  helpHover=el; if(el) el.classList.add('helphover');
}
function helpSet(m){
  helpMode=m;
  document.body.classList.toggle('helpmode', m===1);
  document.getElementById('helpbtn').classList.toggle('on', m>0);
  document.getElementById('helptoast').style.display = m===1 ? 'block' : 'none';
  if(m!==1) helpHoverSet(null);
  if(m!==2){
    document.getElementById('helpdim').style.display='none';
    clearInterval(helpAnim); clearInterval(helpType); helpAnim=helpType=null;
  }
  if(m===1 && typeof closeCtx==='function') closeCtx();   // 右鍵選單開著的話先收掉
}
function helpDrawTutor(i){
  const cv=document.getElementById('helpcv'), g=cv.getContext('2d');
  g.clearRect(0,0,16,16);
  if(!TUTOR) return;
  const f=TUTOR[i%TUTOR.length];
  for(let y=0;y<f.length;y++) for(let x=0;x<f[y].length;x++) if(f[y][x]){ g.fillStyle=f[y][x]; g.fillRect(x,y,1,1); }
}
function helpTypeDone(){ clearInterval(helpType); helpType=null; document.querySelector('#helpbox .bd').textContent=helpText; }
function helpShow(el){
  const tip=helpTip(el);
  helpSet(2);
  const r=el.getBoundingClientRect(), pad=4;
  const hole=document.getElementById('helphole');
  hole.style.left=(r.left-pad)+'px'; hole.style.top=(r.top-pad)+'px';
  hole.style.width=(r.width+pad*2)+'px'; hole.style.height=(r.height+pad*2)+'px';
  document.getElementById('helpdim').style.display='block';
  // 對話框：先放整段文字量好高度再定位（逐字打的時候框才不會一直長高、跳位置）
  const box=document.getElementById('helpbox'), bd=box.querySelector('.bd');
  box.querySelector('.hd').textContent=tip.t;
  helpText=tip.d; bd.style.minHeight=''; bd.textContent=helpText;
  document.getElementById('helpcv').style.display = TUTOR ? '' : 'none';
  // 可視範圍用 clientWidth／clientHeight：innerWidth、100vw 都含捲軸，窄視窗有捲軸時框右邊會被切掉（回報過）
  const W=document.documentElement.clientWidth||innerWidth, H=document.documentElement.clientHeight||innerHeight;
  box.style.width=Math.min(HELP_BOX_W, W-24)+'px';
  const bw=box.offsetWidth, bh=box.offsetHeight, gap=10;
  // 放目標下面；放不下就上面；都放不下（目標很高，例如舞台）就貼視窗底部
  let top = r.bottom+pad+gap+bh<=H ? r.bottom+pad+gap : r.top-pad-gap-bh>=0 ? r.top-pad-gap-bh : H-bh-12;
  const left=Math.max(12, Math.min(W-bw-12, r.left));
  box.style.left=left+'px'; box.style.top=Math.max(12,top)+'px';
  bd.style.minHeight=bd.offsetHeight+'px'; bd.textContent='';
  let n=0;
  helpType=setInterval(()=>{ n++; bd.textContent=helpText.slice(0,n); if(n>=helpText.length) helpTypeDone(); }, HELP_TYPE_MS);
  let f=0; helpDrawTutor(0);
  helpAnim=setInterval(()=>{ f^=1; helpDrawTutor(f); }, HELP_ANIM_MS);
}
function helpCatch(ev){
  if(!helpMode) return;
  const onBtn = !!(ev.target&&ev.target.closest&&ev.target.closest('#helpbtn'));
  // 問號模式下按 ? 鈕＝離開：交給它自己的 click（只放行左鍵那一串）
  if(helpMode===1 && onBtn && ev.type!=='contextmenu') return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  if(ev.type==='contextmenu'){ helpSet(0); return; }
  if(ev.type!=='click') return;
  if(helpMode===2){ if(helpType) helpTypeDone(); else helpSet(0); return; }   // 還在打字：先一次顯示完
  const el=helpTarget(ev.target);
  if(el) helpShow(el);   // 點到沒說明的地方：留在問號模式，什麼都不做
}
['pointerdown','mousedown','mouseup','click','dblclick','auxclick','contextmenu','touchstart']
  .forEach(t=>window.addEventListener(t, helpCatch, true));
window.addEventListener('mouseover', ev=>{ if(helpMode===1) helpHoverSet(helpTarget(ev.target)); }, true);
window.addEventListener('keydown', ev=>{
  if(helpMode && ev.key==='Escape'){ ev.preventDefault(); ev.stopImmediatePropagation(); helpSet(0); }
}, true);
document.getElementById('helpbtn').addEventListener('click', ()=>helpSet(helpMode ? 0 : 1));

const POLL_MS={home:500,yard:${YT.POLL_MS},plaza:250};   // 廣場：一拍 750ms，輪詢要比一拍密才不會跳格
(function pollLoop(){ poll().finally(()=>setTimeout(pollLoop, POLL_MS[view]||500)); })();
</script></body></html>`;

// 拍照：前線那隻的點陣（開心幀、面向右、節日配件照穿）。讀不到美術就不探頭（照片照樣拍）
function photoFront(st, acc) {
    try {
        const id = st && st.characterId;
        let dots = id ? plaza.spriteDots(core, id, 0, 'right', 'HAPPY') : null;
        if (dots && acc) dots = FEST.dress(dots, acc, 'right').dots;
        return dots ? { char: id, dots } : null;
    } catch (e) { return null; }
}
// 照片存哪：~/Pictures/vpet（沒有 Pictures 就放家目錄底下的 vpet）。AGUMON_PHOTO_DIR 給測試指到暫存目錄
function photoDir() {
    if (process.env.AGUMON_PHOTO_DIR) return process.env.AGUMON_PHOTO_DIR;
    const pics = path.join(os.homedir(), 'Pictures');
    return path.join(fs.existsSync(pics) ? pics : os.homedir(), 'vpet');
}
function photoName(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return '營地-' + now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate())
         + '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds()) + '.png';
}

const server = http.createServer((req, res) => {
    // 拍照存檔：前端合成好的 PNG（data URL）。只收 PNG、檔名伺服器自己取，不讓頁面決定路徑
    if (req.method === 'POST' && req.url === '/photo') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
            try {
                const { png } = JSON.parse(body);
                const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(png || ''));
                if (!m) throw new Error('不是 PNG');
                const buf = Buffer.from(m[1], 'base64');
                const dir = photoDir();
                fs.mkdirSync(dir, { recursive: true });
                let file = path.join(dir, photoName());
                for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, photoName().replace(/\.png$/, '-' + i + '.png'));
                fs.writeFileSync(file, buf);
                console.log('   📷 照片存到 ' + file);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, path: file, size: buf.length }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }
    // 打開照片所在的資料夾（並選取剛存的那張）。只開 photoDir 底下的檔，別的路徑一律不理
    if (req.method === 'POST' && req.url === '/photoOpen') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
            let ok = false;
            try {
                const f = path.resolve(String(JSON.parse(body).path || ''));
                const dir = path.resolve(photoDir());
                if (f.startsWith(dir + path.sep) && fs.existsSync(f)) {
                    if (process.platform === 'win32') spawn('explorer.exe', ['/select,', f], { detached: true, stdio: 'ignore' }).unref();
                    else if (process.platform === 'darwin') spawn('open', ['-R', f], { detached: true, stdio: 'ignore' }).unref();
                    else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
                    ok = true;
                }
            } catch (e) { console.log('   ⚠️ 開不了照片資料夾：' + e.message); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok }));
        });
        return;
    }
    // 舞台底圖：使用者自己放的圖（scripts/make-bg.js 產出）。沒放就 404，CSS 退回純色。
    // 刻意不內嵌進 js、也不隨 release 出貨 —— 底圖是個人化的東西，每個人的照片不一樣，
    // 塞進 repo 只會讓 daemon.js 或 release 無謂變肥。
    if (req.url === '/stairs/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
        res.write('event: hello\ndata: {}\n\n');
        stairsStreams.add(res);
        req.on('close', () => stairsStreams.delete(res));
        return;
    }
    if (req.url.startsWith('/stairs/sprites?')) {
        const chars = (new URL(req.url, 'http://x').searchParams.get('c') || '').split(',').slice(0, 8);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(stairsSprites(chars)));
        return;
    }
    if (req.url === '/bg' || req.url.startsWith('/bg?')) {
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
            // ?fest=halloween → 預覽節日（同 ?w=，只影響這次請求）
            const festQ = new URL(req.url, 'http://x').searchParams.get('fest');
            const fest  = festNow(Date.now(), festQ);
            const festOpt = readFest();
            // 圍爐跟著「顯示節慶造型」：關掉就變回平常散步
            const feast = festOpt.costume && festFeast(fest, Date.now(), festQ);
            const alive = new Set((ranch.pets || []).map(p => p.id));
            const yq    = new URL(req.url, 'http://x').searchParams;
            // 營地第二頁：打完的 Armagemon 戰鬥先結算（關掉分頁、中途切走也照結果處理）
            page2Settle(ranch, step);
            const ev    = page2Event(ranch, step);
            // 分頁：事件進行中只有一頁（對峙畫面）；圍爐大家坐同一桌也不分頁。
            // 兩頁 = 兩頁寬的場地大家一起走（跨頁走動），page 只決定鏡頭看哪一半。
            const solo  = !!(ev && ev.standoff);
            // ?photo=<seed>：拍照。大家集合到一頁排好、隨機擺姿勢（圍爐照座位拍）。事件進行中不拍
            const photoQ = yq.get('photo');
            const photo = photoQ != null && !ev && (ranch.pets || []).length ? (Number(photoQ) >>> 0) : null;
            const wide  = !solo && photo == null && plaza.yardWide(ranch, { feast });
            const pages = wide ? 2 : 1;
            const page  = Math.max(0, Math.min(pages - 1, Number(yq.get('pg')) || 0));
            const G     = wide ? plaza.YARD_GEOM_WIDE : plaza.YARD_GEOM;
            const px0   = wide ? plaza.yardPageX(page) : 0;   // 這一頁在兩頁寬畫布上的左緣
            const pr    = ranch;
            // ?drop=<id>：Keramon 空降登場時前端自己畫那隻往下掉，伺服器先別畫牠（當成拿在手上）
            const dropId = yq.get('drop');
            let react = yardReactMap(alive);
            if (dropId) { react = new Map(react); react.set(dropId, { ...(react.get(dropId) || {}), held: true }); }
            // 打贏還沒演完（結果還在）：Keramon 已經進營地名單，但還不能露面 —— 前端會帶 ?drop=，
            // 這裡再保險一次（結果剛出來那一次輪詢前端還沒來得及帶），免得第一頁先閃一下
            if (ev && ev.stage === 'result' && ev.keramonId) {
                react = new Map(react); react.set(ev.keramonId, { ...(react.get(ev.keramonId) || {}), held: true });
            }
            const sto   = ev && ev.standoff ? plaza.composeYardStandoff(core, ranch.pets || [], core.PAGE2_FINAL, step,
                                                                         { enemyDx: ev.enemyDx || 0 }) : null;
            const out   = sto ? null : photo != null ? plaza.composeYardPhoto(core, pr, st, step,
                                            { seed: photo, feast, caches: new Map(),
                                              acc: fest && festOpt.costume ? fest.acc : null,
                                              swap: fest && festOpt.costume ? fest.swap || null : null,
                                              swapSalt: yq.get('ds') || null })
                                        : plaza.composeYard(core, pr, st, step,
                                            { caches: yardCaches, react, wide, page,
                                              layout: zoneLayout,
                                              acc: fest && festOpt.costume ? fest.acc : null,
                                              swap: fest && festOpt.costume ? fest.swap || null : null,
                                              swapSalt: new URL(req.url, 'http://x').searchParams.get('ds') || null,
                                              feast });
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
                         winPct: b ? Math.floor(w / b * 100) : null,
                         // 獲得於 = 這一隻變成現在這個角色的時間（跟著這一隻走，交換／收進營地都不變）。
                         // 原本顯示的「收於」是收進營地的時間，每次交換都重設，被當成獲得時間誤會（2026-10-21）
                         gotAt: st.lastEvolveAt || st.birthAt || null,
                         // 在營地裡自己變掉的（大便獸彩蛋）：右鍵選單要顯示原本是誰
                         wasName: p.evolvedFrom ? core.getDisplayName(p.evolvedFrom) : null };
            };
            // 分區資訊：dev 的「走動範圍」開關要把框與定位點畫出來。
            // 一律回傳（不看 release）—— 它只是幾個數字，藏起來反而讓前端要多一條分支。
            // ⚠️ 一定要用 yardZonesFor（含編輯器存的覆寫檔），不是 plaza.yardZones（只有內建表）。
            //    合成走的是前者、payload 走後者的話，角色照新切法走、框卻畫舊的，
            //    看起來就像「存了沒生效」。踩過一次 —— 兩個來源就是會漂移。
            const zoneInfo = plaza.yardLayoutsFor(core, (pr.pets || []).length);
            // 前端活在「細格」裡（營地畫小一號，見 plaza.js 的 YARD_RENDER）：
            // 尺寸、每隻的位置、範圍框一律換算成畫出來的座標再送。
            // 跨頁時一律換成**這一頁**的座標（減掉 px0）；另一頁的框落在畫布外，前端自然畫不到
            const D = (x, y) => { const d = G.toDraw(x, y); return { x: d.x - px0, y: d.y }; }, R = plaza.YARD_RENDER;
            const zones = sto || photo != null ? [] : plaza.yardZonesFor(core, (pr.pets || []).length, zoneLayout, G).map(z => {
                const lo = D(z.minX, z.minY), hi = D(z.maxX, z.maxY), an = plaza.zoneAnchor(z), a = D(an.x, an.y);
                return { minX: lo.x, maxX: hi.x, minY: lo.y, maxY: hi.y, anchor: { x: a.x, y: a.y } };
            });
            let drop = null;
            if (dropId && !solo) {
                const sp = plaza.yardSpriteFor(core, pr, dropId, step, { layout: zoneLayout, geom: G });
                if (sp) { const at = D(sp.x, sp.y); drop = { id: dropId, frames: sp.frames, x: at.x, y: at.y }; }
            }
            // Keramon 空降：鏡頭要帶到牠**現在走到的**那一頁（跨頁後誰在哪一頁不是固定的）
            let keramonPage = null;
            if (ev && ev.keramonId) {
                keramonPage = 0;
                if (wide) {
                    const sp = plaza.yardSpriteFor(core, pr, ev.keramonId, step, { layout: zoneLayout, geom: G });
                    if (sp) keramonPage = plaza.yardPageAt(G.toDraw(sp.x, sp.y).x);
                }
            }
            body = { ok: true, step, cols: R.w, rows: R.h / 2, sprite: plaza.SPRITE, zones,
                     feast: sto ? null : feast,
                     inPlaza: plazaClient.active(),   // 別的分頁進了廣場 → 這個分頁也要跟進去
                     weather: { ...wx, ...WX.describe(wx) },
                     // 事件的對峙強制非節慶背景（規格：連春節圍爐也蓋過去）
                     festival: sto ? null : festView(fest), festCostume: festOpt.costume,
                     cap: core.ranchCap(ranch),
                     page, pages, drop,
                     // 拍照：前線那隻（前端從左邊斜 45 度探頭畫上去）。開心幀、面向右，穿上節日配件
                     photo: photo != null ? { seed: photo, peek: { x: plaza.PHOTO_PEEK.x, y: plaza.PHOTO_PEEK.y },
                                              front: photoFront(st, fest && festOpt.costume ? fest.acc : null) } : null,
                     event: ev ? { stage: ev.stage, win: ev.win, gaveUp: ev.gaveUp, keramonId: ev.keramonId, exiting: !!ev.exiting,
                                   battle: ev.battle || null, fighter: ev.fighter || null,
                                   keramonPage } : null,
                     // dev 下拉要知道這個隻數有哪些切法可挑、現在是哪一個
                     layout: zoneLayout || zoneInfo.def,
                     layouts: zoneInfo.names,
                     kept: (ranch.pets || []).length,
                     lines: sto ? sto.lines : out ? out.lines : null, layer: out ? out.layer : null,
                     enemy: sto ? sto.enemy : null,
                     // y 回傳**畫出來**的位置（含跳躍位移），不是地面的 y ——
                     // 前端拿這個做命中判定，用地面 y 的話跳到最高點時點身體會落空。
                     pets: sto ? sto.pets.map(p => ({ ...p, name: core.getDisplayName(p.char), ...info(p.id) }))
                         // 跨頁：只交出這一頁看得到的（有任何一塊身體在畫面裡就算，走到交界的兩頁都點得到）
                         : out ? out.placed.filter(p => p.dx + (p.size || plaza.SPRITE) > 0 && p.dx < R.w).map(p => ({
                         id: p.ranchId, name: p.name, char: p.char, zoneIdx: p.zoneIdx,
                         x: p.dx, y: p.dy, size: p.size || plaza.SPRITE, ...info(p.ranchId),
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
    if (req.url === '/plaza' || req.url.startsWith('/plaza?')) {
        let body;
        try {
            if (!plazaClient.active()) {
                body = { ok: true, active: false, notice: plazaNotice };
            } else {
                const me = plazaClient.me();
                const list = plazaClient.roster();
                // 節日用伺服器時間判斷：大家同一刻換裝、同一刻掛上背景。
                // ?fest=<id> = dev 預覽（只影響這個畫面，別人看到的不變；release 的 festNow 不吃）
                const festQ = new URL(req.url, 'http://x').searchParams.get('fest');
                const fest = festNow(Date.now() + plazaClient.skew(), festQ);
                // 開心鈕：照營地摸摸的演法（yard-touch 的 REACT_MS / JUMP_MS / JUMP_H），
                // 用伺服器時間算相位 → 大家看到同一下跳。走路不停（走法是大家共用的公式，
                // 一個人停下來要改伺服器的走法，跳一下不值得）。
                const nowS = Date.now() + plazaClient.skew();
                const happy = (m) => {
                    const el = m.emoteAt ? nowS - m.emoteAt : -1;
                    if (el < 0 || el >= YT.REACT_MS) return null;
                    const ph = Math.floor(el / YT.JUMP_MS);
                    return { react: 'HAPPY', jump: ph < YT.JUMP_HOPS * 2 && ph % 2 === 0 ? YT.JUMP_H : 0 };
                };
                // 偷看盤：躲起來的人不畫（名牌、對話泡泡、點擊判定都跟著沒有）
                const occ = list.filter(m => !m.hidden).map(m => ({
                    key: 'p:' + m.id, code: m.name, color: m.color || null, char: m.char, walk: m.walk,
                    battle: !!m.battle,
                    react: m.battle ? 'BATTLE' : undefined,   // 對戰中：IDLE_1 ↔ ANGRY 循環（開心鈕演出照樣蓋過去）
                    // 本人決定給不給看；我自己關掉「顯示節慶造型」→ 我看到的大家都不過節（跟營地一樣）
                    acc: fest && m.costume !== false && me.costume !== false ? fest.acc : null,
                    swap: fest && m.costume !== false && me.costume !== false ? fest.swap || null : null,
                    ...(happy(m) || {}),
                    // 彩蛋：跑車（聊天打 how do you turn this on）—— 開了幾毫秒，合成時照跑道畫
                    carT: m.carAt && nowS - m.carAt >= 0 && nowS - m.carAt < plaza.CAR_MS ? nowS - m.carAt : undefined,
                }));
                const step = plazaClient.step();
                // 場地與畫法比照營地（69x54 細格、角色 16 細格），原住民先不放。
                // 手動模式用毫秒算位置（每秒 4 格），要給校正過的伺服器時間
                // 圍爐是這台自己畫的場景 → 看本人的「顯示節慶造型」：關掉就看到大家散步
                const feast = me.costume !== false && festFeast(fest, nowS, festQ);
                const out = plaza.composePlazaLive(core, occ, step,
                    { caches: plazaCaches, me: me.name, nowMs: Date.now() + plazaClient.skew(), feast });
                const mine = list.find(m => m.id === me.id);
                body = { ok: true, active: true, step, me: me.name, notice: plazaNotice,
                         mode: mine && mine.mode === 'manual' ? 'manual' : 'auto', feast,
                         // 偷看盤：我躲起來了沒、最近一筆報價（盤中伺服器每 30 秒推）
                         hidden: !!(mine && mine.hidden), stock: plazaClient.stock(),
                         // 對戰邀請：別人邀我（要回覆）／我邀別人（等回覆）
                         invite: (() => {
                             const inc = plazaClient.incoming(), out = plazaClient.outgoing();
                             const left = (e) => Math.max(0, Math.round((e - (Date.now() + plazaClient.skew())) / 1000));
                             if (inc) return { kind: 'in', inviteId: inc.inviteId, name: inc.fromName, secs: left(inc.expiresAt), duel: inc.kind === 'duel' };
                             if (out) return { kind: 'out', name: out.toName, secs: left(out.expiresAt), duel: out.kind === 'duel' };
                             return null;
                         })(),
                         // 我的對戰演出（前線的戰鬥畫面，頁面疊在廣場上）
                         battle: plazaBattle && latest.kind === 'battle' ? plazaBattleView(list, me) : null,
                         cols: plaza.PLAZA_RENDER.w, rows: plaza.PLAZA_RENDER.h / 2,
                         myColor: me.color || null, myChar: me.char || null,
                         festival: festView(fest), festCostume: me.costume !== false,
                         // 天氣比照營地：用這台 daemon 抓到的（內網大家在同一個城市，各抓各的一樣）
                         weather: (() => { const w = weatherFor(null); return { ...w, ...WX.describe(w) }; })(),
                         names: list.map(m => m.name), lines: out.lines, layer: out.layer, tags: out.tags,
                         // owner 一列一個字串：'.' = 沒人，其餘 = '0' + z（20 人以內不會超出可見字元）
                         owner: out.owner.map(r => r.map(z => (z < 0 ? '.' : String.fromCharCode(48 + z))).join('')),
                         // 聊天：最近 50 則；serverNow 給前端判斷對話泡泡還要不要顯示（5 秒）
                         chat: plazaClient.chat(), serverNow: Date.now() + plazaClient.skew(),
                         // 下樓梯：廣場上的房間、我在的那一房、我那房最近一局的結果
                         stairs: { rooms: plazaClient.stairsRooms(), mine: plazaClient.stairsMine(),
                                   end: plazaClient.stairsEnd(), meId: me.id },
                         // 管理列（dev）的踢人下拉：release 不給
                         members: IS_RELEASE ? undefined : list.filter(m => m.id !== me.id).map(m => ({ id: m.id, name: m.name })) };
            }
        } catch (e) {
            body = { ok: false, error: e.message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
        return;
    }
    // 版本與更新狀態：每個畫面（前線／營地／廣場）都要看得到「有新版本」，所以獨立一支
    if (req.url === '/update') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ version: MY_VERSION, pid: process.pid, supervised: !!process.env.VPET_CHILD,
                                 available: process.env.VPET_CHILD ? updateAvail : null, last: lastUpdateResult() }));
        return;
    }
    if (req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(Object.assign({}, latest, { uptimeSec: (Date.now() - startedAt) / 1000,
            plaza: { active: plazaClient.active(), notice: plazaNotice }, bgV: bgVersion() })));
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
