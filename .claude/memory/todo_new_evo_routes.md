---
name: todo-new-evo-routes
description: agumon statusline 新增大量 Adult→Perfect 分歧 + 6 隻新 starter 的路線設計，已驗證待套用
metadata: 
  node_type: memory
  type: project
  originSessionId: c4a65b81-be70-4a28-87c7-cc578614c058
---

## 狀態（2026-06-11 設計；2026-06-15 調整；2026-06-15 第一波實裝；2026-06-22 第二波實裝；2026-06-23 第三波實裝；2026-06-25 後續波完整規格更新；2026-07-06 第四波實裝）

### ✅ 第四波已實裝（2026-07-06，commit 6cfe142 真子彈完成 → --wave --write + install.js）
commit `6cfe142`（「更新多隻角色子彈美術」）把 21 隻補到真子彈+art(12幀)+cutin 齊全。實裝 5 條鏈（+修 1 隻壞 config）：
- **Angoramon starter 線**（上位）：angoramon→symbareangoramon→lamortmon→diarbbitmon（+交叉 angoramon→leomon 下位、symbareangoramon→loaderleomon 下位）
- **Jellymon starter 線**（上位）：jellymon→teslajellymon→thetismon→amphimon（+交叉 jellymon→shellmon、teslajellymon→marinbullmon）
- **Syakomon starter 線（僅 shellmon 支）**：syakomon→shellmon→marinbullmon→ryugumon/ariemon。⚠️**seadramon 支（seadramon/megaseadramon/metalseadramon/shagaramon）使用者指示先不接（路線待調整），這幾隻仍 placeholder 子彈 `1d36e486`**，未加進 --wave 故自動 gate 掉。
- **聖獸夜線**：gatomon→ladydevimon(night)→lilithmon（既有 gatomon→angewomon 自動補 day gate；兩者同 power 130 靠日夜互斥）
- **哥吉拉 Jr 線**：godzillasaurus→godzilla_jr→godzilla_1994（godzillasaurus 分歧：既有 godzilla_1954(130) 上位 + 新 godzilla_jr(125) 下位）
- **修 Sakuyamon config**：原本壞的 `Adult/50/_placeholder` → 依規格改 `Ultimate/165`，接 sekkamon→sakuyamon(60% 下位，與既有 yukinamon 65% 上位並列)。
- 腳本 `apply-new-routes.js`：WAVE_NEW/WAVE_BASE/WAVE_STARTERS 加第四波名單；POWER 加 sakuyamon:165、把 patamon 線終點 dijiangmon→jougamon 對齊 source（dijiangmon 已淘汰、仍 placeholder）；NEW_EDGES 加 sekkamon→sakuyamon。
- dry-run 死路 0。--write：roster 94→112(+18)、starters 14→17(+syakomon/angoramon/jellymon)。install.js 部署驗證：18 隻在 installed、config stage/power/evo 正確、art+cutin+bullet-art 齊全且 bullet-art hash 全唯一、runtime loadCharacter 無錯。
- ✅ **已 commit+push**（2026-07-06 `891829d`，24 檔：22 config+roster+apply-new-routes.js）到 jojohne124/VpetStatusline origin/main。排除 bin/vpet.js（CRLF 噪音，同前三波）。順帶把第二波 biyomon→xiquemon 邊回寫進 source（先前僅在 installed）。
- 📌 patamon 線（turuiemon→antylamon→jougamon）先前已在 source roster 接妥（jougamon 本波才補到真子彈），本波未動。

### ✅ reset 機制新規格（2026-07-09 已實作）

搭配高階 starter 的兩條規格都已做（詳見 [[todo-evo-route-editor]]）：
1. **reset 抽中高階 starter 用 dust_hi 煙霧**：shared 新增 `dust_hi` sprite（frame 14，**先複製 dust(13) 內容**，待美術替換）。`statusline-agumon-color.js` 掉落場景依 `core.isHighTierStarter(st.characterId)` 選 `dust`/`dust_hi`。「高階」由**編輯器手動勾選**（明確旗標），存 `roster.highTierStarters`。
2. **starter 權重（從無到有新建）**：`roster.starterWeights={id:num}`（缺=1）；`statusline-cheat.js --reset` 改**加權隨機** `weightedPickStarter`。編輯器 starter 面板可編權重值。
- 附帶修掉既有 bug：`--reset` 只從**已實裝(在 roster)的 starter** 抽 → 未實裝 starter（如子彈未完成的 fujamon）不會被抽到也不再 crash（原本 `roster.includes` 檢查會擋）。
- ⚠️ fujamon 目前是 starter 但**未實裝**（子彈未完成，使用者完成後手動實裝）；未實裝前不會被 reset 抽到。
- 驗證：加權分布 9.8/90.2≈期望、reset x150 crash 0 / fujamon 0 / angoramon(w9) 31%、isHighTierStarter 正確、編輯器 round-trip 寫入 roster 正確且 config 零語意差。

