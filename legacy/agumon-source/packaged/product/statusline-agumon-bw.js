#!/usr/bin/env node
// 黑白版（v4）：v1 風格狀態列 + 亞古獸（右側）
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { ANCHOR_GAP, loadState, saveState, decideAgumon, buildStatusLines, composeOutput, visLen } = require('./agumon-core');

const ART_FILE   = path.join(os.homedir(), '.claude', 'agumon-assets', 'agumon_art.json');
const STATE_FILE = path.join(os.homedir(), '.claude', 'agumon-state.json');

const F = { NORMAL:0, STEP:1, HAPPY:2, ANGRY:3, ROAR:4, GLARE:5, TALK:6, SURPRISE:7, SLEEP:8 };

const CHAR_DEF = {
  F,
  sleepFrames: [F.SLEEP],
  ROAR_FRAMES: [F.ANGRY, F.ROAR, F.ROAR],
  EXPRS: [
    { frames: [F.HAPPY,    F.HAPPY,    F.NORMAL] },
    { frames: [F.TALK,     F.NORMAL,   F.TALK  ] },
    { frames: [F.GLARE,    F.GLARE,    F.NORMAL] },
    { frames: [F.SURPRISE, F.SURPRISE, F.NORMAL] },
  ],
};

// ── Braille / Quadrant / Sextant 水平翻轉 ───────────────────────
const QUADRANT_FLIP_IDX = [0, 2, 1, 3, 8, 10, 9, 11, 4, 6, 5, 7, 12, 14, 13, 15];
const QUADRANT_CHARS = [
  '⠀','▘','▝','▀','▖','▌','▞','▛',
  '▗','▚','▐','▜','▄','▙','▟','█',
];
const QUADRANT_REV_MAP = new Map(QUADRANT_CHARS.map((c, i) => [c, i]));

function sextantCharToValue(cp) {
  if (cp === 0x2800) return 0;
  if (cp === 0x258C) return 21;
  if (cp === 0x2590) return 42;
  if (cp === 0x2588) return 63;
  if (cp >= 0x1FB00 && cp <= 0x1FB3B) {
    let v = cp - 0x1FB00 + 1;
    if (v >= 21) v++;
    if (v >= 42) v++;
    return v;
  }
  return null;
}
function sextantValueToChar(v) {
  if (v === 0)  return '⠀';
  if (v === 21) return '▌';
  if (v === 42) return '▐';
  if (v === 63) return '█';
  let idx = v - 1;
  if (v > 21) idx--;
  if (v > 42) idx--;
  return String.fromCodePoint(0x1FB00 + idx);
}
function flipSextantValue(v) {
  let f = 0;
  if (v & 1)  f |= 2;  if (v & 2)  f |= 1;
  if (v & 4)  f |= 8;  if (v & 8)  f |= 4;
  if (v & 16) f |= 32; if (v & 32) f |= 16;
  return f;
}
function flipChar(c) {
  const cp = c.codePointAt(0);
  if (cp >= 0x2800 && cp <= 0x28FF) {
    const v = cp - 0x2800;
    let f = 0;
    if (v & 1)   f |= 8;   if (v & 8)   f |= 1;
    if (v & 2)   f |= 16;  if (v & 16)  f |= 2;
    if (v & 4)   f |= 32;  if (v & 32)  f |= 4;
    if (v & 64)  f |= 128; if (v & 128) f |= 64;
    return String.fromCharCode(0x2800 + f);
  }
  if (cp >= 0x1FB00 && cp <= 0x1FB3B) return sextantValueToChar(flipSextantValue(sextantCharToValue(cp)));
  if (QUADRANT_REV_MAP.has(c)) return QUADRANT_CHARS[QUADRANT_FLIP_IDX[QUADRANT_REV_MAP.get(c)]];
  return c;
}
const flipLines = lines => lines.map(l => [...l].reverse().map(flipChar).join(''));
const toLines   = str  => { const ls = str.split('\n'); while (ls.length && ls[ls.length-1].trim() === '') ls.pop(); return ls; };

// ── 主程式 ───────────────────────────────────────────────────────
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i   = JSON.parse(d);
    const st  = loadState(STATE_FILE);
    const now = Date.now();

    const { frameIdx, facing, pos } = decideAgumon(i, st, now, CHAR_DEF);
    saveState(STATE_FILE, st);

    const statusLines = buildStatusLines(i);

    let agumonLines = null;
    try {
      const { frames } = JSON.parse(fs.readFileSync(ART_FILE, 'utf8'));
      const raw = toLines(frames[frameIdx] || frames[0]);
      agumonLines = facing === 'right' ? flipLines(raw) : raw;
    } catch(e) {}

    if (!agumonLines) {
      process.stdout.write(statusLines.join('\n'));
      return;
    }

    const aguCol = Math.max(...statusLines.map(visLen)) + ANCHOR_GAP + pos;
    process.stdout.write(composeOutput(statusLines, agumonLines, aguCol));
  } catch(e) {
    process.stdout.write('statusline-agumon-bw: ' + e.message);
  }
});
