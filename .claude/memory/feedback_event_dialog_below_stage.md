---
name: feedback-event-dialog-below-stage
description: 事件演出／助手對話一律放在舞台下方，永遠不能蓋住上面的畫面（使用者強調很重要）
metadata:
  type: feedback
---

事件演出、助手（大耳獸）對話框一律放在舞台**下方**，不能蓋住上面的畫面（營地、廣場、前線）。新增任何演出都走 `storyOpen`／`storyPlace`，不要自己置中或疊在舞台上。

**Why:** 2026-10-27 vpet mini 的營地事件：小視窗放不下就把對話框置中，整個蓋住營地，玩家選不到要出戰的那隻。使用者說「這很重要，希望未來的事件演出不要遮到上方畫面」。

**How to apply:** `storyPlace`（src/daemon/daemon.js）：視窗放得下 → 舞台下方；vpet mini（WebView2）→ 撐高 body 下內距，殼會把視窗拉長；網頁太矮 → 整層改 absolute 跟著頁面捲。test-yard-page2 有守門（storyPlace 不能出現置中）。相關：[[project-vpet-daemon-standalone]]