### 📋 後續波完整規格（2026-06-25 使用者提供，僅記錄未實裝；含部分變動）

使用者給出「剩餘未實裝角色 + 變動」完整清單。`(NEW)` 標角色或邊為新增；power 在括號內。

**新分歧（既有 starter 加 Adult→Perfect/Ultimate 旁支）：**
- Gomamon(10)>Dolphmon(65)>Whamon(115)>**Leviamon(170)(NEW)** ── 上位分歧
- Patamon(10)>Turuiemon(60)>Antylamon(115)>**Jougamon(165)(NEW)** ── 下位
- Gatomon(55)(夜晚)>LadyDevimon(130)>Lilithmon(175) ── 日夜分歧，持平
- Renamon(15)>Musyamon(60)>Oboromon(110)>Zanbamon(160) ── 下位分歧
- Godzillasaurus(80)>Godzilla_Jr(125)>**Godzilla_1994(180)** ── 前期弱、後期持平（180 為全表最高 power）

**Perfect→Ultimate 旁支（既有完全体的第二條究極体）：**
- MegaKabuterimon>**AncientBeatmon(170)(NEW)** ── 上位（⚠️舊定案拼 `ancientbeetmon`）
- Garudamon>**Gryphonmon(160)(NEW)** ── 下位
- Lillymon>**Rafflesimon(165)(NEW)** ── 上位
- MagnaAngemon>**Goddramon(170)(NEW)** ── 下位
- Angewomon>**Ofanimon(170)(NEW)** ── 下位（⚠️舊定案拼 `ophanimon`）
- Sekkamon>**Sakuyamon(165)(NEW)** ── 下位

**新 starter：**
- Syakomon(15)>Shellmon(62)>MarinBullmon(120)>Ryugumon(170)；MarinBullmon(120)>Ariemon(165)〔分歧〕
- **Fujamon(15)(NEW)**>Seadramon(60)>MegaSeadramon(115)>MetalSeadramon(160)；MegaSeadramon(115)>Shagaramon(165)〔分歧〕
- **Fujamon(15)(NEW)**>**Coelamon(55)(NEW)**>**Huankunmon(115)(NEW)**>**Xiangpengmon(165)(NEW)**

**高階 starter 路線：**
- Angoramon(25)>SymbareAngoramon(75)>Lamortmon(125)>Diarbbitmon(175) ── 上位
- Angoramon>**Turuiemon(NEW 邊)**>… ── 下位（Turuiemon 角色同 Patamon 線，此處為新邊）
- SymbareAngoramon(75)>**Antylamon(NEW 邊)**>… （Antylamon 角色同 Patamon 線，此處為新邊）
- Jellymon(25)>TeslaJellymon(75)>Thetismon(125)>Amphimon(175) ── 上位
- Jellymon>Shellmon>… ── 下位（接 Syakomon 線的 Shellmon）
- TeslaJellymon(75)>MarinBullmon… （接 Syakomon 線的 MarinBullmon）

**vs 舊紀錄的變動（2026-06-25 使用者已確認）：**
1. ✅ 拼字定案：**`AncientBeatmon` / `Ofanimon`（首字大寫）才是正確拼法**。推翻 2026-06-15 第 4 點的 `ancientbeetmon`/`ophanimon`，以本次為準。
2. ✅ **Zudomon>Plesiomon(165) 上位旁支已於第二波實裝**（見上方 wave2 海豚線終點修正：zudomon→[vikemon60%, plesiomon65%]）。所以本次清單沒列 plesiomon＝它已完成、非遺漏。海豚線本身 Gomamon>Dolphmon>Whamon>Leviamon 仍未接（卡 Leviamon）。
3. ✅ 新角色清單正確，**原圖待補 / 待轉換**：除舊列究極体（leviamon/gryphonmon/rafflesimon/goddramon + AncientBeatmon/Ofanimon/Sakuyamon），再加 **Jougamon、Coelamon、Huankunmon、Xiangpengmon、Fujamon、Godzilla_Jr、Godzilla_1994、Godzillasaurus、Oboromon、Zanbamon、Ryugumon、Ariemon、MarinBullmon、Shellmon、Syakomon** 等（多數無 config/art，需原圖→char-cli process/cutin→建 config）。
4. Turuiemon/Antylamon 為**共用角色**：在 Patamon 線是主鏈，在 Angoramon/SymbareAngoramon 線是新增的下位交叉邊（`(NEW)` 指邊非角色）。

