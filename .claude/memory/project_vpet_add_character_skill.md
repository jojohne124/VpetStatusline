---
name: project-vpet-add-character-skill
description: vpet 加角色流程已工具化：add-character.js + vpet-add-character skill
metadata:
  type: project
---

2026-08-21 建立。agumon-cli 加新角色的流程從「每次重想」變成工具：

- `scripts/add-character.js` — 偵測邏輯網格／版面／CutIn／**重複幀**，產 config
  （power → stage 用 evo-rules 推導並回報），轉檔，**逐點比對 art.json 與原圖**，部署。
  `--check` 只偵測不寫。刻意不決定 power／實裝／進化鏈。
- `scripts/test-add-character.js` — 用合成 PNG 釘住偵測與完整流程（暫時建在
  `characters/__TestCharNNN/`，跑完刪除，一律 `--no-deploy`）。
- `~/.claude/skills/vpet-add-character/SKILL.md` — 何時用、要問使用者什麼、專案特有的坑。
- `npm run add-char` 是捷徑；`npm test` 已含新測試。

⚠️ 同批順手補的防呆：`scripts/gen-new-char-scaffold.js` 現在要 `--yes`。
它是一次性腳本，會無條件覆寫 63 隻的 config.json 連同 `evolvesTo` ——
只是想看它在做什麼而順手跑起來，就洗掉 996 行（靠 git 救回）。

相關：[[feedback-char-source-16x16]]、[[feedback-agumon-authoritative]]
