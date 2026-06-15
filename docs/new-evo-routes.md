# 新進化分歧 + 新 starter 路線對照表

> 來源：使用者 2026-06-11 設計，2026-06-15 調整（見下方「2026-06-15 調整摘要」）。win% 依 [`evo-winrate-default.md`](agent-memory/evo-winrate-default.md) 公式（目標 power 決定門檻）+ 本文件補的 **tie-break 規則**。
> 套用腳本：[`scripts/apply-new-routes.js`](../scripts/apply-new-routes.js)（純資料，預設 dry-run，`--write` 才寫檔，**不部署**）。
> 驗證：所有分歧點 win% 嚴格遞增 → 死路風險 0；既有主線門檻 0 改動。
> ⚠️ **本文件僅為設計記錄；2026-06-15 的調整尚未同步進 `apply-new-routes.js`（未實裝）。**

## 2026-06-15 調整摘要（僅記錄、未實裝）

1. **獅子線完全体 shishimamon → `loaderleomon`(115)〔NEW〕**：`leomon` / `garurumon`(交叉) / `symbareangoramon`(高階兔下位) 三個入口全改指 `loaderleomon`。⇒ `shishimamon` 變孤立（無 parent 無 child），實裝時一併退役/移除。
2. **海豚線終點 plesiomon → `leviamon`(170)〔NEW〕**；`plesiomon`(165) 改掛為 `zudomon` 的上位旁支（與既有 `vikemon`(160) 並列）。
3. **新增 7 條 Perfect→Ultimate 旁支**（掛在既有完全体上的第二條究極体分支）：megakabuterimon→ancientbeetmon、zudomon→plesiomon、garudamon→gryphonmon、lillymon→rafflesimon、magnaangemon→goddramon、angewomon→ophanimon、sekkamon→sakuyamon。各與其既有究極体 gate 差 5%（目標 power 差 5），照 `evo-winrate-default.md` 公式即相異、弱邊可達，**不需** tie-break。
4. **拼字定案**：`ancientbeetmon`（Beet 非 Beat）、`ophanimon`（非 Ofanimon）、`loaderleomon`（原暫定 Liomon，改回 Leomon 與家族 leomon 一致）。

## 機制與 tie-break（重要）

`checkEvolution` 在「多條分歧同時達標」時取**進化目標 power 強者**。要做到「勝率不佳走較弱分支」，就靠**強分支掛較高 win%、弱分支較低**：勝率高→兩條都達標→取強；勝率中等→只有弱條達標→走弱。

`evo-winrate-default.md` 公式有個盲區：**相鄰 power（差 5）的兄弟分支取整後會撞同一個 win%**，導致 power-sort 永遠選強的、弱的變死路（直接套會出 16 處，其中 5 處殺掉原始主線）。補規則：

> **同分歧點兩條打平時：保留既有/主線那條的 win%，把新分支挪 5%**（新分支較弱→降 5；較強→升 5）。兩條皆新邊時，弱的留公式值、強的升 5。日夜分歧（gatomon）以 `time_of_day` 互斥，不需遞增。

## 改寫既有 starter 的新分歧

每行 `角色(power)`；箭頭上 `win%` 為進化門檻；`[既有]` = 原本就有的主線（門檻不動）。