實裝仍照既有 SOP：補資產（含真子彈）→ 加 `--wave` 白名單 → dry-run 驗 0 死路 → `--write` → install.js。



### ✅ 第三波已實裝（2026-06-23，美術+真子彈完成 → --wave --write + install.js + push）

使用者回報 3 條鏈美術完成：**植物木偶線**(palmon→woodmon→cherrymon→puppetmon)、**togemon 花妖線**(togemon→blossomon→hydramon)、**bakemon 南瓜線**(bakemon→pumpkinmon→noblepumpkinmon)。資料早在 POWER/NEW_EDGES，只加白名單：
- `WAVE_NEW` += woodmon,cherrymon,puppetmon,blossomon,hydramon,pumpkinmon,noblepumpkinmon（7 隻）；`WAVE_BASE` += palmon,togemon,bakemon（交叉/下位端點）。無新 starter。
- 7 隻資產（art.json 12幀/16x8 color-halfblock 同 greymon、cutin、**真子彈**(bullet hash 皆唯一非 placeholder)）皆已在 repo 且早先 committed（git status 只有 config 變動）。
- dry-run 死路 0。`--write`：source roster 83→90、starters 14 不變。install.js 部署、installed 驗證 7 隻 evolvesTo 正確、roster=90、loadCharacter 無錯。
- 既有邊保留：palmon→togemon(50%)+woodmon(55%)、togemon→lillymon(55%)+blossomon(60%)、bakemon→phantomon(55%)+pumpkinmon(60%)。
- ✅ commit+push origin/main `8be6566`（12 檔：10 config+roster+script）。排除 bin/vpet.js(CRLF噪音)、CresGarurumon/Zephagamon bullet(非本波的既有 dirty)。⚠️ commit 用 Bash tool 時 `@'...'@`(PowerShell here-string)在 git bash 會把 `@` 寫進標題 → 改用 `git commit -F 檔案` 或先寫 /tmp 再 amend。

### ✅ 第二波已實裝（2026-06-22，美術完成 → --wave --write + install.js）

使用者回報 4 條鏈美術完成：**鍬形蟲線**(kuwagamon→okuwamon→grankuwagamon)、**海豚線**(dolphmon→whamon→plesiomon)、**喜鵲線**(xiquemon→crowmon→tengumon)、**翼龍 starter 線**(pteromon25→galemon75→grandgalemon125→zephagamon175)。資料早已在腳本 POWER/NEW_EDGES，只把它們加進 `--wave` 白名單即可：
- `WAVE_NEW` += 上述 13 隻；`WAVE_BASE` += 交叉/下位既有端點 `tentomon,kabuterimon,gomamon,ikkakumon,biyomon,birdramon,garudamon`；`WAVE_STARTERS` += `pteromon`。
- dry-run 死路 0。`--write`：source roster 70→83、starters 13→14（+pteromon）。`install.js` 部署完成。驗證：13 隻 characterExists=true、stage/power 正確、art.json 皆 12 frames/16x8/color-halfblock 與 greymon 同構、cross-base 既有邊保留（tentomon→kabuterimon、ikkakumon→zudomon、birdramon→garudamon 等）。

