# Requirements: tachi-lens

**Defined:** 2026-06-27
**Core Value:** 使用者打開 Twitch 聊天室就能即時看到翻譯

## v1 Requirements

### Infrastructure

- [x] **ENV-01**: pnpm + Vite 8 + TypeScript strict + CRXJS + CI
- [x] **SEC-01**: Storage access level 限制
- [x] **SEC-02**: API Key save / rotate / delete / masked

### Translation Provider

- [x] **ADPT-01**: Gemini Provider adapter
- [x] **ADPT-02**: DeepSeek Provider adapter
- [x] **ADPT-03**: OpenAI Provider adapter
- [x] **ADPT-04**: Claude Provider adapter
- [x] **ADPT-05**: Provider registry + endpoint allowlist

### Service Worker

- [x] **SW-01**: 訊息路由（translate_request / validate_key / provider_status）
- [x] **SW-02**: 批次佇列（150ms debounce + max 10 條/批次）
- [x] **SW-03**: LRU + TTL 快取（max 500 筆、5 分鐘 TTL）
- [x] **SW-04**: RateLimiter 指數退避
- [x] **SW-05**: TranslatorWithRetry 自動重試

### Content Script

- [x] **CS-01**: DOM selector contract（channel / popout / vod / clip）
- [x] **CS-02**: MutationObserver 監聽新訊息
- [x] **CS-03**: 定時重試未處理訊息（5 秒 interval）
- [x] **CS-04**: 設定快取層
- [x] **CS-05**: 三種顯示模式（below / hover / collapse）
- [x] **CS-06**: SPA 導航支援
- [x] **CS-07**: 錯誤 UI 圖示

### Popup

- [x] **POPUP-01**: React 設定表單（Provider / Model / API Key / 語言 / 顯示模式）
- [x] **POPUP-02**: API Key 儲存 / 旋轉 / 刪除 / 遮罩
- [x] **POPUP-03**: 頻道偵測 + 每頻道設定
- [x] **POPUP-04**: 錯誤通知中心

### i18n

- [x] **I18N-01**: 英文 locale
- [x] **I18N-02**: 繁體中文 locale
- [x] **I18N-03**: locale 一致性測試

### UX

- [x] **KB-01**: 快捷鍵（Ctrl+Shift+T 切換翻譯）
- [x] **KB-02**: 快捷鍵（Ctrl+Shift+M 切換顯示模式）
- [x] **KB-03**: 設定廣播（Popup → SW → CS tabs）

## v2 Requirements

（無延期項目）

## Out of Scope

| Feature | Reason |
|---------|--------|
| 自動重新翻譯已處理訊息 | 設定變更後不重譯既有訊息 |
| 真實 API 整合測試 | 需使用者自行填入 API Key 驗證 |
| Unicode 快取正規化 | 低優先級，暫不處理 |
| 多餘 Provider | 四家主流 LLM provider 已足夠 |
| WebSocket 即時翻譯 | MV3 限制，暫不支援 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENV-01 | Phase 1 (Infrastructure) | Complete |
| SEC-01 | Phase 1 | Complete |
| SEC-02 | Phase 1 | Complete |
| ADPT-01~05 | Phase 2 (Provider Adapters) | Complete |
| SW-01~05 | Phase 3 (SW Routing + Queue + Cache) | Complete |
| RATE-01~02 | Phase 4 (Rate Limit) | Complete |
| CS-01~02 | Phase 5 (DOM Selectors) | Complete |
| CS-03~05 | Phase 6 (CS Implementation) | Complete |
| POPUP-01~02 | Phase 7 (Popup UI) | Complete |
| I18N-01~03 | Phase 8 (i18n) | Complete |
| CS-06 | Phase 9 (Multi-page) | Complete |
| POPUP-03 | Phase 10 (Per-channel Settings) | Complete |
| KB-01~03 | Phase 11 (Keyboard Shortcuts) | Complete |
| CS-07 / POPUP-04 | Phase 12 (Error UI) | Complete |

**Coverage:**
- v1 requirements: 32 total
- Mapped to phases: 32
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-27*
*Last updated: 2026-06-27 after project completion*
