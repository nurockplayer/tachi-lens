# tachi-lens

## What This Is

Twitch 聊天室沉浸式翻譯 Chrome Extension。MV3 架構，BYOK（自備 API Key），支援 Gemini、DeepSeek、OpenAI、Claude 四家翻譯 provider。以非破壞式方式在 Twitch 聊天室原文下方附加翻譯行，不取代原生 UI。

## Core Value

使用者打開 Twitch 聊天室就能即時看到翻譯，不用切視窗、不用複製貼上。

## Requirements

### Validated

- ✓ **ENV-01**: pnpm + Vite 8 + TypeScript strict + CRXJS build + CI — *#1*
- ✓ **ADPT-01**: Gemini / DeepSeek / OpenAI / Claude Provider adapter 實作 — *#4*
- ✓ **ADPT-02**: Provider registry 集中註冊 + endpoint allowlist — *#4*
- ✓ **ADPT-03**: 統一 TranslationProvider 介面（translateBatch + validateKey） — *#4*
- ✓ **SW-01**: Service Worker 訊息路由（translate_request / validate_key / provider_status） — *#3*
- ✓ **SW-02**: 批次佇列（150ms debounce + max 10 條/批次） — *#3*
- ✓ **SW-03**: LRU + TTL 快取（max 500 筆、5 分鐘 TTL） — *#3*
- ✓ **RATE-01**: 指數退避 RateLimiter — *#7*
- ✓ **RATE-02**: BackoffStrategy 介面（exponential / linear / fixed） — *#7*
- ✓ **RATE-03**: TranslatorWithRetry 自動重試（rate_limit / network 最多 3 次） — *#7*
- ✓ **SEL-01**: DOM selector contract（channel / popout / vod / clip） — *#8*
- ✓ **SEL-02**: selector 整合測試（真實 DOM 結構驗證） — *#8*
- ✓ **CS-01**: MutationObserver 監聽新訊息 — *#2*
- ✓ **CS-02**: 定時重試（5 秒 interval，獨立於 mutation 批次） — *#2*
- ✓ **CS-03**: 設定快取層（避免逐條 storage 讀取） — *#2*
- ✓ **CS-04**: 三種顯示模式（below / hover / collapse） — *#2*
- ✓ **CS-05**: SPA 導航（history.pushState/replaceState monkey-patch） — *#11*
- ✓ **CS-06**: 錯誤 UI 圖示（auth / rate_limited / timeout / network） — *#14*
- ✓ **POPUP-01**: React 設定表單 — *#5*
- ✓ **POPUP-02**: API Key 管理（儲存 / 旋轉 / 刪除 / 遮罩） — *#5*
- ✓ **POPUP-03**: 頻道偵測 + 每頻道設定 — *#12*
- ✓ **POPUP-04**: 錯誤通知中心 — *#14*
- ✓ **I18N-01**: 多語言支援（en + zh_TW） — *#9*
- ✓ **I18N-02**: locale 一致性測試 — *#9*
- ✓ **SEC-01**: Storage access level 限制 — *#6*
- ✓ **SEC-02**: API Key save / rotate / delete / masked — *#6*
- ✓ **KB-01**: 快捷鍵（Ctrl+Shift+T 切換翻譯、Ctrl+Shift+M 切換顯示模式） — *#13*
- ✓ **KB-02**: 設定廣播（Popup → SW → 所有 CS tabs） — *#13*

### Active

（全數完成，無進行中的項目）

### Out of Scope

| 功能 | 原因 |
|------|------|
| 替換 Twitch 原生 UI | 非破壞式設計，僅附加翻譯行 |
| 自動重新翻譯已處理訊息 | 設定變更後不重譯既有訊息（當前規格） |
| 真實 API 測試 | 測試使用 mock fetch，需使用者自行驗證 |
| Unicode 快取正規化 | 快取 key 使用簡單字串拼接，不處理正規化 |

## Context

- 使用 pnpm + Vite 8 + TypeScript strict + CRXJS
- 測試框架：Vitest + jsdom
- Chrome Extension MV3，無後端伺服器
- 三個 context：Service Worker / Content Script / Popup，透過 `chrome.runtime.sendMessage` 通訊
- 所有 13 個 Issue 已完成，287 個測試全部通過

## Constraints

- **Tech**: Chrome Extension MV3，無後端
- **Security**: API Key 僅存 chrome.storage.local，僅 SW 讀取完整 key
- **Performance**: 批次翻譯（150ms debounce），避免單條 API 呼叫
- **Compatibility**: 支援 Twitch channel / popout / vod / clip 四種頁面

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| BYOK 不自建後端 | 使用者自備 API Key，零 infra 成本 | ✓ Good |
| 非破壞式注入 | 不取代 Twitch 原生 DOM，降低 Twitch 更新後斷掉的風險 | ✓ Good |
| Provider 開放介面 | 可無痛新增更多 LLM provider | ✓ Good |
| LRU + TTL 快取 | 平衡記憶體與翻譯即時性 | ✓ Good |
| history API 取代 bodyObserver | 避免 document.body 大量 mutation 效能開銷 | ✓ Good |

---
*Last updated: 2026-06-27 after project completion*