#### 海豚線終點修正（2026-06-22 同日，依使用者指示改採 2026-06-15 doc 設計）
wave2 初版 whamon→plesiomon 為海豚線終點；使用者要求改成：**whamon 終點換 leviamon(170)**、**plesiomon(165) 改掛 zudomon 上位旁支（與既有 vikemon160 並列）**。leviamon 資產未完成 → 先 gate，待完成再接。已做：
- 腳本：POWER += `leviamon:170`；NEW_EDGES 海豚線改 `['whamon','leviamon']`（被 --wave 自動 gate，因 leviamon 不在 WAVE_NEW）、移除 `['whamon','plesiomon']`；Perfect→Ultimate 段 += `['zudomon','plesiomon']`；WAVE_BASE += `zudomon`。
- ⚠️ 因 wave2 已把 whamon→plesiomon 寫進 source config，腳本會把它當「既有邊」保留 → 必須**手動清空** `characters/whamon/config.json` 的 evolvesTo 為 `[]` 再重跑（已做）。
- 重跑 --wave --write + install：死路 0、roster 83→83（plesiomon 早已在、leviamon gate 住不進）。部署後驗證：whamon→[]（終點待 leviamon）、zudomon→[vikemon60%, plesiomon65%]、leviamon 不在 roster。
- 📌 **leviamon 完成後收尾**：建 `characters/Leviamon` config(Ultimate/170/evolvesTo空)+art+子彈 → 把 `leviamon` 加進 WAVE_NEW → 重跑 --wave --write + install（whamon→leviamon 邊與 POWER 170 已就緒，加白名單即接）。
- ✅ 已 commit+push（2026-06-22）：`f2708cc` 到 jojohne124/VpetStatusline origin/main（腳本+20角色config+roster，22檔）。排除 bin/vpet.js（npm link 造成的 CRLF 行尾差異，無內容變更）。第二波（含海豚線終點修正）一顆 commit 收齊。



### ✅ 第一波已實裝（2026-06-15，--write + install.js 部署完成）

「真子彈已完成」這批已接 evolveTo + 部署 + 進 roster：**Agumon-2010 線**（greymon_2010/metalgreymon_2010/zekegreymon）、**Leomon 線**（leomon→loaderleomon→saberleomon）、**BlitzGreymon**、**CresGarurumon**、**Commandramon 線**、**Loogamon 線**。共 16 隻入 roster（54→70）、commandramon+loogamon 入 starters（11→13）。死路 0。
- 為分波實裝在 `apply-new-routes.js` 加了 **`--wave` 旗標**（只接兩端都屬本波的邊；WAVE_NEW/WAVE_BASE/WAVE_STARTERS 三組白名單，未來分波改名單即可）。完整設計仍保留在腳本，未接的邊原樣留著。
- 同步把 **shishimamon→loaderleomon** 決策寫進腳本（POWER + 3 條邊：leomon/garurumon/symbareangoramon）。`shishimamon` evolvesTo 空、不在 roster（孤立，資產保留）。
- power 修正落地：greymon_2010 75→65、metalgreymon_2010 125→115、blitzgreymon/cresgarurumon 175→173。
- ✅ 已 commit+push 到 origin/main（2026-06-15）：3 顆 `d957bd2..0e75874`（子彈+ZekeGreymon鏡像 / LoaderLeomon新角 / 第一波實裝）。repo: jojohne124/VpetStatusline。

### 待續（後續波）

📋 其餘鏈尚未接（多數子彈仍 placeholder）：Turuiemon/LadyDevimon/Musyamon/Godzilla_Jr 各線、Syakomon/Angoramon/Jellymon starter 線（Kuwagamon/Dolphmon/Xiquemon/Pteromon 第二波已接；Woodmon/Blossomon/Pumpkinmon 三線第三波已接）；2026-06-15 其他調整（leviamon、plesiomon 改掛 zudomon、7 條 Perfect→Ultimate）對應的 7 隻新角色（leviamon/ancientbeetmon/gryphonmon/rafflesimon/goddramon/ophanimon/sakuyamon）連 config 都還沒建。下波要：補資產（含真子彈）→ 把該批加進 `--wave` 白名單 → dry-run 驗 0 死路 → `--write` → install.js。
（commit `d957bd2` 標題列因 here-string 引號誤用，第一行是字面 `@`、真標題擠到第二行；使用者選擇不修。）

### 2026-06-15 調整（**僅記錄進 `docs/new-evo-routes.md`，未碰 `apply-new-routes.js`、未實裝**）

使用者再調整「未實裝」路線，要求只記錄不實裝。已改的只有 doc：
1. 獅子線完全体 `shishimamon` → **`loaderleomon`(115) NEW**（leomon / garurumon交叉 / symbareangoramon下位 三入口全改）。⇒ `shishimamon` 變孤立（無 parent 無 child），實裝時退役。
2. 海豚線終點 `plesiomon` → **`leviamon`(170) NEW**；`plesiomon`(165) 改掛為 `zudomon` 上位旁支（與既有 `vikemon`160 並列）。
3. **新增 7 條 Perfect→Ultimate 旁支**（既有完全体的第二條究極体）：megakabuterimon→ancientbeetmon(170,上位)、zudomon→plesiomon(165,上位)、garudamon→gryphonmon(160,下位)、lillymon→rafflesimon(165,上位)、magnaangemon→goddramon(170,下位)、angewomon→ophanimon(170,下位)、sekkamon→sakuyamon(165,下位)。各與既有究極体 gate 差 5%（目標 power 差 5），照公式即相異、弱邊可達，**不需 tie-break**（tie-break 只給離格 power 58/62 或同 power 的那批）。
4. ~~拼字定案：`ancientbeetmon`（非 Beat）、`ophanimon`（非 Ofanimon）~~ ⚠️**已被 2026-06-25 推翻**，正確拼法為 `AncientBeatmon`/`Ofanimon`（首字大寫）；`loaderleomon`（原暫定 Liomon，改回 Leomon）維持不變。