| 家族 | 路線 |
|---|---|
| 亞古獸（2010 線，前弱後持平） | agumon(20) —45%→ greymon_2010(65) —55%→ metalgreymon_2010(115) —65%→ zekegreymon(170) |
| └ 主線[既有] | agumon —50%→ greymon(70) —65%→ metalgreymon(120) —…→ wargreymon |
| └ 交叉 | greymon —55%→ metalgreymon_2010 |
| 加布獸（獅子下位線） | gabumon(20) —45%→ leomon(65) —55%→ **loaderleomon(115)〔NEW〕** —65%→ saberleomon(165) |
| └ 主線[既有] | gabumon —50%→ garurumon(70) —60%→ weregarurumon(120) |
| └ 交叉 | garurumon —55%→ loaderleomon |
| 甲蟲（鍬形蟲，前弱後持平） | tentomon(15) —50%→ kuwagamon(60) —55%→ okuwamon(110) —65%→ grankuwagamon(165) |
| └ 主線[既有] | tentomon —55%→ kabuterimon(65) —60%→ megakabuterimon(115) |
| └ 交叉 | kabuterimon —55%→ okuwamon |
| 海獸（海豚上位線） | gomamon(10) —55%→ dolphmon(65) —55%→ whamon(115) —70%→ **leviamon(170)〔NEW〕** |
| └ 主線[既有] | gomamon —50%→ ikkakumon(60) —55%→ zudomon(110) |
| └ 交叉 | ikkakumon —60%→ whamon |
| 鳥（喜鵲上位線） | biyomon(15) —60%→ xiquemon(70) —60%→ crowmon(120) —65%→ tengumon(170) |
| └ 主線[既有] | biyomon —55%→ birdramon(65) —60%→ garudamon(115) |
| └ 交叉 | birdramon —65%→ crowmon |
| 植物（木偶上位線） | palmon(10) —55%→ woodmon(65) —55%→ cherrymon(115) —65%→ puppetmon(165) |
| └ 主線[既有] | palmon —50%→ togemon(60) —55%→ lillymon(110) |
| └ 花妖線（上位） | togemon —60%→ blossomon(115) —65%→ hydramon(170)　※ togemon→cherrymon 已依指示刪除 |
| 天使（兔，前弱後強） | patamon(10) —50%→ turuiemon(60) —60%→ antylamon(115) —65%→ dijiangmon(170) |
| └ 主線[既有] | patamon —65%→ angemon(80) —…→ dominimon |
| 聖獸（日夜分歧，持平） | gatomon(55) —70%/**日**→ angewomon(130)［既有，補 day gate］ |
| └ 夜線 | gatomon —65%/**夜**→ ladydevimon(130) —65%→ lilithmon(175) |
| 狐（武者下位線） | renamon(15) —45%→ musyamon(60) —55%→ oboromon(110) —60%→ zanbamon(160) |
| └ 主線[既有] | renamon —50%→ tenkomon(65) —…→ yukinamon |
| 哥吉拉（前弱後持平） | godzillasaurus(80) —55%→ godzilla_jr(125) —70%→ godzilla_1994(180) |
| └ 主線[既有] | godzillasaurus —60%→ godzilla_1954(130) —70%→ godzilla_1999(180) |
| 上位旁支 | metalgreymon —70%→ blitzgreymon(173)（+ —65%→ wargreymon 既有） |
| 上位旁支 | weregarurumon —70%→ cresgarurumon(173)（+ —65%→ metalgarurumon 既有） |
| 上位旁支〔NEW〕 | megakabuterimon —70%→ **ancientbeetmon(170)**（+ —65%→ herculeskabuterimon(165) 既有） |
| 上位旁支〔NEW〕 | zudomon —65%→ **plesiomon(165)**（+ —60%→ vikemon(160) 既有）※plesiomon 由海豚線改掛此處 |
| 下位旁支〔NEW〕 | garudamon —60%→ **gryphonmon(160)**（+ —65%→ phoenixmon(165) 既有） |
| 上位旁支〔NEW〕 | lillymon —65%→ **rafflesimon(165)**（+ —60%→ rosemon(160) 既有） |
| 下位旁支〔NEW〕 | magnaangemon —70%→ **goddramon(170)**（+ —75%→ dominimon(175) 既有） |
| 下位旁支〔NEW〕 | angewomon —70%→ **ophanimon(170)**（+ —75%→ magnadramon(175) 既有） |
| 下位旁支〔NEW〕 | sekkamon —65%→ **sakuyamon(165)**（+ —70%→ yukinamon(170) 既有） |
| 鬼族（南瓜上位線） | bakemon —60%→ pumpkinmon(120) —70%→ noblepumpkinmon(175)（+ —55%→ phantomon 既有） |

## 新 starter

| 線 | 路線 |
|---|---|
| 貝海獸 — 螺線 | syakomon(15) —50%→ shellmon(62) —60%→ marinbullmon(120) —65%→ ryugumon(170) ／ —60%→ ariemon(165) |
| 貝海獸 — 海龍線 | syakomon —45%→ seadramon(58) —60%→ megaseadramon(115) —65%→ shagaramon(165) ／ —60%→ metalseadramon(160) |
| 高階 — 突擊獸 | commandramon(25) —55%→ hi-commandramon(75) —60%→ cargodramon(125) —65%→ brigadramon(175) |
| └ 下位掉共通 | commandramon —50%→ greymon(70)；hi-commandramon —55%→ metalgreymon(120) |
| 高階 — 狼獸 | loogamon(25) —55%→ loogarmon(75) —60%→ soloogarmon(125) —65%→ fenriloogamon(175) |
| └ 下位掉共通 | loogamon —50%→ garurumon(70)；loogarmon —55%→ weregarurumon(120) |
| 高階 — 翼龍 | pteromon(25) —55%→ galemon(75) —60%→ grandgalemon(125) —65%→ zephagamon(175) |
| └ 下位掉共通 | pteromon —50%→ birdramon(65)；galemon —55%→ garudamon(115) |
| 高階 — 兔獸 | angoramon(25) —55%→ symbareangoramon(75) —60%→ lamortmon(125) —65%→ diarbbitmon(175) |
| └ 下位掉共通 | angoramon —50%→ leomon(65)；symbareangoramon —55%→ loaderleomon(115) |
| 高階 — 水母 | jellymon(25) —55%→ teslajellymon(75) —60%→ thetismon(125) —65%→ amphimon(175) |
| └ 下位掉共通 | jellymon —50%→ shellmon(62)；teslajellymon —55%→ marinbullmon(120) |

> 「下位」設計：勝率不夠走自家上位線時，掉進既有共通線（power 較低、門檻較低）。`marinbullmon` / `shellmon` / `weregarurumon` 等成為多家族匯流點（多 parent，引擎支援）。

## ⚠️ 子彈（bullet-art）完成度

接線後上場會用到子彈。目前 source 裡 **真子彈只有 6 條線**，其餘為共用 placeholder（hash `dac6881e`，1258B）：

- ✅ 已完成：**Agumon-2010 線**、**Leomon 線**、**BlitzGreymon**、**CresGarurumon**、**Commandramon 線**、**Loogamon 線**
- ❌ 暫代待補：Kuwagamon / Dolphmon / Xiquemon / Woodmon / Turuiemon / LadyDevimon / Musyamon / Godzilla_Jr / Blossomon / Pumpkinmon / **Syakomon 整組（含 Seadramon 雙線）** / Pteromon / Angoramon / Jellymon 各線
- 🆕 **2026-06-15 新增、連 source config 都還沒有**（實裝前需先建角色 config + 美術 + 子彈）：`loaderleomon`、`leviamon`、`ancientbeetmon`、`gryphonmon`、`rafflesimon`、`goddramon`、`ophanimon`、`sakuyamon`

## 套用方式

```bash
node scripts/apply-new-routes.js            # dry-run，只印計畫
node scripts/apply-new-routes.js --write     # 寫入 source config + roster
node scripts/apply-new-routes.js --write --no-roster   # 只改 config，不動 roster
# 部署到本機桌寵需另跑：
node scripts/install.js
```

- 純資料變更：只改 `config.json` 的 `power` / `evolvesTo` 與 `roster.json`。
- roster：腳本會把已接線的新角色加入 `roster`（戰鬥對手池）、6 隻新 starter 加入 `starters`（reset 可抽）。不想動可加 `--no-roster`。
- **建議**：子彈未補齊前先 `--no-roster`，避免新角色當對手出場時用到 placeholder 子彈。
