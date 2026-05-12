const fs = require('fs');

// ── 幀定義 ──────────────────────────────────────────────────
const F = {
    NORMAL: 0, STEP: 1, HAPPY: 2, ANGRY: 3, ROAR: 4,
    GLARE: 5, TALK: 6, SURPRISE: 7, SLEEP: 8, SAD1: 9, SAD2: 10,
};

// ── 走路中可觸發的表演序列 ──────────────────────────────────
// frames: 幀索引陣列, interval: 每幀毫秒, weight: 抽到的相對機率
const PERFORMANCES = [
    { name: '高興',  frames: [F.HAPPY,    F.NORMAL, F.HAPPY,  F.NORMAL],        interval: 350, weight: 3 },
    { name: '憤怒',  frames: [F.ANGRY,    F.ROAR,   F.ANGRY,  F.NORMAL],        interval: 500, weight: 1 },
    { name: '瞪眼',  frames: [F.GLARE,    F.GLARE,  F.NORMAL],                  interval: 450, weight: 2 },
    { name: '說話',  frames: [F.TALK,     F.NORMAL, F.TALK,   F.NORMAL, F.TALK], interval: 280, weight: 3 },
    { name: '驚訝',  frames: [F.SURPRISE, F.NORMAL, F.SURPRISE],                interval: 350, weight: 1 },
];

// ── 走路參數 ────────────────────────────────────────────────
const WALK_INTERVAL   = 500;   // 走路幀率 ms
const IDLE_INTERVAL   = 800;   // 睡覺幀率 ms
const EXPRESS_CHANCE  = 0.15;  // 每步觸發表演機率
const STEPS_TO_IDLE   = 30;    // 走幾步後進入睡覺
const IDLE_SLEEP_TICKS = 8;    // 睡幾次後醒來
const MAX_POS         = 24;    // 水平最大偏移字元數

// ── 點字水平翻轉 ─────────────────────────────────────────────
function flipBrailleChar(char) {
    const cp = char.codePointAt(0);
    if (cp < 0x2800 || cp > 0x28FF) return char;
    const c = cp - 0x2800;
    let f = 0;
    if (c & (1 << 0)) f |= (1 << 3);
    if (c & (1 << 3)) f |= (1 << 0);
    if (c & (1 << 1)) f |= (1 << 4);
    if (c & (1 << 4)) f |= (1 << 1);
    if (c & (1 << 2)) f |= (1 << 5);
    if (c & (1 << 5)) f |= (1 << 2);
    if (c & (1 << 6)) f |= (1 << 7);
    if (c & (1 << 7)) f |= (1 << 6);
    return String.fromCharCode(0x2800 + f);
}

function flipLines(lines) {
    return lines.map(line => [...line].reverse().map(flipBrailleChar).join(''));
}

function toLines(str) {
    const lines = str.split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines;
}

function render(logUpdate, artFrames, frameIdx, pos, facing) {
    const lines = facing === 'right' ? flipLines(artFrames[frameIdx]) : artFrames[frameIdx];
    const pad = ' '.repeat(Math.max(0, pos));
    logUpdate(lines.map(l => pad + l).join('\n'));
}

// ── 主程式 ───────────────────────────────────────────────────
async function start() {
    const { default: logUpdate } = await import('log-update');

    if (!fs.existsSync('agumon_art.json')) {
        console.error('找不到 agumon_art.json，請先執行 node prepare_frames.js && node convert_to_braille.js');
        return;
    }

    const { frames: rawFrames } = JSON.parse(fs.readFileSync('agumon_art.json', 'utf8'));
    const artFrames = rawFrames.map(toLines);

    // 建立加權表演抽籤池
    const perfPool = [];
    PERFORMANCES.forEach((p, i) => {
        for (let w = 0; w < p.weight; w++) perfPool.push(i);
    });

    // ── 狀態 ──
    let state       = 'walking'; // 'walking' | 'expressing' | 'idle'
    let walkStep    = 0;         // 0=NORMAL, 1=STEP
    let pos         = 0;
    let direction   = 1;         // 1=右, -1=左
    let facing      = 'right';
    let stepCounter = 0;         // 計步（決定何時進入睡覺）
    let idleTicks   = 0;
    let timer       = null;

    function schedule(ms) {
        clearTimeout(timer);
        timer = setTimeout(tick, ms);
    }

    function tick() {
        if (state === 'walking') {
            // 顯示走路幀
            render(logUpdate, artFrames, walkStep === 0 ? F.NORMAL : F.STEP, pos, facing);
            walkStep = 1 - walkStep;

            // 移動位置
            pos += direction;
            if (pos >= MAX_POS) { pos = MAX_POS; direction = -1; facing = 'left'; }
            else if (pos <= 0)  { pos = 0;       direction =  1; facing = 'right'; }

            stepCounter++;

            // 進入睡覺
            if (stepCounter >= STEPS_TO_IDLE) {
                stepCounter = 0;
                state = 'idle';
                idleTicks = 0;
                schedule(IDLE_INTERVAL);
                return;
            }

            // 隨機觸發表演
            if (Math.random() < EXPRESS_CHANCE) {
                const perf = PERFORMANCES[perfPool[Math.floor(Math.random() * perfPool.length)]];
                stepCounter = 0;
                state = 'expressing';
                playPerf(perf, facing, 0);
                return;
            }

            schedule(WALK_INTERVAL);

        } else if (state === 'idle') {
            render(logUpdate, artFrames, F.SLEEP, pos, 'left');
            idleTicks++;

            if (idleTicks >= IDLE_SLEEP_TICKS) {
                // 醒來，繼續走
                state = 'walking';
                stepCounter = 0;
                schedule(WALK_INTERVAL);
            } else {
                schedule(IDLE_INTERVAL);
            }
        }
    }

    // 播放表演序列（遞迴）
    function playPerf(perf, currentFacing, step) {
        if (step >= perf.frames.length) {
            state = 'walking';
            schedule(WALK_INTERVAL);
            return;
        }
        render(logUpdate, artFrames, perf.frames[step], pos, currentFacing);
        setTimeout(() => playPerf(perf, currentFacing, step + 1), perf.interval);
    }

    tick();
}

start().catch(err => console.error(err));