⚠️ 8 隻新角色實裝前需先建 config + 美術 + 子彈，再把調整同步進 `apply-new-routes.js`（POWER + NEW_EDGES）。進度：
- ✅ `loaderleomon`（2026-06-15 使用者放原圖到 `characters/LoaderLeomon`）：已手建 config.json（Perfect/115/evolvesTo 空）+ `char-cli process`/`cutin` 產 pixels/art/cutin-art + `gen-bullet-placeholders.js` 補 placeholder 子彈（1258B `dac6881e`，真子彈待補）。檔組已與 leomon 齊。尚未接 evolveTo、未部署。
- ⬜ 其餘 7 隻仍無 source config：`leviamon`/`ancientbeetmon`/`gryphonmon`/`rafflesimon`/`goddramon`/`ophanimon`/`sakuyamon`。

建角色 SOP（individual 格式）：放 `0.png`…`11.png`+`CutIn.png` 到 `characters/<Name>/` → 比照 leomon 手建 config.json（stage 由 power band 推、evolvesTo 留空）→ `node src/tools/char-cli.js process <Name>` + `cutin <Name>`。

## 內容

使用者給了一整套新進化分歧（既有 starter 加 Adult→Perfect 旁支，含上位/下位/前弱後持平/日夜分歧）+ 6 隻新 starter（syakomon 貝海獸、commandramon/loogamon/pteromon/angoramon/jellymon 高階線）。**目標角色幾乎都已有 config+art**（之前建好的孤立角色，evolvesTo 空），所以本質是純資料接線：調 power + 接 evolvesTo。

## 關鍵發現

- **不需要 weight/priority 引擎**（[[todo-evolution-branching]] 那套）。「勝率不佳走弱分支」用既有的 `checkEvolution`（取目標 power 強者）+ win% 門檻（強分支高、弱分支低）就成立。
- **`evo-winrate-default.md` 公式有盲區**：相鄰 power（差 5）的兄弟分支取整後 win% 會打平 → power-sort 永遠選強的、弱的死路（直接套出 16 處，5 處殺原始主線）。
- **補的 tie-break 規則**：同分歧點打平時，保留既有/主線那條的 win%，新分支挪 ±5%（弱→降、強→升）；兩條皆新邊時弱的留公式值、強的升 5。套後死路歸零、既有門檻 0 改動。
- 唯一要動既有 config 的點：**gatomon→angewomon 補 `time_of_day: day`**，才能跟夜線 ladydevimon 互斥（兩者同 power 130）。使用者已同意修正。
- togemon→cherrymon 依指示**刪除**（原與 blossomon 同 power 115 衝突）。

## 產出（在 agumon-cli repo）

- `docs/new-evo-routes.md` — 完整對照表（各家族鏈 + win% + 子彈完成度）。
- `scripts/apply-new-routes.js` — 可套用腳本，預設 dry-run，`--write` 寫 source config+roster，`--no-roster` 跳過 roster。**不部署**（部署另跑 install.js）。dry-run 已驗證死路=0。

## 待辦

- [ ] 子彈補齊：真子彈只有 6 條線（Agumon-2010 / Leomon / BlitzGreymon / CresGarurumon / Commandramon / Loogamon），其餘約 46 隻仍是共用 placeholder（hash dac6881e）。
- [ ] 子彈 OK 後再 `--write`（建議先 `--no-roster`，避免 placeholder 子彈角色當對手出場）→ install.js 部署。

**Why:** 使用者明確「先不實裝、先檢查路線」，且子彈未完成。
**How to apply:** 接續時先確認子彈完成度，再決定 `--write` 範圍；roster 納入與否是獨立決策。

相關：[[cc-statusline 安裝紀錄]]、[[todo-evolution-branching]]、[[多視窗 race 與動畫純函數 + per-window cost]]
